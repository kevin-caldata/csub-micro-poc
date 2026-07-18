// T06.1 — Vendored G.711 mu-law codec tables + frame-math sanity constants.
// Verbatim per Spec 06 R5 / R10 and findings/06 C1, C5, C8 — do NOT use the
// `alawmulaw` npm package (banned, Spec 06 A2 / master plan R-10): its UMD
// `main` with no `exports` field throws under Node ESM named imports, and its
// `encodeSample()` returns an unmasked value. Vendoring these ~30 lines is
// both correct and measured faster.
//
// Later T06 tasks (T06.2 FIR/resamplers, T06.3 transcoder/audioFormatsFor)
// extend this same file.

// ---- G.711 mu-law (Sun ulaw.c variant, full 16-bit domain, range +/-32124) ----
const BIAS = 0x84;
const CLIP = 32635;
const MULAW_DECODE_EXP = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

function muLawDecodeSample(mu: number): number {
  mu = ~mu & 0xff;
  const exponent = (mu >> 4) & 0x07;
  const sample = MULAW_DECODE_EXP[exponent]! + ((mu & 0x0f) << (exponent + 3));
  return (mu & 0x80) ? -sample : sample;
}

function muLawEncodeSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  sample += BIAS;
  if (sample > CLIP) sample = CLIP;
  let exponent = 7;
  for (let mask = 0x4000; !(sample & mask) && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff; // NOTE the & 0xff
}

/** 256-entry mu-law -> PCM16 decode table, full-scale 16-bit (+/-32124 extremes). */
export const MULAW_DEC = new Int16Array(256);
for (let i = 0; i < 256; i++) MULAW_DEC[i] = muLawDecodeSample(i);

/** 65,536-entry PCM16 -> mu-law encode table, indexed by `pcm & 0xffff`. */
export const MULAW_ENC = new Uint8Array(65536);
for (let s = -32768; s <= 32767; s++) MULAW_ENC[s & 0xffff] = muLawEncodeSample(s);

// ---- Frame-math sanity constants (Spec 06 R10) ----
export const FRAME_MS = 20; // observed Twilio cadence, NOT contractual
export const MULAW_BYTES_PER_20MS = 160; // 8000 Hz x 0.02 s x 1 B
export const MULAW_B64_CHARS_PER_20MS = 216; // ceil(160/3)*4
export const PCM24K_SAMPLES_PER_20MS = 480; // 160 x 3
export const PCM24K_BYTES_PER_20MS = 960; // 480 x 2 (16-bit LE mono)
export const PCM24K_B64_CHARS_PER_20MS = 1280; // 960/3*4 (~1.3 KB ~= 0.5% of gateway 256 KB cap)

// T06.2 — FIR designer + Upsampler3x / Downsampler3x with persistent chunk state.
// Verbatim per Spec 06 R6/R7/R8 and findings/06 §FIR design, §Upsampler, §Downsampler,
// gotchas 4, 8, 9, 10. 48 taps / Hamming window / 3600 Hz cutoff / fs 24 kHz — measured
// far above mu-law's ~38 dB SNDR floor (findings/06 C12); do not spend more taps.

/** Hamming-windowed-sinc lowpass FIR designed at `fs`, unity-DC-gain scaled by `gain`.
 *  Module-private: only the resampler classes below construct filters with it. */
function designLowpassFIR(numTaps: number, cutoffHz: number, fs: number, gain = 1): Float64Array {
  const fc = cutoffHz / fs;
  const M = numTaps - 1;
  const h = new Float64Array(numTaps);
  let sum = 0;
  for (let n = 0; n < numTaps; n++) {
    const k = n - M / 2; // M/2 = 23.5 for 48 taps: k never 0
    const sinc = k === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * k) / k;
    h[n] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M)); // Hamming
    sum += h[n]!;
  }
  for (let n = 0; n < numTaps; n++) h[n] = (h[n]! / sum) * gain; // unity DC gain x gain
  return h;
}

/** Streaming 8 kHz -> 24 kHz x3 polyphase upsampler. Persistent 15-sample history is carried
 *  across `process()` calls so chunk boundaries are click-free (findings/06 C6). Deliberately
 *  has NO reset method: the inbound leg is one continuous call-duration stream and must never
 *  be reset mid-call (Spec 06 R7/R11.1 — structural enforcement). */
export class Upsampler3x {
  private perPhase: number;
  private phases: Float64Array[]; // phases[p][k] = h[3k + p]
  private hist: Float64Array; // last (perPhase - 1) = 15 input samples, oldest->newest

  constructor(numTaps = 48, cutoffHz = 3600) {
    const h = designLowpassFIR(numTaps, cutoffHz, 24000, 3); // gain 3!
    this.perPhase = numTaps / 3; // must divide by 3
    this.phases = [0, 1, 2].map((p) => {
      const c = new Float64Array(this.perPhase);
      for (let k = 0; k < this.perPhase; k++) c[k] = h[3 * k + p]!;
      return c;
    });
    this.hist = new Float64Array(this.perPhase - 1);
  }

  /** any input length; output length is exactly 3 x input length */
  process(pcm8k: Int16Array): Int16Array {
    const N = pcm8k.length;
    const P = this.perPhase;
    const H = P - 1;
    const x = new Float64Array(H + N);
    x.set(this.hist);
    for (let i = 0; i < N; i++) x[H + i] = pcm8k[i]!;
    const out = new Int16Array(N * 3);
    for (let m = 0; m < N; m++) {
      const base = H + m;
      for (let p = 0; p < 3; p++) {
        const c = this.phases[p]!;
        let acc = 0;
        for (let k = 0; k < P; k++) acc += c[k]! * x[base - k]!;
        out[3 * m + p] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
      }
    }
    this.hist.set(x.subarray(x.length - H)); // carry state across chunks
    return out;
  }
}

/** Streaming 24 kHz -> 8 kHz LPF + /3 decimating downsampler. Persistent 47-sample history plus
 *  a mod-3 phase counter are carried across `process()` calls: the phase counter is required
 *  (not optional) because gateway `audio-delta` payload sizes are not guaranteed to be multiples
 *  of 3 samples (findings/06 gotcha 4). `reset()` zeros both — call at each new response boundary
 *  (Spec 06 R11.2/R11.3), never mid-response. */
export class Downsampler3x {
  private h: Float64Array;
  private numTaps: number;
  private hist: Float64Array; // last (numTaps - 1) = 47 input samples
  private phase = 0; // input samples consumed mod 3

  constructor(numTaps = 48, cutoffHz = 3600) {
    this.h = designLowpassFIR(numTaps, cutoffHz, 24000, 1);
    this.numTaps = numTaps;
    this.hist = new Float64Array(numTaps - 1);
  }

  /** any input length; output length ~= input/3 (exact accounting via phase) */
  process(pcm24k: Int16Array): Int16Array {
    const N = pcm24k.length;
    const T = this.numTaps;
    const H = T - 1;
    const x = new Float64Array(H + N);
    x.set(this.hist);
    for (let i = 0; i < N; i++) x[H + i] = pcm24k[i]!;
    const first = (3 - this.phase) % 3; // offset of first kept sample
    const count = first >= N ? 0 : Math.floor((N - first - 1) / 3) + 1;
    const out = new Int16Array(count);
    for (let j = 0; j < count; j++) {
      const center = H + first + 3 * j;
      let acc = 0;
      for (let k = 0; k < T; k++) acc += this.h[k]! * x[center - k]!;
      out[j] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
    }
    this.phase = (this.phase + N) % 3;
    this.hist.set(x.subarray(x.length - H));
    return out;
  }

  reset(): void {
    this.hist.fill(0);
    this.phase = 0;
  } // zero history = start-from-silence
}

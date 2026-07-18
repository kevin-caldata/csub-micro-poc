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

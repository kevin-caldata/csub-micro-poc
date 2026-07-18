import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  MULAW_DEC,
  MULAW_ENC,
  FRAME_MS,
  MULAW_BYTES_PER_20MS,
  MULAW_B64_CHARS_PER_20MS,
  PCM24K_SAMPLES_PER_20MS,
  PCM24K_BYTES_PER_20MS,
  PCM24K_B64_CHARS_PER_20MS,
  Upsampler3x,
  Downsampler3x,
  audioFormatsFor,
  createTranscoder,
} from '../src/dsp.js';

// Locally re-derived reference decoder (Sun ulaw.c variant, full 16-bit domain,
// range +/-32124) per Spec 06 R5 / findings/06 C1 — re-implemented here
// independently of src/dsp.ts so the test doesn't just check itself.
const REF_MULAW_DECODE_EXP = [0, 132, 396, 924, 1980, 4092, 8316, 16764];
function refMuLawDecodeSample(mu: number): number {
  mu = ~mu & 0xff;
  const exponent = (mu >> 4) & 0x07;
  const sample = REF_MULAW_DECODE_EXP[exponent] + ((mu & 0x0f) << (exponent + 3));
  return (mu & 0x80) ? -sample : sample;
}

describe('MULAW_DEC (R12.1)', () => {
  it('matches all 256 values of an independently re-derived reference decoder', () => {
    for (let b = 0; b < 256; b++) {
      // `|| 0` normalizes -0 -> 0: Int16Array (MULAW_DEC's storage) cannot
      // represent signed zero, so both codes that decode to zero-magnitude
      // (0x7F, 0xFF) legitimately collapse to plain 0 — that's the behavior
      // R12.1's "MULAW_DEC[0xFF] === 0" spot-check already relies on.
      expect(MULAW_DEC[b], `mismatch at code ${b}`).toBe(refMuLawDecodeSample(b) || 0);
    }
  });
  it('has 256 entries', () => {
    expect(MULAW_DEC.length).toBe(256);
  });
  it('MULAW_DEC[0xFF] === 0', () => {
    expect(MULAW_DEC[0xff]).toBe(0);
  });
  it('table extremes reach +/-32124', () => {
    let min = 0, max = 0;
    for (let b = 0; b < 256; b++) {
      if (MULAW_DEC[b] < min) min = MULAW_DEC[b];
      if (MULAW_DEC[b] > max) max = MULAW_DEC[b];
    }
    expect(max).toBe(32124);
    expect(min).toBe(-32124);
  });
});

describe('MULAW_ENC (R12.2)', () => {
  it('has 65536 entries', () => {
    expect(MULAW_ENC.length).toBe(65536);
  });
  it('round-trips MULAW_ENC[MULAW_DEC[b] & 0xffff] === b for all codes except 0x7F -> 0xFF', () => {
    for (let b = 0; b < 256; b++) {
      const roundTripped = MULAW_ENC[MULAW_DEC[b] & 0xffff];
      if (b === 0x7f) {
        expect(roundTripped, 'the sole documented exception: 0x7F must map to 0xFF').toBe(0xff);
      } else {
        expect(roundTripped, `round-trip mismatch at code ${b}`).toBe(b);
      }
    }
  });
});

describe('Frame-math constants (R10 / R12.8 constants half)', () => {
  it('matches exact Spec 06 R10 values', () => {
    expect(FRAME_MS).toBe(20);
    expect(MULAW_BYTES_PER_20MS).toBe(160);
    expect(MULAW_B64_CHARS_PER_20MS).toBe(216);
    expect(PCM24K_SAMPLES_PER_20MS).toBe(480);
    expect(PCM24K_BYTES_PER_20MS).toBe(960);
    expect(PCM24K_B64_CHARS_PER_20MS).toBe(1280);
  });
  it('base64 of a 160-byte buffer has length 216', () => {
    expect(Buffer.alloc(160).toString('base64').length).toBe(216);
    expect(Buffer.alloc(MULAW_BYTES_PER_20MS).toString('base64').length).toBe(MULAW_B64_CHARS_PER_20MS);
  });
  it('base64 of a 960-byte buffer has length 1280', () => {
    expect(Buffer.alloc(960).toString('base64').length).toBe(1280);
    expect(Buffer.alloc(PCM24K_BYTES_PER_20MS).toString('base64').length).toBe(PCM24K_B64_CHARS_PER_20MS);
  });
});

// ---- T06.2 test helpers (deterministic fixed-frequency sines only, no RNG) ----

/** Fixed-frequency sine, quantized to Int16 (amplitude/round matches production clamping). */
function generateSine(freqHz: number, amplitude: number, length: number, sampleRate: number): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
  }
  return out;
}

function concatInt16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Max absolute sample difference between two equal-length Int16Arrays. */
function maxAbsDiff(a: Int16Array, b: Int16Array): number {
  expect(a.length, 'compared arrays must have equal length').toBe(b.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

/** Least-squares-projects `y` (sampled at `fs`) onto `A*sin(2*pi*freqHz*n/fs) + B*cos(...)`
 *  over n in [0, y.length), then reports the projected amplitude and THD+N in dB
 *  (10*log10(projected power / residual power)). Because `A*sin(wn)+B*cos(wn)` represents
 *  a sinusoid at `freqHz` of ARBITRARY amplitude and phase, this projection is immune to
 *  any fixed (or fractional) group delay the resampler cascade introduces — unlike a naive
 *  sample-shifted difference, which the fractional 47-sample@24k cascade delay would make
 *  falsely report ~4 dB (Spec 06 R12.5, findings/06 gotcha 8, test 4). */
function projectTone(
  y: Int16Array,
  freqHz: number,
  fs: number,
): { amplitude: number; thdnDb: number } {
  const w = (2 * Math.PI * freqHz) / fs;
  let Sss = 0, Scc = 0, Ssc = 0, Sys = 0, Syc = 0;
  for (let n = 0; n < y.length; n++) {
    const s = Math.sin(w * n);
    const c = Math.cos(w * n);
    Sss += s * s;
    Scc += c * c;
    Ssc += s * c;
    Sys += y[n] * s;
    Syc += y[n] * c;
  }
  const det = Sss * Scc - Ssc * Ssc;
  const A = (Scc * Sys - Ssc * Syc) / det;
  const B = (Sss * Syc - Ssc * Sys) / det;

  let projPower = 0, residPower = 0;
  for (let n = 0; n < y.length; n++) {
    const proj = A * Math.sin(w * n) + B * Math.cos(w * n);
    const resid = y[n] - proj;
    projPower += proj * proj;
    residPower += resid * resid;
  }
  return {
    amplitude: Math.sqrt(A * A + B * B),
    thdnDb: 10 * Math.log10(projPower / residPower),
  };
}

/** Cycles a chunk-size pattern until `total` samples are consumed (last chunk clipped to fit). */
function chunkSizesCycle(pattern: number[], total: number): number[] {
  const sizes: number[] = [];
  let remaining = total;
  let idx = 0;
  while (remaining > 0) {
    const size = Math.min(pattern[idx % pattern.length]!, remaining);
    sizes.push(size);
    remaining -= size;
    idx++;
  }
  return sizes;
}

/** Feeds `input` through `instance.process` in the given chunk sizes; returns the concatenated
 *  output plus the per-chunk output length (needed to locate boundary sample indices). */
function processChunked(
  instance: { process(x: Int16Array): Int16Array },
  input: Int16Array,
  sizes: number[],
): { out: Int16Array; chunkOutLens: number[] } {
  const outs: Int16Array[] = [];
  const chunkOutLens: number[] = [];
  let offset = 0;
  for (const size of sizes) {
    const chunk = input.subarray(offset, offset + size);
    offset += size;
    const y = instance.process(chunk);
    outs.push(y);
    chunkOutLens.push(y.length);
  }
  return { out: concatInt16(outs), chunkOutLens };
}

/** Asserts the max |y[i]-y[i-1]| at chunk boundaries does not exceed the max within-chunk jump
 *  (findings/06 C6 failure signature: stateless processing measured 7995 boundary vs 2339 within). */
function assertNoBoundaryClick(out: Int16Array, chunkOutLens: number[]): void {
  const boundaryIdx = new Set<number>();
  let cum = 0;
  for (const len of chunkOutLens) {
    if (cum > 0 && len > 0) boundaryIdx.add(cum);
    cum += len;
  }
  let maxBoundary = 0;
  let maxWithin = 0;
  for (let i = 1; i < out.length; i++) {
    const d = Math.abs(out[i]! - out[i - 1]!);
    if (boundaryIdx.has(i)) {
      if (d > maxBoundary) maxBoundary = d;
    } else if (d > maxWithin) {
      maxWithin = d;
    }
  }
  expect(maxBoundary <= maxWithin, `chunk-boundary click detected: maxBoundary=${maxBoundary} > maxWithin=${maxWithin}`).toBeTruthy();
}

const RAGGED_CHUNK_PATTERN = [100, 333, 481, 7, 480, 1000];

describe('Upsampler3x / Downsampler3x chunked-vs-oneshot bit-identity (R12.3 / A6)', () => {
  const oneSecUp = generateSine(1000, 8000, 8000, 8000); // 1 s @ 8 kHz
  const oneSecDown = generateSine(1000, 8000, 24000, 24000); // 1 s @ 24 kHz

  it('Upsampler3x: 160-sample chunks are bit-identical to one-shot', () => {
    const oneshot = new Upsampler3x().process(oneSecUp);
    const sizes = chunkSizesCycle([160], oneSecUp.length);
    const { out } = processChunked(new Upsampler3x(), oneSecUp, sizes);
    expect(maxAbsDiff(oneshot, out)).toBe(0);
  });

  it('Upsampler3x: ragged chunks are bit-identical to one-shot', () => {
    const oneshot = new Upsampler3x().process(oneSecUp);
    const sizes = chunkSizesCycle(RAGGED_CHUNK_PATTERN, oneSecUp.length);
    const { out } = processChunked(new Upsampler3x(), oneSecUp, sizes);
    expect(maxAbsDiff(oneshot, out)).toBe(0);
  });

  it('Downsampler3x: 160-sample chunks are bit-identical to one-shot', () => {
    const oneshot = new Downsampler3x().process(oneSecDown);
    const sizes = chunkSizesCycle([160], oneSecDown.length);
    const { out } = processChunked(new Downsampler3x(), oneSecDown, sizes);
    expect(maxAbsDiff(oneshot, out)).toBe(0);
  });

  it('Downsampler3x: ragged (non-multiple-of-3) chunks are bit-identical to one-shot', () => {
    const oneshot = new Downsampler3x().process(oneSecDown);
    const sizes = chunkSizesCycle(RAGGED_CHUNK_PATTERN, oneSecDown.length);
    const { out } = processChunked(new Downsampler3x(), oneSecDown, sizes);
    expect(maxAbsDiff(oneshot, out)).toBe(0);
  });
});

describe('Boundary-continuity / click detector (R12.4)', () => {
  it('Upsampler3x: chunk-boundary jumps do not exceed within-chunk jumps', () => {
    const sine = generateSine(440, 8000, 8000, 8000); // 1 s @ 8 kHz
    const sizes = chunkSizesCycle([160], sine.length);
    const { out, chunkOutLens } = processChunked(new Upsampler3x(), sine, sizes);
    assertNoBoundaryClick(out, chunkOutLens);
  });

  it('Downsampler3x: chunk-boundary jumps do not exceed within-chunk jumps', () => {
    const sine = generateSine(440, 8000, 24000, 24000); // 1 s @ 24 kHz
    const sizes = chunkSizesCycle([160], sine.length);
    const { out, chunkOutLens } = processChunked(new Downsampler3x(), sine, sizes);
    assertNoBoundaryClick(out, chunkOutLens);
  });
});

describe('Ragged/degenerate inputs (R12.9 resampler half)', () => {
  it('Upsampler3x: zero-length input yields zero-length output without corrupting state', () => {
    const sine = generateSine(1000, 8000, 480, 8000);
    const a = new Upsampler3x();
    const outA1 = a.process(sine.subarray(0, 160));
    const outA2 = a.process(sine.subarray(160, 320));

    const b = new Upsampler3x();
    const outB1 = b.process(sine.subarray(0, 160));
    const empty = b.process(new Int16Array(0));
    const outB2 = b.process(sine.subarray(160, 320));

    expect(empty.length).toBe(0);
    expect(maxAbsDiff(outA1, outB1)).toBe(0);
    expect(maxAbsDiff(outA2, outB2)).toBe(0);
  });

  it('Downsampler3x: zero-length input yields zero-length output without corrupting state', () => {
    const sine = generateSine(1000, 8000, 480, 24000);
    const a = new Downsampler3x();
    const outA1 = a.process(sine.subarray(0, 160));
    const outA2 = a.process(sine.subarray(160, 320));

    const b = new Downsampler3x();
    const outB1 = b.process(sine.subarray(0, 160));
    const empty = b.process(new Int16Array(0));
    const outB2 = b.process(sine.subarray(160, 320));

    expect(empty.length).toBe(0);
    expect(maxAbsDiff(outA1, outB1)).toBe(0);
    expect(maxAbsDiff(outA2, outB2)).toBe(0);
  });
});

describe('Structural contract (A7 resampler half)', () => {
  it("'reset' is not in Upsampler3x.prototype (never reset mid-call, R11.1)", () => {
    expect('reset' in Upsampler3x.prototype).toBe(false);
  });

  it('Downsampler3x.prototype.reset is a function', () => {
    expect(typeof Downsampler3x.prototype.reset).toBe('function');
  });

  it('after down.reset(), processing a chunk equals a freshly constructed instance (R11.3: zero history = start-from-silence)', () => {
    const sine = generateSine(1000, 8000, 480, 24000);
    const down = new Downsampler3x();
    down.process(sine.subarray(0, 300)); // dirty the history + phase counter
    down.reset();
    const afterReset = down.process(sine.subarray(300, 480));

    const fresh = new Downsampler3x();
    const freshOut = fresh.process(sine.subarray(300, 480));

    expect(maxAbsDiff(afterReset, freshOut)).toBe(0);
  });
});

describe('Frame-length sanity (R12.8 remainder)', () => {
  it('new Upsampler3x().process(new Int16Array(160)).length === 480', () => {
    expect(new Upsampler3x().process(new Int16Array(160)).length).toBe(480);
  });
});

// ---- T06.3 test helpers (base64 <-> typed-array conversions matching the wrapper mechanics) ----

/** `Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64')`
 *  (findings/06 C9 — LE Int16Array views round-trip base64 exactly). */
function base64FromInt16(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

function base64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function muLawEncodeBytes(pcm: Int16Array): Uint8Array {
  const mu = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) mu[i] = MULAW_ENC[pcm[i]! & 0xffff]!;
  return mu;
}

describe('audioFormatsFor (R2 / A3)', () => {
  it('pcmu format objects carry NO rate field in either direction', () => {
    const formats = audioFormatsFor('pcmu');
    expect('rate' in formats.inputAudioFormat).toBe(false);
    expect('rate' in formats.outputAudioFormat).toBe(false);
    expect(formats.inputAudioFormat.type).toBe('audio/pcmu');
    expect(formats.outputAudioFormat.type).toBe('audio/pcmu');
    expect(JSON.stringify(formats).includes('"rate"')).toBe(false);
  });

  it('transcode format objects carry rate: 24000 in both directions, type audio/pcm', () => {
    const formats = audioFormatsFor('transcode');
    expect(formats.inputAudioFormat.type).toBe('audio/pcm');
    expect(formats.outputAudioFormat.type).toBe('audio/pcm');
    expect(formats.inputAudioFormat.rate).toBe(24000);
    expect(formats.outputAudioFormat.rate).toBe(24000);
    const serialized = JSON.stringify(formats);
    const rateOccurrences = serialized.match(/"rate":24000/g) ?? [];
    expect(rateOccurrences.length).toBe(2);
  });
});

describe('createTranscoder Path A (pcmu) — zero-copy passthrough (R4, R12.7, A5)', () => {
  it('twilioToGateway and gatewayToTwilio return the exact same string (identity, not just value)', () => {
    const t = createTranscoder('pcmu');
    const s = 'AAAA////deadBEEF0011==';
    expect(t.twilioToGateway(s)).toBe(s);
    expect(t.gatewayToTwilio(s)).toBe(s);
  });

  it('mode is pcmu and resetOutbound() does not throw (no-op)', () => {
    const t = createTranscoder('pcmu');
    expect(t.mode).toBe('pcmu');
    expect(() => t.resetOutbound()).not.toThrow();
  });
});

describe('createTranscoder Path B (transcode) — wrapper correctness (R9, findings/06 gotcha 7, C11)', () => {
  it('twilioToGateway: a 160-byte mu-law frame (encoded 20 ms 1 kHz sine) yields a 1280-char base64 delta bit-identical to direct table+resampler processing', () => {
    const sinePcm8 = generateSine(1000, 8000, MULAW_BYTES_PER_20MS, 8000);
    const muBytes = muLawEncodeBytes(sinePcm8);
    expect(muBytes.length).toBe(MULAW_BYTES_PER_20MS);
    const payloadB64 = base64FromBytes(muBytes);

    const t = createTranscoder('transcode');
    const outB64 = t.twilioToGateway(payloadB64);
    expect(outB64.length).toBe(PCM24K_B64_CHARS_PER_20MS);

    // Reference: decode the same mu-law bytes and run through a directly-constructed
    // Upsampler3x — the wrapper must add no header bytes / re-framing (gotcha 7, C11).
    const refPcm8 = new Int16Array(muBytes.length);
    for (let i = 0; i < muBytes.length; i++) refPcm8[i] = MULAW_DEC[muBytes[i]!]!;
    const refPcm24 = new Upsampler3x().process(refPcm8);
    expect(outB64).toBe(base64FromInt16(refPcm24));
  });

  it('gatewayToTwilio: a 960-byte PCM16LE base64 delta (20 ms @ 24 kHz) yields a 216-char base64 mu-law payload bit-identical to direct resampler+table processing', () => {
    const sinePcm24 = generateSine(1000, 8000, PCM24K_SAMPLES_PER_20MS, 24000);
    const deltaB64 = base64FromInt16(sinePcm24);

    const t = createTranscoder('transcode');
    const outB64 = t.gatewayToTwilio(deltaB64);
    expect(outB64.length).toBe(MULAW_B64_CHARS_PER_20MS);

    const refPcm8 = new Downsampler3x().process(sinePcm24);
    expect(outB64).toBe(base64FromBytes(muLawEncodeBytes(refPcm8)));
  });
});

describe('gatewayToTwilio odd-byte-length fallback (R12.9 wrapper half, R9 hard rules)', () => {
  it('an odd-byte-length delta exercises the copy fallback without throwing, and the following even-length delta is still bit-identical to direct processing (state intact)', () => {
    const sine24 = generateSine(1000, 8000, PCM24K_SAMPLES_PER_20MS * 2, 24000);
    const firstChunk = sine24.subarray(0, PCM24K_SAMPLES_PER_20MS);
    const secondChunk = sine24.subarray(PCM24K_SAMPLES_PER_20MS, PCM24K_SAMPLES_PER_20MS * 2);

    const firstBuf = Buffer.from(firstChunk.buffer, firstChunk.byteOffset, firstChunk.byteLength);
    const oddBuf = Buffer.concat([firstBuf, Buffer.from([0x00])]); // trailing extra byte -> odd length
    expect(oddBuf.byteLength % 2, 'sanity: fixture delta must have odd byte length').toBe(1);
    const oddDeltaB64 = oddBuf.toString('base64');
    const secondDeltaB64 = base64FromInt16(secondChunk);

    const t = createTranscoder('transcode');
    let firstOutB64 = '';
    let secondOutB64 = '';
    expect(() => {
      firstOutB64 = t.gatewayToTwilio(oddDeltaB64);
    }).not.toThrow();
    expect(() => {
      secondOutB64 = t.gatewayToTwilio(secondDeltaB64);
    }).not.toThrow();

    const refDown = new Downsampler3x();
    const refOut1 = refDown.process(firstChunk); // odd delta's trailing byte is dropped -> same 480 samples
    const refOut2 = refDown.process(secondChunk);

    expect(firstOutB64).toBe(base64FromBytes(muLawEncodeBytes(refOut1)));
    expect(secondOutB64).toBe(base64FromBytes(muLawEncodeBytes(refOut2)));
  });
});

describe('Transcoder.resetOutbound (transcode mode) — R11 / A7', () => {
  it('resetOutbound() makes the next gatewayToTwilio output equal a fresh instance output for the same delta (delegates to down.reset())', () => {
    const sine24 = generateSine(1000, 8000, PCM24K_SAMPLES_PER_20MS, 24000);
    const deltaB64 = base64FromInt16(sine24);

    const t = createTranscoder('transcode');
    t.gatewayToTwilio(deltaB64); // dirty outbound history + phase counter
    t.resetOutbound();
    const afterReset = t.gatewayToTwilio(deltaB64);

    const fresh = createTranscoder('transcode');
    const freshOut = fresh.gatewayToTwilio(deltaB64);

    expect(afterReset).toBe(freshOut);
  });

  it('resetOutbound() leaves inbound (twilioToGateway) continuity unaffected — the inbound upsampler is never reset (R11.1)', () => {
    const sinePcm8 = generateSine(1000, 8000, MULAW_BYTES_PER_20MS, 8000);
    const payloadB64 = base64FromBytes(muLawEncodeBytes(sinePcm8));

    const t = createTranscoder('transcode');
    const in1 = t.twilioToGateway(payloadB64); // primes inbound history
    t.resetOutbound(); // must touch ONLY the outbound downsampler
    const in2 = t.twilioToGateway(payloadB64); // second chunk: inbound history from in1 must still apply

    const freshFirstChunk = createTranscoder('transcode').twilioToGateway(payloadB64);

    // in1 is itself a fresh-instance first chunk (no inbound history yet):
    expect(in1).toBe(freshFirstChunk);
    // in2 carries real inbound history across the resetOutbound() call, so it must differ
    // from what a fresh (no-history) first chunk would produce for the identical payload —
    // if resetOutbound() had incorrectly reset the inbound upsampler too, in2 would equal
    // freshFirstChunk exactly.
    expect(in2).not.toBe(freshFirstChunk);
  });
});

// ---- T06.4: tone-fidelity (THD+N) projection test + per-frame perf guard ----
// Verbatim methodology per Spec 06 R12.5/R12.6 and findings/06 §Test strategy tests 4 & 6,
// §C10, §C12, gotcha 8. Deterministic fixed-frequency sines only, no RNG.

describe('Tone fidelity — least-squares projection THD+N (R12.5 / A1)', () => {
  const AMPLITUDE = 8000;
  const FS_8K = 8000;
  // 0.5 s @ 8 kHz: even the lowest test tone (300 Hz) gets 150 full cycles, far more than
  // enough for a stable least-squares fit; short enough to keep the suite fast.
  const N8K = 4000;
  // Skip the filter warm-up head before projecting: the 48-tap cascade's impulse response
  // settles within ~16 samples per stage (upsample + downsample), so 50 samples @8k is a
  // generous margin (findings/06 §Test strategy test 4: "skip the steady-state region").
  const WARMUP_8K = 50;

  for (const freqHz of [300, 1000, 2000, 3000]) {
    it(`f=${freqHz} Hz: THD+N >= 60 dB after fresh 8k->24k->8k round trip`, () => {
      const input = generateSine(freqHz, AMPLITUDE, N8K, FS_8K);
      // Fresh instances per Spec 06 R12.5 — no state carried in from other tests.
      const up = new Upsampler3x();
      const down = new Downsampler3x();
      const pcm24 = up.process(input);
      const roundTripped = down.process(pcm24);

      const steady = roundTripped.subarray(WARMUP_8K);
      const { amplitude, thdnDb } = projectTone(steady, freqHz, FS_8K);

      expect(thdnDb >= 60, `THD+N ${thdnDb.toFixed(1)} dB is below the 60 dB floor at ${freqHz} Hz (Spec 06 R12.5)`).toBeTruthy();

      // Gain check applies only below 3000 Hz per Spec 06 R12.5 (the combined cascade's
      // -0.4 dB/stage rolloff right at 3 kHz is measured/expected — findings/06 C12).
      if (freqHz < 3000) {
        const gainDb = 20 * Math.log10(amplitude / AMPLITUDE);
        expect(Math.abs(gainDb) <= 1, `gain ${gainDb.toFixed(2)} dB exceeds +/-1 dB at ${freqHz} Hz (Spec 06 R12.5)`).toBeTruthy();
      }
    });
  }
});

describe('Per-frame perf budget — full production round trip (R12.6 / A1)', () => {
  it('twilioToGateway + gatewayToTwilio on one createTranscoder("transcode") instance average < 500 microseconds per frame', () => {
    const sinePcm8 = generateSine(1000, 8000, MULAW_BYTES_PER_20MS, 8000);
    const inboundPayloadB64 = base64FromBytes(muLawEncodeBytes(sinePcm8));

    const sinePcm24 = generateSine(1000, 8000, PCM24K_SAMPLES_PER_20MS, 24000);
    const outboundDeltaB64 = base64FromInt16(sinePcm24);

    // One instance owns both directions' state, exactly as Spec 05 wires it per-call
    // (Spec 06 R12.6: "full production round trip ... using one createTranscoder instance").
    const t = createTranscoder('transcode');

    const WARMUP_ITERATIONS = 200;
    const TIMED_ITERATIONS = 2000;

    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      t.twilioToGateway(inboundPayloadB64);
      t.gatewayToTwilio(outboundDeltaB64);
    }

    const start = performance.now();
    for (let i = 0; i < TIMED_ITERATIONS; i++) {
      t.twilioToGateway(inboundPayloadB64);
      t.gatewayToTwilio(outboundDeltaB64);
    }
    const elapsedMs = performance.now() - start;
    const usPerFrame = (elapsedMs * 1000) / TIMED_ITERATIONS;

    // Recorded for the M5/S26 ledger row (Railway shared-vCPU multiplier vs this desktop
    // baseline) — findings/06 C10 measured 21.4 us/frame; the 500 us budget is a ~23x
    // margin absorbing CI/shared-vCPU variance (Spec 06 R12.6, master plan T5/S26).
    console.log(`[T06.4 perf] measured mean round trip: ${usPerFrame.toFixed(2)} us/frame`);

    expect(usPerFrame < 500, `measured ${usPerFrame.toFixed(2)} us/frame exceeds the 500 us/frame budget (Spec 06 R12.6)`).toBeTruthy();
  });
});

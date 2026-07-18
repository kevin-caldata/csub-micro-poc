import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
} from './dsp.js';

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
      assert.equal(MULAW_DEC[b], refMuLawDecodeSample(b) || 0, `mismatch at code ${b}`);
    }
  });
  it('has 256 entries', () => {
    assert.equal(MULAW_DEC.length, 256);
  });
  it('MULAW_DEC[0xFF] === 0', () => {
    assert.equal(MULAW_DEC[0xff], 0);
  });
  it('table extremes reach +/-32124', () => {
    let min = 0, max = 0;
    for (let b = 0; b < 256; b++) {
      if (MULAW_DEC[b] < min) min = MULAW_DEC[b];
      if (MULAW_DEC[b] > max) max = MULAW_DEC[b];
    }
    assert.equal(max, 32124);
    assert.equal(min, -32124);
  });
});

describe('MULAW_ENC (R12.2)', () => {
  it('has 65536 entries', () => {
    assert.equal(MULAW_ENC.length, 65536);
  });
  it('round-trips MULAW_ENC[MULAW_DEC[b] & 0xffff] === b for all codes except 0x7F -> 0xFF', () => {
    for (let b = 0; b < 256; b++) {
      const roundTripped = MULAW_ENC[MULAW_DEC[b] & 0xffff];
      if (b === 0x7f) {
        assert.equal(roundTripped, 0xff, 'the sole documented exception: 0x7F must map to 0xFF');
      } else {
        assert.equal(roundTripped, b, `round-trip mismatch at code ${b}`);
      }
    }
  });
});

describe('Frame-math constants (R10 / R12.8 constants half)', () => {
  it('matches exact Spec 06 R10 values', () => {
    assert.equal(FRAME_MS, 20);
    assert.equal(MULAW_BYTES_PER_20MS, 160);
    assert.equal(MULAW_B64_CHARS_PER_20MS, 216);
    assert.equal(PCM24K_SAMPLES_PER_20MS, 480);
    assert.equal(PCM24K_BYTES_PER_20MS, 960);
    assert.equal(PCM24K_B64_CHARS_PER_20MS, 1280);
  });
  it('base64 of a 160-byte buffer has length 216', () => {
    assert.equal(Buffer.alloc(160).toString('base64').length, 216);
    assert.equal(Buffer.alloc(MULAW_BYTES_PER_20MS).toString('base64').length, MULAW_B64_CHARS_PER_20MS);
  });
  it('base64 of a 960-byte buffer has length 1280', () => {
    assert.equal(Buffer.alloc(960).toString('base64').length, 1280);
    assert.equal(Buffer.alloc(PCM24K_BYTES_PER_20MS).toString('base64').length, PCM24K_B64_CHARS_PER_20MS);
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
  assert.equal(a.length, b.length, 'compared arrays must have equal length');
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
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
  assert.ok(
    maxBoundary <= maxWithin,
    `chunk-boundary click detected: maxBoundary=${maxBoundary} > maxWithin=${maxWithin}`,
  );
}

const RAGGED_CHUNK_PATTERN = [100, 333, 481, 7, 480, 1000];

describe('Upsampler3x / Downsampler3x chunked-vs-oneshot bit-identity (R12.3 / A6)', () => {
  const oneSecUp = generateSine(1000, 8000, 8000, 8000); // 1 s @ 8 kHz
  const oneSecDown = generateSine(1000, 8000, 24000, 24000); // 1 s @ 24 kHz

  it('Upsampler3x: 160-sample chunks are bit-identical to one-shot', () => {
    const oneshot = new Upsampler3x().process(oneSecUp);
    const sizes = chunkSizesCycle([160], oneSecUp.length);
    const { out } = processChunked(new Upsampler3x(), oneSecUp, sizes);
    assert.equal(maxAbsDiff(oneshot, out), 0);
  });

  it('Upsampler3x: ragged chunks are bit-identical to one-shot', () => {
    const oneshot = new Upsampler3x().process(oneSecUp);
    const sizes = chunkSizesCycle(RAGGED_CHUNK_PATTERN, oneSecUp.length);
    const { out } = processChunked(new Upsampler3x(), oneSecUp, sizes);
    assert.equal(maxAbsDiff(oneshot, out), 0);
  });

  it('Downsampler3x: 160-sample chunks are bit-identical to one-shot', () => {
    const oneshot = new Downsampler3x().process(oneSecDown);
    const sizes = chunkSizesCycle([160], oneSecDown.length);
    const { out } = processChunked(new Downsampler3x(), oneSecDown, sizes);
    assert.equal(maxAbsDiff(oneshot, out), 0);
  });

  it('Downsampler3x: ragged (non-multiple-of-3) chunks are bit-identical to one-shot', () => {
    const oneshot = new Downsampler3x().process(oneSecDown);
    const sizes = chunkSizesCycle(RAGGED_CHUNK_PATTERN, oneSecDown.length);
    const { out } = processChunked(new Downsampler3x(), oneSecDown, sizes);
    assert.equal(maxAbsDiff(oneshot, out), 0);
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

    assert.equal(empty.length, 0);
    assert.equal(maxAbsDiff(outA1, outB1), 0);
    assert.equal(maxAbsDiff(outA2, outB2), 0);
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

    assert.equal(empty.length, 0);
    assert.equal(maxAbsDiff(outA1, outB1), 0);
    assert.equal(maxAbsDiff(outA2, outB2), 0);
  });
});

describe('Structural contract (A7 resampler half)', () => {
  it("'reset' is not in Upsampler3x.prototype (never reset mid-call, R11.1)", () => {
    assert.equal('reset' in Upsampler3x.prototype, false);
  });

  it('Downsampler3x.prototype.reset is a function', () => {
    assert.equal(typeof Downsampler3x.prototype.reset, 'function');
  });

  it('after down.reset(), processing a chunk equals a freshly constructed instance (R11.3: zero history = start-from-silence)', () => {
    const sine = generateSine(1000, 8000, 480, 24000);
    const down = new Downsampler3x();
    down.process(sine.subarray(0, 300)); // dirty the history + phase counter
    down.reset();
    const afterReset = down.process(sine.subarray(300, 480));

    const fresh = new Downsampler3x();
    const freshOut = fresh.process(sine.subarray(300, 480));

    assert.equal(maxAbsDiff(afterReset, freshOut), 0);
  });
});

describe('Frame-length sanity (R12.8 remainder)', () => {
  it('new Upsampler3x().process(new Int16Array(160)).length === 480', () => {
    assert.equal(new Upsampler3x().process(new Int16Array(160)).length, 480);
  });
});

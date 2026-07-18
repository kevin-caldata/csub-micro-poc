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
  audioFormatsFor,
  createTranscoder,
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
    assert.equal('rate' in formats.inputAudioFormat, false);
    assert.equal('rate' in formats.outputAudioFormat, false);
    assert.equal(formats.inputAudioFormat.type, 'audio/pcmu');
    assert.equal(formats.outputAudioFormat.type, 'audio/pcmu');
    assert.equal(JSON.stringify(formats).includes('"rate"'), false);
  });

  it('transcode format objects carry rate: 24000 in both directions, type audio/pcm', () => {
    const formats = audioFormatsFor('transcode');
    assert.equal(formats.inputAudioFormat.type, 'audio/pcm');
    assert.equal(formats.outputAudioFormat.type, 'audio/pcm');
    assert.equal(formats.inputAudioFormat.rate, 24000);
    assert.equal(formats.outputAudioFormat.rate, 24000);
    const serialized = JSON.stringify(formats);
    const rateOccurrences = serialized.match(/"rate":24000/g) ?? [];
    assert.equal(rateOccurrences.length, 2);
  });
});

describe('createTranscoder Path A (pcmu) — zero-copy passthrough (R4, R12.7, A5)', () => {
  it('twilioToGateway and gatewayToTwilio return the exact same string (identity, not just value)', () => {
    const t = createTranscoder('pcmu');
    const s = 'AAAA////deadBEEF0011==';
    assert.strictEqual(t.twilioToGateway(s), s);
    assert.strictEqual(t.gatewayToTwilio(s), s);
  });

  it('mode is pcmu and resetOutbound() does not throw (no-op)', () => {
    const t = createTranscoder('pcmu');
    assert.equal(t.mode, 'pcmu');
    assert.doesNotThrow(() => t.resetOutbound());
  });
});

describe('createTranscoder Path B (transcode) — wrapper correctness (R9, findings/06 gotcha 7, C11)', () => {
  it('twilioToGateway: a 160-byte mu-law frame (encoded 20 ms 1 kHz sine) yields a 1280-char base64 delta bit-identical to direct table+resampler processing', () => {
    const sinePcm8 = generateSine(1000, 8000, MULAW_BYTES_PER_20MS, 8000);
    const muBytes = muLawEncodeBytes(sinePcm8);
    assert.equal(muBytes.length, MULAW_BYTES_PER_20MS);
    const payloadB64 = base64FromBytes(muBytes);

    const t = createTranscoder('transcode');
    const outB64 = t.twilioToGateway(payloadB64);
    assert.equal(outB64.length, PCM24K_B64_CHARS_PER_20MS);

    // Reference: decode the same mu-law bytes and run through a directly-constructed
    // Upsampler3x — the wrapper must add no header bytes / re-framing (gotcha 7, C11).
    const refPcm8 = new Int16Array(muBytes.length);
    for (let i = 0; i < muBytes.length; i++) refPcm8[i] = MULAW_DEC[muBytes[i]!]!;
    const refPcm24 = new Upsampler3x().process(refPcm8);
    assert.equal(outB64, base64FromInt16(refPcm24));
  });

  it('gatewayToTwilio: a 960-byte PCM16LE base64 delta (20 ms @ 24 kHz) yields a 216-char base64 mu-law payload bit-identical to direct resampler+table processing', () => {
    const sinePcm24 = generateSine(1000, 8000, PCM24K_SAMPLES_PER_20MS, 24000);
    const deltaB64 = base64FromInt16(sinePcm24);

    const t = createTranscoder('transcode');
    const outB64 = t.gatewayToTwilio(deltaB64);
    assert.equal(outB64.length, MULAW_B64_CHARS_PER_20MS);

    const refPcm8 = new Downsampler3x().process(sinePcm24);
    assert.equal(outB64, base64FromBytes(muLawEncodeBytes(refPcm8)));
  });
});

describe('gatewayToTwilio odd-byte-length fallback (R12.9 wrapper half, R9 hard rules)', () => {
  it('an odd-byte-length delta exercises the copy fallback without throwing, and the following even-length delta is still bit-identical to direct processing (state intact)', () => {
    const sine24 = generateSine(1000, 8000, PCM24K_SAMPLES_PER_20MS * 2, 24000);
    const firstChunk = sine24.subarray(0, PCM24K_SAMPLES_PER_20MS);
    const secondChunk = sine24.subarray(PCM24K_SAMPLES_PER_20MS, PCM24K_SAMPLES_PER_20MS * 2);

    const firstBuf = Buffer.from(firstChunk.buffer, firstChunk.byteOffset, firstChunk.byteLength);
    const oddBuf = Buffer.concat([firstBuf, Buffer.from([0x00])]); // trailing extra byte -> odd length
    assert.equal(oddBuf.byteLength % 2, 1, 'sanity: fixture delta must have odd byte length');
    const oddDeltaB64 = oddBuf.toString('base64');
    const secondDeltaB64 = base64FromInt16(secondChunk);

    const t = createTranscoder('transcode');
    let firstOutB64 = '';
    let secondOutB64 = '';
    assert.doesNotThrow(() => {
      firstOutB64 = t.gatewayToTwilio(oddDeltaB64);
    });
    assert.doesNotThrow(() => {
      secondOutB64 = t.gatewayToTwilio(secondDeltaB64);
    });

    const refDown = new Downsampler3x();
    const refOut1 = refDown.process(firstChunk); // odd delta's trailing byte is dropped -> same 480 samples
    const refOut2 = refDown.process(secondChunk);

    assert.equal(firstOutB64, base64FromBytes(muLawEncodeBytes(refOut1)));
    assert.equal(secondOutB64, base64FromBytes(muLawEncodeBytes(refOut2)));
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

    assert.equal(afterReset, freshOut);
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
    assert.equal(in1, freshFirstChunk);
    // in2 carries real inbound history across the resetOutbound() call, so it must differ
    // from what a fresh (no-history) first chunk would produce for the identical payload —
    // if resetOutbound() had incorrectly reset the inbound upsampler too, in2 would equal
    // freshFirstChunk exactly.
    assert.notEqual(in2, freshFirstChunk);
  });
});

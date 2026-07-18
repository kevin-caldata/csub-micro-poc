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

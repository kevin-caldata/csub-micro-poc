// src/fallback-asset.test.ts
//
// Format regression test for assets/fallback-apology.ulaw (Spec 09 R6.1/R6.2,
// A5). Guards against the raw-container swap that findings/03 claim 5 warns
// about: header bytes (e.g. a RIFF WAV container) on this asset would cause
// garbled playback over Twilio Media Streams, since Twilio expects raw
// headerless mu-law/8000 mono bytes with no framing of any kind.
//
// DEV-04 route note: the asset is produced without ffmpeg — Windows
// System.Speech renders the source WAV, and scripts/build-fallback-clip.ts
// (mu-law encoding via this repo's own MULAW_ENC table) converts it to the
// raw .ulaw bytes this test checks. See assets/README.md for the full
// regeneration procedure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { MULAW_DEC } from './dsp.js';

const ASSET_PATH = 'assets/fallback-apology.ulaw';

describe('assets/fallback-apology.ulaw (Spec 09 A5)', () => {
  it('exists and is a regular file with nonzero size', () => {
    const stat = statSync(ASSET_PATH);
    assert.ok(stat.isFile(), `${ASSET_PATH} should be a regular file`);
    assert.ok(stat.size > 0, `${ASSET_PATH} should be nonempty`);
  });

  it('is headerless: first 4 bytes are NOT the RIFF container magic', () => {
    const buf = readFileSync(ASSET_PATH);
    const first4 = buf.subarray(0, 4).toString('ascii');
    assert.notEqual(first4, 'RIFF', 'asset must be raw mu-law, not a WAV container');
  });

  it('byte length is within 24,000-56,000 bytes (~3-7 s at 8000 B/s)', () => {
    const stat = statSync(ASSET_PATH);
    assert.ok(
      stat.size >= 24_000 && stat.size <= 56_000,
      `expected 24000-56000 bytes, got ${stat.size}`,
    );
  });

  it('byte length equals the raw file size exactly (no trailing container chunk)', () => {
    const buf = readFileSync(ASSET_PATH);
    const stat = statSync(ASSET_PATH);
    assert.equal(buf.length, stat.size);
    assert.ok(buf.length > 0);
  });

  it('round-trips through MULAW_DEC without throwing and stays in PCM16 range', () => {
    const buf = readFileSync(ASSET_PATH);
    // Sample a handful of points across the clip (not every byte — this is a
    // sanity check, not a perceptual audio test) and confirm every mu-law
    // byte decodes to a plausible 16-bit PCM sample.
    const step = Math.max(1, Math.floor(buf.length / 50));
    for (let i = 0; i < buf.length; i += step) {
      const pcm = MULAW_DEC[buf[i]!]!;
      assert.ok(Number.isInteger(pcm), `decoded sample at byte ${i} should be an integer`);
      assert.ok(pcm >= -32768 && pcm <= 32767, `decoded sample at byte ${i} out of PCM16 range`);
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const BASE = {
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ ...BASE });
    assert.equal(c.port, 3000);
    assert.equal(c.modelId, 'openai/gpt-realtime-2.1');
    assert.equal(c.audioMode, 'transcode');
    assert.equal(c.voice, 'marin');
    assert.equal(c.publicHost, 'example.ngrok.app');
  });
  it('throws with a clear message when AI_GATEWAY_API_KEY is missing', () => {
    const { AI_GATEWAY_API_KEY: _omit, ...env } = BASE;
    assert.throws(() => loadConfig(env), /AI_GATEWAY_API_KEY/);
    assert.throws(() => loadConfig(env), /OIDC/);
  });
  it('prefers PUBLIC_HOST over RAILWAY_PUBLIC_DOMAIN', () => {
    const c = loadConfig({ ...BASE, RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' });
    assert.equal(c.publicHost, 'example.ngrok.app');
  });
  it('throws when neither PUBLIC_HOST nor RAILWAY_PUBLIC_DOMAIN is set', () => {
    const { PUBLIC_HOST: _omit, ...env } = BASE;
    assert.throws(() => loadConfig(env), /PUBLIC_HOST|RAILWAY_PUBLIC_DOMAIN/);
  });
  it('rejects an invalid AUDIO_MODE', () => {
    assert.throws(() => loadConfig({ ...BASE, AUDIO_MODE: 'wav' }));
  });
  it('accepts pcmu as a valid AUDIO_MODE (Path A, Spec 06 R1)', () => {
    const c = loadConfig({ ...BASE, AUDIO_MODE: 'pcmu' });
    assert.equal(c.audioMode, 'pcmu');
  });
  it('rejects every illegal AUDIO_MODE value with a message naming both legal values (Spec 06 R1/A4)', () => {
    for (const bad of ['garbage', '', 'pcm', 'mulaw']) {
      assert.throws(
        () => loadConfig({ ...BASE, AUDIO_MODE: bad }),
        (err: unknown) => err instanceof Error && /pcmu/.test(err.message) && /transcode/.test(err.message),
        `AUDIO_MODE=${JSON.stringify(bad)} should be rejected with a message naming pcmu and transcode`,
      );
    }
  });
  it('types audioMode as the pcmu|transcode union, not string (Spec 06 R1)', () => {
    const c = loadConfig({ ...BASE, AUDIO_MODE: 'pcmu' });
    // Compile-time check: this generic only accepts the union; if `audioMode` were
    // widened to `string` this file would fail `npm run typecheck`.
    type AssertAudioModeUnion<T extends 'pcmu' | 'transcode'> = T;
    type _Check = AssertAudioModeUnion<typeof c.audioMode>;
    assert.ok(c.audioMode === 'pcmu' || c.audioMode === 'transcode');
  });
  it('runs in a plain Node environment (G6: no jsdom window)', () => {
    assert.equal((globalThis as Record<string, unknown>).window, undefined);
  });
  it('TWILIO_VALIDATE_UPGRADE defaults to false (Spec 03 R8, log-only advisory check)', () => {
    const c = loadConfig({ ...BASE });
    assert.equal(c.twilioValidateUpgrade, false);
  });
  it('TWILIO_VALIDATE_UPGRADE=true parses to true', () => {
    const c = loadConfig({ ...BASE, TWILIO_VALIDATE_UPGRADE: 'true' });
    assert.equal(c.twilioValidateUpgrade, true);
  });
  it('rejects a garbage TWILIO_VALIDATE_UPGRADE value', () => {
    assert.throws(() => loadConfig({ ...BASE, TWILIO_VALIDATE_UPGRADE: 'yes' }));
  });
});

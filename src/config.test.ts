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
  it('runs in a plain Node environment (G6: no jsdom window)', () => {
    assert.equal((globalThis as Record<string, unknown>).window, undefined);
  });
});

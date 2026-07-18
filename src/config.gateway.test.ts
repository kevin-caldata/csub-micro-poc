import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const BASE = {
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
};

describe('loadConfig — Spec 04 R2 gateway keys', () => {
  it('applies defaults for all nine new fields when unset', () => {
    const c = loadConfig({ ...BASE });
    assert.equal(c.voiceFallback, 'alloy');
    assert.equal(c.vadSilenceMs, 500);
    assert.equal(c.vadThreshold, 0.5);
    assert.equal(c.vadPrefixPaddingMs, 300);
    assert.equal(c.tokenTtlSeconds, 600);
    assert.equal(c.gatewayHandshakeTimeoutMs, 5000);
    assert.equal(c.gatewayPingSeconds, 0);
    assert.equal(c.waitForSessionUpdated, false);
    assert.equal(c.gatewayTags, undefined);
  });

  it('coerces string ints', () => {
    const c = loadConfig({ ...BASE, VAD_SILENCE_MS: '400' });
    assert.equal(c.vadSilenceMs, 400);
  });

  it('rejects VAD_THRESHOLD outside 0.0-1.0', () => {
    assert.throws(
      () => loadConfig({ ...BASE, VAD_THRESHOLD: '1.5' }),
      /Invalid environment configuration/,
    );
    assert.throws(
      () => loadConfig({ ...BASE, VAD_THRESHOLD: '-0.1' }),
      /Invalid environment configuration/,
    );
  });

  it('parses WAIT_FOR_SESSION_UPDATED as a strict boolean', () => {
    assert.equal(loadConfig({ ...BASE, WAIT_FOR_SESSION_UPDATED: 'true' }).waitForSessionUpdated, true);
    assert.equal(loadConfig({ ...BASE, WAIT_FOR_SESSION_UPDATED: 'false' }).waitForSessionUpdated, false);
    assert.equal(loadConfig({ ...BASE }).waitForSessionUpdated, false);
  });

  it('splits GATEWAY_TAGS into a trimmed array, or undefined when empty/unset', () => {
    assert.deepEqual(loadConfig({ ...BASE, GATEWAY_TAGS: 'poc, voice' }).gatewayTags, ['poc', 'voice']);
    assert.equal(loadConfig({ ...BASE, GATEWAY_TAGS: '' }).gatewayTags, undefined);
    assert.equal(loadConfig({ ...BASE }).gatewayTags, undefined);
  });
});

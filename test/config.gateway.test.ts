import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
};

describe('loadConfig — Spec 04 R2 gateway keys', () => {
  it('applies defaults for all nine new fields when unset', () => {
    const c = loadConfig({ ...BASE });
    expect(c.voiceFallback).toBe('alloy');
    expect(c.vadSilenceMs).toBe(500);
    expect(c.vadThreshold).toBe(0.5);
    expect(c.vadPrefixPaddingMs).toBe(300);
    expect(c.tokenTtlSeconds).toBe(300); // S15: gateway max is 300 (answered at M1)
    expect(c.gatewayHandshakeTimeoutMs).toBe(5000);
    expect(c.gatewayPingSeconds).toBe(0);
    expect(c.waitForSessionUpdated).toBe(false);
    expect(c.gatewayTags).toBe(undefined);
  });

  it('coerces string ints', () => {
    const c = loadConfig({ ...BASE, VAD_SILENCE_MS: '400' });
    expect(c.vadSilenceMs).toBe(400);
  });

  it('rejects VAD_THRESHOLD outside 0.0-1.0', () => {
    expect(() => loadConfig({ ...BASE, VAD_THRESHOLD: '1.5' })).toThrow(/Invalid environment configuration/);
    expect(() => loadConfig({ ...BASE, VAD_THRESHOLD: '-0.1' })).toThrow(/Invalid environment configuration/);
  });

  it('parses WAIT_FOR_SESSION_UPDATED as a strict boolean', () => {
    expect(loadConfig({ ...BASE, WAIT_FOR_SESSION_UPDATED: 'true' }).waitForSessionUpdated).toBe(true);
    expect(loadConfig({ ...BASE, WAIT_FOR_SESSION_UPDATED: 'false' }).waitForSessionUpdated).toBe(false);
    expect(loadConfig({ ...BASE }).waitForSessionUpdated).toBe(false);
  });

  it('splits GATEWAY_TAGS into a trimmed array, or undefined when empty/unset', () => {
    expect(loadConfig({ ...BASE, GATEWAY_TAGS: 'poc, voice' }).gatewayTags).toEqual(['poc', 'voice']);
    expect(loadConfig({ ...BASE, GATEWAY_TAGS: '' }).gatewayTags).toBe(undefined);
    expect(loadConfig({ ...BASE }).gatewayTags).toBe(undefined);
  });
});

// findings/18 addendum (claim 21): TWILIO_PING_SECONDS is the discriminating-experiment config
// key — unlike GATEWAY_PING_SECONDS (default 0/off), this one defaults to ON (5s) because it IS
// the live-traffic instrumentation the addendum calls for; 0 still means fully disabled.
describe('loadConfig — TWILIO_PING_SECONDS (findings/18 addendum claim 21)', () => {
  it('defaults to 5 (enabled) when unset', () => {
    const c = loadConfig({ ...BASE });
    expect(c.twilioPingSeconds).toBe(5);
  });

  it('coerces a numeric string', () => {
    const c = loadConfig({ ...BASE, TWILIO_PING_SECONDS: '10' });
    expect(c.twilioPingSeconds).toBe(10);
    expect(typeof c.twilioPingSeconds).toBe('number');
  });

  it('accepts 0 (fully disabled)', () => {
    const c = loadConfig({ ...BASE, TWILIO_PING_SECONDS: '0' });
    expect(c.twilioPingSeconds).toBe(0);
  });

  it('rejects a negative value', () => {
    expect(() => loadConfig({ ...BASE, TWILIO_PING_SECONDS: '-1' })).toThrow(/Invalid environment configuration/);
  });

  it('rejects a non-integer value', () => {
    expect(() => loadConfig({ ...BASE, TWILIO_PING_SECONDS: '1.5' })).toThrow(/Invalid environment configuration/);
  });
});

// Findings review (Minor — GATEWAY_WS_URL prod guard): GATEWAY_WS_URL (Spec 10 R10) is a
// test-harness-only seam that opens a bare, unauthenticated WS at whatever URL it names, skipping
// mintRealtimeToken entirely — it must never reach a real deployment. RAILWAY_PUBLIC_DOMAIN is
// injected by Railway itself (never hand-set), so its presence is a reliable "this is production"
// signal loadConfig can refuse to boot against.
describe('loadConfig — GATEWAY_WS_URL production guard (Spec 10 R10)', () => {
  it('throws when GATEWAY_WS_URL is set alongside RAILWAY_PUBLIC_DOMAIN', () => {
    const { PUBLIC_HOST: _omit, ...base } = BASE;
    expect(() =>
      loadConfig({ ...base, RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app', GATEWAY_WS_URL: 'ws://127.0.0.1:9999' }),
    ).toThrow(/GATEWAY_WS_URL/);
  });

  it('allows GATEWAY_WS_URL when RAILWAY_PUBLIC_DOMAIN is absent (local/test harness use)', () => {
    const c = loadConfig({ ...BASE, GATEWAY_WS_URL: 'ws://127.0.0.1:9999' });
    expect(c.gatewayWsUrl).toBe('ws://127.0.0.1:9999');
  });

  it('allows RAILWAY_PUBLIC_DOMAIN alone (real Railway deploy, GATEWAY_WS_URL unset)', () => {
    const { PUBLIC_HOST: _omit, ...base } = BASE;
    const c = loadConfig({ ...base, RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' });
    expect(c.gatewayWsUrl).toBe(undefined);
    expect(c.publicHost).toBe('x.up.railway.app');
  });
});

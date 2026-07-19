import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ ...BASE });
    expect(c.port).toBe(3000);
    expect(c.modelId).toBe('openai/gpt-realtime-2.1');
    expect(c.audioMode).toBe('transcode');
    expect(c.voice).toBe('marin');
    expect(c.publicHost).toBe('example.ngrok.app');
  });
  it('throws with a clear message when AI_GATEWAY_API_KEY is missing', () => {
    const { AI_GATEWAY_API_KEY: _omit, ...env } = BASE;
    expect(() => loadConfig(env)).toThrow(/AI_GATEWAY_API_KEY/);
    expect(() => loadConfig(env)).toThrow(/OIDC/);
  });
  it('throws a boot-time error naming the variable when TWILIO_AUTH_TOKEN is missing (R7.2)', () => {
    const { TWILIO_AUTH_TOKEN: _omit, ...env } = BASE;
    expect(() => loadConfig(env)).toThrow(/TWILIO_AUTH_TOKEN/);
  });
  it('PORT parses as a number from a numeric string (R7.5)', () => {
    const c = loadConfig({ ...BASE, PORT: '8080' });
    expect(c.port).toBe(8080);
    expect(typeof c.port).toBe('number');
  });
  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...BASE, PORT: 'not-a-port' })).toThrow();
  });
  it('prefers PUBLIC_HOST over RAILWAY_PUBLIC_DOMAIN', () => {
    const c = loadConfig({ ...BASE, RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' });
    expect(c.publicHost).toBe('example.ngrok.app');
  });
  it('throws when neither PUBLIC_HOST nor RAILWAY_PUBLIC_DOMAIN is set', () => {
    const { PUBLIC_HOST: _omit, ...env } = BASE;
    expect(() => loadConfig(env)).toThrow(/PUBLIC_HOST|RAILWAY_PUBLIC_DOMAIN/);
  });
  it('rejects an invalid AUDIO_MODE', () => {
    expect(() => loadConfig({ ...BASE, AUDIO_MODE: 'wav' })).toThrow();
  });
  it('accepts pcmu as a valid AUDIO_MODE (Path A, Spec 06 R1)', () => {
    const c = loadConfig({ ...BASE, AUDIO_MODE: 'pcmu' });
    expect(c.audioMode).toBe('pcmu');
  });
  it('rejects every illegal AUDIO_MODE value with a message naming both legal values (Spec 06 R1/A4)', () => {
    for (const bad of ['garbage', '', 'pcm', 'mulaw']) {
      let thrown: unknown;
      try {
        loadConfig({ ...BASE, AUDIO_MODE: bad });
      } catch (err) {
        thrown = err;
      }
      const matches = thrown instanceof Error && /pcmu/.test(thrown.message) && /transcode/.test(thrown.message);
      expect(
        matches,
        `AUDIO_MODE=${JSON.stringify(bad)} should be rejected with a message naming pcmu and transcode`,
      ).toBe(true);
    }
  });
  it('types audioMode as the pcmu|transcode union, not string (Spec 06 R1)', () => {
    const c = loadConfig({ ...BASE, AUDIO_MODE: 'pcmu' });
    // Compile-time check: this generic only accepts the union; if `audioMode` were
    // widened to `string` this file would fail `npm run typecheck`.
    type AssertAudioModeUnion<T extends 'pcmu' | 'transcode'> = T;
    type _Check = AssertAudioModeUnion<typeof c.audioMode>;
    expect(c.audioMode === 'pcmu' || c.audioMode === 'transcode').toBeTruthy();
  });
  it('runs in a plain Node environment (G6: no jsdom window)', () => {
    expect((globalThis as Record<string, unknown>).window).toBe(undefined);
  });
  it('TWILIO_VALIDATE_UPGRADE defaults to false (Spec 03 R8, log-only advisory check)', () => {
    const c = loadConfig({ ...BASE });
    expect(c.twilioValidateUpgrade).toBe(false);
  });
  it('TWILIO_VALIDATE_UPGRADE=true parses to true', () => {
    const c = loadConfig({ ...BASE, TWILIO_VALIDATE_UPGRADE: 'true' });
    expect(c.twilioValidateUpgrade).toBe(true);
  });
  it('rejects a garbage TWILIO_VALIDATE_UPGRADE value', () => {
    expect(() => loadConfig({ ...BASE, TWILIO_VALIDATE_UPGRADE: 'yes' })).toThrow();
  });
});

describe('loadConfig — Demo Spec 03 MCP knowledge keys', () => {
  it('applies the three MCP defaults when unset', () => {
    const c = loadConfig({ ...BASE });
    expect(c.mcpModelId).toBe('google/gemini-3.1-flash-lite');
    expect(c.mcpModelMaxTokens).toBe(400);
    expect(c.mcpToolTimeoutMs).toBe(4500);
  });

  it('coerces MCP numeric strings and accepts the 4999 boundary', () => {
    const c = loadConfig({ ...BASE, MCP_MODEL_MAX_TOKENS: '200', MCP_TOOL_TIMEOUT_MS: '4999' });
    expect(c.mcpModelMaxTokens).toBe(200);
    expect(typeof c.mcpModelMaxTokens).toBe('number');
    expect(c.mcpToolTimeoutMs).toBe(4999);
    expect(typeof c.mcpToolTimeoutMs).toBe('number');
  });

  it('rejects MCP_TOOL_TIMEOUT_MS at the transport cap with the cap message', () => {
    expect(() => loadConfig({ ...BASE, MCP_TOOL_TIMEOUT_MS: '5000' })).toThrow(/runTool transport cap/);
  });

  it('rejects non-positive and non-integer MCP_TOOL_TIMEOUT_MS', () => {
    for (const bad of ['0', '-1', '1.5']) {
      expect(() => loadConfig({ ...BASE, MCP_TOOL_TIMEOUT_MS: bad })).toThrow(/Invalid environment configuration/);
    }
  });

  it('rejects MCP_MODEL_MAX_TOKENS=0', () => {
    expect(() => loadConfig({ ...BASE, MCP_MODEL_MAX_TOKENS: '0' })).toThrow(/Invalid environment configuration/);
  });

  it('rejects an empty MCP_MODEL_ID', () => {
    expect(() => loadConfig({ ...BASE, MCP_MODEL_ID: '' })).toThrow(/Invalid environment configuration/);
  });
});

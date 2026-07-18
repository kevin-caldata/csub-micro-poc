import { describe, it, expect, vi } from 'vitest';
import {
  gateway,
  GatewayError,
  GatewayAuthenticationError,
  GatewayInvalidRequestError,
  GatewayRateLimitError,
  GatewayModelNotFoundError,
  GatewayInternalServerError,
  GatewayFailedDependencyError,
  GatewayForbiddenError,
} from '@ai-sdk/gateway';
import { loadConfig } from '../src/config.js';
import { mintRealtimeToken, GatewayMintError } from '../src/gateway.js';

const baseCfg = loadConfig({
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
});

/** Captures every line mintRealtimeToken writes via logEvent (Spec 01 R12 -> process.stdout.write). */
function spyOnLog() {
  const writeMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return {
    lines: () => writeMock.mock.calls.map((c) => JSON.parse(String(c[0]))),
    restore: () => writeMock.mockRestore(),
  };
}

describe('mintRealtimeToken', () => {
  it('runs in a plain Node environment (no DOM window) — findings/10 G6', () => {
    expect(globalThis.window).toBe(undefined);
  });

  it('calls the factory getToken({model, expiresAfterSeconds}) with no sessionConfig, and returns MintResult (A1)', async () => {
    const getTokenMock = vi.spyOn(gateway.experimental_realtime, 'getToken').mockImplementation(async () => ({
      token: 'vcst_x',
      url: 'wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1',
      expiresAt: 123,
    }));
    const log = spyOnLog();
    try {
      const result = await mintRealtimeToken(baseCfg, 'CA-success');

      expect(result.token).toBe('vcst_x');
      expect(result.url).toBe('wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1');
      expect(result.expiresAt).toBe(123);
      expect(typeof result.getTokenMs).toBe('number');

      expect(getTokenMock.mock.calls.length).toBe(1);
      const arg = getTokenMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg).toEqual({ model: baseCfg.modelId, expiresAfterSeconds: baseCfg.tokenTtlSeconds });
      expect('sessionConfig' in arg).toBe(false);
    } finally {
      getTokenMock.mockRestore();
      log.restore();
    }
  });

  it('emits a get-token log line with callSid, getTokenMs, expiresAt (A11)', async () => {
    const getTokenMock = vi.spyOn(gateway.experimental_realtime, 'getToken').mockImplementation(async () => ({
      token: 'vcst_y',
      url: 'wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1',
      expiresAt: 456,
    }));
    const log = spyOnLog();
    try {
      await mintRealtimeToken(baseCfg, 'CA-logged');
      const line = log.lines().find((l) => l.event === 'get-token');
      expect(line, 'expected a get-token log line').toBeTruthy();
      expect(line.callSid).toBe('CA-logged');
      expect(typeof line.getTokenMs).toBe('number');
      expect(line.expiresAt).toBe(456);
    } finally {
      getTokenMock.mockRestore();
      log.restore();
    }
  });

  const classificationCases: Array<{
    label: string;
    err: unknown;
    errorType: string;
    statusCode: number | undefined;
  }> = [
    { label: 'authentication_error', err: new GatewayAuthenticationError(), errorType: 'authentication_error', statusCode: 401 },
    { label: 'invalid_request_error', err: new GatewayInvalidRequestError(), errorType: 'invalid_request_error', statusCode: 400 },
    { label: 'rate_limit_exceeded', err: new GatewayRateLimitError(), errorType: 'rate_limit_exceeded', statusCode: 429 },
    { label: 'model_not_found', err: new GatewayModelNotFoundError(), errorType: 'model_not_found', statusCode: 404 },
    { label: 'internal_server_error', err: new GatewayInternalServerError(), errorType: 'internal_server_error', statusCode: 500 },
    { label: 'failed_dependency', err: new GatewayFailedDependencyError(), errorType: 'failed_dependency', statusCode: 424 },
    { label: 'forbidden', err: new GatewayForbiddenError(), errorType: 'forbidden', statusCode: 403 },
    // Tier 2 — not one of the seven named classes, but a GatewayError-shaped object: statusCode fallback (A11).
    { label: 'statusCode-fallback (bare GatewayError)', err: new GatewayError({ message: 'weird', statusCode: 418 }), errorType: 'unknown', statusCode: 418 },
    // Tier 3 — no instanceof match and no statusCode at all: 'unknown' branch (A11).
    { label: 'unknown (plain Error, no statusCode)', err: new Error('boom'), errorType: 'unknown', statusCode: undefined },
  ];

  for (const c of classificationCases) {
    it(`classifies ${c.label} into GatewayMintError{errorType, statusCode} and logs get-token-failed`, async () => {
      const getTokenMock = vi.spyOn(gateway.experimental_realtime, 'getToken').mockImplementation(async () => {
        throw c.err;
      });
      const log = spyOnLog();
      try {
        let caught: unknown;
        try {
          await mintRealtimeToken(baseCfg, 'CA-fail');
        } catch (err) {
          caught = err;
        }
        expect(caught instanceof GatewayMintError, 'expected a GatewayMintError').toBe(true);
        const mintErr = caught as GatewayMintError;
        expect(mintErr.errorType).toBe(c.errorType);
        expect(mintErr.statusCode).toBe(c.statusCode);
        expect(typeof mintErr.getTokenMs).toBe('number');
        expect(mintErr.cause).toBe(c.err);

        const lines = log.lines();
        const failLine = lines.find((l) => l.event === 'get-token-failed');
        expect(failLine, 'expected a get-token-failed log line').toBeTruthy();
        expect(failLine.callSid).toBe('CA-fail');
        expect(failLine.errorType).toBe(c.errorType);
        expect(failLine.statusCode).toBe(c.statusCode);
        expect(typeof failLine.getTokenMs).toBe('number');
      } finally {
        getTokenMock.mockRestore();
        log.restore();
      }
    });
  }

  it('model_not_found additionally logs a line naming MODEL_ID=openai/gpt-realtime-2 (Spec 04 R3 / S7)', async () => {
    const getTokenMock = vi.spyOn(gateway.experimental_realtime, 'getToken').mockImplementation(async () => {
      throw new GatewayModelNotFoundError({ modelId: 'openai/gpt-realtime-2.1' });
    });
    const log = spyOnLog();
    try {
      await expect((() => mintRealtimeToken(baseCfg, 'CA-model-not-found'))()).rejects.toThrow();
      const hint = log.lines().find(
        (l) => typeof l.message === 'string' && l.message.includes('MODEL_ID=openai/gpt-realtime-2'),
      );
      expect(hint, 'expected a log line whose message names MODEL_ID=openai/gpt-realtime-2').toBeTruthy();
    } finally {
      getTokenMock.mockRestore();
      log.restore();
    }
  });
});

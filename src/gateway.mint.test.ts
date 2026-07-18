import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
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
import { loadConfig } from './config.js';
import { mintRealtimeToken, GatewayMintError } from './gateway.js';

const baseCfg = loadConfig({
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
});

/** Captures every line mintRealtimeToken writes via logEvent (Spec 01 R12 -> process.stdout.write). */
function spyOnLog() {
  const writeMock = mock.method(process.stdout, 'write', () => true);
  return {
    lines: () => writeMock.mock.calls.map((c) => JSON.parse(String(c.arguments[0]))),
    restore: () => writeMock.mock.restore(),
  };
}

describe('mintRealtimeToken', () => {
  it('runs in a plain Node environment (no DOM window) — findings/10 G6', () => {
    assert.equal(globalThis.window, undefined);
  });

  it('calls the factory getToken({model, expiresAfterSeconds}) with no sessionConfig, and returns MintResult (A1)', async () => {
    const getTokenMock = mock.method(gateway.experimental_realtime, 'getToken', async () => ({
      token: 'vcst_x',
      url: 'wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1',
      expiresAt: 123,
    }));
    const log = spyOnLog();
    try {
      const result = await mintRealtimeToken(baseCfg, 'CA-success');

      assert.equal(result.token, 'vcst_x');
      assert.equal(result.url, 'wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1');
      assert.equal(result.expiresAt, 123);
      assert.equal(typeof result.getTokenMs, 'number');

      assert.equal(getTokenMock.mock.calls.length, 1);
      const arg = getTokenMock.mock.calls[0]?.arguments[0] as Record<string, unknown>;
      assert.deepEqual(arg, { model: baseCfg.modelId, expiresAfterSeconds: baseCfg.tokenTtlSeconds });
      assert.equal('sessionConfig' in arg, false);
    } finally {
      getTokenMock.mock.restore();
      log.restore();
    }
  });

  it('emits a get-token log line with callSid, getTokenMs, expiresAt (A11)', async () => {
    const getTokenMock = mock.method(gateway.experimental_realtime, 'getToken', async () => ({
      token: 'vcst_y',
      url: 'wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1',
      expiresAt: 456,
    }));
    const log = spyOnLog();
    try {
      await mintRealtimeToken(baseCfg, 'CA-logged');
      const line = log.lines().find((l) => l.event === 'get-token');
      assert.ok(line, 'expected a get-token log line');
      assert.equal(line.callSid, 'CA-logged');
      assert.equal(typeof line.getTokenMs, 'number');
      assert.equal(line.expiresAt, 456);
    } finally {
      getTokenMock.mock.restore();
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
      const getTokenMock = mock.method(gateway.experimental_realtime, 'getToken', async () => {
        throw c.err;
      });
      const log = spyOnLog();
      try {
        await assert.rejects(
          () => mintRealtimeToken(baseCfg, 'CA-fail'),
          (err: unknown) => {
            assert.ok(err instanceof GatewayMintError, 'expected a GatewayMintError');
            const mintErr = err as GatewayMintError;
            assert.equal(mintErr.errorType, c.errorType);
            assert.equal(mintErr.statusCode, c.statusCode);
            assert.equal(typeof mintErr.getTokenMs, 'number');
            assert.equal(mintErr.cause, c.err);
            return true;
          },
        );

        const lines = log.lines();
        const failLine = lines.find((l) => l.event === 'get-token-failed');
        assert.ok(failLine, 'expected a get-token-failed log line');
        assert.equal(failLine.callSid, 'CA-fail');
        assert.equal(failLine.errorType, c.errorType);
        assert.equal(failLine.statusCode, c.statusCode);
        assert.equal(typeof failLine.getTokenMs, 'number');
      } finally {
        getTokenMock.mock.restore();
        log.restore();
      }
    });
  }

  it('model_not_found additionally logs a line naming MODEL_ID=openai/gpt-realtime-2 (Spec 04 R3 / S7)', async () => {
    const getTokenMock = mock.method(gateway.experimental_realtime, 'getToken', async () => {
      throw new GatewayModelNotFoundError({ modelId: 'openai/gpt-realtime-2.1' });
    });
    const log = spyOnLog();
    try {
      await assert.rejects(() => mintRealtimeToken(baseCfg, 'CA-model-not-found'));
      const hint = log.lines().find(
        (l) => typeof l.message === 'string' && l.message.includes('MODEL_ID=openai/gpt-realtime-2'),
      );
      assert.ok(hint, 'expected a log line whose message names MODEL_ID=openai/gpt-realtime-2');
    } finally {
      getTokenMock.mock.restore();
      log.restore();
    }
  });
});

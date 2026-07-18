import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import twilio from 'twilio'; // default-import + destructure: safe under both ESM and CJS emit (twilio is CJS)
const { getExpectedTwilioSignature } = twilio;
import { registerTwimlRoutes, pendingCalls, PENDING_TTL_MS, type MintFn, type TwimlDeps } from './twiml.js';
import type { AppConfig } from './config.js';

// A minimal app (not buildApp()) is used here — buildApp() auto-registers the real
// registerTwimlRoutes with the default gateway mint (T02.3), which would collide with a
// second registration and cannot accept the fake `mint` these tests inject.
async function buildTestApp(deps?: TwimlDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(formbody);
  registerTwimlRoutes(app, fixtureConfig, deps);
  return app;
}

const fixtureConfig: AppConfig = {
  aiGatewayApiKey: 'vck_test',
  twilioAuthToken: 'tok123',
  port: 3000,
  publicHost: 'test.example.com',
  modelId: 'openai/gpt-realtime-2.1',
  audioMode: 'transcode',
  voice: 'marin',
  voiceFallback: 'alloy',
  vadSilenceMs: 500,
  vadThreshold: 0.5,
  vadPrefixPaddingMs: 300,
  tokenTtlSeconds: 600,
  gatewayHandshakeTimeoutMs: 5000,
  gatewayPingSeconds: 0,
  waitForSessionUpdated: false,
  gatewayTags: undefined,
};

/** Wraps process.stdout.write to capture logEvent()'s minified-JSON lines; always restore in `finally`. */
function captureStdout(): { lines: () => Record<string, unknown>[]; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    lines: () =>
      chunks
        .map((c) => {
          try {
            return JSON.parse(c);
          } catch {
            return null;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== null),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function sign(params: Record<string, string>): string {
  const url = `https://${fixtureConfig.publicHost}/twiml`;
  return getExpectedTwilioSignature(fixtureConfig.twilioAuthToken, url, params);
}

beforeEach(() => {
  pendingCalls.clear();
});

describe('registerTwimlRoutes — POST /twiml', () => {
  it('A2 happy path: 200 text/xml with the exact TwiML shape', async () => {
    const fakeMint: MintFn = async () => ({ token: 'vcst_fake', url: 'wss://gw.example/x' });
    const app = await buildTestApp({ mint: fakeMint });

    const params = { CallSid: 'CA1', From: '+15550001111' };
    const res = await app.inject({
      method: 'POST',
      url: '/twiml',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': sign(params),
      },
      payload: new URLSearchParams(params).toString(),
    });

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/xml/);

    const body = res.body;
    assert.match(body, /<Connect>/);

    const streamUrlMatch = body.match(/<Stream url="([^"]+)"/);
    assert.ok(streamUrlMatch, 'expected a <Stream url="..."> attribute');
    assert.equal(streamUrlMatch![1], `wss://${fixtureConfig.publicHost}/twilio-media`);
    assert.equal(streamUrlMatch![1].includes('?'), false);

    assert.ok(body.includes(`statusCallback="https://${fixtureConfig.publicHost}/stream-status"`));
    assert.ok(body.includes('statusCallbackMethod="POST"'));

    const paramCount = (body.match(/<Parameter name="token"/g) ?? []).length;
    assert.equal(paramCount, 1);

    const afterConnect = body.split('</Connect>')[1];
    assert.equal(afterConnect, '</Response>');

    await app.close();
  });

  it('A4 store + mint: mint invoked once with modelId; entry stored; getToken-resolved logged', async () => {
    const mintCalls: string[] = [];
    const fakeResult = { token: 'vcst_fake', url: 'wss://gw.example/x', expiresAt: 99999 };
    const fakeMint: MintFn = async (modelId) => {
      mintCalls.push(modelId);
      return fakeResult;
    };
    const app = await buildTestApp({ mint: fakeMint });

    const params = { CallSid: 'CA1', From: '+15550001111' };
    const capture = captureStdout();
    let res;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/twiml',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': sign(params),
        },
        payload: new URLSearchParams(params).toString(),
      });
      await new Promise((r) => setImmediate(r));
    } finally {
      capture.restore();
    }

    assert.equal(res.statusCode, 200);
    assert.equal(pendingCalls.size, 1);
    const [entry] = [...pendingCalls.values()];
    assert.equal(entry!.callSid, 'CA1');
    assert.deepEqual(mintCalls, [fixtureConfig.modelId]);
    const resolved = await entry!.gatewayAuth;
    assert.deepEqual(resolved, fakeResult);

    const resolvedLines = capture.lines().filter((l) => l.event === 'getToken-resolved');
    assert.equal(resolvedLines.length, 1);
    assert.equal(typeof resolvedLines[0]!.getTokenMs, 'number');
    assert.equal(resolvedLines[0]!.expiresAt, 99999);

    await app.close();
  });

  it('A4 rejection safety: mint rejection logs getToken-failed, still 200, no unhandledRejection', async () => {
    const fakeMint: MintFn = () => Promise.reject(new Error('boom'));
    const app = await buildTestApp({ mint: fakeMint });

    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on('unhandledRejection', onUnhandled);

    const params = { CallSid: 'CA2', From: '+15550001111' };
    const capture = captureStdout();
    let res;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/twiml',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': sign(params),
        },
        payload: new URLSearchParams(params).toString(),
      });
      await new Promise((r) => setImmediate(r));
    } finally {
      capture.restore();
      process.off('unhandledRejection', onUnhandled);
    }

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<Connect>/);

    const failLines = capture.lines().filter((l) => l.event === 'getToken-failed');
    assert.equal(failLines.length, 1);
    assert.equal(unhandled, undefined);

    await app.close();
  });

  it('A3 bad signature: 403, pendingCalls unchanged, mint never called, one warn line', async () => {
    let mintCalled = false;
    const fakeMint: MintFn = async () => {
      mintCalled = true;
      return { token: 't', url: 'u' };
    };
    const app = await buildTestApp({ mint: fakeMint });

    const sizeBefore = pendingCalls.size;
    const capture = captureStdout();
    let res;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/twiml',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': 'totally-wrong-signature',
        },
        payload: new URLSearchParams({ CallSid: 'CA3' }).toString(),
      });
    } finally {
      capture.restore();
    }

    assert.equal(res.statusCode, 403);
    assert.equal(pendingCalls.size, sizeBefore);
    assert.equal(mintCalled, false);

    const warnLines = capture.lines().filter((l) => l.event === 'twiml-bad-signature');
    assert.equal(warnLines.length, 1);

    await app.close();
  });

  it('sweeps expired pendingCalls entries on every /twiml hit', async () => {
    const fakeMint: MintFn = async () => ({ token: 't', url: 'u' });
    const app = await buildTestApp({ mint: fakeMint });

    const staleToken = 'stale-token';
    pendingCalls.set(staleToken, {
      callSid: 'CA_old',
      createdAt: Date.now() - PENDING_TTL_MS - 1000,
      gatewayAuth: Promise.resolve({ token: 't', url: 'u' }),
    });

    const params = { CallSid: 'CA5' };
    const res = await app.inject({
      method: 'POST',
      url: '/twiml',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': sign(params),
      },
      payload: new URLSearchParams(params).toString(),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(pendingCalls.has(staleToken), false);
    assert.equal(pendingCalls.size, 1);

    await app.close();
  });
});

describe('registerTwimlRoutes — POST /stream-status', () => {
  it('A6: 204, one error-level stream-status log line with top-level fields', async () => {
    const app = await buildTestApp();

    const capture = captureStdout();
    let res;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/stream-status',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          StreamEvent: 'stream-error',
          StreamError: 'x',
          CallSid: 'CA1',
          StreamSid: 'MZ1',
        }).toString(),
      });
    } finally {
      capture.restore();
    }

    assert.equal(res.statusCode, 204);

    const streamLines = capture.lines().filter((l) => l.event === 'stream-status');
    assert.equal(streamLines.length, 1);
    assert.equal(streamLines[0]!.level, 'error');
    assert.equal(streamLines[0]!.callSid, 'CA1');
    assert.equal(streamLines[0]!.streamSid, 'MZ1');
    assert.equal(streamLines[0]!.streamEvent, 'stream-error');
    assert.equal(streamLines[0]!.streamError, 'x');

    await app.close();
  });
});

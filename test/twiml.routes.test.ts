import { describe, it, beforeEach, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import twilio from 'twilio'; // default-import + destructure: safe under both ESM and CJS emit (twilio is CJS)
const { getExpectedTwilioSignature } = twilio;
import { registerTwimlRoutes, pendingCalls, PENDING_TTL_MS, type MintFn, type TwimlDeps } from '../src/twiml.js';
import type { AppConfig } from '../src/config.js';

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

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/text\/xml/);

    const body = res.body;
    expect(body).toMatch(/<Connect>/);

    const streamUrlMatch = body.match(/<Stream url="([^"]+)"/);
    expect(streamUrlMatch, 'expected a <Stream url="..."> attribute').toBeTruthy();
    expect(streamUrlMatch![1]).toBe(`wss://${fixtureConfig.publicHost}/twilio-media`);
    expect(streamUrlMatch![1].includes('?')).toBe(false);

    expect(body.includes(`statusCallback="https://${fixtureConfig.publicHost}/stream-status"`)).toBeTruthy();
    expect(body.includes('statusCallbackMethod="POST"')).toBeTruthy();

    const paramCount = (body.match(/<Parameter name="token"/g) ?? []).length;
    expect(paramCount).toBe(1);

    const afterConnect = body.split('</Connect>')[1];
    expect(afterConnect).toBe('</Response>');

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

    expect(res.statusCode).toBe(200);
    expect(pendingCalls.size).toBe(1);
    const [entry] = [...pendingCalls.values()];
    expect(entry!.callSid).toBe('CA1');
    expect(mintCalls).toEqual([fixtureConfig.modelId]);
    const resolved = await entry!.gatewayAuth;
    expect(resolved).toEqual(fakeResult);

    const resolvedLines = capture.lines().filter((l) => l.event === 'getToken-resolved');
    expect(resolvedLines.length).toBe(1);
    expect(typeof resolvedLines[0]!.getTokenMs).toBe('number');
    expect(resolvedLines[0]!.expiresAt).toBe(99999);

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

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<Connect>/);

    const failLines = capture.lines().filter((l) => l.event === 'getToken-failed');
    expect(failLines.length).toBe(1);
    expect(unhandled).toBe(undefined);

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

    expect(res.statusCode).toBe(403);
    expect(pendingCalls.size).toBe(sizeBefore);
    expect(mintCalled).toBe(false);

    const warnLines = capture.lines().filter((l) => l.event === 'twiml-bad-signature');
    expect(warnLines.length).toBe(1);

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

    expect(res.statusCode).toBe(200);
    expect(pendingCalls.has(staleToken)).toBe(false);
    expect(pendingCalls.size).toBe(1);

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

    expect(res.statusCode).toBe(204);

    const streamLines = capture.lines().filter((l) => l.event === 'stream-status');
    expect(streamLines.length).toBe(1);
    expect(streamLines[0]!.level).toBe('error');
    expect(streamLines[0]!.callSid).toBe('CA1');
    expect(streamLines[0]!.streamSid).toBe('MZ1');
    expect(streamLines[0]!.streamEvent).toBe('stream-error');
    expect(streamLines[0]!.streamError).toBe('x');

    await app.close();
  });
});

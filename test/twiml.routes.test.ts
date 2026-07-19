import { describe, it, beforeEach, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyWebsocket from '@fastify/websocket';
import twilio from 'twilio'; // default-import + destructure: safe under both ESM and CJS emit (twilio is CJS)
const { getExpectedTwilioSignature } = twilio;
import { registerTwimlRoutes, pendingCalls, PENDING_TTL_MS, type MintFn, type TwimlDeps } from '../src/twiml.js';
import { registerTwilioMediaRoute, type TwilioMediaDeps } from '../src/twilio-media.js';
import { sessions, type Session } from '../src/sessions.js';
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
  sessions.clear();
});

/** Polls `pred` until true or `timeoutMs` elapses; throws on timeout (avoids fixed sleeps). */
async function waitUntil(pred: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Map-backed, single-use stub for claimPendingCall (mirrors twilio-media.test.ts's helper). */
function stubClaim(validTokens: Iterable<string>): TwilioMediaDeps['claimPendingCall'] {
  const live = new Set(validTokens);
  return (candidate: string) => {
    if (!live.has(candidate)) return undefined;
    live.delete(candidate); // single-use
    return { callSid: 'CA-stub' };
  };
}

const connectedFrame = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });

function startFrame(overrides: { streamSid?: string; callSid?: string; token?: string } = {}) {
  return JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    streamSid: overrides.streamSid ?? 'MZ1',
    start: {
      accountSid: 'AC1',
      streamSid: overrides.streamSid ?? 'MZ1',
      callSid: overrides.callSid ?? 'CA1',
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: overrides.token === undefined ? { token: 'tok-1' } : { token: overrides.token },
    },
  });
}

/**
 * Builds a single app with BOTH `/twilio-media` (real route, real 'close' handler wiring) and
 * `/stream-status` (the fix under test) registered — needed to exercise the fix's actual
 * contract: /stream-status must not implement its own teardown, it must trigger the EXISTING
 * close-triggered `teardownSession` path that `registerTwilioMediaRoute` already wires up.
 */
async function buildCombinedApp(
  twilioMediaDeps: Partial<TwilioMediaDeps> = {},
): Promise<{ app: FastifyInstance; onSessionStartCalls: Session[] }> {
  const app = Fastify({ logger: false });
  await app.register(formbody);
  await app.register(fastifyWebsocket, {
    options: { perMessageDeflate: false, maxPayload: 1 * 1024 * 1024 },
  });

  const fakeMint: MintFn = async () => ({ token: 'vcst_fake', url: 'wss://gw.example/x' });
  registerTwimlRoutes(app, fixtureConfig, { mint: fakeMint });

  const onSessionStartCalls: Session[] = [];
  registerTwilioMediaRoute(app, {
    config: { publicHost: fixtureConfig.publicHost, twilioAuthToken: fixtureConfig.twilioAuthToken, twilioValidateUpgrade: false },
    claimPendingCall: twilioMediaDeps.claimPendingCall ?? stubClaim([]),
    onSessionStart: twilioMediaDeps.onSessionStart ?? ((s) => onSessionStartCalls.push(s)),
    startTimeoutMs: twilioMediaDeps.startTimeoutMs,
  });

  await app.ready();
  return { app, onSessionStartCalls };
}

/** Mirrors twilio-media.test.ts's helper: avoids the 30s graceful-close fallback over injectWS. */
async function closeCombinedApp(app: FastifyInstance): Promise<void> {
  for (const client of app.websocketServer.clients) client.terminate();
  await app.close();
}

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

// Zombie-socket fix: Twilio's stream-error callback (no WS close frame follows it) must now
// proactively tear the session down instead of leaving it half-open for 30s-2min until TCP
// death. These tests exercise the FULL path — /twilio-media's real 'close' handler wiring must
// be the thing that actually reaps the session; /stream-status only triggers it.
describe('registerTwimlRoutes — POST /stream-status stream-error proactive teardown', () => {
  it('(i) live session: 204, warn log, socket terminated, and the EXISTING close/teardown path reaps it (gateway leg + session removed)', async () => {
    const { app, onSessionStartCalls } = await buildCombinedApp({ claimPendingCall: stubClaim(['tok-err']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame({ streamSid: 'MZerr1', callSid: 'CAerr1', token: 'tok-err' }));
      await waitUntil(() => sessions.has('MZerr1'));

      const session = onSessionStartCalls[0];
      expect(session).toBeTruthy();
      // Stands in for "the gateway leg closes" — production wiring installs onTeardown to close
      // the gateway leg and MCP client (Spec 05/07); this route never touches that wiring itself,
      // it only needs to reach the ONE existing teardown funnel that calls it.
      let onTeardownCalls = 0;
      session!.onTeardown = () => {
        onTeardownCalls += 1;
      };

      const capture = captureStdout();
      let res;
      try {
        res = await app.inject({
          method: 'POST',
          url: '/stream-status',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams({
            StreamEvent: 'stream-error',
            StreamError: 'Stream signal error, code: 31924',
            StreamErrorCode: '31924',
            CallSid: 'CAerr1',
            StreamSid: 'MZerr1',
          }).toString(),
        });
        // terminate() -> the socket's 'close' event -> teardownSession is asynchronous (an
        // event-loop tick over injectWS's fake duplex); poll rather than assume synchronity.
        await waitUntil(() => !sessions.has('MZerr1'));
      } finally {
        capture.restore();
      }

      expect(res!.statusCode).toBe(204);
      expect(onTeardownCalls, 'the EXISTING teardown funnel must have run').toBe(1);
      expect(sessions.has('MZerr1'), 'session must be reaped from the registry').toBe(false);

      const teardownLines = capture.lines().filter((l) => l.event === 'stream-error-teardown');
      expect(teardownLines.length).toBe(1);
      expect(teardownLines[0]!.level).toBe('warn');
      expect(teardownLines[0]!.callSid).toBe('CAerr1');
      expect(teardownLines[0]!.streamSid).toBe('MZerr1');
      expect(teardownLines[0]!.streamErrorCode).toBe('31924');

      // The normal stream-stop summary line still fires — same path as any other disconnect.
      const stopLines = capture.lines().filter((l) => l.event === 'stream-stop');
      expect(stopLines.length).toBe(1);
      expect(stopLines[0]!.streamSid).toBe('MZerr1');
    } finally {
      await closeCombinedApp(app);
    }
  });

  it('(ii) no matching session (already gone): 204, no throw, no teardown attempted', async () => {
    const { app } = await buildCombinedApp();
    try {
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
            StreamErrorCode: '31924',
            CallSid: 'CA-gone',
            StreamSid: 'MZ-gone',
          }).toString(),
        });
      } finally {
        capture.restore();
      }

      expect(res!.statusCode).toBe(204);
      // The existing stream-status log line still fires (unchanged) ...
      const statusLines = capture.lines().filter((l) => l.event === 'stream-status');
      expect(statusLines.length).toBe(1);
      expect(statusLines[0]!.level).toBe('error');
      // ... but nothing beyond it: no teardown attempted, and no failure branch either.
      expect(capture.lines().filter((l) => l.event === 'stream-error-teardown').length).toBe(0);
      expect(capture.lines().filter((l) => l.event === 'stream-error-teardown-failed').length).toBe(0);
      expect(sessions.size).toBe(0);
    } finally {
      await closeCombinedApp(app);
    }
  });

  it('(iii) non-error stream-status events are unchanged: 204, info log, live session left alone', async () => {
    const { app, onSessionStartCalls } = await buildCombinedApp({ claimPendingCall: stubClaim(['tok-ok']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame({ streamSid: 'MZok1', callSid: 'CAok1', token: 'tok-ok' }));
      await waitUntil(() => sessions.has('MZok1'));
      const session = onSessionStartCalls[0];
      let onTeardownCalls = 0;
      session!.onTeardown = () => {
        onTeardownCalls += 1;
      };

      const capture = captureStdout();
      let res;
      try {
        res = await app.inject({
          method: 'POST',
          url: '/stream-status',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams({
            StreamEvent: 'stream-started',
            CallSid: 'CAok1',
            StreamSid: 'MZok1',
          }).toString(),
        });
      } finally {
        capture.restore();
      }

      expect(res!.statusCode).toBe(204);
      const statusLines = capture.lines().filter((l) => l.event === 'stream-status');
      expect(statusLines.length).toBe(1);
      expect(statusLines[0]!.level).toBe('info');
      expect(statusLines[0]!.streamEvent).toBe('stream-started');

      // The live session (same StreamSid) must be left completely alone — no teardown triggered.
      expect(capture.lines().filter((l) => l.event === 'stream-error-teardown').length).toBe(0);
      expect(onTeardownCalls).toBe(0);
      expect(sessions.has('MZok1')).toBe(true);

      ws.terminate();
    } finally {
      await closeCombinedApp(app);
    }
  });
});

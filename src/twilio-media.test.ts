import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { logEvent } from './logger.js';
import { sessions } from './state.js';
import { registerTwilioMediaRoute, type TwilioMediaDeps } from './twilio-media.js';
import type { Session } from './sessions.js';

/** Captures every line written via logEvent()/log() (process.stdout.write). */
function spyOnLog() {
  const writeMock = mock.method(process.stdout, 'write', () => true);
  return {
    lines: () =>
      writeMock.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c.arguments[0]));
          } catch {
            return undefined;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== undefined),
    restore: () => writeMock.mock.restore(),
  };
}

/** Polls `pred` until true or `timeoutMs` elapses; throws on timeout (avoids fixed sleeps). */
async function waitUntil(pred: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Map-backed, single-use stub for claimPendingCall (Spec 02's real one is tested elsewhere). */
function stubClaim(validTokens: Iterable<string>): TwilioMediaDeps['claimPendingCall'] {
  const live = new Set(validTokens);
  return (candidate: string) => {
    if (!live.has(candidate)) return undefined;
    live.delete(candidate); // single-use
    return { callSid: 'CA-stub' };
  };
}

async function buildTestApp(deps: Partial<TwilioMediaDeps> = {}): Promise<{
  app: FastifyInstance;
  onSessionStartCalls: Session[];
}> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket, {
    options: { perMessageDeflate: false, maxPayload: 1 * 1024 * 1024 },
    errorHandler: (err, socket) => {
      logEvent({ level: 'error', message: 'ws handler error', event: 'ws-error', err: String(err) });
      socket.terminate();
    },
  });

  const onSessionStartCalls: Session[] = [];
  const fullDeps: TwilioMediaDeps = {
    config: { publicHost: 'example.ngrok.app', twilioAuthToken: 'tok_test', twilioValidateUpgrade: false },
    claimPendingCall: deps.claimPendingCall ?? stubClaim([]),
    onSessionStart: deps.onSessionStart ?? ((s) => onSessionStartCalls.push(s)),
    startTimeoutMs: deps.startTimeoutMs,
  };
  registerTwilioMediaRoute(app, fullDeps);
  await app.ready();
  return { app, onSessionStartCalls };
}

/**
 * `app.close()`'s default `preClose` gracefully closes any still-tracked server-side WS
 * clients — but a *graceful* close handshake over `injectWS`'s fake duplex transport does not
 * reliably complete promptly in this environment (same root cause as `shutdown.test.ts`'s
 * `preClose` comment): it falls back to `ws`'s internal 30s force-close timer, which keeps the
 * test process alive well past any already-finished assertions. Forcibly `terminate()`ing every
 * tracked server-side client first (idempotent if already closed) avoids that 30s tail latency.
 */
async function closeTestApp(app: FastifyInstance): Promise<void> {
  for (const client of app.websocketServer.clients) client.terminate();
  await app.close();
}

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

const connectedFrame = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });

beforeEach(() => {
  sessions.clear();
});

describe('registerTwilioMediaRoute — A1 auth happy path', () => {
  it('connected then valid start: session registered, onSessionStart called once, one stream-start log line', async () => {
    const log = spyOnLog();
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      assert.equal(sessions.size, 1);
      assert.equal(onSessionStartCalls.length, 1);
      assert.equal(onSessionStartCalls[0]?.streamSid, 'MZ1');
      assert.equal(onSessionStartCalls[0]?.callSid, 'CA1');

      const lines = log.lines();
      const startLines = lines.filter((l) => l.event === 'stream-start');
      assert.equal(startLines.length, 1);
      assert.equal(startLines[0]?.callSid, 'CA1');
      assert.equal(startLines[0]?.streamSid, 'MZ1');
      assert.deepEqual(startLines[0]?.mediaFormat, { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 });

      ws.terminate();
      await closeTestApp(app);
    } finally {
      log.restore();
    }
  });
});

describe('registerTwilioMediaRoute — A2 auth gate', () => {
  it('missing token: closes 1008, sessions stays empty, onSessionStart never called', async () => {
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
      });
      ws.send(connectedFrame);
      ws.send(startFrame({ token: '' }));
      const { code } = await closeInfo;
      assert.equal(code, 1008);
      assert.equal(sessions.size, 0);
      assert.equal(onSessionStartCalls.length, 0);
    } finally {
      await closeTestApp(app);
    }
  });

  it('unknown token: closes 1008, sessions stays empty', async () => {
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      const closeInfo = new Promise<{ code: number }>((resolve) => {
        ws.on('close', (code: number) => resolve({ code }));
      });
      ws.send(connectedFrame);
      ws.send(startFrame({ token: 'not-the-token' }));
      const { code } = await closeInfo;
      assert.equal(code, 1008);
      assert.equal(sessions.size, 0);
      assert.equal(onSessionStartCalls.length, 0);
    } finally {
      await closeTestApp(app);
    }
  });

  it('already-claimed (single-use) token: second stream with the same token also closes 1008', async () => {
    const claim = stubClaim(['tok-1']);
    const { app } = await buildTestApp({ claimPendingCall: claim });
    try {
      // First claim succeeds.
      const ws1 = await app.injectWS('/twilio-media');
      ws1.send(connectedFrame);
      ws1.send(startFrame({ streamSid: 'MZ1', callSid: 'CA1', token: 'tok-1' }));
      await waitUntil(() => sessions.has('MZ1'));

      // Second stream reusing the same (now-claimed) token must fail the gate.
      const ws2 = await app.injectWS('/twilio-media');
      const closeInfo = new Promise<{ code: number }>((resolve) => {
        ws2.on('close', (code: number) => resolve({ code }));
      });
      ws2.send(connectedFrame);
      ws2.send(startFrame({ streamSid: 'MZ2', callSid: 'CA2', token: 'tok-1' }));
      const { code } = await closeInfo;
      assert.equal(code, 1008);
      assert.equal(sessions.has('MZ2'), false);

      ws1.terminate();
    } finally {
      await closeTestApp(app);
    }
  });

  it('logs auth-fail with callSid on gate failure', async () => {
    const log = spyOnLog();
    const { app } = await buildTestApp({ claimPendingCall: stubClaim([]) });
    try {
      const ws = await app.injectWS('/twilio-media');
      const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
      ws.send(connectedFrame);
      ws.send(startFrame({ callSid: 'CA-bad', token: 'nope' }));
      await closed;
      const lines = log.lines();
      const authFail = lines.find((l) => l.event === 'auth-fail');
      assert.ok(authFail, 'expected an auth-fail log line');
      assert.equal(authFail?.callSid, 'CA-bad');
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — A3 start timeout', () => {
  // Deviation from the plan's first-choice approach (recorded in the completion report):
  // `node:test`'s `mock.timers` proved incompatible with `fastify.injectWS`'s fake duplex
  // transport — enabling the global mock stalled unrelated real timers (observed: `ws`'s
  // internal 30s close-handshake timer from an earlier test fired 30s late once the mock was
  // enabled/reset), cascading into unrelated test failures/timeouts in this same file. Falling
  // back to `TwilioMediaDeps.startTimeoutMs` (a deps-injected override) exercises the real
  // timeout code path deterministically with a small real delay instead.
  it('connected only, no start: socket closes 1008 within the configured start-timeout', async () => {
    const { app } = await buildTestApp({ startTimeoutMs: 30 });
    try {
      const ws = await app.injectWS('/twilio-media');
      const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
      });
      ws.send(connectedFrame);

      const { code, reason } = await closeInfo;
      assert.equal(code, 1008);
      assert.equal(reason, 'no start');
      assert.equal(sessions.size, 0);
    } finally {
      await closeTestApp(app);
    }
  });

  it('nothing sent at all: socket still closes 1008 within the configured start-timeout', async () => {
    const { app } = await buildTestApp({ startTimeoutMs: 30 });
    try {
      const ws = await app.injectWS('/twilio-media');
      const closeInfo = new Promise<{ code: number }>((resolve) => {
        ws.on('close', (code: number) => resolve({ code }));
      });

      const { code } = await closeInfo;
      assert.equal(code, 1008);
    } finally {
      await closeTestApp(app);
    }
  });

  it('a start arriving before the timeout clears it (no spurious 1008 close)', async () => {
    const { app } = await buildTestApp({ startTimeoutMs: 60, claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      let closeCode: number | undefined;
      ws.on('close', (code: number) => {
        closeCode = code;
      });
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));
      // Wait past the configured timeout window; the timer must have been cleared on `start`.
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(closeCode, undefined);
      ws.terminate();
    } finally {
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — A12 route hygiene (partial)', () => {
  it('a binary frame is ignored without close/teardown', async () => {
    const { app } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      let closed = false;
      ws.on('close', () => {
        closed = true;
      });
      ws.send(connectedFrame);
      ws.send(Buffer.from([0x01, 0x02, 0x03])); // binary frame
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));
      assert.equal(closed, false);
      assert.equal(sessions.size, 1);
      ws.terminate();
    } finally {
      await closeTestApp(app);
    }
  });

  it('an unparseable text frame is ignored without close/teardown', async () => {
    const { app } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      let closed = false;
      ws.on('close', () => {
        closed = true;
      });
      ws.send(connectedFrame);
      ws.send('not-json{{');
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));
      assert.equal(closed, false);
      assert.equal(sessions.size, 1);
      ws.terminate();
    } finally {
      await closeTestApp(app);
    }
  });

  it('plain HTTP GET to /twilio-media 404s', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/twilio-media' });
      assert.equal(res.statusCode, 404);
    } finally {
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — stream-stop summary', () => {
  // Note: `ws.close()` (graceful) initiated from the client over `injectWS`'s fake duplex
  // transport does not complete the close handshake promptly in this environment — it only
  // resolves via `ws`'s internal 30s force-close fallback (same root cause documented in
  // `shutdown.test.ts`'s comment on `preClose`). `ws.terminate()` (abrupt) is used here instead
  // to keep the test fast and deterministic; the abnormal/code/reason relationship asserted
  // below holds regardless of which numeric code the abrupt termination surfaces as.
  it('logs a stream-stop line with code/reason/abnormal/bufferedAmount on close, and tears down the session', async () => {
    const log = spyOnLog();
    const { app } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      ws.terminate();
      await waitUntil(() => !sessions.has('MZ1'));

      const lines = log.lines();
      const stopLine = lines.find((l) => l.event === 'stream-stop');
      assert.ok(stopLine, 'expected a stream-stop log line');
      assert.equal(typeof stopLine?.code, 'number');
      assert.equal(typeof stopLine?.reason, 'string'); // Buffer decoded, never a Buffer/object
      assert.equal(stopLine?.callSid, 'CA1');
      assert.equal(stopLine?.streamSid, 'MZ1');
      // abnormal iff 1006 with no `stop` seen — no `stop` frame was sent in this test.
      assert.equal(stopLine?.abnormal, stopLine?.code === 1006);
      assert.equal(typeof stopLine?.bufferedAmount, 'number');
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

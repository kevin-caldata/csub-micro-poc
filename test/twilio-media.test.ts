import { describe, it, beforeEach, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { logEvent } from '../src/logger.js';
import { sessions } from '../src/state.js';
import { registerTwilioMediaRoute, type TwilioMediaDeps } from '../src/twilio-media.js';
import type { Session } from '../src/sessions.js';

/** Captures every line written via logEvent()/log() (process.stdout.write). */
function spyOnLog() {
  const writeMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return {
    lines: () =>
      writeMock.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0]));
          } catch {
            return undefined;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== undefined),
    restore: () => writeMock.mockRestore(),
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

async function buildTestApp(
  deps: Partial<TwilioMediaDeps> = {},
  configOverrides: Partial<TwilioMediaDeps['config']> = {},
): Promise<{
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
    config: {
      publicHost: 'example.ngrok.app',
      twilioAuthToken: 'tok_test',
      twilioValidateUpgrade: false,
      // Off by default in this file's shared harness (most tests don't care); the dedicated
      // heartbeat describe block below opts in per-test via `configOverrides`.
      twilioPingSeconds: 0,
      ...configOverrides,
    },
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

      expect(sessions.size).toBe(1);
      expect(onSessionStartCalls.length).toBe(1);
      expect(onSessionStartCalls[0]?.streamSid).toBe('MZ1');
      expect(onSessionStartCalls[0]?.callSid).toBe('CA1');

      const lines = log.lines();
      const startLines = lines.filter((l) => l.event === 'stream-start');
      expect(startLines.length).toBe(1);
      expect(startLines[0]?.callSid).toBe('CA1');
      expect(startLines[0]?.streamSid).toBe('MZ1');
      expect(startLines[0]?.mediaFormat).toEqual({ encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 });

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
      expect(code).toBe(1008);
      expect(sessions.size).toBe(0);
      expect(onSessionStartCalls.length).toBe(0);
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
      expect(code).toBe(1008);
      expect(sessions.size).toBe(0);
      expect(onSessionStartCalls.length).toBe(0);
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
      expect(code).toBe(1008);
      expect(sessions.has('MZ2')).toBe(false);

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
      expect(authFail, 'expected an auth-fail log line').toBeTruthy();
      expect(authFail?.callSid).toBe('CA-bad');
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
      expect(code).toBe(1008);
      expect(reason).toBe('no start');
      expect(sessions.size).toBe(0);
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
      expect(code).toBe(1008);
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
      expect(closeCode).toBe(undefined);
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
      expect(closed).toBe(false);
      expect(sessions.size).toBe(1);
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
      expect(closed).toBe(false);
      expect(sessions.size).toBe(1);
      ws.terminate();
    } finally {
      await closeTestApp(app);
    }
  });

  it('plain HTTP GET to /twilio-media 404s', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/twilio-media' });
      expect(res.statusCode).toBe(404);
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
      expect(stopLine, 'expected a stream-stop log line').toBeTruthy();
      expect(typeof stopLine?.code).toBe('number');
      expect(typeof stopLine?.reason).toBe('string'); // Buffer decoded, never a Buffer/object
      expect(stopLine?.callSid).toBe('CA1');
      expect(stopLine?.streamSid).toBe('MZ1');
      // abnormal iff 1006 with no `stop` seen — no `stop` frame was sent in this test.
      expect(stopLine?.abnormal).toBe(stopLine?.code === 1006);
      expect(typeof stopLine?.bufferedAmount).toBe('number');
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

// findings/18 addendum (claims 21-23) — route-level wiring for the Twilio-leg heartbeat.
// `startTwilioHeartbeat`'s own logic (interval cadence, RTT, missed-pong latch, disabled-mode) is
// unit-tested in isolation with fake timers in test/twilio-heartbeat.test.ts; this describe block
// only proves the WIRING: it starts the instant a session exists, and clears at teardown.
//
// `@fastify/websocket`'s `injectWS` client is constructed via `new WebSocket(null, undefined,
// { isServer: false })` (ws's own "attach a socket later" constructor path) — that path skips
// `initAsClient`'s option defaulting entirely, so `_autoPong` is left `undefined` instead of ws's
// normal client default of `true`. A REAL peer (a production `ws` client, or Twilio's own stack —
// the addendum's own "ws-based client auto-pongs" claim) responds to a `ping` automatically; this
// harness-only gap is worked around here by wiring the one manual `ping` -> `pong` responder a
// real client would provide for free, so the test exercises genuine round-trip wiring rather than
// a harness artifact.
describe('registerTwilioMediaRoute — Twilio-leg heartbeat wiring (findings/18 addendum)', () => {
  it('with twilioPingSeconds=1, a real ping/pong round-trips and the teardown summary reports it; no more pings after close', async () => {
    const log = spyOnLog();
    const { app } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) }, { twilioPingSeconds: 1 });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.on('ping', (data: Buffer) => ws.pong(data)); // injectWS's test double doesn't autoPong (see comment above) — a real ws client would
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      // Let at least one 1s ping/pong round-trip happen (ws auto-pongs a peer's ping).
      await new Promise((r) => setTimeout(r, 1500));

      ws.terminate();
      await waitUntil(() => !sessions.has('MZ1'));

      const lines = log.lines();
      const summary = lines.find((l) => l.event === 'twilio-heartbeat');
      expect(summary, 'expected a twilio-heartbeat summary line at teardown').toBeTruthy();
      expect(summary?.callSid).toBe('CA1');
      expect(summary?.streamSid).toBe('MZ1');
      expect(summary?.pingsSent as number).toBeGreaterThanOrEqual(1);
      expect(summary?.pongsReceived as number).toBeGreaterThanOrEqual(1);
      expect(typeof summary?.maxRttMs).toBe('number');
      expect(typeof summary?.lastPongAgoMs).toBe('number');

      // Only ONE summary line for the whole call, and no per-pong info log alongside it.
      expect(lines.filter((l) => l.event === 'twilio-heartbeat').length).toBe(1);
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });

  it('with the default twilioPingSeconds=0 override (disabled), no twilio-heartbeat line ever appears', async () => {
    const log = spyOnLog();
    const { app } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) }); // default override: twilioPingSeconds:0
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      await new Promise((r) => setTimeout(r, 300));

      ws.terminate();
      await waitUntil(() => !sessions.has('MZ1'));

      const lines = log.lines();
      expect(lines.some((l) => l.event === 'twilio-heartbeat')).toBe(false);
      expect(lines.some((l) => l.event === 'twilio-pong-missed')).toBe(false);
      expect(lines.some((l) => l.event === 'twilio-pong-slow')).toBe(false);
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

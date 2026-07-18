// T03.4/T03.5 — inbound `media`/`dtmf`/`mark`/`stop`/socket-error dispatch, A10 isolation, and A11
// upgrade-signature (default + enabled/mismatch). Spec 03 R4/R7/R8, A4/A5/A9/A10/A11.
//
// T10.1 consolidation note: under `tsx --test` (node:test v22.14.0, Windows) these nine cases each
// lived in their own file — one real async `fastify.injectWS`-backed test per file — because
// node:test's TAP reporter was observed to silently drop `it()` results whenever a
// file/describe held two or more such tests together (see git history for the original files'
// header comments for the full incident writeup). Vitest uses its own non-TAP reporter/runner, so
// this repo's T10.1 migration re-merged these nine cases into one file and confirmed (via
// `vitest run --reporter=json`, three consecutive full-suite reruns) that all nine report and pass
// every time with zero drops — the environment workaround this file's split existed for is
// specific to node:test on Windows and does not reproduce under vitest.

import { describe, it, beforeEach, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { logEvent } from '../src/logger.js';
import { sessions } from '../src/state.js';
import {
  registerTwilioMediaRoute,
  nextMarkName,
  sendMark,
  type TwilioMediaDeps,
} from '../src/twilio-media.js';
import { pushMark } from '../src/bargein.js';
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

const PUBLIC_HOST = 'example.ngrok.app';

async function buildTestApp(
  deps: Partial<TwilioMediaDeps> = {},
  configOverrides: Partial<TwilioMediaDeps['config']> = {},
): Promise<{ app: FastifyInstance; onSessionStartCalls: Session[] }> {
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
      publicHost: PUBLIC_HOST,
      twilioAuthToken: 'tok_test',
      twilioValidateUpgrade: false,
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

function startFrameFor(overrides: { streamSid: string; callSid: string; token: string }) {
  return JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    streamSid: overrides.streamSid,
    start: {
      accountSid: 'AC1',
      streamSid: overrides.streamSid,
      callSid: overrides.callSid,
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: { token: overrides.token },
    },
  });
}

function mediaFrame(overrides: { timestamp?: string; payload?: string; chunk?: string } = {}) {
  return JSON.stringify({
    event: 'media',
    sequenceNumber: '3',
    streamSid: 'MZ1',
    media: {
      track: 'inbound',
      chunk: overrides.chunk ?? '1',
      timestamp: overrides.timestamp ?? '12345',
      payload: overrides.payload ?? 'AQIDBA==', // 4 raw bytes, base64
    },
  });
}

function mediaFrameFor(streamSid: string, timestamp: string) {
  return JSON.stringify({
    event: 'media',
    sequenceNumber: '3',
    streamSid,
    media: { track: 'inbound', chunk: '1', timestamp, payload: 'AQIDBA==' },
  });
}

function dtmfFrame(digit: string) {
  return JSON.stringify({
    event: 'dtmf',
    streamSid: 'MZ1',
    sequenceNumber: '7',
    dtmf: { track: 'inbound_track', digit },
  });
}

function markFrame(name: string) {
  return JSON.stringify({ event: 'mark', sequenceNumber: '4', streamSid: 'MZ1', mark: { name } });
}

function markFrameFor(streamSid: string, name: string) {
  return JSON.stringify({ event: 'mark', sequenceNumber: '4', streamSid, mark: { name } });
}

function stopFrame() {
  return JSON.stringify({
    event: 'stop',
    sequenceNumber: '9',
    streamSid: 'MZ1',
    stop: { accountSid: 'AC1', callSid: 'CA1' },
  });
}

const connectedFrame = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });

beforeEach(() => {
  sessions.clear();
});

describe('registerTwilioMediaRoute — T03.4 media dispatch', () => {
  it('Number()s the string timestamp, forwards the exact payload, and logs one media-cadence line', async () => {
    const log = spyOnLog();
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      const session = onSessionStartCalls[0];
      expect(session).toBeTruthy();
      const received: string[] = [];
      session.onTwilioMedia = (payload) => received.push(payload);

      ws.send(mediaFrame({ timestamp: '12345', payload: 'AQIDBA==' }));
      await waitUntil(() => received.length === 1);

      expect(session.latestMediaTimestamp).toBe(12345);
      expect(typeof session.latestMediaTimestamp).toBe('number');
      expect(received[0]).toBe('AQIDBA==');

      const cadenceLines = log.lines().filter((l) => l.event === 'media-cadence');
      expect(cadenceLines.length).toBe(1);
      expect(cadenceLines[0]?.timestamp).toBe(12345);
      expect(cadenceLines[0]?.payloadBytes).toBe(Buffer.from('AQIDBA==', 'base64').length);
      expect(cadenceLines[0]?.callSid).toBe('CA1');
      expect(cadenceLines[0]?.streamSid).toBe('MZ1');

      ws.terminate();
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — T03.4 media dispatch (no-per-frame-logging)', () => {
  it('never logs per-frame — 50 more media frames add zero new stdout lines', async () => {
    const log = spyOnLog();
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      const session = onSessionStartCalls[0];
      expect(session).toBeTruthy();
      let receivedCount = 0;
      session.onTwilioMedia = () => {
        receivedCount += 1;
      };

      ws.send(mediaFrame({ timestamp: '160' }));
      await waitUntil(() => receivedCount === 1);
      const lineCountAfterFirst = log.lines().length;
      expect(log.lines().filter((l) => l.event === 'media-cadence').length).toBe(1);

      for (let i = 0; i < 50; i += 1) {
        ws.send(mediaFrame({ timestamp: String(160 + (i + 1) * 20) }));
      }
      await waitUntil(() => receivedCount === 51);

      expect(log.lines().length, 'no new stdout lines from subsequent media frames').toBe(lineCountAfterFirst);
      expect(log.lines().filter((l) => l.event === 'media-cadence').length).toBe(1);

      ws.terminate();
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — T03.4 dtmf dispatch', () => {
  it('logs exactly one {event:"dtmf", digit} line and takes no other action', async () => {
    const log = spyOnLog();
    const { app } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      ws.send(dtmfFrame('5'));
      await waitUntil(() => log.lines().some((l) => l.event === 'dtmf'));

      const dtmfLines = log.lines().filter((l) => l.event === 'dtmf');
      expect(dtmfLines.length).toBe(1);
      expect(dtmfLines[0]?.digit).toBe('5');
      expect(sessions.has('MZ1'), 'dtmf must not tear down').toBe(true);

      ws.terminate();
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — T03.4 socket error (leaves session alive until close)', () => {
  it('an error event on the server-side socket logs ws-error-class output and leaves the session alive', async () => {
    const log = spyOnLog();
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      const session = onSessionStartCalls[0];
      expect(session).toBeTruthy();
      session.twilioWs.emit('error', new Error('boom'));
      await waitUntil(() => log.lines().some((l) => l.event === 'twilio-ws-error'));

      expect(sessions.has('MZ1'), 'error alone must not tear down the session').toBe(true);

      ws.terminate();
      await waitUntil(() => !sessions.has('MZ1'));
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — T03.4 mark dispatch (A5, findings/10 C4)', () => {
  it('removes by name, tolerates unknown names, fires onPlaybackDrained once and onFirstMarkEcho on the first mark only', async () => {
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      const session = onSessionStartCalls[0];
      expect(session).toBeTruthy();
      let drainedCount = 0;
      const firstEchoes: string[] = [];
      session.onPlaybackDrained = () => {
        drainedCount += 1;
      };
      session.onFirstMarkEcho = (name) => firstEchoes.push(name);

      // Seed markQueue = ['rA:1', 'rA:2'] via the real nextMarkName + pushMark path — the exact
      // pairing session.ts's dispatch() uses (T05.2 single-writer collapse: pushMark, not the
      // raw sendMark, is the SOLE writer of `firstMarkNameOfResponse`, which is what makes
      // `onFirstMarkEcho` fire below).
      const n1 = nextMarkName(session, 'A');
      pushMark(session, n1);
      const n2 = nextMarkName(session, 'A');
      pushMark(session, n2);
      expect(session.markQueue).toEqual(['rA:1', 'rA:2']);

      // Echo rA:1 → queue ['rA:2'], drained not yet fired, first-echo fired once with 'rA:1'.
      ws.send(markFrame('rA:1'));
      await waitUntil(() => session.markQueue.length === 1);
      expect(session.markQueue).toEqual(['rA:2']);
      expect(drainedCount).toBe(0);
      expect(firstEchoes).toEqual(['rA:1']);

      // Echo unknown 'zz' → queue unchanged, no throw.
      ws.send(markFrame('zz'));
      await new Promise((r) => setTimeout(r, 30));
      expect(session.markQueue).toEqual(['rA:2']);
      expect(drainedCount).toBe(0);

      // Echo rA:2 → queue [], onPlaybackDrained fired exactly once.
      ws.send(markFrame('rA:2'));
      await waitUntil(() => session.markQueue.length === 0);
      expect(drainedCount).toBe(1);
      expect(firstEchoes).toEqual(['rA:1']); // rA:2 was never the first mark of response A

      ws.terminate();
    } finally {
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — T03.4 stop dispatch (A9: stop-then-close runs teardown exactly once)', () => {
  it('sets sawStop, tears down on stop, and the eventual close logs exactly one non-abnormal stream-stop line', async () => {
    const log = spyOnLog();
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      const session = onSessionStartCalls[0];
      expect(session).toBeTruthy();
      let teardownCount = 0;
      session.onTeardown = () => {
        teardownCount += 1;
      };

      ws.send(stopFrame());
      // teardownSession runs synchronously inside the 'stop' message handler — sessions.delete
      // and the socket.close(1000, 'caller-hangup') call both happen before this resolves.
      await waitUntil(() => !sessions.has('MZ1'));
      expect(teardownCount).toBe(1);

      // The server already initiated a graceful close above; over injectWS's fake duplex that
      // handshake does not reliably complete promptly even with a client-side terminate()
      // (empirically observed: unlike a client-initiated close-alone scenario, here the *server*
      // is the closer, and the test client never sends its own close/ack frame). Forcing the same
      // server-side socket closed directly is the deterministic equivalent of Twilio completing
      // its half of the handshake — the route's own 'close' listener still runs exactly once,
      // exactly as it would in production once Twilio's close frame arrives.
      session.twilioWs.terminate();
      await waitUntil(() => log.lines().some((l) => l.event === 'stream-stop'));

      const stopLines = log.lines().filter((l) => l.event === 'stream-stop');
      expect(stopLines.length, 'exactly one stream-stop line even though both stop and close fired').toBe(1);
      expect(typeof stopLines[0]?.reason).toBe('string');
      expect(!stopLines[0]?.abnormal, 'abnormal must be falsy: sawStop was true regardless of close code').toBeTruthy();
      expect(teardownCount, 'onTeardown still only once — the close-triggered teardownSession no-oped').toBe(1);
      expect(sessions.size).toBe(0);
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — A10 isolation (FR-3)', () => {
  it('two concurrent connections: independent Sessions, no cross-call state leakage, independent teardown', async () => {
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-A', 'tok-B']) });
    try {
      const wsA = await app.injectWS('/twilio-media');
      const wsB = await app.injectWS('/twilio-media');

      wsA.send(connectedFrame);
      wsA.send(startFrameFor({ streamSid: 'MZ-A', callSid: 'CA-A', token: 'tok-A' }));
      wsB.send(connectedFrame);
      wsB.send(startFrameFor({ streamSid: 'MZ-B', callSid: 'CA-B', token: 'tok-B' }));

      await waitUntil(() => sessions.has('MZ-A') && sessions.has('MZ-B'));

      // A10: two independent Sessions in the registry.
      expect(sessions.size).toBe(2);
      expect(onSessionStartCalls.length).toBe(2);

      const sessionA = onSessionStartCalls.find((s) => s.streamSid === 'MZ-A');
      const sessionB = onSessionStartCalls.find((s) => s.streamSid === 'MZ-B');
      expect(sessionA).toBeTruthy();
      expect(sessionB).toBeTruthy();
      expect(sessionA).not.toBe(sessionB);

      // media on one never mutates the other's latestMediaTimestamp.
      wsA.send(mediaFrameFor('MZ-A', '1000'));
      await waitUntil(() => sessionA!.latestMediaTimestamp === 1000);
      expect(sessionB!.latestMediaTimestamp).toBe(0);

      wsB.send(mediaFrameFor('MZ-B', '2000'));
      await waitUntil(() => sessionB!.latestMediaTimestamp === 2000);
      expect(sessionA!.latestMediaTimestamp).toBe(1000); // unchanged by B's media

      // marks on one never touch the other's markQueue.
      const nameA = nextMarkName(sessionA!, 'rA');
      sendMark(sessionA!, nameA);
      expect(sessionA!.markQueue).toEqual([nameA]);
      expect(sessionB!.markQueue).toEqual([]);

      const nameB = nextMarkName(sessionB!, 'rB');
      sendMark(sessionB!, nameB);
      expect(sessionB!.markQueue).toEqual([nameB]);
      expect(sessionA!.markQueue).toEqual([nameA]); // unaffected by B's mark

      wsA.send(markFrameFor('MZ-A', nameA));
      await waitUntil(() => sessionA!.markQueue.length === 0);
      expect(sessionB!.markQueue).toEqual([nameB]); // still queued — A's echo didn't touch B

      // Closing one leaves the other in `sessions` and functional.
      wsA.terminate();
      await waitUntil(() => !sessions.has('MZ-A'));
      expect(sessions.has('MZ-B')).toBe(true);

      wsB.send(mediaFrameFor('MZ-B', '3000'));
      await waitUntil(() => sessionB!.latestMediaTimestamp === 3000);
      expect(sessions.size).toBe(1);

      wsB.terminate();
    } finally {
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — A11 upgrade-signature (default config)', () => {
  it('no x-twilio-signature header, default config: logs presence:false once, never calls validateRequest', async () => {
    const log = spyOnLog();
    const { app } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      // No headers passed — default injectWS upgrade has no x-twilio-signature.
      const ws = await app.injectWS('/twilio-media');
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      const lines = log.lines();
      const sigLines = lines.filter((l) => l.event === 'upgrade-signature');
      expect(sigLines.length).toBe(1);
      expect(sigLines[0]?.present).toBe(false);

      const checkLines = lines.filter((l) => l.event === 'upgrade-signature-check');
      expect(checkLines.length).toBe(0);

      ws.terminate();
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

describe('registerTwilioMediaRoute — A11 upgrade-signature (enabled, mismatch)', () => {
  it('twilioValidateUpgrade:true + bogus signature header: connection proceeds normally, logs ok:false with the wss:// url used', async () => {
    const log = spyOnLog();
    const { app, onSessionStartCalls } = await buildTestApp(
      { claimPendingCall: stubClaim(['tok-1']) },
      { twilioValidateUpgrade: true },
    );
    try {
      const ws = await app.injectWS('/twilio-media', { headers: { 'x-twilio-signature': 'bogus' } });
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      // Log-only, never rejects: the connected/start flow completes as normal despite the
      // mismatching signature — session created, onSessionStart invoked.
      expect(sessions.size).toBe(1);
      expect(onSessionStartCalls.length).toBe(1);

      const lines = log.lines();
      const sigLines = lines.filter((l) => l.event === 'upgrade-signature');
      expect(sigLines.length).toBe(1);
      expect(sigLines[0]?.present).toBe(true);

      const checkLines = lines.filter((l) => l.event === 'upgrade-signature-check');
      expect(checkLines.length).toBe(1);
      expect(checkLines[0]?.ok).toBe(false);
      expect(checkLines[0]?.url).toBe(`wss://${PUBLIC_HOST}/twilio-media`);

      ws.terminate();
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

// Plan self-check (not a unit assertion — grepped at commit time, recorded in the completion
// report): `markQueue.shift(` must appear nowhere in `src/` [Spec 03 A5 grep clause].

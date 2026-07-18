// T03.4 — inbound `mark` dispatch: remove-by-name, drain + first-echo hooks (Spec 03 R4, A5;
// findings/10 C4). Split into its own file — see `twilio-media.inbound.test.ts`'s header comment
// for why (a node:test v22.14.0/Windows TAP-reporting quirk when several heavy injectWS suites
// share one process; splitting by file sidesteps it since each matched file gets its own process).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { logEvent } from './logger.js';
import { sessions } from './state.js';
import { registerTwilioMediaRoute, nextMarkName, type TwilioMediaDeps } from './twilio-media.js';
import { pushMark } from './bargein.js';
import type { Session } from './sessions.js';

async function waitUntil(pred: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function stubClaim(validTokens: Iterable<string>): TwilioMediaDeps['claimPendingCall'] {
  const live = new Set(validTokens);
  return (candidate: string) => {
    if (!live.has(candidate)) return undefined;
    live.delete(candidate);
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

function markFrame(name: string) {
  return JSON.stringify({ event: 'mark', sequenceNumber: '4', streamSid: 'MZ1', mark: { name } });
}

const connectedFrame = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });

beforeEach(() => {
  sessions.clear();
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
      assert.ok(session);
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
      assert.deepEqual(session.markQueue, ['rA:1', 'rA:2']);

      // Echo rA:1 → queue ['rA:2'], drained not yet fired, first-echo fired once with 'rA:1'.
      ws.send(markFrame('rA:1'));
      await waitUntil(() => session.markQueue.length === 1);
      assert.deepEqual(session.markQueue, ['rA:2']);
      assert.equal(drainedCount, 0);
      assert.deepEqual(firstEchoes, ['rA:1']);

      // Echo unknown 'zz' → queue unchanged, no throw.
      ws.send(markFrame('zz'));
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(session.markQueue, ['rA:2']);
      assert.equal(drainedCount, 0);

      // Echo rA:2 → queue [], onPlaybackDrained fired exactly once.
      ws.send(markFrame('rA:2'));
      await waitUntil(() => session.markQueue.length === 0);
      assert.equal(drainedCount, 1);
      assert.deepEqual(firstEchoes, ['rA:1']); // rA:2 was never the first mark of response A

      ws.terminate();
    } finally {
      await closeTestApp(app);
    }
  });
});

// Plan self-check (not a unit assertion — grepped at commit time, recorded in the completion
// report): `markQueue.shift(` must appear nowhere in `src/` [Spec 03 A5 grep clause].

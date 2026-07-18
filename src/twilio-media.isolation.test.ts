// T03.5 — A10 (isolation, FR-3): two concurrent injected WS connections with distinct
// streamSids/tokens produce two independent Sessions; per-call state never leaks across them
// (media timestamp, mark queue); closing one leaves the other live and functional. One real
// async `fastify.injectWS`-backed test per file (this test opens two connections within that one
// `it()`, which is fine — the environment quirk is about multiple *tests*, not multiple sockets
// within a single test) — see `twilio-media.inbound.test.ts`'s header comment for the rationale.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { logEvent } from './logger.js';
import { sessions } from './state.js';
import { registerTwilioMediaRoute, nextMarkName, sendMark, type TwilioMediaDeps } from './twilio-media.js';
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

function startFrame(overrides: { streamSid: string; callSid: string; token: string }) {
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

function mediaFrame(streamSid: string, timestamp: string) {
  return JSON.stringify({
    event: 'media',
    sequenceNumber: '3',
    streamSid,
    media: { track: 'inbound', chunk: '1', timestamp, payload: 'AQIDBA==' },
  });
}

function markFrame(streamSid: string, name: string) {
  return JSON.stringify({ event: 'mark', sequenceNumber: '4', streamSid, mark: { name } });
}

const connectedFrame = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });

beforeEach(() => {
  sessions.clear();
});

describe('registerTwilioMediaRoute — A10 isolation (FR-3)', () => {
  it('two concurrent connections: independent Sessions, no cross-call state leakage, independent teardown', async () => {
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-A', 'tok-B']) });
    try {
      const wsA = await app.injectWS('/twilio-media');
      const wsB = await app.injectWS('/twilio-media');

      wsA.send(connectedFrame);
      wsA.send(startFrame({ streamSid: 'MZ-A', callSid: 'CA-A', token: 'tok-A' }));
      wsB.send(connectedFrame);
      wsB.send(startFrame({ streamSid: 'MZ-B', callSid: 'CA-B', token: 'tok-B' }));

      await waitUntil(() => sessions.has('MZ-A') && sessions.has('MZ-B'));

      // A10: two independent Sessions in the registry.
      assert.equal(sessions.size, 2);
      assert.equal(onSessionStartCalls.length, 2);

      const sessionA = onSessionStartCalls.find((s) => s.streamSid === 'MZ-A');
      const sessionB = onSessionStartCalls.find((s) => s.streamSid === 'MZ-B');
      assert.ok(sessionA);
      assert.ok(sessionB);
      assert.notEqual(sessionA, sessionB);

      // media on one never mutates the other's latestMediaTimestamp.
      wsA.send(mediaFrame('MZ-A', '1000'));
      await waitUntil(() => sessionA.latestMediaTimestamp === 1000);
      assert.equal(sessionB.latestMediaTimestamp, 0);

      wsB.send(mediaFrame('MZ-B', '2000'));
      await waitUntil(() => sessionB.latestMediaTimestamp === 2000);
      assert.equal(sessionA.latestMediaTimestamp, 1000); // unchanged by B's media

      // marks on one never touch the other's markQueue.
      const nameA = nextMarkName(sessionA, 'rA');
      sendMark(sessionA, nameA);
      assert.deepEqual(sessionA.markQueue, [nameA]);
      assert.deepEqual(sessionB.markQueue, []);

      const nameB = nextMarkName(sessionB, 'rB');
      sendMark(sessionB, nameB);
      assert.deepEqual(sessionB.markQueue, [nameB]);
      assert.deepEqual(sessionA.markQueue, [nameA]); // unaffected by B's mark

      wsA.send(markFrame('MZ-A', nameA));
      await waitUntil(() => sessionA.markQueue.length === 0);
      assert.deepEqual(sessionB.markQueue, [nameB]); // still queued — A's echo didn't touch B

      // Closing one leaves the other in `sessions` and functional.
      wsA.terminate();
      await waitUntil(() => !sessions.has('MZ-A'));
      assert.equal(sessions.has('MZ-B'), true);

      wsB.send(mediaFrame('MZ-B', '3000'));
      await waitUntil(() => sessionB.latestMediaTimestamp === 3000);
      assert.equal(sessions.size, 1);

      wsB.terminate();
    } finally {
      await closeTestApp(app);
    }
  });
});

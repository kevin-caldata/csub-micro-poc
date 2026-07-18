// T03.4 — inbound `stop` dispatch: stop-then-close teardown matrix (Spec 03 R4/R7, A9). Split
// into its own file — see `twilio-media.inbound.test.ts`'s header comment for why.

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { logEvent } from './logger.js';
import { sessions } from './state.js';
import { registerTwilioMediaRoute, type TwilioMediaDeps } from './twilio-media.js';
import type { Session } from './sessions.js';

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
      assert.ok(session);
      let teardownCount = 0;
      session.onTeardown = () => {
        teardownCount += 1;
      };

      ws.send(stopFrame());
      // teardownSession runs synchronously inside the 'stop' message handler — sessions.delete
      // and the socket.close(1000, 'caller-hangup') call both happen before this resolves.
      await waitUntil(() => !sessions.has('MZ1'));
      assert.equal(teardownCount, 1);

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
      assert.equal(stopLines.length, 1, 'exactly one stream-stop line even though both stop and close fired');
      assert.equal(typeof stopLines[0]?.reason, 'string');
      assert.ok(!stopLines[0]?.abnormal, 'abnormal must be falsy: sawStop was true regardless of close code');
      assert.equal(teardownCount, 1, 'onTeardown still only once — the close-triggered teardownSession no-oped');
      assert.equal(sessions.size, 0);
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

// T03.5 — A11 (enabled half): with `twilioValidateUpgrade: true` and a mismatching
// `x-twilio-signature` header, the route calls `validateRequest` and logs the result (log-only —
// the connection MUST still proceed through the normal connected/start flow regardless of the
// mismatch). One real async `fastify.injectWS`-backed test per file — see
// `twilio-media.inbound.test.ts`'s header comment for why this repo splits these one-per-file.

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

const PUBLIC_HOST = 'example.ngrok.app';

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
    config: { publicHost: PUBLIC_HOST, twilioAuthToken: 'tok_test', twilioValidateUpgrade: true },
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

const connectedFrame = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });

beforeEach(() => {
  sessions.clear();
});

describe('registerTwilioMediaRoute — A11 upgrade-signature (enabled, mismatch)', () => {
  it('twilioValidateUpgrade:true + bogus signature header: connection proceeds normally, logs ok:false with the wss:// url used', async () => {
    const log = spyOnLog();
    const { app, onSessionStartCalls } = await buildTestApp({ claimPendingCall: stubClaim(['tok-1']) });
    try {
      const ws = await app.injectWS('/twilio-media', { headers: { 'x-twilio-signature': 'bogus' } });
      ws.send(connectedFrame);
      ws.send(startFrame());
      await waitUntil(() => sessions.has('MZ1'));

      // Log-only, never rejects: the connected/start flow completes as normal despite the
      // mismatching signature — session created, onSessionStart invoked.
      assert.equal(sessions.size, 1);
      assert.equal(onSessionStartCalls.length, 1);

      const lines = log.lines();
      const sigLines = lines.filter((l) => l.event === 'upgrade-signature');
      assert.equal(sigLines.length, 1);
      assert.equal(sigLines[0]?.present, true);

      const checkLines = lines.filter((l) => l.event === 'upgrade-signature-check');
      assert.equal(checkLines.length, 1);
      assert.equal(checkLines[0]?.ok, false);
      assert.equal(checkLines[0]?.url, `wss://${PUBLIC_HOST}/twilio-media`);

      ws.terminate();
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

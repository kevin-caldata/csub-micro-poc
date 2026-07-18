// T03.4 — inbound `media` dispatch: no-per-frame-logging half of A4 (Spec 03 R3 last paragraph,
// findings/09 rules — Railway 500 lines/s cap). Split into its own file — see
// `twilio-media.inbound.test.ts`'s header comment for why.

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

const connectedFrame = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });

beforeEach(() => {
  sessions.clear();
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
      assert.ok(session);
      let receivedCount = 0;
      session.onTwilioMedia = () => {
        receivedCount += 1;
      };

      ws.send(mediaFrame({ timestamp: '160' }));
      await waitUntil(() => receivedCount === 1);
      const lineCountAfterFirst = log.lines().length;
      assert.equal(log.lines().filter((l) => l.event === 'media-cadence').length, 1);

      for (let i = 0; i < 50; i += 1) {
        ws.send(mediaFrame({ timestamp: String(160 + (i + 1) * 20) }));
      }
      await waitUntil(() => receivedCount === 51);

      assert.equal(log.lines().length, lineCountAfterFirst, 'no new stdout lines from subsequent media frames');
      assert.equal(log.lines().filter((l) => l.event === 'media-cadence').length, 1);

      ws.terminate();
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

// T03.4 — inbound `media` dispatch (Spec 03 R4, A4).
//
// Same injectWS/stub-registry pattern as `twilio-media.test.ts` (T03.2) — duplicated locally
// (each test file in this repo is self-contained, matching `twilio-media.outbound.test.ts`'s
// precedent) rather than exported, to keep each spec's test file independently readable.
//
// `dtmf`, `mark` (A5), `stop` (A9), the socket-error case, and the no-per-frame-logging half of
// A4 each live in their own sibling file (`twilio-media.inbound-*.test.ts`), each holding exactly
// ONE `it()`, rather than as additional `describe()`s/`it()`s piled into one file. This is a
// deliberate environment workaround, not a Spec 03 semantics change — recorded in the T03.4
// completion report: `node:test`'s (v22.14.0, Windows) TAP reporter was observed to silently drop
// some `it()` results whenever a file/describe held two or more REAL async
// `fastify.injectWS`-backed tests together — reproduced deterministically (including via
// swap-testing the same two test bodies in reverse order and watching the vanishing follow
// different, seemingly race-dependent positions depending on the exact pair's content/timing —
// no simple ordering rule reliably fixed it), and even intermittently for the pre-existing
// `twilio-media.test.ts` run in isolation (its "A12 route hygiene" suite vanishes from
// `ok`/`not ok` output with zero `cancelled` count when that file is run standalone, though it
// resurfaces when run as part of the full `npm test` aggregate). The one pattern that was 100%
// reliable across dozens of repeated runs: a file/describe with exactly one `it()`. Since
// `tsx --test`/`node --test` runs each matched file in its own child process, one real async
// `it()` per file fully avoids the issue.

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { logEvent } from './logger.js';
import { sessions } from './state.js';
import { registerTwilioMediaRoute, type TwilioMediaDeps } from './twilio-media.js';
import type { Session } from './sessions.js';

// The compile-level "media.timestamp/chunk are declared string" assertion for A4 lives in
// src/type-assertions.ts, not here: tsconfig.json excludes src/**/*.test.ts from `tsc --noEmit`,
// and tsx --test's esbuild transform strips types without checking them, so a `@ts-expect-error`
// inside this file would be inert — see that module's header comment for the full rationale.
// This file keeps only the RUNTIME half of A4 (the `typeof === 'number'` assertion below).

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
      assert.ok(session);
      const received: string[] = [];
      session.onTwilioMedia = (payload) => received.push(payload);

      ws.send(mediaFrame({ timestamp: '12345', payload: 'AQIDBA==' }));
      await waitUntil(() => received.length === 1);

      assert.equal(session.latestMediaTimestamp, 12345);
      assert.equal(typeof session.latestMediaTimestamp, 'number');
      assert.equal(received[0], 'AQIDBA==');

      const cadenceLines = log.lines().filter((l) => l.event === 'media-cadence');
      assert.equal(cadenceLines.length, 1);
      assert.equal(cadenceLines[0]?.timestamp, 12345);
      assert.equal(cadenceLines[0]?.payloadBytes, Buffer.from('AQIDBA==', 'base64').length);
      assert.equal(cadenceLines[0]?.callSid, 'CA1');
      assert.equal(cadenceLines[0]?.streamSid, 'MZ1');

      ws.terminate();
    } finally {
      log.restore();
      await closeTestApp(app);
    }
  });
});

// FR-R (findings/18) — <Connect action> stream-reconnect flow: end-reason registry
// (src/reconnect.ts), POST /twiml-action (src/twiml.ts), STREAM_RECONNECT_MAX config, the
// expected-end marks on deliberate closes, and the reconnect-greeting selection seam
// (gateway.ts greetingInstructions / session.ts pendingCall.reconnectAttempt threading).
//
// Harness style mirrors twiml.routes.test.ts (minimal Fastify app + signed injects +
// captureStdout) and gateway.session-config.test.ts (startMockGateway frames).

import { describe, it, beforeEach, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import twilio from 'twilio'; // default-import + destructure: safe under both ESM and CJS emit (twilio is CJS)
const { getExpectedTwilioSignature } = twilio;
import { registerTwimlRoutes, pendingCalls, type MintFn, type PendingCall } from '../src/twiml.js';
import {
  callEndings,
  markAbnormalEnd,
  markExpectedEnd,
  sweepCallEndings,
  getCallEnding,
  CALL_ENDING_TTL_MS,
} from '../src/reconnect.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import {
  openGatewayLeg,
  RECONNECT_GREETING_INSTRUCTIONS,
  type MintResult,
  type GatewayLegCallbacks,
} from '../src/gateway.js';
import type { OpenGatewayLegOptions, GatewayLeg } from '../src/gateway.js';
import { startMockGateway } from './gateway.mock.js';
import { createSession, type Session } from '../src/sessions.js';
import { playFallbackAndCloseWith } from '../src/fallback.js';
import { startSessionBridge } from '../src/session.js';

const BASE = {
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
};

/** Same fixture shape as twiml.routes.test.ts, parameterized on streamReconnectMax. */
function makeConfig(streamReconnectMax = 2): AppConfig {
  return {
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
    tokenTtlSeconds: 300,
    gatewayHandshakeTimeoutMs: 5000,
    gatewayPingSeconds: 0,
    waitForSessionUpdated: false,
    gatewayTags: undefined,
    streamReconnectMax,
  } as AppConfig;
}

async function buildTestApp(config: AppConfig, mint?: MintFn): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(formbody);
  registerTwimlRoutes(app, config, { mint: mint ?? (async () => ({ token: 'vcst_fake', url: 'wss://gw.example/x' })) });
  return app;
}

function signFor(config: AppConfig, path: string, params: Record<string, string>): string {
  return getExpectedTwilioSignature(config.twilioAuthToken, `https://${config.publicHost}${path}`, params);
}

/** POST /twiml-action with a valid signature; returns the raw inject response. */
async function postAction(app: FastifyInstance, config: AppConfig, params: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/twiml-action',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signFor(config, '/twiml-action', params),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

/** Wraps process.stdout.write to capture logEvent()'s minified-JSON lines; always restore in `finally`. */
function captureStdout(): { lines: () => Record<string, unknown>[]; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any) => {
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

/** Polls `pred` until true or `timeoutMs` elapses; throws on timeout (avoids fixed sleeps). */
async function waitUntil(pred: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const OPEN = 1;
const CLOSED = 3;

/** Minimal fake Twilio socket + Session (fallback.test.ts's fakeSocket/makeSession pattern). */
function makeFakeSession(opts: { callSid?: string; readyState?: number } = {}): Session {
  const socket = {
    readyState: opts.readyState ?? CLOSED,
    bufferedAmount: 0,
    send() {},
    close() {},
    ping() {},
    on() {},
    off() {},
  };
  return createSession({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    twilioWs: socket as any,
    streamSid: 'MZrec',
    callSid: opts.callSid ?? 'CArec',
    log: () => {},
  });
}

beforeEach(() => {
  pendingCalls.clear();
  callEndings.clear();
});

describe('STREAM_RECONNECT_MAX config (R1)', () => {
  it('defaults to 2', () => {
    expect(loadConfig({ ...BASE }).streamReconnectMax).toBe(2);
  });

  it('parses 0 (reconnect disabled)', () => {
    expect(loadConfig({ ...BASE, STREAM_RECONNECT_MAX: '0' }).streamReconnectMax).toBe(0);
  });

  it('rejects negative and non-integer values', () => {
    expect(() => loadConfig({ ...BASE, STREAM_RECONNECT_MAX: '-1' })).toThrow();
    expect(() => loadConfig({ ...BASE, STREAM_RECONNECT_MAX: '1.5' })).toThrow();
  });
});

describe('end-reason registry (R2)', () => {
  it('markAbnormalEnd records an abnormal end with attempts 0', () => {
    markAbnormalEnd('CA1');
    expect(getCallEnding('CA1')).toMatchObject({ endReason: 'abnormal', attempts: 0 });
  });

  it("precedence: an 'expected' mark is not overwritten by a later 'abnormal' observation", () => {
    markExpectedEnd('CA2'); // e.g. fallback.ts marks BEFORE closing ...
    markAbnormalEnd('CA2'); // ... then the non-1000 close code is observed by the close handler
    expect(getCallEnding('CA2')!.endReason).toBe('expected');
  });

  it("a deliberate end after a reconnect flips 'abnormal' to 'expected' (reverse IS allowed)", () => {
    markAbnormalEnd('CA3');
    const entry = getCallEnding('CA3')!;
    entry.attempts = 1; // as /twiml-action would after granting a reconnect
    markExpectedEnd('CA3'); // caller hangs up on the reconnected stream
    expect(getCallEnding('CA3')).toMatchObject({ endReason: 'expected', attempts: 1 });
  });

  it('TTL sweep evicts stale entries (sweep-on-access, no timers)', () => {
    markAbnormalEnd('CA-stale');
    markAbnormalEnd('CA-fresh');
    callEndings.get('CA-stale')!.updatedAt = Date.now() - CALL_ENDING_TTL_MS - 1000;
    sweepCallEndings();
    expect(callEndings.has('CA-stale')).toBe(false);
    expect(callEndings.has('CA-fresh')).toBe(true);
  });

  it('empty callSid is a no-op (pre-start closes have nothing to key on)', () => {
    markAbnormalEnd('');
    markExpectedEnd('');
    expect(callEndings.size).toBe(0);
  });
});

describe('POST /twiml-action (R4)', () => {
  it('403 on missing signature, 403 on bad signature, one warn line each; no TwiML leaks', async () => {
    const config = makeConfig();
    const app = await buildTestApp(config);
    markAbnormalEnd('CA-sig'); // even an abnormal entry must not be reachable unsigned

    const capture = captureStdout();
    let missing, bad;
    try {
      missing = await app.inject({
        method: 'POST',
        url: '/twiml-action',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ CallSid: 'CA-sig' }).toString(),
      });
      bad = await app.inject({
        method: 'POST',
        url: '/twiml-action',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': 'totally-wrong-signature',
        },
        payload: new URLSearchParams({ CallSid: 'CA-sig' }).toString(),
      });
    } finally {
      capture.restore();
    }

    expect(missing!.statusCode).toBe(403);
    expect(bad!.statusCode).toBe(403);
    expect(missing!.body.includes('<Connect')).toBe(false);
    const warnLines = capture.lines().filter((l) => l.event === 'twiml-action-bad-signature');
    expect(warnLines.length).toBe(2);
    expect(pendingCalls.size).toBe(0); // no token minted on a rejected request

    await app.close();
  });

  it('unknown CallSid: empty <Response/> (ends the call) + stream-reconnect-declined unknown-call', async () => {
    const config = makeConfig();
    const app = await buildTestApp(config);

    const capture = captureStdout();
    let res;
    try {
      res = await postAction(app, config, { CallSid: 'CA-never-seen' });
    } finally {
      capture.restore();
    }

    expect(res!.statusCode).toBe(200);
    expect(String(res!.headers['content-type'])).toMatch(/text\/xml/);
    expect(res!.body).toContain('<Response/>');
    expect(res!.body.includes('<Connect')).toBe(false);

    const declined = capture.lines().filter((l) => l.event === 'stream-reconnect-declined');
    expect(declined.length).toBe(1);
    expect(declined[0]!.reason).toBe('unknown-call');
    expect(declined[0]!.level).toBe('info');

    await app.close();
  });

  it('abnormal end under the cap: fresh <Connect action> TwiML with token + reconnect parameters, new pendingCalls entry, warn log', async () => {
    const config = makeConfig(2);
    const app = await buildTestApp(config);
    markAbnormalEnd('CA-drop');

    const capture = captureStdout();
    let res;
    try {
      res = await postAction(app, config, { CallSid: 'CA-drop' });
    } finally {
      capture.restore();
    }

    expect(res!.statusCode).toBe(200);
    expect(String(res!.headers['content-type'])).toMatch(/text\/xml/);
    const body = res!.body;

    const connectTag = body.match(/<Connect[^>]*>/)?.[0];
    expect(connectTag, 'expected a <Connect ...> tag').toBeTruthy();
    expect(connectTag).toContain(`action="https://${config.publicHost}/twiml-action"`);
    expect(connectTag).toContain('method="POST"');
    expect(body).toContain(`<Stream url="wss://${config.publicHost}/twilio-media"`);
    expect(body).toContain(`statusCallback="https://${config.publicHost}/stream-status"`);

    const tokenMatch = body.match(/<Parameter name="token" value="([^"]+)"/);
    expect(tokenMatch, 'expected a token <Parameter>').toBeTruthy();
    expect(body).toMatch(/<Parameter name="reconnect" value="1"/);

    // The mint/pendingCalls flow is the same one /twiml uses — entry keyed by the emitted token.
    const entry = pendingCalls.get(tokenMatch![1]!) as PendingCall | undefined;
    expect(entry, 'pendingCalls entry stored under the emitted token').toBeTruthy();
    expect(entry!.callSid).toBe('CA-drop');
    expect(entry!.reconnectAttempt).toBe(1);

    expect(getCallEnding('CA-drop')!.attempts).toBe(1);

    const reconnectLines = capture.lines().filter((l) => l.event === 'stream-reconnect');
    expect(reconnectLines.length).toBe(1);
    expect(reconnectLines[0]!.level).toBe('warn');
    expect(reconnectLines[0]!.callSid).toBe('CA-drop');
    expect(reconnectLines[0]!.attempt).toBe(1);

    await app.close();
  });

  it('cap honored across successive callbacks: attempt 1, attempt 2, then attempts-exhausted', async () => {
    const config = makeConfig(2);
    const app = await buildTestApp(config);
    markAbnormalEnd('CA-cap');

    const first = await postAction(app, config, { CallSid: 'CA-cap' });
    expect(first.body).toMatch(/<Parameter name="reconnect" value="1"/);

    const second = await postAction(app, config, { CallSid: 'CA-cap' });
    expect(second.body).toMatch(/<Parameter name="reconnect" value="2"/);

    const capture = captureStdout();
    let third;
    try {
      third = await postAction(app, config, { CallSid: 'CA-cap' });
    } finally {
      capture.restore();
    }
    expect(third!.body.includes('<Connect')).toBe(false);
    expect(third!.body).toContain('<Response/>');
    const declined = capture.lines().filter((l) => l.event === 'stream-reconnect-declined');
    expect(declined.length).toBe(1);
    expect(declined[0]!.reason).toBe('attempts-exhausted');

    await app.close();
  });

  it("expected end: empty <Response/> + declined reason 'expected-end' (no reconnect for deliberate closes)", async () => {
    const config = makeConfig(2);
    const app = await buildTestApp(config);
    markExpectedEnd('CA-bye');

    const capture = captureStdout();
    let res;
    try {
      res = await postAction(app, config, { CallSid: 'CA-bye' });
    } finally {
      capture.restore();
    }

    expect(res!.body.includes('<Connect')).toBe(false);
    const declined = capture.lines().filter((l) => l.event === 'stream-reconnect-declined');
    expect(declined.length).toBe(1);
    expect(declined[0]!.reason).toBe('expected-end');

    await app.close();
  });

  it("STREAM_RECONNECT_MAX=0 disables reconnect: empty <Response/> even for an abnormal end (reason 'disabled')", async () => {
    const config = makeConfig(0);
    const app = await buildTestApp(config);
    markAbnormalEnd('CA-off');

    const capture = captureStdout();
    let res;
    try {
      res = await postAction(app, config, { CallSid: 'CA-off' });
    } finally {
      capture.restore();
    }

    expect(res!.body.includes('<Connect')).toBe(false);
    expect(res!.body).toContain('<Response/>');
    const declined = capture.lines().filter((l) => l.event === 'stream-reconnect-declined');
    expect(declined.length).toBe(1);
    expect(declined[0]!.reason).toBe('disabled');
    expect(getCallEnding('CA-off')!.attempts).toBe(0); // never incremented while disabled

    await app.close();
  });
});

describe('abnormal/expected marking at the observation points (R2 population)', () => {
  it('/stream-status stream-error marks the CallSid abnormal (before any terminate)', async () => {
    const config = makeConfig();
    const app = await buildTestApp(config);

    const capture = captureStdout(); // silence the stream-status error line
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/stream-status',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          StreamEvent: 'stream-error',
          StreamError: 'Stream signal error, code: 31924',
          CallSid: 'CA-31924',
          StreamSid: 'MZ-31924',
        }).toString(),
      });
      expect(res.statusCode).toBe(204);
    } finally {
      capture.restore();
    }

    expect(getCallEnding('CA-31924')).toMatchObject({ endReason: 'abnormal', attempts: 0 });

    await app.close();
  });

  it('/stream-status non-error events do not touch the registry', async () => {
    const config = makeConfig();
    const app = await buildTestApp(config);

    const capture = captureStdout();
    try {
      await app.inject({
        method: 'POST',
        url: '/stream-status',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          StreamEvent: 'stream-stopped',
          CallSid: 'CA-normal',
          StreamSid: 'MZ-normal',
        }).toString(),
      });
    } finally {
      capture.restore();
    }

    expect(getCallEnding('CA-normal')).toBe(undefined);

    await app.close();
  });

  it("fallback.ts's deliberate close marks expected BEFORE closing — and it survives a later abnormal observation (no reconnect loop)", async () => {
    const session = makeFakeSession({ callSid: 'CA-fb', readyState: OPEN });
    session.markQueue.length = 0;

    await playFallbackAndCloseWith(session, { clipB64: 'aGVsbG8=', timeoutMs: 50, pollMs: 10 });

    expect(getCallEnding('CA-fb')!.endReason).toBe('expected');
    // The code-less close() reads back as a non-1000 close code — the close handler's
    // markAbnormalEnd must NOT flip this call back to abnormal (loop guard).
    markAbnormalEnd('CA-fb');
    expect(getCallEnding('CA-fb')!.endReason).toBe('expected');
  });
});

describe('reconnect greeting selection (R5)', () => {
  it('openGatewayLeg: greetingInstructions override reaches the greeting response-create frame', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const noop: GatewayLegCallbacks = {
      onOpen: () => {
        opened = true;
      },
      onOpenFailed: () => {},
      onEvent: () => {},
      onClose: () => {
        closed = true;
      },
    };
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-rg',
      tools: [],
      formats: { inputAudioFormat: { type: 'audio/pcmu' }, outputAudioFormat: { type: 'audio/pcmu' } },
      config: cfg,
      callbacks: noop,
      greetingInstructions: RECONNECT_GREETING_INSTRUCTIONS,
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 2);
      const frame2 = mock1.frames[1] as Record<string, unknown>;
      expect(frame2.type).toBe('response-create');
      expect((frame2.options as Record<string, unknown>).instructions).toBe(RECONNECT_GREETING_INSTRUCTIONS);
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });

  it('openGatewayLeg: absent override keeps the standard greeting (bit-identical fresh-call path)', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-std',
      tools: [],
      formats: { inputAudioFormat: { type: 'audio/pcmu' }, outputAudioFormat: { type: 'audio/pcmu' } },
      config: cfg,
      callbacks: {
        onOpen: () => {
          opened = true;
        },
        onOpenFailed: () => {},
        onEvent: () => {},
        onClose: () => {
          closed = true;
        },
      },
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 2);
      const frame2 = mock1.frames[1] as Record<string, unknown>;
      const instructions = (frame2.options as Record<string, unknown>).instructions as string;
      expect(instructions).toContain('Thanks for calling Cal State Bakersfield!');
      expect(instructions).not.toBe(RECONNECT_GREETING_INSTRUCTIONS);
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });

  it('startSessionBridge threads pendingCall.reconnectAttempt -> greetingInstructions (and omits it for fresh calls)', async () => {
    const cfg = loadConfig({ ...BASE });
    const captured: Array<string | undefined> = [];
    const fakeLeg: GatewayLeg = {
      send: async () => {},
      appendAudio: async () => {},
      isOpen: false,
      close: () => {},
    };
    const fakeOpen = (opts: OpenGatewayLegOptions): GatewayLeg => {
      captured.push(opts.greetingInstructions);
      return fakeLeg;
    };
    const deps = {
      config: cfg,
      openGatewayLeg: fakeOpen as typeof openGatewayLeg,
      createMcpClient: async () => {
        throw new Error('no MCP in this test'); // degraded path: session continues without tools
      },
      fetchToolDefs: async () => [],
    };
    const mkPending = (reconnectAttempt?: number): PendingCall => ({
      callSid: 'CA-thread',
      createdAt: Date.now(),
      gatewayAuth: Promise.resolve({ token: 'tok', url: 'wss://gw.example/x' }),
      ...(reconnectAttempt !== undefined ? { reconnectAttempt } : {}),
    });

    const capture = captureStdout(); // silence mcp-client-failed error lines
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await startSessionBridge(makeFakeSession({ callSid: 'CA-thread' }), mkPending(1), deps as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await startSessionBridge(makeFakeSession({ callSid: 'CA-thread' }), mkPending(), deps as any);
    } finally {
      capture.restore();
    }

    expect(captured).toEqual([RECONNECT_GREETING_INSTRUCTIONS, undefined]);
  });
});

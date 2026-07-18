// T10.6 — offline integration harness (Spec 10 R12 / A6).
//
// Boots the REAL Fastify app (buildApp, src/server.ts) in-process on an ephemeral loopback
// port, against the fake gateway (test/fakes/fake-gateway.ts, T10.5) and the fake Twilio client
// (test/fakes/fake-twilio.ts, T10.5), and drives one full scripted call end to end through the
// real bridge (session.ts/gateway.ts/twilio-media.ts/tools.ts) with ZERO network access — every
// socket in this file talks to 127.0.0.1.
//
// Two seams make this possible with no real Vercel/Twilio traffic:
//   1. `GATEWAY_WS_URL` (Spec 10 R10, src/config.ts + src/gateway.ts) — bypasses
//      mintRealtimeToken/getWebSocketConfig entirely; openGatewayLeg dials the fake gateway
//      directly.
//   2. `buildApp`'s additive `deps.twiml.mint` seam (this task's own deviation-by-design, see
//      src/server.ts's doc comment on `BuildAppDeps` for the full rationale) — GATEWAY_WS_URL
//      does NOT bypass the mint call (mintRealtimeToken itself hits the real gateway's HTTP
//      token-mint endpoint), so a fake `mint` is threaded down to registerTwimlRoutes to avoid
//      that live network call.

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { MintFn } from '../src/twiml.js';
import { createMcpClient, closeMcpClient, fetchToolDefs } from '../src/tools.js';
import { startFakeGateway, type FakeGatewayHandle, type FakeGatewayScenario } from './fakes/fake-gateway.js';
import { runFakeCall, type CallCapture, type CallScript } from './fakes/fake-twilio.js';

expect(globalThis.window).toBe(undefined); // G6 guard — plain node environment, never jsdom

const AUTH_TOKEN = 'test-harness-token';

// ── Global (h): zero unhandled rejections, zero stray stderr writes, for the WHOLE file ──────

let unhandled: unknown[] = [];
function onUnhandledRejection(err: unknown): void {
  unhandled.push(err);
}

let stderrCalls: unknown[][] = [];
let originalStderrWrite: typeof process.stderr.write;

beforeAll(() => {
  process.on('unhandledRejection', onUnhandledRejection);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (...args: unknown[]) => {
    stderrCalls.push(args);
    return true;
  };
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandledRejection);
  process.stderr.write = originalStderrWrite;
});

afterEach(() => {
  expect(unhandled, 'no unhandled rejection during this scenario (R12 h)').toEqual([]);
  expect(stderrCalls, 'no stray stderr writes during this scenario (R12 h)').toEqual([]);
  unhandled = [];
  stderrCalls = [];
});

/** Wraps process.stdout.write to capture logEvent()'s minified-JSON lines; always restore. */
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

interface Harness {
  fakeGw: FakeGatewayHandle;
  app: FastifyInstance;
  shutdown: (signal: string) => Promise<void>;
  config: AppConfig;
  baseUrl: string;
  publicHost: string;
}

/**
 * Boots the real app in-process against a fresh fake gateway scripted per `scenario`. Env is set
 * via `loadConfig`'s override-map parameter (never `process.env` mutation — avoids cross-test
 * leakage). `config.port`/`config.publicHost` are mutated AFTER `app.listen` resolves the real
 * ephemeral port — safe because every consumer (registerTwimlRoutes' /twiml handler,
 * startSessionBridge's MCP-client port) reads them at request time, not at boot time.
 */
async function bootHarness(scenario: FakeGatewayScenario = {}): Promise<Harness> {
  const fakeGw = await startFakeGateway({ scenario });

  const config = loadConfig({
    AI_GATEWAY_API_KEY: 'test-harness-key',
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    PUBLIC_HOST: 'localhost', // placeholder — corrected below once the real port is known
    AUDIO_MODE: 'pcmu',
    // PORT is left at its default — this harness never reads config.port until AFTER
    // app.listen({port: 0, ...}) below resolves the real ephemeral port and mutates it in.
    GATEWAY_WS_URL: `ws://127.0.0.1:${fakeGw.port}`,
  } as unknown as NodeJS.ProcessEnv);

  // Fake mint — R10's GATEWAY_WS_URL override bypasses openGatewayLeg's use of mint.url/token
  // entirely (src/gateway.ts), so the values here are never actually dialed; this only exists to
  // avoid mintRealtimeToken's real network call to the Vercel AI Gateway (see file header).
  const fakeMint: MintFn = async () => ({ token: 'fake-vcst-token', url: config.gatewayWsUrl! });

  const { app, shutdown } = await buildApp(config, undefined, { twiml: { mint: fakeMint } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  config.port = port;
  config.publicHost = `127.0.0.1:${port}`;

  return { fakeGw, app, shutdown, config, baseUrl: `http://127.0.0.1:${port}`, publicHost: config.publicHost };
}

async function teardownHarness(h: Harness): Promise<void> {
  await h.shutdown('SIGINT').catch(() => {});
  await h.app.close().catch(() => {});
  await h.fakeGw.close();
}

/** True for a normalized client->server frame of the given `type` (never an array frame). */
function isFrame(x: unknown, type: string): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && (x as Record<string, unknown>).type === type;
}

// ── Baseline scenario: greeting order, per-frame append passthrough, media/mark pairing, ──────
// ── live-/mcp tool mapping, clean teardown with the stream-stop summary (R12 a/b/c/d/g) ───────

describe('harness — baseline call (R12 a, b, c, d, g)', () => {
  let h: Harness;
  let capture: CallCapture;
  let expectedTools: Array<{ type: 'function'; name: string; description?: string; parameters: Record<string, unknown> }>;
  let logLines: Record<string, unknown>[];

  beforeAll(async () => {
    h = await bootHarness({});

    // Independent /mcp round trip (assertion a: tools "came from the live /mcp route") — a
    // SEPARATE MCP client from the one startSessionBridge creates for the call itself.
    const mcpClient = await createMcpClient(h.config.port);
    expectedTools = await fetchToolDefs(mcpClient);
    await closeMcpClient(mcpClient);

    const stdout = captureStdout();
    try {
      capture = await runFakeCall({
        baseUrl: h.baseUrl,
        authToken: AUTH_TOKEN,
        publicHost: h.publicHost,
        script: { mediaFrameCount: 45, postMediaWaitMs: 900 } satisfies CallScript,
      });
      // `stop` triggers teardownSession synchronously (twilio-media.ts), but the resulting
      // Twilio-leg WS 'close' event (and its own 'stream-stop' log line) and the gateway leg's
      // close fire asynchronously a tick or two later — after runFakeCall's own ws.close() has
      // already resolved its promise. Give them a moment to land before the spy is restored.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      logLines = stdout.lines();
      stdout.restore();
    }
  });

  afterAll(async () => {
    await teardownHarness(h);
  });

  it('(a) session-update is the first gateway message; config.tools came from the live /mcp route with $schema stripped', () => {
    expect(expectedTools.length, 'sanity: the live /mcp route must actually list tools').toBeGreaterThan(0);
    const first = h.fakeGw.received[0];
    expect(isFrame(first, 'session-update')).toBe(true);
    const config = (first as Record<string, unknown>).config as Record<string, unknown>;
    expect(config.tools).toEqual(expectedTools);
    for (const tool of config.tools as Array<{ parameters: Record<string, unknown> }>) {
      expect('$schema' in tool.parameters, `$schema must never reach session-update.tools (tool ${JSON.stringify(tool)})`).toBe(false);
    }
  });

  it('(b) greeting response-create follows session-update', () => {
    expect(isFrame(h.fakeGw.received[1], 'response-create')).toBe(true);
  });

  it('(c) inbound media frames arrive as input-audio-append with byte-identical base64 (Path A identity)', () => {
    const appends = h.fakeGw.received.filter((f) => isFrame(f, 'input-audio-append')) as Array<{ audio: string }>;
    expect(appends.length, 'at least most of the streamed frames should survive the bootstrap window').toBeGreaterThan(20);
    const silence = Buffer.alloc(160, 0xff).toString('base64');
    for (const a of appends) {
      expect(a.audio).toBe(silence); // pcmu mode: zero-copy passthrough, never re-encoded
    }
  });

  it('(d) every audio-delta reaches fake-Twilio as a media message followed by its mark', () => {
    expect(capture.media.length, 'greeting (3 deltas) + the VAD turn (3 deltas) worth of media').toBeGreaterThanOrEqual(3);
    expect(capture.marks.length).toBe(capture.media.length); // one mark per delta, 1:1 (Spec 03 R5/R6)
    const n = Math.min(capture.media.length, capture.marks.length);
    for (let i = 0; i < n; i++) {
      expect(
        capture.marks[i]!.receivedAtMs >= capture.media[i]!.receivedAtMs,
        `mark #${i} must not be observed before its media #${i} (sendMedia then pushMark, same synchronous dispatch — Spec 03 R5)`,
      ).toBe(true);
    }
  });

  it('(g) stop tears down both legs and emits the stream-stop summary with ttfbP50/turns', () => {
    const summary = logLines.find((l) => l.event === 'stream-stop' && 'ttfbP50' in l);
    expect(summary, 'expected the TurnRecorder stream-stop summary line (Spec 08 R12)').toBeTruthy();
    expect(typeof summary!.turns).toBe('number');
    expect((summary!.turns as number) >= 1, 'the completed VAD turn must be counted').toBe(true);
    expect(typeof summary!.ttfbP50).toBe('number'); // numeric only because ≥1 eligible turn exists

    const twilioClose = logLines.find((l) => l.event === 'stream-stop' && 'code' in l);
    expect(twilioClose, 'expected twilio-media.ts\'s own stream-stop (WS close) line').toBeTruthy();

    const gatewayClose = logLines.find((l) => l.event === 'gateway-close');
    expect(gatewayClose, 'expected the gateway leg to have been closed by session teardown').toBeTruthy();
  });
});

// ── Barge-in scenario (R12 e) — see the CAPTURED FINDING note below ───────────────────────────
//
// FINDING (captured for escalation, not a T05/T07 wiring bug — see this task's Completion
// Report): the fixed fake-gateway.ts `DELTA_CADENCE_MS` (50 ms per step) sending 160-byte
// (20 ms-of-audio) deltas, combined with fake-twilio.ts's continuous-real-time playhead model
// (`playheadAtMs` advances only by bytes actually received, starting from call-open), means
// audio is scripted to arrive SLOWER than it plays out. Empirically instrumented against the
// live `Session` (polling `s.markQueue`/`s.responseStartTimestamp` every 5 ms via `src/state.js`
// while running this exact scenario): the barge-in-eligible response's first (and only, before
// the scripted interrupt) delta's mark is echoed back — disarming the truncate epoch — within
// single-digit ms of being sent, i.e. well inside the fixed 50 ms wait before fake-gateway's
// scripted `speech-started` fires. This reproduced on every run, at every `mediaFrameCount`
// tried (30-70) — it is a deterministic property of the two already-built T10.5 fixtures'
// timing constants, not a race. By the time the interrupt fires, `Session.responseStartTimestamp`
// is already `null` (fully drained) — the CORRECT, spec-mandated, already-unit-tested outcome
// for that state (`test/bargein.test.ts` "response-created seen, no delta yet: clear sent, NO
// truncate") is: `clear` sent (a response is still active), no `conversation-item-truncate`.
// Forcing a genuine "audio still buffered" state would require changing fake-gateway.ts's
// cadence/frame-size constants or fake-twilio.ts's playhead model — both pinned T10.5
// interfaces/behavior this task was not chartered to alter. R12(e)'s literal "clear precedes
// truncate with correct audioEndMs" is therefore NOT exercised by this harness; what IS proven
// below is the (correct) clear-without-truncate branch of the same bargeIn() code path.

describe('harness — barge-in scenario (R12 e — partially blocked, see FINDING above)', () => {
  let h: Harness;
  let capture: CallCapture;
  let logLines: Record<string, unknown>[];

  beforeAll(async () => {
    h = await bootHarness({ bargeIn: true });
    const stdout = captureStdout();
    try {
      capture = await runFakeCall({
        baseUrl: h.baseUrl,
        authToken: AUTH_TOKEN,
        publicHost: h.publicHost,
        script: { mediaFrameCount: 70, postMediaWaitMs: 900 } satisfies CallScript,
      });
      await new Promise((r) => setTimeout(r, 200)); // see the baseline describe's identical note
    } finally {
      logLines = stdout.lines();
      stdout.restore();
    }
  });

  afterAll(async () => {
    await teardownHarness(h);
  });

  it('the mid-response speech-started reaches bargeIn(): clear IS sent to the Twilio leg', () => {
    expect(capture.clears.length, 'expected at least one clear from the scripted mid-response interrupt').toBeGreaterThanOrEqual(1);
  });

  it('no conversation-item-truncate is sent (epoch already drained — the documented FINDING, not a bug) and the call still ends cleanly', () => {
    const truncate = h.fakeGw.received.find((f) => isFrame(f, 'conversation-item-truncate'));
    expect(truncate, 'see FINDING above: this fixture pairing cannot leave audio buffered at the interrupt point').toBeUndefined();
    // The interrupted response never reaches response-done here (fake-gateway's `ackTruncate`
    // is what would send it, and it never fires without a truncate to ack) — so the TurnRecorder
    // summary legitimately has 0 eligible turns (no ttfbP50 key at all — pct() of an empty array
    // is undefined, dropped by JSON.stringify). Assert the summary line itself still exists.
    const summary = logLines.find((l) => l.event === 'stream-stop' && typeof l.turns === 'number');
    expect(summary, 'clean teardown even though the barge-in produced no truncate').toBeTruthy();
  });
});

// ── Tool-call scenario: real MCP round trip, exactly one gated follow-up response-create ──────
// ── (R12 f) ──────────────────────────────────────────────────────────────────────────────────

describe('harness — tool-call scenario (R12 f)', () => {
  let h: Harness;
  let capture: CallCapture;

  beforeAll(async () => {
    h = await bootHarness({ toolCall: true });
    capture = await runFakeCall({
      baseUrl: h.baseUrl,
      authToken: AUTH_TOKEN,
      publicHost: h.publicHost,
      script: { mediaFrameCount: 30, postMediaWaitMs: 900 } satisfies CallScript,
    });
  });

  afterAll(async () => {
    await teardownHarness(h);
  });

  it('the real MCP round trip produced conversation-item-create(function-call-output) then exactly one response-create', () => {
    const itemCreateIdx = h.fakeGw.received.findIndex((f) => isFrame(f, 'conversation-item-create'));
    expect(itemCreateIdx, 'expected a conversation-item-create frame').toBeGreaterThanOrEqual(0);

    const itemCreate = h.fakeGw.received[itemCreateIdx] as { item: Record<string, unknown> };
    expect(itemCreate.item.type).toBe('function-call-output');
    expect(itemCreate.item.name).toBe('hello');
    // Real MCP round trip (not a stub): src/mcp-server.ts's `hello` tool returns this exact text.
    const output = JSON.parse(itemCreate.item.output as string) as { content: Array<{ text: string }> };
    expect(output.content[0]!.text).toBe('Hello, Kevin!');

    const responseCreatesAfter = h.fakeGw.received
      .slice(itemCreateIdx + 1)
      .filter((f) => isFrame(f, 'response-create'));
    expect(responseCreatesAfter.length, 'exactly one gated follow-up response-create (findings/04 G7)').toBe(1);
  });

  it('a follow-up audio response played to the Twilio leg', () => {
    expect(capture.media.length, 'the follow-up response\'s deltas must have reached Twilio').toBeGreaterThan(0);
  });
});

// ── Anomaly scenario: array frame, benign error, unmapped custom — all survive; clean end ─────

describe('harness — anomaly scenario (array frame + benign error + unmapped custom)', () => {
  let h: Harness;
  let capture: CallCapture;
  let logLines: Record<string, unknown>[];

  beforeAll(async () => {
    h = await bootHarness({ arrayFrame: true, benignError: true, unmappedCustom: true });
    const stdout = captureStdout();
    try {
      capture = await runFakeCall({
        baseUrl: h.baseUrl,
        authToken: AUTH_TOKEN,
        publicHost: h.publicHost,
        script: { mediaFrameCount: 30, postMediaWaitMs: 900 } satisfies CallScript,
      });
      await new Promise((r) => setTimeout(r, 200)); // see the baseline describe's identical note
    } finally {
      logLines = stdout.lines();
      stdout.restore();
    }
  });

  afterAll(async () => {
    await teardownHarness(h);
  });

  it('the JSON-array frame\'s two custom events are both processed (no throw, no crash)', () => {
    // session.ts's dispatch logs these as message:'custom event', event:'custom' (the `event`
    // field is NOT the literal string 'custom event' — see src/session.ts's `case 'custom'`).
    const customCreated = logLines.find((l) => l.event === 'custom' && l.rawType === 'conversation.created');
    const customRetrieved = logLines.find((l) => l.event === 'custom' && l.rawType === 'conversation.item.retrieved');
    expect(customCreated, 'array frame element 1 must have been dispatched').toBeTruthy();
    expect(customRetrieved, 'array frame element 2 must have been dispatched').toBeTruthy();
  });

  it('the benign error is logged and survives (no teardown triggered by it)', () => {
    const benignLine = logLines.find(
      (l) => l.event === 'error' && typeof l.message === 'string' && (l.message as string).includes('no active response'),
    );
    expect(benignLine, 'expected the benign-error whitelist path (warn, not teardown)').toBeTruthy();
    expect(benignLine!.level).toBe('warn');
  });

  it('the unmapped custom event is ignored (no error-level line for it) and the call still ends cleanly', () => {
    const rateLimitsLines = logLines.filter((l) => l.event === 'custom' && l.rawType === 'rate_limits.updated');
    // session.ts's dispatch deliberately no-ops rate_limits.updated (findings/04 G8) — it must
    // never surface as its own 'custom event' info line (that would mean the ignore-list broke).
    expect(rateLimitsLines.length).toBe(0);
    const errorLevelForRateLimits = logLines.filter(
      (l) => l.level === 'error' && String(l.rawType ?? '').includes('rate_limits'),
    );
    expect(errorLevelForRateLimits.length).toBe(0);

    const summary = logLines.find((l) => l.event === 'stream-stop' && 'ttfbP50' in l);
    expect(summary, 'clean teardown: the stream-stop summary must still be emitted').toBeTruthy();
    expect(capture.clears.length).toBe(0); // no barge-in scripted in this scenario
  });
});

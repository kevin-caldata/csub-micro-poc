// T05.2 — dispatch()/handleTwilioMedia() unit suite (Spec 05 A7, A13, A14-runtime, A3-partial).
// Pure-logic module, no fastify.injectWS anywhere in this file (same exemption as
// bargein.test.ts: the "one injectWS-backed test per file" rule only targets heavy WS-server
// suites). Fake Session built on the real `createSession` (never a hand-rolled competing shape),
// with fake gateway/transcoder/socket spies in the same style as bargein.test.ts.

import { describe, it, expect } from 'vitest';
import { dispatch, handleTwilioMedia } from '../src/session.js';
import { onMarkEcho } from '../src/bargein.js';
import { createSession, type Session } from '../src/sessions.js';
import { TurnRecorder } from '../src/latency.js';
import { ToolLoop } from '../src/tools.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';

/** Flushes pending microtasks/macrotasks queued by ToolLoop's async continuations (same helper
 *  shape as test/tool-loop.test.ts's own `flush`). */
function flush(times = 6): Promise<void> {
  return times <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => setImmediate(() => flush(times - 1).then(resolve)));
}

/** A fake MCP `Client` whose `callTool` always succeeds with a text result (mirrors
 *  test/tool-loop.test.ts's `fakeClient`). */
function fakeMcpClient(): Client {
  return { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) } as unknown as Client;
}

const OPEN = 1;
const CLOSING = 2;

interface FakeSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  closedWith?: { code?: number; reason?: string };
}

function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  const socket: FakeSocket = {
    readyState: OPEN,
    bufferedAmount: 0,
    sent,
    send(data: string) {
      sent.push(data);
    },
    close(code?: number, reason?: string) {
      socket.readyState = CLOSING;
      socket.closedWith = { code, reason };
    },
  };
  return socket;
}

interface FakeGateway {
  calls: ClientEvent[];
  appendCalls: string[];
  isOpenFlag: boolean;
  send: (ev: ClientEvent) => Promise<void>;
  appendAudio: (b64: string) => Promise<void>;
  isOpen: boolean;
}

function fakeGateway(isOpenFlag = true): FakeGateway {
  const gw: FakeGateway = {
    calls: [],
    appendCalls: [],
    isOpenFlag,
    async send(ev: ClientEvent) {
      gw.calls.push(ev);
    },
    async appendAudio(b64: string) {
      gw.appendCalls.push(b64);
    },
    get isOpen() {
      return gw.isOpenFlag;
    },
  };
  return gw;
}

interface FakeTranscoder {
  resetCalls: number;
  gw2tw: string[];
  tw2gw: string[];
  resetOutbound: () => void;
  gatewayToTwilio: (delta: string) => string;
  twilioToGateway: (payload: string) => string;
}

function fakeTranscoder(): FakeTranscoder {
  const t: FakeTranscoder = {
    resetCalls: 0,
    gw2tw: [],
    tw2gw: [],
    resetOutbound() {
      t.resetCalls += 1;
    },
    gatewayToTwilio(delta: string) {
      t.gw2tw.push(delta);
      return `tw:${delta}`;
    },
    twilioToGateway(payload: string) {
      t.tw2gw.push(payload);
      return `gw:${payload}`;
    },
  };
  return t;
}

interface LogLine {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

function makeSession(opts: { gateway?: FakeGateway; transcoder?: FakeTranscoder } = {}): {
  s: Session;
  socket: FakeSocket;
  logs: LogLine[];
  gateway: FakeGateway;
  transcoder: FakeTranscoder;
} {
  const socket = fakeSocket();
  const logs: LogLine[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = createSession({ twilioWs: socket as any, streamSid: 'MZ1', callSid: 'CA1', log: () => {} });
  s.log = (level, message, fields) => {
    logs.push({ level, message, fields });
  };
  const gateway = opts.gateway ?? fakeGateway();
  const transcoder = opts.transcoder ?? fakeTranscoder();
  s.gateway = gateway as unknown as Session['gateway'];
  s.transcoder = transcoder as unknown as Session['transcoder'];
  return { s, socket, logs, gateway, transcoder };
}

describe('dispatch — A7 stale-epoch regression (normative)', () => {
  it('response-created(r1) -> deltas -> drain -> response-created(r2) -> delta(r2) -> speech-started truncates from r2s epoch, never r1s', () => {
    const { s, socket, gateway } = makeSession();

    // Response A: two deltas, epoch arms at latestMediaTimestamp=1000 (A's first delta).
    dispatch(s, { type: 'response-created', responseId: 'A', raw: {} });
    s.latestMediaTimestamp = 1000;
    dispatch(s, { type: 'audio-delta', responseId: 'A', itemId: 'itemA', delta: 'd1', raw: {} });
    s.latestMediaTimestamp = 1300;
    dispatch(s, { type: 'audio-delta', responseId: 'A', itemId: 'itemA', delta: 'd2', raw: {} });
    expect(s.markQueue).toEqual(['rA:1', 'rA:2']);

    // Queue drains -> epoch disarmed (Spec 05 R4 point 3, via bargein.ts's onMarkEcho).
    onMarkEcho(s, 'rA:1');
    onMarkEcho(s, 'rA:2');
    expect(s.markQueue).toEqual([]);
    expect(s.responseStartTimestamp).toBe(null);

    // A LOT of call time passes (a full second turn's worth) before response B starts.
    dispatch(s, { type: 'response-created', responseId: 'B', raw: {} });
    s.latestMediaTimestamp = 8100; // B's first delta arrives here
    dispatch(s, { type: 'audio-delta', responseId: 'B', itemId: 'itemB', delta: 'd3', raw: {} });

    // Caller barges in shortly (400 ms) after B starts playing.
    s.latestMediaTimestamp = 8500;
    dispatch(s, { type: 'speech-started', raw: {} });

    const truncateCalls = gateway.calls.filter((c) => (c as { type: string }).type === 'conversation-item-truncate');
    expect(truncateCalls.length).toBe(1);
    const truncate = truncateCalls[0] as unknown as { itemId: string; audioEndMs: number };
    expect(truncate.itemId).toBe('itemB'); // NEVER itemA
    expect(truncate.audioEndMs).toBe(400); // 8500 - 8100, NEVER 8500 - 1000 = 7500
    expect(truncate.audioEndMs).not.toBe(7500);

    const clearFrames = socket.sent.filter((m) => (JSON.parse(m) as { event: string }).event === 'clear');
    expect(clearFrames.length).toBe(1);
  });
});

describe('dispatch — epoch reset point 1 (response-created)', () => {
  it('sets responseStartTimestamp=null, currentResponseId, responseActive=true, firstMarkNameOfResponse=null, resetOutbound once', () => {
    const { s, transcoder } = makeSession();
    s.responseStartTimestamp = 999;
    s.firstMarkNameOfResponse = 'stale:1';
    s.responseActive = false;

    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });

    expect(s.responseStartTimestamp).toBe(null);
    expect(s.currentResponseId).toBe('r1');
    expect(s.responseActive).toBe(true);
    expect(s.firstMarkNameOfResponse).toBe(null);
    expect(transcoder.resetCalls).toBe(1);
  });
});

describe('dispatch — epoch re-arm point 2 (S16 lazy attach)', () => {
  it('an audio-delta with a responseId different from currentResponseId (no prior response-created) re-arms from latestMediaTimestamp', () => {
    const { s } = makeSession();
    expect(s.currentResponseId).toBe(null);
    expect(s.responseStartTimestamp).toBe(null);

    s.latestMediaTimestamp = 4200;
    dispatch(s, { type: 'audio-delta', responseId: 'lazy1', itemId: 'itemX', delta: 'dz', raw: {} });

    expect(s.responseStartTimestamp).toBe(4200);
    expect(s.currentResponseId).toBe('lazy1');
    expect(s.lastAssistantItemId).toBe('itemX');
  });
});

describe('dispatch — epoch reset point 3 (mark-queue drain), end to end', () => {
  it('delta -> mark -> echo drains the queue and disarms responseStartTimestamp', () => {
    const { s } = makeSession();
    dispatch(s, { type: 'response-created', responseId: 'X', raw: {} });
    s.latestMediaTimestamp = 500;
    dispatch(s, { type: 'audio-delta', responseId: 'X', itemId: 'item1', delta: 'd', raw: {} });
    expect(s.responseStartTimestamp).toBe(500);
    expect(s.markQueue).toEqual(['rX:1']);

    onMarkEcho(s, 'rX:1');

    expect(s.markQueue).toEqual([]);
    expect(s.responseStartTimestamp).toBe(null);
  });
});

describe('dispatch — A13 resetOutbound call-site count (response-created x2 + one effective bargeIn)', () => {
  it('resetOutbound is called exactly 3 times across a full simulated exchange; no other reset-like calls', () => {
    const { s, transcoder } = makeSession();

    dispatch(s, { type: 'response-created', responseId: 'A', raw: {} });
    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: 'A', itemId: 'itemA', delta: 'd1', raw: {} });
    s.latestMediaTimestamp = 150;
    dispatch(s, { type: 'speech-started', raw: {} }); // effective barge-in (markQueue non-empty)

    dispatch(s, { type: 'response-created', responseId: 'B', raw: {} });

    expect(transcoder.resetCalls).toBe(3);
  });
});

describe('dispatch — outbound flow (send then mark; first-delta logging only)', () => {
  it('forwards via transcoder.gatewayToTwilio then pushes one mark; recorder logs first-audio-delta/first-twilio-send once, nothing on the second delta', () => {
    // T05.3 update: the direct s.log('first-audio-delta'/'first-twilio-send') calls T05.2 left in
    // dispatch() were a double-emit once a recorder is attached (T05.2 review finding) — deleted.
    // `s.recorder` (TurnRecorder) is now the SOLE emitter of these two lines, so this test wires
    // a real one (same style as session-turns.test.ts) and asserts on its `event` field rather
    // than the old direct-log `message` string (the recorder's message text differs: "first audio
    // delta" / "first twilio send", with spaces — the machine-readable `event` field is unchanged
    // and is the more robust thing to assert on regardless).
    const { s, socket, logs, transcoder } = makeSession();
    s.recorder = new TurnRecorder({ callSid: s.callSid, streamSid: s.streamSid }, (fields) => {
      const { level, message, ...rest } = fields;
      logs.push({ level, message, fields: rest });
    });
    dispatch(s, { type: 'speech-stopped', raw: {} }); // opens the turn the recorder attaches to

    dispatch(s, { type: 'response-created', responseId: 'X', raw: {} });
    s.latestMediaTimestamp = 200;
    dispatch(s, { type: 'audio-delta', responseId: 'X', itemId: 'item1', delta: 'd1', raw: {} });

    expect(transcoder.gw2tw.length).toBe(1);
    expect(transcoder.gw2tw[0]).toBe('d1');
    expect(socket.sent.length).toBe(2); // media then mark
    const mediaMsg = JSON.parse(socket.sent[0]!) as { event: string; media: { payload: string } };
    expect(mediaMsg.event).toBe('media');
    expect(mediaMsg.media.payload).toBe('tw:d1');
    const markMsg = JSON.parse(socket.sent[1]!) as { event: string; mark: { name: string } };
    expect(markMsg.event).toBe('mark');
    expect(markMsg.mark.name).toBe('rX:1');

    const firstDeltaLines = logs.filter((l) => l.fields?.event === 'first-audio-delta');
    const firstSendLines = logs.filter((l) => l.fields?.event === 'first-twilio-send');
    expect(firstDeltaLines.length).toBe(1);
    expect(firstSendLines.length).toBe(1);

    // Second delta of the SAME response: no additional first-* log lines.
    dispatch(s, { type: 'audio-delta', responseId: 'X', itemId: 'item1', delta: 'd2', raw: {} });
    expect(logs.filter((l) => l.fields?.event === 'first-audio-delta').length).toBe(1);
    expect(logs.filter((l) => l.fields?.event === 'first-twilio-send').length).toBe(1);
    expect(socket.sent.length).toBe(4); // second media + mark, no new first-* logs
  });
});

// findings/18 (Twilio 31924 investigation) — log-only per-response outbound-burst evidence.
// Uses the same `makeSession()` fake-gateway/fake-transcoder harness as the outbound-flow test
// above; wires a real TurnRecorder so the 'outbound-burst' line's adjacency to the 'turn' line
// (both keyed by responseId) is exercised end to end, not just in isolation.
describe('dispatch — outbound-burst metrics (findings/18, log-only)', () => {
  it('emits exactly one outbound-burst line per response, with plausible fields, on response-done', () => {
    const { s, logs } = makeSession();
    s.recorder = new TurnRecorder({ callSid: s.callSid, streamSid: s.streamSid }, (fields) => {
      const { level, message, ...rest } = fields;
      logs.push({ level, message, fields: rest });
    });

    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'aGVsbG8=', raw: {} }); // 'hello' base64
    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'aGVsbG8gd29ybGQ=', raw: {} }); // 'hello world'

    // No line yet — only emitted at response-done.
    expect(logs.filter((l) => l.fields?.event === 'outbound-burst').length).toBe(0);

    dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} });

    const burstLines = logs.filter((l) => l.fields?.event === 'outbound-burst');
    expect(burstLines.length).toBe(1); // exactly one per response, none per delta
    const fields = burstLines[0]!.fields!;
    expect(fields.responseId).toBe('r1');
    expect(fields.deltaCount).toBe(2);
    expect(fields.totalBytes).toBeGreaterThan(0);
    expect(fields.maxDeltaBytes).toBeGreaterThan(0);
    expect(fields.maxDeltaBytes as number).toBeLessThanOrEqual(fields.totalBytes as number);
    expect(typeof fields.burstMs).toBe('number');
    expect(fields.burstMs as number).toBeGreaterThanOrEqual(0);
    expect(burstLines[0]!.level).toBe('info');

    // A response with no audio (straight to a function call) — no line at all, per response.
    dispatch(s, { type: 'response-created', responseId: 'r2', raw: {} });
    dispatch(s, { type: 'response-done', responseId: 'r2', status: 'completed', raw: {} });
    expect(logs.filter((l) => l.fields?.event === 'outbound-burst').length).toBe(1); // still just the one from r1

    // The accumulator resets cleanly for a fresh response with its own audio.
    dispatch(s, { type: 'response-created', responseId: 'r3', raw: {} });
    dispatch(s, { type: 'audio-delta', responseId: 'r3', itemId: 'item3', delta: 'aGk=', raw: {} }); // 'hi'
    dispatch(s, { type: 'response-done', responseId: 'r3', status: 'completed', raw: {} });

    const allBurstLines = logs.filter((l) => l.fields?.event === 'outbound-burst');
    expect(allBurstLines.length).toBe(2);
    expect(allBurstLines[1]!.fields!.responseId).toBe('r3');
    expect(allBurstLines[1]!.fields!.deltaCount).toBe(1);
  });
});

describe('dispatch — backpressure (Spec 03 R6, exercised through sendMedia)', () => {
  it('bufferedAmount over the guard closes the socket 1011 and sends nothing', () => {
    const { s, socket } = makeSession();
    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    socket.bufferedAmount = 1_000_001;

    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'd1', raw: {} });

    expect(socket.closedWith).toEqual({ code: 1011, reason: 'backpressure' });
    expect(socket.sent).toEqual([]); // no media AND no mark (socket left OPEN->CLOSING by our fake)
  });
});

describe('handleTwilioMedia — inbound flow (Spec 05 R3 steps 2-4)', () => {
  it('appends transcoder.twilioToGateway(payload) exactly once when gateway.isOpen', () => {
    const gateway = fakeGateway(true);
    const { s } = makeSession({ gateway });

    handleTwilioMedia(s, 'payload123');

    expect(gateway.appendCalls).toEqual(['gw:payload123']);
  });

  it('does nothing when gateway.isOpen is false', () => {
    const gateway = fakeGateway(false);
    const { s } = makeSession({ gateway });

    handleTwilioMedia(s, 'payload123');

    expect(gateway.appendCalls).toEqual([]);
  });
});

describe('dispatch — consciously-ignored events (no throw, no log)', () => {
  const ignored: unknown[] = [
    { type: 'audio-done', responseId: 'r1', itemId: 'i1', raw: {} },
    { type: 'content-part-added', responseId: 'r1', itemId: 'i1', raw: {} },
    { type: 'content-part-done', responseId: 'r1', itemId: 'i1', raw: {} },
    { type: 'output-item-done', responseId: 'r1', itemId: 'i1', raw: {} },
    { type: 'conversation-item-added', itemId: 'i1', item: {}, raw: {} },
    { type: 'text-delta', responseId: 'r1', itemId: 'i1', delta: 'hi', raw: {} },
    { type: 'text-done', responseId: 'r1', itemId: 'i1', text: 'hi', raw: {} },
    { type: 'function-call-arguments-delta', responseId: 'r1', itemId: 'i1', callId: 'c1', delta: '{', raw: {} },
    { type: 'audio-committed', itemId: 'i1', raw: {} },
  ];

  for (const ev of ignored) {
    it(`(${(ev as { type: string }).type}) produces no log line and does not throw`, () => {
      const { s, logs } = makeSession();
      expect(() => dispatch(s, ev as Parameters<typeof dispatch>[1])).not.toThrow();
      expect(logs).toEqual([]);
    });
  }
});

describe('dispatch — output-item-added sets lastAssistantItemId', () => {
  it('backup source for lastAssistantItemId', () => {
    const { s } = makeSession();
    dispatch(s, { type: 'output-item-added', responseId: 'r1', itemId: 'item-xyz', raw: {} });
    expect(s.lastAssistantItemId).toBe('item-xyz');
  });
});

describe('dispatch — custom matcher (Spec 05 R7)', () => {
  it("rawType 'input_audio_buffer.speech_started' triggers bargeIn", () => {
    const { s, socket, gateway } = makeSession();
    // Arm state so bargeIn is effective and observable.
    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    s.latestMediaTimestamp = 50;
    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'd1', raw: {} });
    s.latestMediaTimestamp = 90;

    dispatch(s, { type: 'custom', rawType: 'input_audio_buffer.speech_started', raw: {} });

    const clearFrames = socket.sent.filter((m) => (JSON.parse(m) as { event: string }).event === 'clear');
    expect(clearFrames.length).toBe(1);
    const truncateCalls = gateway.calls.filter((c) => (c as { type: string }).type === 'conversation-item-truncate');
    expect(truncateCalls.length).toBe(1);
  });

  it("rawType 'conversation.item.truncated' logs the truncate-ack line", () => {
    const { s, logs } = makeSession();
    const raw = { audio_end_ms: 1234 };
    dispatch(s, { type: 'custom', rawType: 'conversation.item.truncated', raw });

    const line = logs.find((l) => l.message === 'truncate ack');
    expect(line).toBeTruthy();
    expect(line!.fields?.event).toBe('custom');
    expect(line!.fields?.rawType).toBe('conversation.item.truncated');
    expect(JSON.parse(line!.fields?.raw as string)).toEqual(raw);
  });

  it("rawType 'rate_limits.updated' produces no info-level line", () => {
    const { s, logs } = makeSession();
    dispatch(s, { type: 'custom', rawType: 'rate_limits.updated', raw: { n: 1 } });
    expect(logs).toEqual([]);
  });

  it('any other rawType logs one custom line with safeRaw', () => {
    const { s, logs } = makeSession();
    const raw = { foo: 'bar' };
    dispatch(s, { type: 'custom', rawType: 'conversation.item.done', raw });

    const line = logs.find((l) => l.message === 'custom event');
    expect(line).toBeTruthy();
    expect(line!.fields?.rawType).toBe('conversation.item.done');
    expect(JSON.parse(line!.fields?.raw as string)).toEqual(raw);
  });
});

describe('dispatch — error policy (Spec 05 R9)', () => {
  it('a benign error logs one warn with .raw and does NOT teardown', () => {
    const { s, logs } = makeSession();
    let tornDown = 0;
    s.teardown = () => {
      tornDown += 1;
    };

    dispatch(s, { type: 'error', message: 'no active response to cancel', raw: { a: 1 } });

    const line = logs.find((l) => l.fields?.event === 'error');
    expect(line).toBeTruthy();
    expect(line!.level).toBe('warn');
    expect(JSON.parse(line!.fields?.raw as string)).toEqual({ a: 1 });
    expect(tornDown).toBe(0);
  });

  it('a non-benign error logs error with .raw and invokes teardown(gateway-error)', () => {
    const { s, logs } = makeSession();
    const teardownCalls: string[] = [];
    s.teardown = (reason: string) => {
      teardownCalls.push(reason);
    };

    dispatch(s, { type: 'error', message: 'boom-unknown', code: 'weird_code', raw: { b: 2 } });

    const line = logs.find((l) => l.fields?.event === 'error');
    expect(line).toBeTruthy();
    expect(line!.level).toBe('error');
    expect(JSON.parse(line!.fields?.raw as string)).toEqual({ b: 2 });
    expect(teardownCalls).toEqual(['gateway-error']);
  });

  // S11 tuning (live-call evidence, call CAd9fff35837be498644789a9d485bf594): a barge-in's
  // truncate can legitimately target audio that already finished playing (the mark-echo drain
  // that disarms the epoch is subject to real Twilio round-trip latency — see findings/04 G6).
  // Before this fix, the gateway's actual wording for that case ("Audio content of Nms is
  // already shorter than Mms", code invalid_value) matched none of the benign classes, so the
  // gateway leg tore the call down mid-response for a functionally no-op complaint.
  it('a truncate-overshoot invalid_value error (S11) logs warn and does NOT teardown', () => {
    const { s, logs } = makeSession();
    let tornDown = 0;
    s.teardown = () => {
      tornDown += 1;
    };

    dispatch(s, {
      type: 'error',
      code: 'invalid_value',
      message: 'Audio content of 10950ms is already shorter than 13160ms',
      raw: { c: 3 },
    });

    const line = logs.find((l) => l.fields?.event === 'error');
    expect(line).toBeTruthy();
    expect(line!.level).toBe('warn');
    expect(JSON.parse(line!.fields?.raw as string)).toEqual({ c: 3 });
    expect(tornDown).toBe(0);
  });

  // The classification is message-pattern-scoped, not a blanket 'invalid_value' whitelist entry —
  // a different invalid_value error (e.g. a genuinely malformed field) must still be fatal.
  it('a different invalid_value error (no "already shorter than" phrasing) stays fatal', () => {
    const { s, logs } = makeSession();
    const teardownCalls: string[] = [];
    s.teardown = (reason: string) => {
      teardownCalls.push(reason);
    };

    dispatch(s, {
      type: 'error',
      code: 'invalid_value',
      message: "Invalid value: 'bogus' is not a valid voice",
      raw: { d: 4 },
    });

    const line = logs.find((l) => l.fields?.event === 'error');
    expect(line).toBeTruthy();
    expect(line!.level).toBe('error');
    expect(teardownCalls).toEqual(['gateway-error']);
  });
});

// Findings review (Important — R12 lost-race is call-fatal): before this fix, a create-while-
// active error had zero production callers reaching ToolLoop.onBenignCreateWhileActiveError, and
// the error text matched none of gateway.ts's benign classes — so a lost R12 gate race classified
// as non-benign and tore the call down mid-tool-answer. This test wires a REAL ToolLoop into a
// REAL Session (through dispatch() itself, the same call sites startSessionBridge uses) and
// scripts exactly that lost race end to end: the gate's own response-create collides with an
// auto-spawned response, the gateway reports it back as a create-while-active error, and the
// deferred retry must be the thing that recovers — never a teardown.
describe('dispatch — error policy engages ToolLoop deferred retry for the create-while-active benign class (Spec 07 R12)', () => {
  it('warns (never tears down) and the deferred retry fires exactly one eventual response-create', async () => {
    const { s, logs } = makeSession();
    let tornDownCalls = 0;
    s.teardown = () => {
      tornDownCalls += 1;
    };

    const sent: ClientEvent[] = [];
    s.toolLoop = new ToolLoop({
      client: fakeMcpClient(),
      gwSend: async (ev) => {
        sent.push(ev);
      },
      isResponseActive: () => s.responseActive,
      log: (f) => logs.push({ level: f.level, message: f.message, fields: f as unknown as Record<string, unknown> }),
    });

    // Tool call arrives on response r1; the tool resolves and its output is sent.
    dispatch(s, { type: 'function-call-arguments-done', responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '{}' });
    await flush();

    // r1 completes: the double gate is now fully satisfied and isResponseActive() reads false
    // (session.responseActive was set false by this same response-done, per dispatch's own R8
    // ordering) — so the ToolLoop fires its OWN response-create. This is the lost race: the
    // gateway, from its own vantage point, already has a VAD-auto response in flight that the
    // Session hasn't been told about yet.
    dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed' });
    await flush();
    expect(sent.filter((e) => e.type === 'response-create').length, 'the raced attempt').toBe(1);

    // The gateway reports the lost race back as an in-band error — the exact benign shape this
    // fix adds to gateway.ts's whitelist.
    dispatch(s, { type: 'error', message: 'Conversation already has an active response', raw: {} });

    const errorLine = logs.find((l) => l.fields?.event === 'error');
    expect(errorLine, 'expected an error-event log line').toBeTruthy();
    expect(errorLine!.level, 'benign -> warn, never error').toBe('warn');
    expect(tornDownCalls, 'the call must survive a lost R12 gate race').toBe(0);

    // The auto-spawned response (the one that won the race) plays out and finishes.
    dispatch(s, { type: 'response-created', responseId: 'auto1', raw: {} });
    dispatch(s, { type: 'response-done', responseId: 'auto1', status: 'completed' });
    await flush();

    // The deferred retry: exactly one MORE response-create beyond the original raced attempt.
    const responseCreates = sent.filter((e) => e.type === 'response-create');
    expect(responseCreates.length, 'exactly one eventual retried response-create').toBe(2);

    // The real follow-up response arrives and its first delta closes the tool-call cycle.
    dispatch(s, { type: 'response-created', responseId: 'follow1', raw: {} });
    dispatch(s, { type: 'audio-delta', responseId: 'follow1', itemId: 'itemF', delta: 'd', raw: {} });

    const toolCallLines = logs.filter((l) => l.fields?.event === 'tool-call');
    expect(toolCallLines.length, 'exactly one tool-call line for the eventual follow-up').toBe(1);
  });
});

describe('dispatch — speech-started (Spec 05 R10)', () => {
  it('runs bargeIn and sets turnPhase to user-speaking', () => {
    const { s, socket } = makeSession();
    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    s.latestMediaTimestamp = 10;
    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'd1', raw: {} });

    dispatch(s, { type: 'speech-started', raw: {} });

    expect(s.turnPhase).toBe('user-speaking');
    const clearFrames = socket.sent.filter((m) => (JSON.parse(m) as { event: string }).event === 'clear');
    expect(clearFrames.length).toBe(1); // proves bargeIn actually ran
  });
});

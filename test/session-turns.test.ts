// T05.3 — turn lifecycle wiring & tool-flow response-create gate (Spec 05 R2/R8/R10; Spec 07
// R10-R14; Spec 08 R5/R6/R9/R11). Pure-logic module, no fastify.injectWS anywhere in this file
// (same exemption as session-dispatch.test.ts/bargein.test.ts: the "one injectWS-backed test per
// file" rule only targets heavy WS-server suites; pure state-machine tests share files).
//
// Drives `dispatch` on a fake Session carrying a REAL `TurnRecorder` (src/latency.ts) and a REAL
// `ToolLoop` (src/tools.ts) — never a hand-rolled competing state machine — with a fake MCP
// client (`callTool` resolves/rejects on command) and a captured `gateway.send`-equivalent
// (`gwSend`). This is what proves the T05.2 review findings are actually fixed:
//   (1) TurnRecorder is the SOLE source of turn data (dispatch carries no parallel bookkeeping).
//   (2) first-audio-delta/first-twilio-send are emitted exactly once, only by the recorder.
//   (3) the double-gated tool response-create (Spec 07 R12 / Spec 05 R8) actually releases once,
//       re-checks on every response-done, and defers correctly when a VAD response intervenes.

import { describe, it, expect } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';
import { dispatch } from '../src/session.js';
import { createSession, type Session } from '../src/sessions.js';
import { TurnRecorder } from '../src/latency.js';
import { ToolLoop } from '../src/tools.js';
import type { LogFields } from '../src/logger.js';

const OPEN = 1;

interface FakeSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}

function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  return {
    readyState: OPEN,
    bufferedAmount: 0,
    sent,
    send(data: string) {
      sent.push(data);
    },
    close() {
      /* not exercised in this file */
    },
  };
}

/** Flushes the microtask queue `times` times — enough for the ToolLoop's
 * `runTool -> gwSend -> tryReleaseGate` await chain (Spec 07 R11.1) to fully settle. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** A controllable fake MCP client: `callTool` resolves/rejects only when the test calls
 * `resolve`/`reject` — lets tests interleave gateway events with an in-flight tool call
 * (needed for the R12/G7 deferral race, Test 4 below). */
function fakeMcpClient(): {
  client: Client;
  resolve: (result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }) => void;
} {
  let resolveFn!: (v: unknown) => void;
  const pending = new Promise((r) => {
    resolveFn = r;
  });
  const client = {
    async callTool() {
      return pending;
    },
  } as unknown as Client;
  return {
    client,
    resolve: (result) => resolveFn(result),
  };
}

interface Wired {
  s: Session;
  socket: FakeSocket;
  logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }>;
  turnLogs: LogFields[];
  toolLogs: LogFields[];
  gwCalls: ClientEvent[];
  recorder: TurnRecorder;
  resolveTool: (result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }) => void;
}

/** Builds a Session wired with a REAL TurnRecorder and a REAL ToolLoop (fake MCP client +
 * captured gwSend), per the plan's "Consumes" contract. */
function wireSession(): Wired {
  const socket = fakeSocket();
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = createSession({ twilioWs: socket as any, streamSid: 'MZ1', callSid: 'CA1', log: () => {} });
  s.log = (level, message, fields) => {
    logs.push({ level, message, fields });
  };

  const turnLogs: LogFields[] = [];
  const recorder = new TurnRecorder({ callSid: s.callSid, streamSid: s.streamSid }, (fields) => {
    turnLogs.push(fields);
  });
  s.recorder = recorder;

  const toolLogs: LogFields[] = [];
  const gwCalls: ClientEvent[] = [];
  const { client, resolve: resolveTool } = fakeMcpClient();
  const toolLoop = new ToolLoop({
    client,
    gwSend: async (ev: ClientEvent) => {
      gwCalls.push(ev);
    },
    isResponseActive: () => s.responseActive,
    log: (fields: LogFields) => {
      toolLogs.push(fields);
    },
  });
  s.toolLoop = toolLoop;

  return { s, socket, logs, turnLogs, toolLogs, gwCalls, recorder, resolveTool };
}

describe('session-turns — plain turn (A3: one consolidated turn line, no per-delta logs)', () => {
  it('speech-stopped -> response-created(r1) -> audio-delta(r1) -> response-done(r1, completed) emits exactly one turn line with numeric ttfbMs/bridgeMs/turnMs, bargedIn:false; turnPhase walks awaiting-response -> responding -> idle', () => {
    const { s, turnLogs } = wireSession();

    dispatch(s, { type: 'speech-stopped', raw: {} });
    expect(s.turnPhase).toBe('awaiting-response');

    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    expect(s.turnPhase).toBe('awaiting-response');

    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'd1', raw: {} });
    expect(s.turnPhase).toBe('responding');

    dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} });
    expect(s.turnPhase).toBe('idle');

    const turnLines = turnLogs.filter((f) => f.event === 'turn');
    expect(turnLines.length).toBe(1);
    const line = turnLines[0]!;
    expect(line.responseId).toBe('r1');
    expect(typeof line.ttfbMs).toBe('number');
    expect(typeof line.bridgeMs).toBe('number');
    expect(typeof line.turnMs).toBe('number');
    expect(line.bargedIn).toBe(false);
    expect(line.status).toBe('completed');
  });

  it('turnPhase is advisory only — bargeIn still runs when markQueue/responseActive say so, even with turnPhase idle', () => {
    const { s, socket } = wireSession();

    dispatch(s, { type: 'speech-stopped', raw: {} });
    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    s.latestMediaTimestamp = 50;
    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'd1', raw: {} });
    dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} });
    expect(s.turnPhase).toBe('idle'); // no mark echo simulated -> markQueue still non-empty

    dispatch(s, { type: 'speech-started', raw: {} });

    const clearFrames = socket.sent.filter((m) => (JSON.parse(m) as { event: string }).event === 'clear');
    expect(clearFrames.length).toBe(1); // bargeIn ran despite turnPhase being 'idle', not gated by it
  });
});

describe('session-turns — correlation by responseId (findings/09 gotcha 9)', () => {
  it('an audio-delta for an unrelated responseId does not stamp the current turns tFirstAudioDelta', () => {
    const { s, turnLogs } = wireSession();

    dispatch(s, { type: 'speech-stopped', raw: {} });
    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });

    s.latestMediaTimestamp = 10;
    dispatch(s, { type: 'audio-delta', responseId: 'foreign-response', itemId: 'ix', delta: 'dx', raw: {} });
    expect(turnLogs.filter((f) => f.event === 'first-audio-delta').length).toBe(0);

    s.latestMediaTimestamp = 20;
    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'd1', raw: {} });
    const firstDeltaLines = turnLogs.filter((f) => f.event === 'first-audio-delta');
    expect(firstDeltaLines.length).toBe(1);
    expect(firstDeltaLines[0]!.responseId).toBe('r1');
  });
});

describe('session-turns — tool-flow response-create gate (Spec 05 R8 / Spec 07 R12)', () => {
  it('happy path: output sent while responseActive, no response-create until response-done for the tool-bearing response arrives, then exactly one', async () => {
    const { s, gwCalls, resolveTool } = wireSession();

    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    expect(s.responseActive).toBe(true);

    dispatch(s, {
      type: 'function-call-arguments-done',
      responseId: 'r1',
      itemId: 'i1',
      callId: 'c1',
      name: 'get_current_time',
      arguments: '{}',
      raw: {},
    });

    resolveTool({ content: [{ type: 'text', text: '2026-07-18T00:00:00Z' }] });
    await flush();

    const outputsSoFar = gwCalls.filter((c) => (c as { type: string }).type === 'conversation-item-create');
    expect(outputsSoFar.length).toBe(1);
    const item = (outputsSoFar[0] as unknown as { item: { type: string; callId: string; name: string } }).item;
    expect(item.type).toBe('function-call-output');
    expect(item.callId).toBe('c1');
    expect(item.name).toBe('get_current_time'); // findings/02 gotcha 5 — name included

    const createsSoFar = gwCalls.filter((c) => (c as { type: string }).type === 'response-create');
    expect(createsSoFar.length).toBe(0); // r1 hasn't gotten response-done yet -> gate held

    dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} });
    await flush();

    const creates = gwCalls.filter((c) => (c as { type: string }).type === 'response-create');
    expect(creates.length).toBe(1); // exactly one, gated on both response-done AND responseActive===false
  });

  it('deferral/re-check: a VAD-created response (r2) active at gate time defers; the next response-done(r2) releases exactly one', async () => {
    const { s, gwCalls, resolveTool } = wireSession();

    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    dispatch(s, {
      type: 'function-call-arguments-done',
      responseId: 'r1',
      itemId: 'i1',
      callId: 'c1',
      name: 'get_current_time',
      arguments: '{}',
      raw: {},
    });

    // r1 completes (toolResponseDone -> true) BEFORE the tool call itself resolves.
    dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} });
    expect(s.responseActive).toBe(false);

    // A VAD-auto-created response (caller spoke again) becomes active before the output is sent.
    dispatch(s, { type: 'response-created', responseId: 'r2', raw: {} });
    expect(s.responseActive).toBe(true);

    // NOW the tool call resolves: output gets sent, but the gate's condition (c) fails (r2 active).
    resolveTool({ content: [{ type: 'text', text: 'ok' }] });
    await flush();

    const outputs = gwCalls.filter((c) => (c as { type: string }).type === 'conversation-item-create');
    expect(outputs.length).toBe(1); // output IS sent regardless of the gate
    let creates = gwCalls.filter((c) => (c as { type: string }).type === 'response-create');
    expect(creates.length).toBe(0); // deferred — r2 is active

    // r2 finishes -> the deferred-retry path (ToolLoop.onResponseDone) re-checks and releases.
    dispatch(s, { type: 'response-done', responseId: 'r2', status: 'completed', raw: {} });
    await flush();

    creates = gwCalls.filter((c) => (c as { type: string }).type === 'response-create');
    expect(creates.length).toBe(1); // exactly one, released by r2's response-done
  });

  it('idempotence: further response-done events after release send no second response-create', async () => {
    const { s, gwCalls, resolveTool } = wireSession();

    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    dispatch(s, {
      type: 'function-call-arguments-done',
      responseId: 'r1',
      itemId: 'i1',
      callId: 'c1',
      name: 'hello',
      arguments: '{}',
      raw: {},
    });
    resolveTool({ content: [{ type: 'text', text: 'Hello, world!' }] });
    await flush();
    dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} });
    await flush();

    let creates = gwCalls.filter((c) => (c as { type: string }).type === 'response-create');
    expect(creates.length).toBe(1);

    // Extra response-done noise (e.g. the follow-up response's own eventual response-done).
    dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} });
    dispatch(s, { type: 'response-done', responseId: 'some-other-id', status: 'completed', raw: {} });
    await flush();

    creates = gwCalls.filter((c) => (c as { type: string }).type === 'response-create');
    expect(creates.length).toBe(1); // still exactly one
  });
});

describe('session-turns — no-audio turn (findings/09 §2 edge case)', () => {
  it('a turn that goes straight to a function call (no audio-delta) leaves ttfbMs absent and does not crash', async () => {
    const { s, turnLogs, resolveTool } = wireSession();

    dispatch(s, { type: 'speech-stopped', raw: {} });
    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    expect(() => {
      dispatch(s, {
        type: 'function-call-arguments-done',
        responseId: 'r1',
        itemId: 'i1',
        callId: 'c1',
        name: 'get_current_time',
        arguments: '{}',
        raw: {},
      });
    }).not.toThrow();

    expect(() => {
      dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} });
    }).not.toThrow();

    const turnLines = turnLogs.filter((f) => f.event === 'turn');
    expect(turnLines.length).toBe(1);
    expect(turnLines[0]!.ttfbMs).toBe(undefined);
    expect(turnLines[0]!.turn).toBe(1);

    // Drain the still-pending tool call so it never rejects unhandled after the test ends.
    resolveTool({ content: [{ type: 'text', text: 'irrelevant' }] });
    await flush();
  });
});

describe('session-turns — greeting flows through dispatch with zero special casing (Spec 05 R10 / Spec 08 R7)', () => {
  it('a response with no preceding speech-stopped (turn 0) does not corrupt turn 1s numbering', () => {
    const { s, recorder, turnLogs } = wireSession();

    // Simulates the greeting-response window Spec 04/08 opens BEFORE the greeting's
    // response-create is sent — this dispatch test only proves dispatch() itself adds no
    // special-casing around it.
    recorder.onGreetingCreateSent();

    dispatch(s, { type: 'response-created', responseId: 'greet', raw: {} });
    s.latestMediaTimestamp = 5;
    dispatch(s, { type: 'audio-delta', responseId: 'greet', itemId: 'gitem', delta: 'gd', raw: {} });
    dispatch(s, { type: 'response-done', responseId: 'greet', status: 'completed', raw: {} });

    expect(turnLogs.filter((f) => f.event === 'greeting').length).toBe(1);
    expect(turnLogs.filter((f) => f.event === 'turn').length).toBe(0); // greeting never a turn line
    expect(recorder.turns.length).toBe(0); // greeting excluded from turns[] by construction

    // A real caller turn now proceeds exactly as normal — no leftover greeting state corrupts it.
    dispatch(s, { type: 'speech-stopped', raw: {} });
    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'd1', raw: {} });
    dispatch(s, { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} });

    const turnLines = turnLogs.filter((f) => f.event === 'turn');
    expect(turnLines.length).toBe(1);
    expect(turnLines[0]!.turn).toBe(1); // turn 1, never turn 2 — the greeting never incremented turnSeq
    expect(recorder.turns.length).toBe(1);
    expect(recorder.turns[0]!.turn).toBe(1);
  });
});

describe('session-turns — transcripts (Spec 05 R2 rows)', () => {
  it('audio-transcript-delta accumulates silently (no per-delta log); audio-transcript-done and input-transcription-completed each emit one line', () => {
    const { s, logs } = wireSession();

    dispatch(s, { type: 'audio-transcript-delta', responseId: 'r1', itemId: 'i1', delta: 'hel', raw: {} });
    dispatch(s, { type: 'audio-transcript-delta', responseId: 'r1', itemId: 'i1', delta: 'lo', raw: {} });
    expect(logs).toEqual([]); // no per-delta log line, no crash

    dispatch(s, { type: 'audio-transcript-done', responseId: 'r1', itemId: 'i1', transcript: 'hello', raw: {} });
    const outputLines = logs.filter((l) => l.fields?.event === 'output-transcript');
    expect(outputLines.length).toBe(1);
    expect(outputLines[0]!.fields?.transcript).toBe('hello');
    expect(outputLines[0]!.fields?.responseId).toBe('r1');

    dispatch(s, { type: 'input-transcription-completed', itemId: 'item9', transcript: 'hi there', raw: {} });
    const inputLines = logs.filter((l) => l.fields?.event === 'input-transcript');
    expect(inputLines.length).toBe(1);
    expect(inputLines[0]!.fields?.itemId).toBe('item9');
    expect(inputLines[0]!.fields?.transcript).toBe('hi there');
  });
});

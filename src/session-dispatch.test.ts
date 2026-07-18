// T05.2 — dispatch()/handleTwilioMedia() unit suite (Spec 05 A7, A13, A14-runtime, A3-partial).
// Pure-logic module, no fastify.injectWS anywhere in this file (same exemption as
// bargein.test.ts: the "one injectWS-backed test per file" rule only targets heavy WS-server
// suites). Fake Session built on the real `createSession` (never a hand-rolled competing shape),
// with fake gateway/transcoder/socket spies in the same style as bargein.test.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, handleTwilioMedia } from './session.js';
import { onMarkEcho } from './bargein.js';
import { createSession, type Session } from './sessions.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';

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
    assert.deepEqual(s.markQueue, ['rA:1', 'rA:2']);

    // Queue drains -> epoch disarmed (Spec 05 R4 point 3, via bargein.ts's onMarkEcho).
    onMarkEcho(s, 'rA:1');
    onMarkEcho(s, 'rA:2');
    assert.deepEqual(s.markQueue, []);
    assert.equal(s.responseStartTimestamp, null);

    // A LOT of call time passes (a full second turn's worth) before response B starts.
    dispatch(s, { type: 'response-created', responseId: 'B', raw: {} });
    s.latestMediaTimestamp = 8100; // B's first delta arrives here
    dispatch(s, { type: 'audio-delta', responseId: 'B', itemId: 'itemB', delta: 'd3', raw: {} });

    // Caller barges in shortly (400 ms) after B starts playing.
    s.latestMediaTimestamp = 8500;
    dispatch(s, { type: 'speech-started', raw: {} });

    const truncateCalls = gateway.calls.filter((c) => (c as { type: string }).type === 'conversation-item-truncate');
    assert.equal(truncateCalls.length, 1);
    const truncate = truncateCalls[0] as unknown as { itemId: string; audioEndMs: number };
    assert.equal(truncate.itemId, 'itemB'); // NEVER itemA
    assert.equal(truncate.audioEndMs, 400); // 8500 - 8100, NEVER 8500 - 1000 = 7500
    assert.notEqual(truncate.audioEndMs, 7500);

    const clearFrames = socket.sent.filter((m) => (JSON.parse(m) as { event: string }).event === 'clear');
    assert.equal(clearFrames.length, 1);
  });
});

describe('dispatch — epoch reset point 1 (response-created)', () => {
  it('sets responseStartTimestamp=null, currentResponseId, responseActive=true, firstMarkNameOfResponse=null, resetOutbound once', () => {
    const { s, transcoder } = makeSession();
    s.responseStartTimestamp = 999;
    s.firstMarkNameOfResponse = 'stale:1';
    s.responseActive = false;

    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });

    assert.equal(s.responseStartTimestamp, null);
    assert.equal(s.currentResponseId, 'r1');
    assert.equal(s.responseActive, true);
    assert.equal(s.firstMarkNameOfResponse, null);
    assert.equal(transcoder.resetCalls, 1);
  });
});

describe('dispatch — epoch re-arm point 2 (S16 lazy attach)', () => {
  it('an audio-delta with a responseId different from currentResponseId (no prior response-created) re-arms from latestMediaTimestamp', () => {
    const { s } = makeSession();
    assert.equal(s.currentResponseId, null);
    assert.equal(s.responseStartTimestamp, null);

    s.latestMediaTimestamp = 4200;
    dispatch(s, { type: 'audio-delta', responseId: 'lazy1', itemId: 'itemX', delta: 'dz', raw: {} });

    assert.equal(s.responseStartTimestamp, 4200);
    assert.equal(s.currentResponseId, 'lazy1');
    assert.equal(s.lastAssistantItemId, 'itemX');
  });
});

describe('dispatch — epoch reset point 3 (mark-queue drain), end to end', () => {
  it('delta -> mark -> echo drains the queue and disarms responseStartTimestamp', () => {
    const { s } = makeSession();
    dispatch(s, { type: 'response-created', responseId: 'X', raw: {} });
    s.latestMediaTimestamp = 500;
    dispatch(s, { type: 'audio-delta', responseId: 'X', itemId: 'item1', delta: 'd', raw: {} });
    assert.equal(s.responseStartTimestamp, 500);
    assert.deepEqual(s.markQueue, ['rX:1']);

    onMarkEcho(s, 'rX:1');

    assert.deepEqual(s.markQueue, []);
    assert.equal(s.responseStartTimestamp, null);
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

    assert.equal(transcoder.resetCalls, 3);
  });
});

describe('dispatch — outbound flow (send then mark; first-delta logging only)', () => {
  it('forwards via transcoder.gatewayToTwilio then pushes one mark; logs first-audio-delta/first-twilio-send once, nothing on the second delta', () => {
    const { s, socket, logs, transcoder } = makeSession();

    dispatch(s, { type: 'response-created', responseId: 'X', raw: {} });
    s.latestMediaTimestamp = 200;
    dispatch(s, { type: 'audio-delta', responseId: 'X', itemId: 'item1', delta: 'd1', raw: {} });

    assert.equal(transcoder.gw2tw.length, 1);
    assert.equal(transcoder.gw2tw[0], 'd1');
    assert.equal(socket.sent.length, 2); // media then mark
    const mediaMsg = JSON.parse(socket.sent[0]!) as { event: string; media: { payload: string } };
    assert.equal(mediaMsg.event, 'media');
    assert.equal(mediaMsg.media.payload, 'tw:d1');
    const markMsg = JSON.parse(socket.sent[1]!) as { event: string; mark: { name: string } };
    assert.equal(markMsg.event, 'mark');
    assert.equal(markMsg.mark.name, 'rX:1');

    const firstDeltaLines = logs.filter((l) => l.message === 'first-audio-delta');
    const firstSendLines = logs.filter((l) => l.message === 'first-twilio-send');
    assert.equal(firstDeltaLines.length, 1);
    assert.equal(firstSendLines.length, 1);

    // Second delta of the SAME response: no additional first-* log lines.
    dispatch(s, { type: 'audio-delta', responseId: 'X', itemId: 'item1', delta: 'd2', raw: {} });
    assert.equal(logs.filter((l) => l.message === 'first-audio-delta').length, 1);
    assert.equal(logs.filter((l) => l.message === 'first-twilio-send').length, 1);
    assert.equal(socket.sent.length, 4); // second media + mark, no new first-* logs
  });
});

describe('dispatch — backpressure (Spec 03 R6, exercised through sendMedia)', () => {
  it('bufferedAmount over the guard closes the socket 1011 and sends nothing', () => {
    const { s, socket } = makeSession();
    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    socket.bufferedAmount = 1_000_001;

    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'd1', raw: {} });

    assert.deepEqual(socket.closedWith, { code: 1011, reason: 'backpressure' });
    assert.deepEqual(socket.sent, []); // no media AND no mark (socket left OPEN->CLOSING by our fake)
  });
});

describe('handleTwilioMedia — inbound flow (Spec 05 R3 steps 2-4)', () => {
  it('appends transcoder.twilioToGateway(payload) exactly once when gateway.isOpen', () => {
    const gateway = fakeGateway(true);
    const { s } = makeSession({ gateway });

    handleTwilioMedia(s, 'payload123');

    assert.deepEqual(gateway.appendCalls, ['gw:payload123']);
  });

  it('does nothing when gateway.isOpen is false', () => {
    const gateway = fakeGateway(false);
    const { s } = makeSession({ gateway });

    handleTwilioMedia(s, 'payload123');

    assert.deepEqual(gateway.appendCalls, []);
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
      assert.doesNotThrow(() => dispatch(s, ev as Parameters<typeof dispatch>[1]));
      assert.deepEqual(logs, []);
    });
  }
});

describe('dispatch — output-item-added sets lastAssistantItemId', () => {
  it('backup source for lastAssistantItemId', () => {
    const { s } = makeSession();
    dispatch(s, { type: 'output-item-added', responseId: 'r1', itemId: 'item-xyz', raw: {} });
    assert.equal(s.lastAssistantItemId, 'item-xyz');
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
    assert.equal(clearFrames.length, 1);
    const truncateCalls = gateway.calls.filter((c) => (c as { type: string }).type === 'conversation-item-truncate');
    assert.equal(truncateCalls.length, 1);
  });

  it("rawType 'conversation.item.truncated' logs the truncate-ack line", () => {
    const { s, logs } = makeSession();
    const raw = { audio_end_ms: 1234 };
    dispatch(s, { type: 'custom', rawType: 'conversation.item.truncated', raw });

    const line = logs.find((l) => l.message === 'truncate ack');
    assert.ok(line);
    assert.equal(line!.fields?.event, 'custom');
    assert.equal(line!.fields?.rawType, 'conversation.item.truncated');
    assert.deepEqual(JSON.parse(line!.fields?.raw as string), raw);
  });

  it("rawType 'rate_limits.updated' produces no info-level line", () => {
    const { s, logs } = makeSession();
    dispatch(s, { type: 'custom', rawType: 'rate_limits.updated', raw: { n: 1 } });
    assert.deepEqual(logs, []);
  });

  it('any other rawType logs one custom line with safeRaw', () => {
    const { s, logs } = makeSession();
    const raw = { foo: 'bar' };
    dispatch(s, { type: 'custom', rawType: 'conversation.item.done', raw });

    const line = logs.find((l) => l.message === 'custom event');
    assert.ok(line);
    assert.equal(line!.fields?.rawType, 'conversation.item.done');
    assert.deepEqual(JSON.parse(line!.fields?.raw as string), raw);
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
    assert.ok(line);
    assert.equal(line!.level, 'warn');
    assert.deepEqual(JSON.parse(line!.fields?.raw as string), { a: 1 });
    assert.equal(tornDown, 0);
  });

  it('a non-benign error logs error with .raw and invokes teardown(gateway-error)', () => {
    const { s, logs } = makeSession();
    const teardownCalls: string[] = [];
    s.teardown = (reason: string) => {
      teardownCalls.push(reason);
    };

    dispatch(s, { type: 'error', message: 'boom-unknown', code: 'weird_code', raw: { b: 2 } });

    const line = logs.find((l) => l.fields?.event === 'error');
    assert.ok(line);
    assert.equal(line!.level, 'error');
    assert.deepEqual(JSON.parse(line!.fields?.raw as string), { b: 2 });
    assert.deepEqual(teardownCalls, ['gateway-error']);
  });
});

describe('dispatch — speech-started (Spec 05 R10)', () => {
  it('runs bargeIn and sets turnPhase to user-speaking', () => {
    const { s, socket } = makeSession();
    dispatch(s, { type: 'response-created', responseId: 'r1', raw: {} });
    s.latestMediaTimestamp = 10;
    dispatch(s, { type: 'audio-delta', responseId: 'r1', itemId: 'item1', delta: 'd1', raw: {} });

    dispatch(s, { type: 'speech-started', raw: {} });

    assert.equal(s.turnPhase, 'user-speaking');
    const clearFrames = socket.sent.filter((m) => (JSON.parse(m) as { event: string }).event === 'clear');
    assert.equal(clearFrames.length, 1); // proves bargeIn actually ran
  });
});

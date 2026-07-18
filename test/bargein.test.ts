// T05.1 — bargein.ts unit suite (Spec 05 A8, A9, A10, A11 + bargeIn half of A13 + static half
// of A14). Pure-logic module, no fastify.injectWS anywhere in this file — exempt from the repo's
// "one injectWS-backed test per file" rule (node:test Windows silent-drop bug only bites heavy
// WS-server suites), so all cases share this one file per the plan.

import { describe, it, expect, vi } from 'vitest';
import { bargeIn, pushMark, onMarkEcho } from '../src/bargein.js';
import { dispatch } from '../src/session.js';
import { createSession, type Session } from '../src/sessions.js';
import { createTranscoder } from '../src/dsp.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';

const OPEN = 1;

/** Minimal fake WebSocket — only the surface sendClear/sendMark touch (same pattern as
 *  twilio-media.outbound.test.ts's fakeSocket). */
function fakeSocket(): { readyState: number; bufferedAmount: number; sent: string[]; send: (data: string) => void } {
  const sent: string[] = [];
  return {
    readyState: OPEN,
    bufferedAmount: 0,
    sent,
    send(data: string) {
      sent.push(data);
    },
  };
}

/** Fake gateway.send — captures every ClientEvent handed to it (bargeIn's truncate). */
function fakeGateway(): { calls: ClientEvent[]; send: (ev: ClientEvent) => Promise<void> } {
  const calls: ClientEvent[] = [];
  return {
    calls,
    async send(ev: ClientEvent) {
      calls.push(ev);
    },
  };
}

/** Spy transcoder — resetOutbound is what bargeIn()/dispatch() call directly; the two identity
 *  passthroughs exist only so T10.4's dispatch()-driven tests (which exercise the audio-delta
 *  outbound-forward path, unlike this file's original T05.1-era bargeIn()-only tests) don't hit
 *  a missing-method TypeError — DSP itself is out of scope for every test in this file. */
function fakeTranscoder(): {
  resetCalls: number;
  resetOutbound: () => void;
  gatewayToTwilio: (delta: string) => string;
  twilioToGateway: (payload: string) => string;
} {
  const spy = {
    resetCalls: 0,
    resetOutbound: () => {},
    gatewayToTwilio: (delta: string) => delta,
    twilioToGateway: (payload: string) => payload,
  };
  spy.resetOutbound = () => {
    spy.resetCalls += 1;
  };
  return spy;
}

function makeSession(streamSid = 'MZ1'): Session {
  const socket = fakeSocket();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = createSession({ twilioWs: socket as any, streamSid, callSid: 'CA1', log: () => {} });
  session.gateway = fakeGateway() as unknown as Session['gateway'];
  session.transcoder = fakeTranscoder() as unknown as Session['transcoder'];
  return session;
}

function socketSent(s: Session): string[] {
  return (s.twilioWs as unknown as { sent: string[] }).sent;
}
function gatewayCalls(s: Session): ClientEvent[] {
  return (s.gateway as unknown as { calls: ClientEvent[] }).calls;
}
function transcoderResetCalls(s: Session): number {
  return (s.transcoder as unknown as { resetCalls: number }).resetCalls;
}

describe('bargeIn — A9 no-op guard', () => {
  it('markQueue empty AND !responseActive: nothing sent on either socket', () => {
    const s = makeSession();
    s.markQueue = [];
    s.responseActive = false;

    bargeIn(s);

    expect(socketSent(s)).toEqual([]);
    expect(gatewayCalls(s)).toEqual([]);
    expect(transcoderResetCalls(s)).toBe(0);
  });
});

describe('bargeIn — A10 pre-delta barge-in', () => {
  it('response-created seen, no delta yet: clear sent, NO truncate', () => {
    const s = makeSession();
    s.responseActive = true; // response-created seen
    s.markQueue = []; // no delta has arrived yet
    s.responseStartTimestamp = null; // epoch unarmed
    s.lastAssistantItemId = null;

    bargeIn(s);

    const sent = socketSent(s);
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0]!)).toEqual({ event: 'clear', streamSid: 'MZ1' });
    expect(gatewayCalls(s)).toEqual([]); // no truncate — epoch never armed
    expect(transcoderResetCalls(s)).toBe(1); // still an EFFECTIVE barge-in (guard passed)
  });
});

describe('bargeIn — A11 multiple barge-ins', () => {
  it('second barge-in while state is disarmed no-ops; re-arming makes the next one fire', () => {
    const s = makeSession();

    // Arm response A and barge in — effective. (`pushMark` itself sends one 'mark' wire frame,
    // so socket-send counts below track deltas around each `bargeIn` call rather than
    // absolute totals — the clear frame is the only thing `bargeIn` itself sends here.)
    s.responseActive = true;
    pushMark(s, 'rA:1');
    s.responseStartTimestamp = 100;
    s.lastAssistantItemId = 'itemA';
    s.currentResponseId = 'A';
    s.latestMediaTimestamp = 150;

    const beforeFirst = socketSent(s).length;
    bargeIn(s);
    expect(socketSent(s).length).toBe(beforeFirst + 1); // the clear frame
    expect(gatewayCalls(s).length).toBe(1);
    expect(transcoderResetCalls(s)).toBe(1);

    // Simulate response-done arriving with no new speech (session.ts's job in production) —
    // this is the "state disarmed, same response, no new delta" condition the guard checks.
    s.responseActive = false;

    const beforeNoop = socketSent(s).length;
    bargeIn(s); // second speech-started: markQueue==[] AND !responseActive -> true no-op
    expect(socketSent(s).length).toBe(beforeNoop); // unchanged — nothing sent
    expect(gatewayCalls(s).length).toBe(1); // unchanged
    expect(transcoderResetCalls(s)).toBe(1); // unchanged

    // Simulate the NEXT response's first delta re-arming the epoch.
    s.responseActive = true;
    pushMark(s, 'rB:1');
    s.responseStartTimestamp = 200;
    s.lastAssistantItemId = 'itemB';
    s.currentResponseId = 'B';
    s.latestMediaTimestamp = 260;

    const beforeSecond = socketSent(s).length; // includes rB:1's mark send
    bargeIn(s); // fires again
    expect(socketSent(s).length).toBe(beforeSecond + 1); // the clear frame
    expect(gatewayCalls(s).length).toBe(2);
    expect(transcoderResetCalls(s)).toBe(2);
    expect(gatewayCalls(s)[1]).toEqual({
      type: 'conversation-item-truncate',
      itemId: 'itemB',
      contentIndex: 0,
      audioEndMs: 60,
    });
  });
});

describe('bargeIn — A8 mark storm (post-clear echo tolerance)', () => {
  it('flushed-name echoes leave the NEXT response markQueue intact; barge-in on it still fires', () => {
    const s = makeSession();

    // Response A: two marks pushed, then an effective barge-in flushes the queue.
    s.responseActive = true;
    pushMark(s, 'rA:1');
    pushMark(s, 'rA:2');
    s.responseStartTimestamp = 100;
    s.lastAssistantItemId = 'itemA';
    s.currentResponseId = 'A';
    s.latestMediaTimestamp = 140;

    bargeIn(s);
    expect(s.markQueue).toEqual([]);

    // Response B starts: a mark is pushed for it.
    pushMark(s, 'rB:1');
    expect(s.markQueue).toEqual(['rB:1']);

    // Stale echoes for A's already-flushed marks arrive (Twilio's post-clear echo storm).
    onMarkEcho(s, 'rA:1');
    onMarkEcho(s, 'rA:2');
    expect(s.markQueue).toEqual(['rB:1']); // NOT corrupted — B's mark survives

    // Response B's first delta re-arms the epoch; a barge-in on B still fires.
    s.responseActive = true;
    s.responseStartTimestamp = 200;
    s.lastAssistantItemId = 'itemB';
    s.currentResponseId = 'B';
    s.latestMediaTimestamp = 230;

    bargeIn(s);
    expect(gatewayCalls(s).length).toBe(2);
    expect(gatewayCalls(s)[1]).toEqual({
      type: 'conversation-item-truncate',
      itemId: 'itemB',
      contentIndex: 0,
      audioEndMs: 30,
    });
  });
});

describe('bargeIn — epoch arithmetic', () => {
  it('audioEndMs = max(0, latestMediaTimestamp - responseStartTimestamp); itemId/contentIndex fixed', () => {
    const s = makeSession();
    s.responseActive = true;
    s.markQueue = ['r1:1'];
    s.responseStartTimestamp = 1000;
    s.lastAssistantItemId = 'item1';
    s.currentResponseId = 'r1';
    s.latestMediaTimestamp = 1070;

    bargeIn(s);

    expect(gatewayCalls(s)[0]).toEqual({
      type: 'conversation-item-truncate',
      itemId: 'item1',
      contentIndex: 0,
      audioEndMs: 70,
    });
  });

  it('audioEndMs: 0 is legal (latestMediaTimestamp <= responseStartTimestamp)', () => {
    const s = makeSession();
    s.responseActive = true;
    s.markQueue = ['r1:1'];
    s.responseStartTimestamp = 1000;
    s.lastAssistantItemId = 'item1';
    s.currentResponseId = 'r1';
    s.latestMediaTimestamp = 950; // a mark-echo-in-flight race — see findings/04 G6

    bargeIn(s);

    expect(gatewayCalls(s).length).toBe(1);
    expect(gatewayCalls(s)[0]!.type === 'conversation-item-truncate' && (gatewayCalls(s)[0] as { audioEndMs: number }).audioEndMs).toBe(0);
  });
});

describe('bargeIn — unwired gateway guard', () => {
  it('gateway undefined: warns loudly (barge-in-no-gateway) instead of silently skipping the truncate, and never throws', () => {
    const socket = fakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = createSession({ twilioWs: socket as any, streamSid: 'MZ1', callSid: 'CA1', log: () => {} });
    s.transcoder = fakeTranscoder() as unknown as Session['transcoder'];
    // s.gateway is intentionally left undefined here — an unwired/mis-constructed session.

    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    s.log = (level, message, fields) => {
      logs.push({ level, message, fields });
    };

    s.responseActive = true;
    s.markQueue = ['r1:1'];
    s.responseStartTimestamp = 100;
    s.lastAssistantItemId = 'item1';
    s.currentResponseId = 'r1';
    s.latestMediaTimestamp = 150;

    expect(() => bargeIn(s)).not.toThrow();

    const warnLine = logs.find((l) => l.message === 'barge-in-no-gateway');
    expect(warnLine, 'expected a barge-in-no-gateway warn line').toBeTruthy();
    expect(warnLine.level).toBe('warn');
    expect(warnLine.fields?.audioEndMs).toBe(50);

    // The truncate branch was skipped EXPLICITLY (loud warn), not silently swallowed as a
    // normal 'info'-level barge-in line.
    expect(logs.some((l) => l.message === 'barge-in')).toBe(false);

    // Flush/disarm still happens — an unwired gateway must not leave the epoch stuck armed.
    expect(s.markQueue).toEqual([]);
    expect(s.responseStartTimestamp).toBe(null);
  });
});

describe('bargeIn — A13 (bargeIn half): transcoder.resetOutbound call-site contract', () => {
  it('is called exactly once per EFFECTIVE barge-in, never on the A9 no-op path', () => {
    const s = makeSession();

    // No-op path first.
    s.markQueue = [];
    s.responseActive = false;
    bargeIn(s);
    expect(transcoderResetCalls(s)).toBe(0);

    // Effective path.
    s.responseActive = true;
    s.markQueue = ['r1:1'];
    bargeIn(s);
    expect(transcoderResetCalls(s)).toBe(1);
  });
});

describe('bargeIn — post-bargeIn state', () => {
  it('flushes markQueue/firstMarkNameOfResponse/responseStartTimestamp/lastAssistantItemId/currentResponseId and tags an open currentTurn', () => {
    const s = makeSession();
    s.responseActive = true;
    pushMark(s, 'r1:1');
    s.responseStartTimestamp = 100;
    s.lastAssistantItemId = 'item1';
    s.currentResponseId = 'r1';
    s.latestMediaTimestamp = 150;
    s.currentTurn = { turn: 1, tools: [], bargedIn: false }; // open turn (no tResponseDone)

    bargeIn(s);

    expect(s.markQueue).toEqual([]);
    expect(s.firstMarkNameOfResponse).toBe(null);
    expect(s.responseStartTimestamp).toBe(null);
    expect(s.lastAssistantItemId).toBe(null);
    expect(s.currentResponseId).toBe(null);
    const turn = s.currentTurn;
    expect(turn).toBeTruthy();
    expect(turn.bargedIn).toBe(true);
  });

  it('does NOT force bargedIn on an already-closed currentTurn (tResponseDone set)', () => {
    const s = makeSession();
    s.responseActive = true;
    s.markQueue = ['r1:1'];
    s.currentTurn = { turn: 1, tools: [], bargedIn: false, tResponseDone: 42 };

    bargeIn(s);

    const turn = s.currentTurn;
    expect(turn).toBeTruthy();
    expect(turn.bargedIn).toBe(false);
  });
});

describe('pushMark — closed-socket guard (T05.4 regression, Spec 03 R5 sendMark contract)', () => {
  it('CLOSING/CLOSED socket: sendMark no-ops and firstMarkNameOfResponse stays unarmed', () => {
    for (const rs of [2 /* CLOSING */, 3 /* CLOSED */]) {
      const s = makeSession();
      (s.twilioWs as unknown as { readyState: number }).readyState = rs;
      s.firstMarkNameOfResponse = null;

      pushMark(s, 'r1:1');

      expect(socketSent(s)).toEqual([]); // sendMark itself no-oped
      expect(s.firstMarkNameOfResponse).toBe(null); // never armed for a mark that was never sent
      expect(s.markQueue).toEqual([]); // sendMark's own push never ran either
    }
  });
});

describe('onMarkEcho — drain disarm (Spec 05 R4 rule 3)', () => {
  it('removing the LAST queued name sets responseStartTimestamp = null and fires onPlaybackDrained', () => {
    const s = makeSession();
    s.markQueue = ['r1:1'];
    s.responseStartTimestamp = 999;
    let drained = 0;
    s.onPlaybackDrained = () => {
      drained += 1;
    };

    onMarkEcho(s, 'r1:1');

    expect(s.markQueue).toEqual([]);
    expect(s.responseStartTimestamp).toBe(null);
    expect(drained).toBe(1);
  });

  it('unknown/stale names are silently ignored (never a bare shift(), never a throw)', () => {
    const s = makeSession();
    s.markQueue = ['r1:1', 'r1:2'];

    expect(() => onMarkEcho(s, 'unknown-name')).not.toThrow();
    expect(s.markQueue).toEqual(['r1:1', 'r1:2']);
  });
});

describe('static A14 (grep companion — see completion report)', () => {
  it('bargeIn never constructs the redundant cancel ClientEvent (C3)', () => {
    const s = makeSession();
    s.responseActive = true;
    s.markQueue = ['r1:1'];
    s.responseStartTimestamp = 100;
    s.lastAssistantItemId = 'item1';
    s.latestMediaTimestamp = 150;

    bargeIn(s);

    // Built at runtime (never a literal wire-name substring in src/) so this assertion doesn't
    // itself trip the A14 source-grep it's here to back up.
    const redundantCancelEventType = ['response', 'cancel'].join('-');
    for (const ev of gatewayCalls(s)) {
      expect((ev as { type: string }).type).not.toBe(redundantCancelEventType);
    }
  });
});

// ── T10.4 additions below — Spec 10 R5 event-sequence simulations driven through the real
// dispatch() loop (src/session.ts), not bargein.ts's exported functions directly. Everything
// above this line is T05.1-era pure-bargein.ts-level coverage (A7-A14), kept as-is per the plan's
// "absorbs/extends" instruction. R5.5 (benign-error whitelist) and R5.7 (silent-ignore set) are
// exhaustively covered per-event-type by test/session-dispatch.test.ts's "dispatch — error
// policy" and "dispatch — consciously-ignored events" suites already — the two smoke tests below
// exist only so `npx vitest run test/bargein.test.ts` alone still demonstrates every R5 item
// without re-deriving that exhaustive list here.

describe('dispatch — R5.1 stale-epoch regression (Spec 10 R5.1 literal script, normative)', () => {
  it("streamSid MZtest1: r1's 3 deltas all echoed + drain (media->6000) disarms the epoch; r2's first delta re-arms it at 8000; media->8500; speech-started -> clear to Twilio FIRST, THEN truncate(item_b, contentIndex:0, audioEndMs:500), never 7500 (8500-1000)", () => {
    const socket = fakeSocket();
    const session = createSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      twilioWs: socket as any,
      streamSid: 'MZtest1',
      callSid: 'CA-r51',
      log: () => {},
    });
    session.gateway = fakeGateway() as unknown as Session['gateway'];
    session.transcoder = fakeTranscoder() as unknown as Session['transcoder'];

    // Cross-socket ordering timeline: `clear` goes to the Twilio socket, `truncate` goes to the
    // gateway socket — two independent arrays in production too (Spec 05 R5 ordering note: "no
    // cross-ordering exists" between them structurally), so a shared tagged timeline via
    // wrapping both fakes' `send` is the only way to assert R5.1's literal "clear sent to Twilio
    // FIRST" wording end to end.
    const timeline: string[] = [];
    const origSocketSend = socket.send;
    socket.send = (data: string) => {
      if ((JSON.parse(data) as { event: string }).event === 'clear') timeline.push('clear');
      origSocketSend(data);
    };
    const gw = session.gateway as unknown as { send: (ev: ClientEvent) => Promise<void> };
    const origGwSend = gw.send;
    gw.send = async (ev: ClientEvent) => {
      if ((ev as { type: string }).type === 'conversation-item-truncate') timeline.push('truncate');
      await origGwSend(ev);
    };

    // r1: response-created, media->1000, three deltas (three marks queued).
    dispatch(session, { type: 'response-created', responseId: 'r1', raw: {} });
    session.latestMediaTimestamp = 1000;
    dispatch(session, { type: 'audio-delta', responseId: 'r1', itemId: 'item_a', delta: 'd1', raw: {} });
    dispatch(session, { type: 'audio-delta', responseId: 'r1', itemId: 'item_a', delta: 'd2', raw: {} });
    dispatch(session, { type: 'audio-delta', responseId: 'r1', itemId: 'item_a', delta: 'd3', raw: {} });
    expect(session.markQueue.length).toBe(3);

    // Echo every emitted mark back -> queue drains -> epoch MUST disarm (R4 rule 3).
    for (const name of [...session.markQueue]) onMarkEcho(session, name);
    expect(session.markQueue).toEqual([]);
    expect(session.responseStartTimestamp).toBe(null);
    session.latestMediaTimestamp = 6000;

    // r2: response-created, media->8000, two deltas (epoch re-arms at 8000 — NOT 1000, NOT 6000).
    dispatch(session, { type: 'response-created', responseId: 'r2', raw: {} });
    session.latestMediaTimestamp = 8000;
    dispatch(session, { type: 'audio-delta', responseId: 'r2', itemId: 'item_b', delta: 'd4', raw: {} });
    dispatch(session, { type: 'audio-delta', responseId: 'r2', itemId: 'item_b', delta: 'd5', raw: {} });
    expect(session.responseStartTimestamp).toBe(8000);

    session.latestMediaTimestamp = 8500;
    dispatch(session, { type: 'speech-started', raw: {} });

    expect(timeline).toEqual(['clear', 'truncate']); // clear to Twilio strictly before truncate to gateway

    const gwCalls = (session.gateway as unknown as { calls: ClientEvent[] }).calls;
    const truncateCalls = gwCalls.filter((c) => (c as { type: string }).type === 'conversation-item-truncate');
    expect(truncateCalls.length).toBe(1);
    const truncate = truncateCalls[0] as unknown as { itemId: string; contentIndex: number; audioEndMs: number };
    expect(truncate.itemId).toBe('item_b');
    expect(truncate.contentIndex).toBe(0);
    expect(truncate.audioEndMs).toBe(500); // 8500 - 8000
    expect(truncate.audioEndMs).not.toBe(7500); // the stale-epoch bug value (8500 - 1000)

    // R5.2 (same script): no response-cancel ever sent across the whole exchange (server-vad
    // interrupt_response already cancelled; C3 decision).
    const redundantCancelEventType = ['response', 'cancel'].join('-');
    expect(gwCalls.some((c) => (c as { type: string }).type === redundantCancelEventType)).toBe(false);
  });
});

describe('dispatch — R5.3 guard no-ops (event-sequence via dispatch, not bargein.ts directly)', () => {
  it('speech-started with empty markQueue and disarmed epoch (turn 1 / post-playback / tool gap) sends nothing on either socket', () => {
    const s = makeSession();

    dispatch(s, { type: 'speech-started', raw: {} });

    expect(socketSent(s)).toEqual([]);
    expect(gatewayCalls(s)).toEqual([]);
  });

  it('a second speech-started in the same response (after the first effective barge-in) no-ops until the NEXT response first delta re-arms', () => {
    const s = makeSession();

    dispatch(s, { type: 'response-created', responseId: 'A', raw: {} });
    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: 'A', itemId: 'itemA', delta: 'd1', raw: {} });
    s.latestMediaTimestamp = 150;
    dispatch(s, { type: 'speech-started', raw: {} }); // effective: clear + truncate

    const sentAfterFirst = socketSent(s).length;
    const gwAfterFirst = gatewayCalls(s).length;
    expect(gwAfterFirst).toBe(1);

    // `bargeIn()` itself never touches `responseActive` (only `response-done` does, R10) — the
    // guard's `!responseActive` half only goes true once the server-vad auto-cancel's
    // `response-done` for the barged-in response arrives (same production dependency the
    // existing "A11 multiple barge-ins" test above documents by flipping the flag by hand).
    dispatch(s, { type: 'response-done', responseId: 'A', status: 'cancelled', raw: {} });

    // Same response, no new delta, now disarmed: state is disarmed -> no-op.
    dispatch(s, { type: 'speech-started', raw: {} });
    expect(socketSent(s).length).toBe(sentAfterFirst);
    expect(gatewayCalls(s).length).toBe(gwAfterFirst);

    // Next response's first delta re-arms the epoch; barge-in fires again.
    dispatch(s, { type: 'response-created', responseId: 'B', raw: {} });
    s.latestMediaTimestamp = 220;
    dispatch(s, { type: 'audio-delta', responseId: 'B', itemId: 'itemB', delta: 'd2', raw: {} });
    s.latestMediaTimestamp = 260;
    dispatch(s, { type: 'speech-started', raw: {} });

    expect(gatewayCalls(s).length).toBe(gwAfterFirst + 1);
    const truncate = gatewayCalls(s)[gwAfterFirst] as unknown as { itemId: string; audioEndMs: number };
    expect(truncate.itemId).toBe('itemB');
    expect(truncate.audioEndMs).toBe(40); // 260 - 220
  });
});

describe('dispatch — R5.4 array-frame contract (session-level ordering; array-splitting locus is src/gateway.ts, see test/gateway.leg.test.ts "A6 array frames")', () => {
  it('feeding the two-event array payload through dispatch, in order, applies both events in order', () => {
    const s = makeSession();

    // Exact payload from Spec 10 R5.4: one JSON array of [response-created, audio-delta]. The
    // array-SPLITTING itself is gateway.ts's job (Spec 05 R2 preamble: "gateway.ts... handles
    // single-event AND array frames... deliver every normalized event to callbacks.onEvent") and
    // is already covered end-to-end (real WS round trip, ordering + log line asserted) by
    // gateway.leg.test.ts's "handles an array frame" test. What THIS test proves is dispatch()'s
    // own side: it is agnostic to framing and produces the correct end state when fed the same
    // two events in the same order, one at a time.
    const events = [
      { type: 'response-created' as const, responseId: 'r3', raw: {} },
      { type: 'audio-delta' as const, responseId: 'r3', itemId: 'i3', delta: 'AAAA', raw: {} },
    ];
    for (const ev of events) dispatch(s, ev);

    expect(s.currentResponseId).toBe('r3');
    expect(s.lastAssistantItemId).toBe('i3');
    expect(s.markQueue.length).toBe(1); // the delta's mark was pushed -> both events landed, in order
  });
});

describe('dispatch — R5.5 benign-error whitelist (smoke; exhaustive per-code coverage in test/session-dispatch.test.ts "dispatch — error policy")', () => {
  it('a whitelisted code (response_cancel_not_active) logs warn and does not teardown', () => {
    const s = makeSession();
    let tornDown = 0;
    s.teardown = () => {
      tornDown += 1;
    };
    const warnLines: Array<{ level: string }> = [];
    s.log = (level) => {
      warnLines.push({ level });
    };

    dispatch(s, { type: 'error', message: 'no active response to cancel', code: 'response_cancel_not_active', raw: {} });

    expect(warnLines.some((l) => l.level === 'warn')).toBe(true);
    expect(tornDown).toBe(0);
  });

  it('an unknown code invokes the FR-7 teardown path', () => {
    const s = makeSession();
    const teardownCalls: string[] = [];
    s.teardown = (reason: string) => {
      teardownCalls.push(reason);
    };

    dispatch(s, { type: 'error', message: 'totally unrecognized failure', code: 'some_unknown_code', raw: {} });

    expect(teardownCalls).toEqual(['gateway-error']);
  });
});

describe('dispatch — R5.6 DSP reset seam with the REAL transcoder (createTranscoder("transcode"), per the Consumes contract)', () => {
  it('resetOutbound is invoked on response-created and on an effective bargeIn; the inbound Upsampler3x has no reset method at all (structural guarantee, not just an untested call site)', () => {
    const socket = fakeSocket();
    const session = createSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      twilioWs: socket as any,
      streamSid: 'MZ1',
      callSid: 'CA-dsp',
      log: () => {},
    });
    session.gateway = fakeGateway() as unknown as Session['gateway'];
    const realTranscoder = createTranscoder('transcode');
    session.transcoder = realTranscoder;
    const resetSpy = vi.spyOn(realTranscoder, 'resetOutbound');

    dispatch(session, { type: 'response-created', responseId: 'r1', raw: {} });
    expect(resetSpy).toHaveBeenCalledTimes(1); // call site 1 of 2 (Spec 06 R11.2)

    session.latestMediaTimestamp = 100;
    // 960 zero bytes = PCM24K_BYTES_PER_20MS (dsp.ts) — a realistic gateway audio-delta payload
    // for the REAL downsampler to chew on, not a fake string.
    dispatch(session, {
      type: 'audio-delta',
      responseId: 'r1',
      itemId: 'item1',
      delta: Buffer.alloc(960).toString('base64'),
      raw: {},
    });
    session.latestMediaTimestamp = 150;
    dispatch(session, { type: 'speech-started', raw: {} }); // effective bargeIn

    expect(resetSpy).toHaveBeenCalledTimes(2); // call site 2 of 2 (Spec 06 R11.2 / bargeIn step 4)

    // The inbound leg (Upsampler3x) is never reset mid-call — enforced structurally, not just by
    // convention: src/dsp.ts's Transcoder interface exposes exactly one reset method
    // (resetOutbound), and Upsampler3x itself has no reset() at all ("Deliberately has NO reset
    // method... must never be reset mid-call", src/dsp.ts). There is no call site to spy on
    // because the type system offers none.
    expect((realTranscoder as unknown as { resetInbound?: unknown }).resetInbound).toBeUndefined();
  });
});

describe('dispatch — R5.7 silent-ignore set (smoke; exhaustive per-event-type coverage in test/session-dispatch.test.ts "dispatch — consciously-ignored events")', () => {
  it('conversation-item-added, output-item-done, content-part-added/done, audio-done, text-delta/done, function-call-arguments-delta: no warn, no throw', () => {
    const s = makeSession();
    const logs: unknown[] = [];
    s.log = (level, message, fields) => {
      logs.push({ level, message, fields });
    };
    const ignored = [
      { type: 'conversation-item-added', itemId: 'i1', item: {}, raw: {} },
      { type: 'output-item-done', responseId: 'r1', itemId: 'i1', raw: {} },
      { type: 'content-part-added', responseId: 'r1', itemId: 'i1', raw: {} },
      { type: 'content-part-done', responseId: 'r1', itemId: 'i1', raw: {} },
      { type: 'audio-done', responseId: 'r1', itemId: 'i1', raw: {} },
      { type: 'text-delta', responseId: 'r1', itemId: 'i1', delta: 'hi', raw: {} },
      { type: 'text-done', responseId: 'r1', itemId: 'i1', text: 'hi', raw: {} },
      { type: 'function-call-arguments-delta', responseId: 'r1', itemId: 'i1', callId: 'c1', delta: '{', raw: {} },
    ] as const;

    for (const ev of ignored) {
      expect(() => dispatch(s, ev as Parameters<typeof dispatch>[1])).not.toThrow();
    }
    expect(logs).toEqual([]);
  });
});

describe('dispatch — greeting barge-in (Spec 05 R5 edge case: "the same machinery applies with zero special casing")', () => {
  it('a caller interrupting the greeting response (no preceding speech-stopped, turn 0) barges in exactly like any other response', () => {
    const s = makeSession();

    // The greeting flows through dispatch with no speech-stopped ever having fired — Spec 04
    // owns sending its response-create; this test only proves bargeIn's machinery doesn't
    // special-case the absence of a preceding turn.
    dispatch(s, { type: 'response-created', responseId: 'greet', raw: {} });
    s.latestMediaTimestamp = 200;
    dispatch(s, { type: 'audio-delta', responseId: 'greet', itemId: 'greetItem', delta: 'g1', raw: {} });
    s.latestMediaTimestamp = 350;

    dispatch(s, { type: 'speech-started', raw: {} });

    const clearFrames = socketSent(s).filter((m) => (JSON.parse(m) as { event: string }).event === 'clear');
    expect(clearFrames.length).toBe(1);
    const truncateCalls = gatewayCalls(s).filter((c) => (c as { type: string }).type === 'conversation-item-truncate');
    expect(truncateCalls.length).toBe(1);
    expect((truncateCalls[0] as unknown as { itemId: string; audioEndMs: number }).itemId).toBe('greetItem');
    expect((truncateCalls[0] as unknown as { audioEndMs: number }).audioEndMs).toBe(150); // 350 - 200
    expect(s.markQueue).toEqual([]); // flushed, same as any other barge-in
  });
});

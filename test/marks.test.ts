// T10.4 — Mark-registry suite (Spec 10 R6; discharges Spec 10 A4). Drives the REAL
// dispatch()/bargein.ts pipeline (src/session.ts, src/bargein.ts) through a captured Twilio
// socket + gateway leg — the same "fake sockets around a real createSession()" driver pattern
// test/bargein.test.ts and test/session-dispatch.test.ts already established (no second,
// competing driver introduced here; `makeDrivenSession` below is this file's local instance of
// that pattern, not a new shared export — the plan's Produces clause treats extraction as
// optional and only two of three T10.4 files need it, so it isn't).
//
// R6.1-R6.4 (queue/removal-by-name mechanics) are exercised at the dispatch level, same as
// test/session-dispatch.test.ts's A7 stale-epoch test — never re-implementing the mark-echo
// removal logic, only driving it. R6.5 additionally wires `session.onFirstMarkEcho` to a REAL
// `TurnRecorder.onMarkEcho` exactly as `src/session.ts`'s `startSessionBridge` wires it in
// production (that one wire is NOT exercised by test/session-turns.test.ts's own `wireSession()`
// helper, which never sets `onFirstMarkEcho` — this file closes that gap for the mark-registry
// half specifically).

import { describe, it, expect } from 'vitest';
import { dispatch } from '../src/session.js';
import { onMarkEcho } from '../src/bargein.js';
import { createSession, type Session } from '../src/sessions.js';
import { TurnRecorder } from '../src/latency.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';
import type { LogFields } from '../src/logger.js';

const OPEN = 1;

/** Minimal fake WebSocket — only the surface sendClear/sendMark/sendMedia touch. */
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

/** Identity transcoder — DSP is out of scope for this suite; only mark/queue mechanics matter. */
function fakeTranscoder(): { resetOutbound: () => void; gatewayToTwilio: (d: string) => string; twilioToGateway: (p: string) => string } {
  return {
    resetOutbound() {},
    gatewayToTwilio(delta: string) {
      return delta;
    },
    twilioToGateway(payload: string) {
      return payload;
    },
  };
}

/**
 * Builds a Session wired exactly as `startSessionBridge` (src/session.ts) wires the mark-echo ->
 * recorder path for R6.5: `session.onFirstMarkEcho = (name) => session.recorder?.onMarkEcho(name);`
 * — the one piece of production wiring test/session-turns.test.ts's own `wireSession()` doesn't
 * install (it wires `s.recorder` for turn-lifecycle purposes but never touches
 * `onFirstMarkEcho`), and the one thing R6.5 needs to prove end to end.
 */
function makeDrivenSession(): { s: Session; turnLogs: LogFields[] } {
  const socket = fakeSocket();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = createSession({ twilioWs: socket as any, streamSid: 'MZ1', callSid: 'CA1', log: () => {} });
  s.gateway = fakeGateway() as unknown as Session['gateway'];
  s.transcoder = fakeTranscoder() as unknown as Session['transcoder'];

  const turnLogs: LogFields[] = [];
  const recorder = new TurnRecorder({ callSid: s.callSid, streamSid: s.streamSid }, (fields) => {
    turnLogs.push(fields);
  });
  s.recorder = recorder;
  s.onFirstMarkEcho = (name) => {
    s.recorder?.onMarkEcho(name);
  };

  return { s, turnLogs };
}

function socketSent(s: Session): string[] {
  return (s.twilioWs as unknown as { sent: string[] }).sent;
}

describe('marks — R6.1/R6.2 post-clear echo storm (findings/04 G2; findings/03 claim 16.3; findings/10 C4)', () => {
  it('r1 queues 3 unique marks; echoing the first then barging in flushes the queue locally; late echoes of the other two are ignored (no crash, no undercount, no epoch re-arm)', () => {
    const { s } = makeDrivenSession();

    dispatch(s, { type: 'response-created', responseId: '1', raw: {} });
    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd1', raw: {} });
    s.latestMediaTimestamp = 130;
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd2', raw: {} });
    s.latestMediaTimestamp = 160;
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd3', raw: {} });

    expect(s.markQueue).toEqual(['r1:1', 'r1:2', 'r1:3']); // m1, m2, m3 — unique per-response names
    const [m1, m2, m3] = s.markQueue;

    // Echo m1: removed by name; queue still non-empty, epoch still armed.
    onMarkEcho(s, m1!);
    expect(s.markQueue).toEqual([m2, m3]);
    expect(s.responseStartTimestamp).not.toBe(null);

    // Caller barges in: clear sent, queue flushed LOCALLY (bargeIn step 4) — BEFORE Twilio's
    // simulated echo of the still-pending m2/m3 ever arrives.
    s.latestMediaTimestamp = 180;
    dispatch(s, { type: 'speech-started', raw: {} });
    expect(s.markQueue).toEqual([]);
    expect(s.responseStartTimestamp).toBe(null);
    const clearFrames = socketSent(s).filter((f) => (JSON.parse(f) as { event: string }).event === 'clear');
    expect(clearFrames.length).toBe(1);

    // The post-clear storm: Twilio echoes ALL pending marks on `clear` (they mean "flushed", not
    // "played"). m2/m3 arrive late and must be tolerated.
    expect(() => onMarkEcho(s, m2!)).not.toThrow();
    expect(() => onMarkEcho(s, m3!)).not.toThrow();
    expect(s.markQueue).toEqual([]); // still empty — no negative length, no undercount
    expect(s.responseStartTimestamp).toBe(null); // NOT re-armed by the stale echoes
  });
});

describe('marks — R6.3 next-response accounting uncorrupted by a prior storm', () => {
  it('after a barge-in flush, the next response queues exactly its own mark; echoing it drains the queue and disarms the epoch; late echoes of the OLD (flushed) names never touch it', () => {
    const { s } = makeDrivenSession();

    dispatch(s, { type: 'response-created', responseId: '1', raw: {} });
    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd1', raw: {} });
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd2', raw: {} });
    const [staleA, staleB] = s.markQueue;
    s.latestMediaTimestamp = 150;
    dispatch(s, { type: 'speech-started', raw: {} }); // barge-in flushes response 1's queue
    expect(s.markQueue).toEqual([]);

    // Response 2's first delta queues exactly its own mark — response 1's storm must not have
    // poisoned markSeq/queue bookkeeping.
    dispatch(s, { type: 'response-created', responseId: '2', raw: {} });
    s.latestMediaTimestamp = 300;
    dispatch(s, { type: 'audio-delta', responseId: '2', itemId: 'item2', delta: 'd3', raw: {} });
    expect(s.markQueue.length).toBe(1);
    const n1 = s.markQueue[0]!;
    expect(s.responseStartTimestamp).toBe(300);

    // Late echoes of response 1's already-flushed names arrive AFTER response 2 has started —
    // must not touch response 2's queue.
    onMarkEcho(s, staleA!);
    onMarkEcho(s, staleB!);
    expect(s.markQueue).toEqual([n1]); // untouched

    // n1's real echo drains the queue and disarms the epoch (R4 rule 3).
    onMarkEcho(s, n1);
    expect(s.markQueue).toEqual([]);
    expect(s.responseStartTimestamp).toBe(null);
  });
});

describe('marks — R6.4 never-sent name', () => {
  it('a mark echo whose name was never sent is ignored: no throw, no queue mutation', () => {
    const { s } = makeDrivenSession();
    dispatch(s, { type: 'response-created', responseId: '1', raw: {} });
    s.latestMediaTimestamp = 50;
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd1', raw: {} });
    expect(s.markQueue).toEqual(['r1:1']);

    expect(() => onMarkEcho(s, 'never-sent-name')).not.toThrow();
    expect(s.markQueue).toEqual(['r1:1']); // untouched
  });
});

describe('marks — R6.5 first-mark-per-response stamps tFirstMarkEcho (findings/10 T3 unified namespace, full production wiring)', () => {
  it('echoing the FIRST mark of a response — even out of order — stamps the turn record, surfaced as a numeric playbackConfirmMs on the consolidated turn line', () => {
    const { s, turnLogs } = makeDrivenSession();

    dispatch(s, { type: 'speech-stopped', raw: {} });
    dispatch(s, { type: 'response-created', responseId: '1', raw: {} });
    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd1', raw: {} });
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd2', raw: {} });
    expect(s.markQueue).toEqual(['r1:1', 'r1:2']);

    // Echo the SECOND mark first — tFirstMarkEcho must stamp on the FIRST mark's NAME only,
    // never on "whichever echo happens to arrive first".
    onMarkEcho(s, 'r1:2');
    onMarkEcho(s, 'r1:1');

    dispatch(s, { type: 'response-done', responseId: '1', status: 'completed', raw: {} });

    const turnLines = turnLogs.filter((f) => f.event === 'turn');
    expect(turnLines.length).toBe(1);
    expect(typeof turnLines[0]!.playbackConfirmMs).toBe('number'); // proves tFirstMarkEcho was stamped
  });

  it('a response with no mark echo at all leaves playbackConfirmMs absent (never crashes, never fabricates a stamp)', () => {
    const { s, turnLogs } = makeDrivenSession();
    dispatch(s, { type: 'speech-stopped', raw: {} });
    dispatch(s, { type: 'response-created', responseId: '1', raw: {} });
    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd1', raw: {} });
    // no onMarkEcho call at all — the mark is still "in flight" when the response ends.
    dispatch(s, { type: 'response-done', responseId: '1', status: 'completed', raw: {} });

    const turnLines = turnLogs.filter((f) => f.event === 'turn');
    expect(turnLines.length).toBe(1);
    expect(turnLines[0]!.playbackConfirmMs).toBe(undefined);
  });

  it('the SECOND response only stamps its OWN first mark echo — a stale first-response echo arriving late never re-stamps the new turn', () => {
    const { s, turnLogs } = makeDrivenSession();

    dispatch(s, { type: 'speech-stopped', raw: {} });
    dispatch(s, { type: 'response-created', responseId: '1', raw: {} });
    s.latestMediaTimestamp = 100;
    dispatch(s, { type: 'audio-delta', responseId: '1', itemId: 'item1', delta: 'd1', raw: {} });
    const staleFirstMark = s.markQueue[0]!;
    s.latestMediaTimestamp = 150;
    dispatch(s, { type: 'speech-started', raw: {} }); // barge-in flushes response 1's queue

    dispatch(s, { type: 'speech-stopped', raw: {} });
    dispatch(s, { type: 'response-created', responseId: '2', raw: {} });
    s.latestMediaTimestamp = 300;
    dispatch(s, { type: 'audio-delta', responseId: '2', itemId: 'item2', delta: 'd2', raw: {} });
    const secondFirstMark = s.markQueue[0]!;

    // The stale response-1 name arrives late (post-clear storm) — must not stamp response 2's
    // tFirstMarkEcho even though response 1's own name has the MARK_NAME_RE-parseable form.
    onMarkEcho(s, staleFirstMark);
    onMarkEcho(s, secondFirstMark);

    dispatch(s, { type: 'response-done', responseId: '2', status: 'completed', raw: {} });

    const turnLines = turnLogs.filter((f) => f.event === 'turn' && f.responseId === '2');
    expect(turnLines.length).toBe(1);
    expect(typeof turnLines[0]!.playbackConfirmMs).toBe('number');
  });
});

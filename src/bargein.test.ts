// T05.1 — bargein.ts unit suite (Spec 05 A8, A9, A10, A11 + bargeIn half of A13 + static half
// of A14). Pure-logic module, no fastify.injectWS anywhere in this file — exempt from the repo's
// "one injectWS-backed test per file" rule (node:test Windows silent-drop bug only bites heavy
// WS-server suites), so all cases share this one file per the plan.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bargeIn, pushMark, onMarkEcho } from './bargein.js';
import { createSession, type Session } from './sessions.js';
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

/** Spy transcoder — only resetOutbound matters to this module (Spec 06 R11/A9 contract). */
function fakeTranscoder(): { resetCalls: number; resetOutbound: () => void } {
  const spy = { resetCalls: 0, resetOutbound: () => {} };
  spy.resetOutbound = () => {
    spy.resetCalls += 1;
  };
  return spy;
}

function makeSession(): Session {
  const socket = fakeSocket();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = createSession({ twilioWs: socket as any, streamSid: 'MZ1', callSid: 'CA1', log: () => {} });
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

    assert.deepEqual(socketSent(s), []);
    assert.deepEqual(gatewayCalls(s), []);
    assert.equal(transcoderResetCalls(s), 0);
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
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0]!), { event: 'clear', streamSid: 'MZ1' });
    assert.deepEqual(gatewayCalls(s), []); // no truncate — epoch never armed
    assert.equal(transcoderResetCalls(s), 1); // still an EFFECTIVE barge-in (guard passed)
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
    assert.equal(socketSent(s).length, beforeFirst + 1); // the clear frame
    assert.equal(gatewayCalls(s).length, 1);
    assert.equal(transcoderResetCalls(s), 1);

    // Simulate response-done arriving with no new speech (session.ts's job in production) —
    // this is the "state disarmed, same response, no new delta" condition the guard checks.
    s.responseActive = false;

    const beforeNoop = socketSent(s).length;
    bargeIn(s); // second speech-started: markQueue==[] AND !responseActive -> true no-op
    assert.equal(socketSent(s).length, beforeNoop); // unchanged — nothing sent
    assert.equal(gatewayCalls(s).length, 1); // unchanged
    assert.equal(transcoderResetCalls(s), 1); // unchanged

    // Simulate the NEXT response's first delta re-arming the epoch.
    s.responseActive = true;
    pushMark(s, 'rB:1');
    s.responseStartTimestamp = 200;
    s.lastAssistantItemId = 'itemB';
    s.currentResponseId = 'B';
    s.latestMediaTimestamp = 260;

    const beforeSecond = socketSent(s).length; // includes rB:1's mark send
    bargeIn(s); // fires again
    assert.equal(socketSent(s).length, beforeSecond + 1); // the clear frame
    assert.equal(gatewayCalls(s).length, 2);
    assert.equal(transcoderResetCalls(s), 2);
    assert.deepEqual(gatewayCalls(s)[1], {
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
    assert.deepEqual(s.markQueue, []);

    // Response B starts: a mark is pushed for it.
    pushMark(s, 'rB:1');
    assert.deepEqual(s.markQueue, ['rB:1']);

    // Stale echoes for A's already-flushed marks arrive (Twilio's post-clear echo storm).
    onMarkEcho(s, 'rA:1');
    onMarkEcho(s, 'rA:2');
    assert.deepEqual(s.markQueue, ['rB:1']); // NOT corrupted — B's mark survives

    // Response B's first delta re-arms the epoch; a barge-in on B still fires.
    s.responseActive = true;
    s.responseStartTimestamp = 200;
    s.lastAssistantItemId = 'itemB';
    s.currentResponseId = 'B';
    s.latestMediaTimestamp = 230;

    bargeIn(s);
    assert.equal(gatewayCalls(s).length, 2);
    assert.deepEqual(gatewayCalls(s)[1], {
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

    assert.deepEqual(gatewayCalls(s)[0], {
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

    assert.equal(gatewayCalls(s).length, 1);
    assert.equal(gatewayCalls(s)[0]!.type === 'conversation-item-truncate' && (gatewayCalls(s)[0] as { audioEndMs: number }).audioEndMs, 0);
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

    assert.doesNotThrow(() => bargeIn(s));

    const warnLine = logs.find((l) => l.message === 'barge-in-no-gateway');
    assert.ok(warnLine, 'expected a barge-in-no-gateway warn line');
    assert.equal(warnLine.level, 'warn');
    assert.equal(warnLine.fields?.audioEndMs, 50);

    // The truncate branch was skipped EXPLICITLY (loud warn), not silently swallowed as a
    // normal 'info'-level barge-in line.
    assert.equal(logs.some((l) => l.message === 'barge-in'), false);

    // Flush/disarm still happens — an unwired gateway must not leave the epoch stuck armed.
    assert.deepEqual(s.markQueue, []);
    assert.equal(s.responseStartTimestamp, null);
  });
});

describe('bargeIn — A13 (bargeIn half): transcoder.resetOutbound call-site contract', () => {
  it('is called exactly once per EFFECTIVE barge-in, never on the A9 no-op path', () => {
    const s = makeSession();

    // No-op path first.
    s.markQueue = [];
    s.responseActive = false;
    bargeIn(s);
    assert.equal(transcoderResetCalls(s), 0);

    // Effective path.
    s.responseActive = true;
    s.markQueue = ['r1:1'];
    bargeIn(s);
    assert.equal(transcoderResetCalls(s), 1);
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

    assert.deepEqual(s.markQueue, []);
    assert.equal(s.firstMarkNameOfResponse, null);
    assert.equal(s.responseStartTimestamp, null);
    assert.equal(s.lastAssistantItemId, null);
    assert.equal(s.currentResponseId, null);
    const turn = s.currentTurn;
    assert.ok(turn);
    assert.equal(turn.bargedIn, true);
  });

  it('does NOT force bargedIn on an already-closed currentTurn (tResponseDone set)', () => {
    const s = makeSession();
    s.responseActive = true;
    s.markQueue = ['r1:1'];
    s.currentTurn = { turn: 1, tools: [], bargedIn: false, tResponseDone: 42 };

    bargeIn(s);

    const turn = s.currentTurn;
    assert.ok(turn);
    assert.equal(turn.bargedIn, false);
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

    assert.deepEqual(s.markQueue, []);
    assert.equal(s.responseStartTimestamp, null);
    assert.equal(drained, 1);
  });

  it('unknown/stale names are silently ignored (never a bare shift(), never a throw)', () => {
    const s = makeSession();
    s.markQueue = ['r1:1', 'r1:2'];

    assert.doesNotThrow(() => onMarkEcho(s, 'unknown-name'));
    assert.deepEqual(s.markQueue, ['r1:1', 'r1:2']);
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
      assert.notEqual((ev as { type: string }).type, redundantCancelEventType);
    }
  });
});

// T03.3 — outbound send helpers, mark naming, and the backpressure guard (Spec 03 R5/R6, A6-A8).
// No network needed here: a fake socket object stands in for `ws.WebSocket` (same pattern as
// sessions.test.ts's `fakeSocket`), so these tests exercise `sendMedia`/`sendMark`/`sendClear`/
// `hangup`/`nextMarkName` as pure functions over a `Session`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendMedia,
  sendMark,
  sendClear,
  hangup,
  nextMarkName,
  isFirstMarkOfResponse,
} from './twilio-media.js';
import { createSession, type Session } from './sessions.js';

const OPEN = 1;
const CONNECTING = 0;
const CLOSING = 2;
const CLOSED = 3;

const noopLog: Session['log'] = () => {};

/** Minimal fake WebSocket — only the surface the outbound helpers touch. */
function fakeSocket(overrides: { readyState?: number; bufferedAmount?: number } = {}): {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  send: (data: string) => void;
  closeCalls: Array<{ code?: number; reason?: string }>;
  close: (code?: number, reason?: string) => void;
} {
  const sent: string[] = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  return {
    readyState: overrides.readyState ?? OPEN,
    bufferedAmount: overrides.bufferedAmount ?? 0,
    sent,
    send(data: string) {
      sent.push(data);
    },
    closeCalls,
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason });
    },
  };
}

function makeSession(socket: ReturnType<typeof fakeSocket>, streamSid = 'MZ1'): Session {
  return createSession({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    twilioWs: socket as any,
    streamSid,
    callSid: 'CA1',
    log: noopLog,
  });
}

describe('sendMedia — A6 outbound contract + backpressure guard', () => {
  it('sends byte-exact {event:"media",streamSid,media:{payload}} with no track field', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    sendMedia(session, 'QUJD');
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0], '{"event":"media","streamSid":"MZ1","media":{"payload":"QUJD"}}');
    assert.equal(JSON.parse(socket.sent[0] ?? '').media.track, undefined);
  });

  it('no-ops without throwing when readyState !== OPEN', () => {
    for (const rs of [CONNECTING, CLOSING, CLOSED]) {
      const socket = fakeSocket({ readyState: rs });
      const session = makeSession(socket);
      assert.doesNotThrow(() => sendMedia(session, 'QUJD'));
      assert.equal(socket.sent.length, 0);
      assert.equal(socket.closeCalls.length, 0);
    }
  });

  it('A7: a 100 KB payload goes out as exactly ONE send call', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    const bigPayload = 'A'.repeat(100_000);
    sendMedia(session, bigPayload);
    assert.equal(socket.sent.length, 1);
    assert.equal(JSON.parse(socket.sent[0] ?? '').media.payload, bigPayload);
  });

  it('A8: bufferedAmount > 1,000,000 closes 1011 and does not send', () => {
    const socket = fakeSocket({ bufferedAmount: 1_000_001 });
    const session = makeSession(socket);
    sendMedia(session, 'QUJD');
    assert.equal(socket.sent.length, 0);
    assert.equal(socket.closeCalls.length, 1);
    assert.equal(socket.closeCalls[0]?.code, 1011);
    assert.equal(socket.closeCalls[0]?.reason, 'backpressure');
  });

  it('A8: at exactly the 1,000,000 threshold it still sends (threshold is >)', () => {
    const socket = fakeSocket({ bufferedAmount: 1_000_000 });
    const session = makeSession(socket);
    sendMedia(session, 'QUJD');
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.closeCalls.length, 0);
  });
});

describe('sendMark — A6 outbound contract', () => {
  it('sends byte-exact {event:"mark",streamSid,mark:{name}} and pushes onto markQueue', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    sendMark(session, 'rA:1');
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0], '{"event":"mark","streamSid":"MZ1","mark":{"name":"rA:1"}}');
    assert.deepEqual(session.markQueue, ['rA:1']);
  });

  it('no-ops (no send, no queue push) without throwing when readyState !== OPEN', () => {
    for (const rs of [CONNECTING, CLOSING, CLOSED]) {
      const socket = fakeSocket({ readyState: rs });
      const session = makeSession(socket);
      assert.doesNotThrow(() => sendMark(session, 'rA:1'));
      assert.equal(socket.sent.length, 0);
      assert.deepEqual(session.markQueue, []);
    }
  });
});

describe('sendClear — A6 outbound contract', () => {
  it('sends byte-exact {event:"clear",streamSid}', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    sendClear(session);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0], '{"event":"clear","streamSid":"MZ1"}');
  });

  it('no-ops without throwing when readyState !== OPEN', () => {
    for (const rs of [CONNECTING, CLOSING, CLOSED]) {
      const socket = fakeSocket({ readyState: rs });
      const session = makeSession(socket);
      assert.doesNotThrow(() => sendClear(session));
      assert.equal(socket.sent.length, 0);
    }
  });
});

describe('hangup — R7 clean-hangup mechanism', () => {
  it('closes with the default code/reason (1000, "bye")', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    hangup(session);
    assert.equal(socket.closeCalls.length, 1);
    assert.equal(socket.closeCalls[0]?.code, 1000);
    assert.equal(socket.closeCalls[0]?.reason, 'bye');
  });

  it('closes with a caller-supplied code/reason', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    hangup(session, 1011, 'internal fault');
    assert.equal(socket.closeCalls[0]?.code, 1011);
    assert.equal(socket.closeCalls[0]?.reason, 'internal fault');
  });

  it('no-ops without throwing when readyState !== OPEN', () => {
    for (const rs of [CONNECTING, CLOSING, CLOSED]) {
      const socket = fakeSocket({ readyState: rs });
      const session = makeSession(socket);
      assert.doesNotThrow(() => hangup(session));
      assert.equal(socket.closeCalls.length, 0);
    }
  });
});

describe('nextMarkName — mark-naming rule (findings/10 T3)', () => {
  it('mints r<responseId>:<seq> with a per-session monotonic markSeq (not per-response)', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    assert.equal(nextMarkName(session, 'A'), 'rA:1');
    assert.equal(nextMarkName(session, 'A'), 'rA:2');
    assert.equal(nextMarkName(session, 'B'), 'rB:3');
  });

  it('two distinct sessions mint independent sequences (isolation)', () => {
    const sessionA = makeSession(fakeSocket(), 'MZ-a');
    const sessionB = makeSession(fakeSocket(), 'MZ-b');
    assert.equal(nextMarkName(sessionA, 'X'), 'rX:1');
    assert.equal(nextMarkName(sessionB, 'Y'), 'rY:1');
    assert.equal(nextMarkName(sessionA, 'X'), 'rX:2');
    assert.equal(nextMarkName(sessionB, 'Y'), 'rY:2');
  });
});

describe('isFirstMarkOfResponse — mark-naming rule (consumed by T03.4 mark-echo handler)', () => {
  it('flags only the first-minted name per responseId; later names for the same response are not first', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    const rA1 = nextMarkName(session, 'A');
    const rA2 = nextMarkName(session, 'A');
    const rB1 = nextMarkName(session, 'B');

    assert.equal(isFirstMarkOfResponse(session, rA1), true);
    assert.equal(isFirstMarkOfResponse(session, rA2), false);
    assert.equal(isFirstMarkOfResponse(session, rB1), true);
    assert.equal(isFirstMarkOfResponse(session, 'unknown-name'), false);
  });
});

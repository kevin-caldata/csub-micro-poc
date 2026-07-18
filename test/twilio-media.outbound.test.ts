// T03.3 — outbound send helpers, mark naming, and the backpressure guard (Spec 03 R5/R6, A6-A8).
// No network needed here: a fake socket object stands in for `ws.WebSocket` (same pattern as
// sessions.test.ts's `fakeSocket`), so these tests exercise `sendMedia`/`sendMark`/`sendClear`/
// `hangup`/`nextMarkName` as pure functions over a `Session`.

import { describe, it, expect } from 'vitest';
import {
  sendMedia,
  sendMark,
  sendClear,
  hangup,
  nextMarkName,
  isFirstMarkOfResponse,
} from '../src/twilio-media.js';
import { createSession, type Session } from '../src/sessions.js';

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
    expect(socket.sent.length).toBe(1);
    expect(socket.sent[0]).toBe('{"event":"media","streamSid":"MZ1","media":{"payload":"QUJD"}}');
    expect(JSON.parse(socket.sent[0] ?? '').media.track).toBe(undefined);
  });

  it('no-ops without throwing when readyState !== OPEN', () => {
    for (const rs of [CONNECTING, CLOSING, CLOSED]) {
      const socket = fakeSocket({ readyState: rs });
      const session = makeSession(socket);
      expect(() => sendMedia(session, 'QUJD')).not.toThrow();
      expect(socket.sent.length).toBe(0);
      expect(socket.closeCalls.length).toBe(0);
    }
  });

  it('A7: a 100 KB payload goes out as exactly ONE send call', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    const bigPayload = 'A'.repeat(100_000);
    sendMedia(session, bigPayload);
    expect(socket.sent.length).toBe(1);
    expect(JSON.parse(socket.sent[0] ?? '').media.payload).toBe(bigPayload);
  });

  it('A8: bufferedAmount > 1,000,000 closes 1011 and does not send', () => {
    const socket = fakeSocket({ bufferedAmount: 1_000_001 });
    const session = makeSession(socket);
    sendMedia(session, 'QUJD');
    expect(socket.sent.length).toBe(0);
    expect(socket.closeCalls.length).toBe(1);
    expect(socket.closeCalls[0]?.code).toBe(1011);
    expect(socket.closeCalls[0]?.reason).toBe('backpressure');
  });

  it('A8: at exactly the 1,000,000 threshold it still sends (threshold is >)', () => {
    const socket = fakeSocket({ bufferedAmount: 1_000_000 });
    const session = makeSession(socket);
    sendMedia(session, 'QUJD');
    expect(socket.sent.length).toBe(1);
    expect(socket.closeCalls.length).toBe(0);
  });
});

describe('sendMark — A6 outbound contract', () => {
  it('sends byte-exact {event:"mark",streamSid,mark:{name}} and pushes onto markQueue', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    sendMark(session, 'rA:1');
    expect(socket.sent.length).toBe(1);
    expect(socket.sent[0]).toBe('{"event":"mark","streamSid":"MZ1","mark":{"name":"rA:1"}}');
    expect(session.markQueue).toEqual(['rA:1']);
  });

  it('no-ops (no send, no queue push) without throwing when readyState !== OPEN', () => {
    for (const rs of [CONNECTING, CLOSING, CLOSED]) {
      const socket = fakeSocket({ readyState: rs });
      const session = makeSession(socket);
      expect(() => sendMark(session, 'rA:1')).not.toThrow();
      expect(socket.sent.length).toBe(0);
      expect(session.markQueue).toEqual([]);
    }
  });
});

describe('sendClear — A6 outbound contract', () => {
  it('sends byte-exact {event:"clear",streamSid}', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    sendClear(session);
    expect(socket.sent.length).toBe(1);
    expect(socket.sent[0]).toBe('{"event":"clear","streamSid":"MZ1"}');
  });

  it('no-ops without throwing when readyState !== OPEN', () => {
    for (const rs of [CONNECTING, CLOSING, CLOSED]) {
      const socket = fakeSocket({ readyState: rs });
      const session = makeSession(socket);
      expect(() => sendClear(session)).not.toThrow();
      expect(socket.sent.length).toBe(0);
    }
  });
});

describe('hangup — R7 clean-hangup mechanism', () => {
  it('closes with the default code/reason (1000, "bye")', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    hangup(session);
    expect(socket.closeCalls.length).toBe(1);
    expect(socket.closeCalls[0]?.code).toBe(1000);
    expect(socket.closeCalls[0]?.reason).toBe('bye');
  });

  it('closes with a caller-supplied code/reason', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    hangup(session, 1011, 'internal fault');
    expect(socket.closeCalls[0]?.code).toBe(1011);
    expect(socket.closeCalls[0]?.reason).toBe('internal fault');
  });

  it('no-ops without throwing when readyState !== OPEN', () => {
    for (const rs of [CONNECTING, CLOSING, CLOSED]) {
      const socket = fakeSocket({ readyState: rs });
      const session = makeSession(socket);
      expect(() => hangup(session)).not.toThrow();
      expect(socket.closeCalls.length).toBe(0);
    }
  });
});

describe('nextMarkName — mark-naming rule (findings/10 T3)', () => {
  it('mints r<responseId>:<seq> with a per-session monotonic markSeq (not per-response)', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    expect(nextMarkName(session, 'A')).toBe('rA:1');
    expect(nextMarkName(session, 'A')).toBe('rA:2');
    expect(nextMarkName(session, 'B')).toBe('rB:3');
  });

  it('two distinct sessions mint independent sequences (isolation)', () => {
    const sessionA = makeSession(fakeSocket(), 'MZ-a');
    const sessionB = makeSession(fakeSocket(), 'MZ-b');
    expect(nextMarkName(sessionA, 'X')).toBe('rX:1');
    expect(nextMarkName(sessionB, 'Y')).toBe('rY:1');
    expect(nextMarkName(sessionA, 'X')).toBe('rX:2');
    expect(nextMarkName(sessionB, 'Y')).toBe('rY:2');
  });
});

describe('isFirstMarkOfResponse — mark-naming rule (consumed by T03.4 mark-echo handler)', () => {
  it('flags only the first-minted name per responseId; later names for the same response are not first', () => {
    const socket = fakeSocket();
    const session = makeSession(socket);
    const rA1 = nextMarkName(session, 'A');
    const rA2 = nextMarkName(session, 'A');
    const rB1 = nextMarkName(session, 'B');

    expect(isFirstMarkOfResponse(session, rA1)).toBe(true);
    expect(isFirstMarkOfResponse(session, rA2)).toBe(false);
    expect(isFirstMarkOfResponse(session, rB1)).toBe(true);
    expect(isFirstMarkOfResponse(session, 'unknown-name')).toBe(false);
  });
});

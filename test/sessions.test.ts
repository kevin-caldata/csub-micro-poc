import { describe, it, beforeEach, expect } from 'vitest';
import { sessions as stateSessions } from '../src/state.js';
import { sessions, createSession, teardownSession, type Session } from '../src/sessions.js';

/** Minimal fake WebSocket — only the surface teardownSession/createSession touch. */
function fakeSocket(readyState: number): {
  readyState: number;
  closeCalls: Array<{ code?: number; reason?: string }>;
  close: (code?: number, reason?: string) => void;
} {
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  return {
    readyState,
    closeCalls,
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason });
    },
  };
}

const OPEN = 1;
const CONNECTING = 0;
const CLOSING = 2;
const CLOSED = 3;

const noopLog: Session['log'] = () => {};

beforeEach(() => {
  sessions.clear();
});

describe('sessions.ts — registry identity, createSession, teardownSession (Spec 03 R7/R9)', () => {
  it('(1) sessions from ./sessions.js is reference-identical to sessions from ./state.js', () => {
    expect(sessions as unknown).toBe(stateSessions as unknown);
  });

  it('(2) createSession initializes every field per the Produces list', () => {
    const socket = fakeSocket(OPEN);
    const session = createSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      twilioWs: socket as any,
      streamSid: 'MZ123',
      callSid: 'CA123',
      log: noopLog,
    });

    expect(session.streamSid).toBe('MZ123');
    expect(session.callSid).toBe('CA123');
    expect(session.twilioWs).toBe(socket);
    expect(session.log).toBe(noopLog);
    expect(session.latestMediaTimestamp).toBe(0);
    expect(session.markQueue).toEqual([]);
    expect(session.markSeq).toBe(0);
    expect(session.tornDown).toBe(false);
    expect(session.responseStartTimestamp).toBe(null);
    expect(session.currentResponseId).toBe(null);
    expect(session.lastAssistantItemId).toBe(null);
    expect(session.responseActive).toBe(false);
    expect(session.pendingToolCalls instanceof Map).toBeTruthy();
    expect(session.pendingToolCalls.size).toBe(0);
    expect(session.timestamps).toEqual({});
    expect(typeof session.teardown).toBe('function');

    // createSession does NOT insert into the registry (route's `start` handler does that).
    expect(sessions.size).toBe(0);
  });

  it('(3) teardownSession called twice runs side effects once', () => {
    const socket = fakeSocket(OPEN);
    const session = createSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      twilioWs: socket as any,
      streamSid: 'MZ-dup',
      callSid: 'CA-dup',
      log: noopLog,
    });
    sessions.set(session.streamSid, session);

    let onTeardownCalls = 0;
    session.onTeardown = () => {
      onTeardownCalls++;
    };

    teardownSession(session, 'first');
    teardownSession(session, 'second');

    expect(onTeardownCalls).toBe(1);
    expect(session.tornDown).toBe(true);
    expect(sessions.has('MZ-dup')).toBe(false);
    expect(socket.closeCalls.length).toBe(1);
  });

  it('(4) teardown clears a set startTimer (asserted via a clearTimeout spy)', () => {
    const socket = fakeSocket(OPEN);
    const session = createSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      twilioWs: socket as any,
      streamSid: 'MZ-timer',
      callSid: 'CA-timer',
      log: noopLog,
    });
    sessions.set(session.streamSid, session);

    const handle = setTimeout(() => {}, 5000);
    session.startTimer = handle;

    const originalClearTimeout = global.clearTimeout;
    const clearedWith: unknown[] = [];
    global.clearTimeout = ((h: unknown) => {
      clearedWith.push(h);
      return originalClearTimeout(h as Parameters<typeof originalClearTimeout>[0]);
    }) as typeof global.clearTimeout;
    try {
      teardownSession(session, 'no start');
    } finally {
      global.clearTimeout = originalClearTimeout;
    }

    expect(clearedWith).toEqual([handle]);
  });

  it('(5) teardown closes an OPEN fake socket with default code 1000; session.teardown(...) closes with 1001', () => {
    const socket1 = fakeSocket(OPEN);
    const session1 = createSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      twilioWs: socket1 as any,
      streamSid: 'MZ-close1',
      callSid: 'CA-close1',
      log: noopLog,
    });
    sessions.set(session1.streamSid, session1);
    teardownSession(session1, 'bye');
    expect(socket1.closeCalls.length).toBe(1);
    expect(socket1.closeCalls[0]?.code).toBe(1000);
    expect(socket1.closeCalls[0]?.reason).toBe('bye');

    const socket2 = fakeSocket(OPEN);
    const session2 = createSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      twilioWs: socket2 as any,
      streamSid: 'MZ-close2',
      callSid: 'CA-close2',
      log: noopLog,
    });
    sessions.set(session2.streamSid, session2);
    session2.teardown('server shutdown');
    expect(socket2.closeCalls.length).toBe(1);
    expect(socket2.closeCalls[0]?.code).toBe(1001);
    expect(socket2.closeCalls[0]?.reason).toBe('server shutdown');
  });

  it('does not close a socket that is already CLOSING or CLOSED', () => {
    for (const rs of [CLOSING, CLOSED]) {
      const socket = fakeSocket(rs);
      const session = createSession({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        twilioWs: socket as any,
        streamSid: `MZ-rs-${rs}`,
        callSid: `CA-rs-${rs}`,
        log: noopLog,
      });
      sessions.set(session.streamSid, session);
      teardownSession(session, 'bye');
      expect(socket.closeCalls.length).toBe(0);
    }
  });

  it('closes a CONNECTING socket too', () => {
    const socket = fakeSocket(CONNECTING);
    const session = createSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      twilioWs: socket as any,
      streamSid: 'MZ-connecting',
      callSid: 'CA-connecting',
      log: noopLog,
    });
    sessions.set(session.streamSid, session);
    teardownSession(session, 'bye');
    expect(socket.closeCalls.length).toBe(1);
  });

  it('(6) an onTeardown that throws still results in sessions.delete having run', () => {
    const socket = fakeSocket(OPEN);
    const session = createSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      twilioWs: socket as any,
      streamSid: 'MZ-throw',
      callSid: 'CA-throw',
      log: noopLog,
    });
    sessions.set(session.streamSid, session);
    session.onTeardown = () => {
      throw new Error('boom');
    };

    expect(() => teardownSession(session, 'bye')).not.toThrow();
    expect(sessions.has('MZ-throw')).toBe(false);
    expect(session.tornDown).toBe(true);
    expect(socket.closeCalls.length).toBe(1);
  });

  it('(7) globalThis.window === undefined (G6 env-guard)', () => {
    expect((globalThis as { window?: unknown }).window).toBe(undefined);
  });
});

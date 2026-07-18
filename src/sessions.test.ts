import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sessions as stateSessions } from './state.js';
import { sessions, createSession, teardownSession, type Session } from './sessions.js';

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
    assert.equal(sessions as unknown, stateSessions as unknown);
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

    assert.equal(session.streamSid, 'MZ123');
    assert.equal(session.callSid, 'CA123');
    assert.equal(session.twilioWs, socket);
    assert.equal(session.log, noopLog);
    assert.equal(session.latestMediaTimestamp, 0);
    assert.deepEqual(session.markQueue, []);
    assert.equal(session.markSeq, 0);
    assert.equal(session.tornDown, false);
    assert.equal(session.responseStartTimestamp, null);
    assert.equal(session.currentResponseId, null);
    assert.equal(session.lastAssistantItemId, null);
    assert.equal(session.responseActive, false);
    assert.ok(session.pendingToolCalls instanceof Map);
    assert.equal(session.pendingToolCalls.size, 0);
    assert.deepEqual(session.timestamps, {});
    assert.equal(typeof session.teardown, 'function');

    // createSession does NOT insert into the registry (route's `start` handler does that).
    assert.equal(sessions.size, 0);
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

    assert.equal(onTeardownCalls, 1);
    assert.equal(session.tornDown, true);
    assert.equal(sessions.has('MZ-dup'), false);
    assert.equal(socket.closeCalls.length, 1);
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

    assert.deepEqual(clearedWith, [handle]);
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
    assert.equal(socket1.closeCalls.length, 1);
    assert.equal(socket1.closeCalls[0]?.code, 1000);
    assert.equal(socket1.closeCalls[0]?.reason, 'bye');

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
    assert.equal(socket2.closeCalls.length, 1);
    assert.equal(socket2.closeCalls[0]?.code, 1001);
    assert.equal(socket2.closeCalls[0]?.reason, 'server shutdown');
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
      assert.equal(socket.closeCalls.length, 0);
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
    assert.equal(socket.closeCalls.length, 1);
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

    assert.doesNotThrow(() => teardownSession(session, 'bye'));
    assert.equal(sessions.has('MZ-throw'), false);
    assert.equal(session.tornDown, true);
    assert.equal(socket.closeCalls.length, 1);
  });

  it('(7) globalThis.window === undefined (G6 env-guard)', () => {
    assert.equal((globalThis as { window?: unknown }).window, undefined);
  });
});

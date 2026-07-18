// T09.3 — playFallbackAndClose (Spec 09 R6.4-R6.7, A4 repo-side half).
//
// Pure-logic tests over a fake Twilio socket (same fakeSocket/makeSession pattern as
// twilio-media.outbound.test.ts) — no fastify.injectWS needed here, so the REPO TEST RULE's
// "one injectWS-backed test per file" cap doesn't apply; this file is plain node:test logic.
// The real sendMedia/sendMark/sendClear from src/twilio-media.ts are used (not re-implemented)
// so frame shapes stay byte-exact with Spec 03 R5.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { playFallbackAndCloseWith } from './fallback.js';
import { createSession, type Session } from './sessions.js';

const OPEN = 1;
const CONNECTING = 0;
const CLOSED = 3;

const TINY_CLIP_B64 = 'aGVsbG8='; // 'hello' — small stand-in clip payload for these tests

interface FakeSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  send: (data: string) => void;
  closeCalls: number[];
  close: (code?: number, reason?: string) => void;
}

/** Minimal fake WebSocket — mirrors twilio-media.outbound.test.ts's fakeSocket. */
function fakeSocket(overrides: { readyState?: number; throwOnMedia?: boolean } = {}): FakeSocket {
  const sent: string[] = [];
  const closeCalls: number[] = [];
  return {
    readyState: overrides.readyState ?? OPEN,
    bufferedAmount: 0,
    sent,
    send(data: string) {
      if (overrides.throwOnMedia && (JSON.parse(data) as { event: string }).event === 'media') {
        throw new Error('send failed');
      }
      sent.push(data);
    },
    closeCalls,
    close() {
      closeCalls.push(closeCalls.length + 1);
    },
  };
}

interface LoggedLine {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

function makeSession(
  socket: FakeSocket,
  opts: { streamSid?: string; markQueue?: string[] } = {},
): { session: Session; logs: LoggedLine[] } {
  const logs: LoggedLine[] = [];
  const log: Session['log'] = (level, message, fields = {}) => {
    logs.push({ level, message, fields });
  };
  const session = createSession({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    twilioWs: socket as any,
    streamSid: opts.streamSid ?? 'MZtest',
    callSid: 'CAtest',
    log,
  });
  if (opts.markQueue) session.markQueue.push(...opts.markQueue);
  return { session, logs };
}

/** Events (in wire order) of the JSON frames sent on the fake socket. */
function eventsOf(socket: FakeSocket): string[] {
  return socket.sent.map((s) => (JSON.parse(s) as { event: string }).event);
}

describe('playFallbackAndCloseWith — Spec 09 R6.4-R6.7', () => {
  it('(R6.4-1) streamSid unset: no frames sent; close() called because the socket is OPEN; resolves without throwing', async () => {
    const socket = fakeSocket({ readyState: OPEN });
    const { session } = makeSession(socket, { streamSid: '' });
    await assert.doesNotReject(() =>
      playFallbackAndCloseWith(session, { clipB64: TINY_CLIP_B64, timeoutMs: 100, pollMs: 10 }),
    );
    assert.deepEqual(eventsOf(socket), []);
    assert.equal(socket.closeCalls.length, 1);
  });

  it('(R6.4-1) readyState !== OPEN: no frames sent; close() NOT called; resolves without throwing', async () => {
    for (const rs of [CONNECTING, CLOSED]) {
      const socket = fakeSocket({ readyState: rs });
      const { session } = makeSession(socket);
      await assert.doesNotReject(() =>
        playFallbackAndCloseWith(session, { clipB64: TINY_CLIP_B64, timeoutMs: 100, pollMs: 10 }),
      );
      assert.deepEqual(eventsOf(socket), []);
      assert.equal(socket.closeCalls.length, 0);
    }
  });

  it('(R6.4-2..6, R6.7) happy path: clear→media→mark in order, payload matches clip, mark name is fallback-apology, resolves on echo, closes after, logs fallback-played with reason', async () => {
    const socket = fakeSocket({ readyState: OPEN });
    const { session, logs } = makeSession(socket, { markQueue: ['stale-mark'] });

    // Simulate the Twilio mark echo after ~2 polls (pollMs=10 → ~20ms).
    setTimeout(() => {
      const i = session.markQueue.indexOf('fallback-apology');
      if (i !== -1) session.markQueue.splice(i, 1);
    }, 20);

    await playFallbackAndCloseWith(session, {
      clipB64: TINY_CLIP_B64,
      timeoutMs: 200,
      pollMs: 10,
      reason: 'gateway-error',
    });

    assert.deepEqual(eventsOf(socket), ['clear', 'media', 'mark']);
    const mediaFrame = JSON.parse(socket.sent[1] ?? '') as { media: { payload: string } };
    assert.equal(mediaFrame.media.payload, TINY_CLIP_B64);
    const markFrame = JSON.parse(socket.sent[2] ?? '') as { mark: { name: string } };
    assert.equal(markFrame.mark.name, 'fallback-apology');

    // close() must be called, and only after the wait resolved (trivially true given the
    // synchronous await-then-close structure, but assert the call happened at all).
    assert.equal(socket.closeCalls.length, 1);

    const played = logs.filter((l) => l.fields.event === 'fallback-played');
    assert.equal(played.length, 1);
    assert.equal(played[0]?.fields.reason, 'gateway-error');
    assert.equal(played[0]?.fields.echoed, true);
  });

  it('(R6.7) no clear frame when markQueue is empty at entry', async () => {
    const socket = fakeSocket({ readyState: OPEN });
    const { session } = makeSession(socket, { markQueue: [] });

    setTimeout(() => {
      const i = session.markQueue.indexOf('fallback-apology');
      if (i !== -1) session.markQueue.splice(i, 1);
    }, 20);

    await playFallbackAndCloseWith(session, { clipB64: TINY_CLIP_B64, timeoutMs: 200, pollMs: 10 });

    assert.deepEqual(eventsOf(socket), ['media', 'mark']);
  });

  it('(R6.4-4) echo never arrives: resolves after ~timeoutMs and still closes (no dead air, no hang)', async () => {
    const socket = fakeSocket({ readyState: OPEN });
    const { session, logs } = makeSession(socket);

    const startedAt = Date.now();
    await playFallbackAndCloseWith(session, { clipB64: TINY_CLIP_B64, timeoutMs: 100, pollMs: 10 });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed >= 90, `expected to wait close to the 100ms timeout, waited ${elapsed}ms`);
    assert.equal(socket.closeCalls.length, 1);
    const played = logs.filter((l) => l.fields.event === 'fallback-played');
    assert.equal(played.length, 1);
    assert.equal(played[0]?.fields.echoed, false);
  });

  it('(robustness) a throwing send on the media frame still reaches close() and resolves without throwing', async () => {
    const socket = fakeSocket({ readyState: OPEN, throwOnMedia: true });
    const { session, logs } = makeSession(socket);

    await assert.doesNotReject(() =>
      playFallbackAndCloseWith(session, { clipB64: TINY_CLIP_B64, timeoutMs: 100, pollMs: 10 }),
    );

    assert.equal(socket.closeCalls.length, 1);
    // A logged line must still exist (either the error path, the final fallback-played line, or
    // both) — the helper must never crash teardown even when a send throws mid-sequence.
    assert.ok(logs.length >= 1);
  });
});

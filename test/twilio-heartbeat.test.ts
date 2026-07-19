// findings/18 addendum (claims 21-23) — Twilio-leg WS ping/pong heartbeat unit tests.
//
// Pure-logic module test (no fastify.injectWS anywhere in this file — exempt from the repo's
// "one injectWS-backed test per file" rule, same as sessions.test.ts/teardown.test.ts):
// `startTwilioHeartbeat` is a standalone function of `(session, pingSeconds)`, so it is exercised
// directly against a hand-rolled EventEmitter-based fake socket + `vi.useFakeTimers()`, without
// going through the real route at all. The route-level wiring (heartbeat starts on session start,
// clears on socket close) is covered separately in twilio-media.test.ts with real timers, mirroring
// gateway.leg.test.ts's own A12 keepalive-ping pattern.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSession, type Session } from '../src/sessions.js';
import { startTwilioHeartbeat } from '../src/twilio-media.js';

const OPEN = 1;

/** Minimal fake WebSocket — only the surface startTwilioHeartbeat touches (readyState, ping, pong events). */
class FakeSocket extends EventEmitter {
  readyState = OPEN;
  pingCalls: string[] = [];
  ping(data?: Buffer | string): void {
    this.pingCalls.push(data === undefined ? '' : data.toString());
  }
}

type LogLine = { level: string; message: string; fields?: Record<string, unknown> };

function makeSession(): { session: Session; socket: FakeSocket; logs: LogLine[] } {
  const socket = new FakeSocket();
  const logs: LogLine[] = [];
  const session = createSession({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    twilioWs: socket as any,
    streamSid: 'MZ-hb',
    callSid: 'CA-hb',
    log: (level, message, fields) => {
      logs.push({ level, message, fields });
    },
  });
  return { session, socket, logs };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startTwilioHeartbeat — enabled (pingSeconds > 0)', () => {
  it('sends one ping per interval and clears the timer on stop() (no pings after stop)', () => {
    const { session, socket } = makeSession();
    const hb = startTwilioHeartbeat(session, 5);

    vi.advanceTimersByTime(5000);
    expect(socket.pingCalls.length).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(socket.pingCalls.length).toBe(2);

    hb.stop();
    vi.advanceTimersByTime(30000);
    expect(socket.pingCalls.length, 'timer must be cleared on stop() — no pings after').toBe(2);
  });

  it('computes RTT from the ping payload on pong and tracks maxRttMs; warns twilio-pong-slow only when RTT > 1000ms', () => {
    const { session, socket, logs } = makeSession();
    const hb = startTwilioHeartbeat(session, 5);

    vi.advanceTimersByTime(5000); // ping #1
    expect(socket.pingCalls.length).toBe(1);
    const fastSentAt = Date.now() - 200; // fabricate a 200ms-old send timestamp -> RTT ~200ms
    socket.emit('pong', Buffer.from(String(fastSentAt)));
    expect(logs.some((l) => l.message === 'twilio-pong-slow')).toBe(false);

    vi.advanceTimersByTime(5000); // ping #2
    const slowSentAt = Date.now() - 1500; // fabricate a 1500ms-old send timestamp -> RTT ~1500ms
    socket.emit('pong', Buffer.from(String(slowSentAt)));
    const slow = logs.find((l) => l.message === 'twilio-pong-slow');
    expect(slow, 'expected a twilio-pong-slow warn when RTT > 1000ms').toBeTruthy();
    expect(slow?.level).toBe('warn');
    expect(slow?.fields?.rttMs).toBe(1500);
    expect(slow?.fields?.callSid).toBe('CA-hb');
    expect(slow?.fields?.streamSid).toBe('MZ-hb');

    hb.stop();
    const summary = logs.find((l) => l.message === 'twilio-heartbeat');
    expect(summary?.fields?.maxRttMs).toBe(1500);
    expect(summary?.fields?.pingsSent).toBe(2);
    expect(summary?.fields?.pongsReceived).toBe(2);
  });

  it('warns twilio-pong-missed once a ping goes unanswered past 2 silent intervals, and the latch resets on the next pong', () => {
    const { session, logs } = makeSession();
    const hb = startTwilioHeartbeat(session, 5);

    vi.advanceTimersByTime(5000); // tick 1 — silent, sinceLastPongMs=5000 (not > 10000)
    expect(logs.some((l) => l.message === 'twilio-pong-missed')).toBe(false);
    vi.advanceTimersByTime(5000); // tick 2 — silent, sinceLastPongMs=10000 (not > 10000, strict)
    expect(logs.some((l) => l.message === 'twilio-pong-missed')).toBe(false);
    vi.advanceTimersByTime(5000); // tick 3 — silent, sinceLastPongMs=15000 > 10000 -> warns
    const missed = logs.find((l) => l.message === 'twilio-pong-missed');
    expect(missed, 'expected a twilio-pong-missed warn after 2 full silent intervals').toBeTruthy();
    expect(missed?.level).toBe('warn');
    expect(missed?.fields?.sinceLastPongMs).toBe(15000);
    expect(missed?.fields?.callSid).toBe('CA-hb');
    expect(missed?.fields?.streamSid).toBe('MZ-hb');

    // Still silent — the latch must not re-fire every subsequent tick.
    vi.advanceTimersByTime(5000);
    expect(logs.filter((l) => l.message === 'twilio-pong-missed').length).toBe(1);

    hb.stop();
  });

  it('a pong arriving after a missed-pong warn resets the latch so a later silent stretch warns again', () => {
    const { session, socket, logs } = makeSession();
    const hb = startTwilioHeartbeat(session, 5);

    vi.advanceTimersByTime(15000); // ticks 1-3 -> first missed-pong warn fires on tick 3
    expect(logs.filter((l) => l.message === 'twilio-pong-missed').length).toBe(1);

    socket.emit('pong', Buffer.from(String(Date.now()))); // resets lastPongAt + the latch

    vi.advanceTimersByTime(15000); // three more ticks with no further pong -> warns again
    expect(logs.filter((l) => l.message === 'twilio-pong-missed').length).toBe(2);

    hb.stop();
  });

  it('emits exactly ONE twilio-heartbeat info summary line at stop() (idempotent), never a per-pong info log', () => {
    const { session, socket, logs } = makeSession();
    const hb = startTwilioHeartbeat(session, 5);

    vi.advanceTimersByTime(5000);
    socket.emit('pong', Buffer.from(String(Date.now() - 50)));
    vi.advanceTimersByTime(5000);
    socket.emit('pong', Buffer.from(String(Date.now() - 50)));

    // No per-pong info log before stop() — the log budget is anomalies-only + one summary.
    expect(logs.filter((l) => l.level === 'info').length).toBe(0);

    hb.stop();
    const infoLines = logs.filter((l) => l.level === 'info' && l.message === 'twilio-heartbeat');
    expect(infoLines.length).toBe(1);
    expect(infoLines[0]?.fields?.pingsSent).toBe(2);
    expect(infoLines[0]?.fields?.pongsReceived).toBe(2);
    expect(infoLines[0]?.fields?.callSid).toBe('CA-hb');
    expect(infoLines[0]?.fields?.streamSid).toBe('MZ-hb');
    expect(typeof infoLines[0]?.fields?.maxRttMs).toBe('number');
    expect(typeof infoLines[0]?.fields?.lastPongAgoMs).toBe('number');

    hb.stop(); // idempotent — must not emit a second summary
    expect(logs.filter((l) => l.message === 'twilio-heartbeat').length).toBe(1);
  });

  it('stop() before any pong ever arrives still emits exactly one summary with pongsReceived:0', () => {
    const { session, logs } = makeSession();
    const hb = startTwilioHeartbeat(session, 5);
    vi.advanceTimersByTime(5000);
    hb.stop();
    const summary = logs.find((l) => l.message === 'twilio-heartbeat');
    expect(summary?.fields?.pingsSent).toBe(1);
    expect(summary?.fields?.pongsReceived).toBe(0);
    expect(summary?.fields?.maxRttMs).toBe(0);
  });

  it('never pings a socket that is not OPEN (guarded, same convention as sendMedia)', () => {
    const { session, socket } = makeSession();
    socket.readyState = 3; // CLOSED
    const hb = startTwilioHeartbeat(session, 5);
    vi.advanceTimersByTime(20000);
    expect(socket.pingCalls.length).toBe(0);
    hb.stop();
  });
});

describe('startTwilioHeartbeat — TWILIO_PING_SECONDS=0 disables everything', () => {
  it('never starts a timer, never listens for pong, and stop() is a fully silent no-op', () => {
    const { session, socket, logs } = makeSession();
    const hb = startTwilioHeartbeat(session, 0);

    vi.advanceTimersByTime(60000);
    expect(socket.pingCalls.length).toBe(0);
    expect(socket.listenerCount('pong')).toBe(0);

    hb.stop();
    expect(logs.length, 'fully disabled means no twilio-heartbeat summary either').toBe(0);
  });
});

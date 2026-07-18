import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';
import {
  openGatewayLeg,
  isBenignGatewayError,
  BENIGN_ERROR_CODES,
  type MintResult,
  type GatewayLegCallbacks,
} from './gateway.js';
import { startMockGateway } from './gateway.mock.test.js';

const BASE = {
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
};

const FORMATS = {
  inputAudioFormat: { type: 'audio/pcmu' },
  outputAudioFormat: { type: 'audio/pcmu' },
};

/** Captures every line written via logEvent/log (Spec 01 R12 -> process.stdout.write). */
function spyOnLog() {
  const writeMock = mock.method(process.stdout, 'write', () => true);
  return {
    lines: () =>
      writeMock.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c.arguments[0]));
          } catch {
            return undefined;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== undefined),
    restore: () => writeMock.mock.restore(),
  };
}

/** Polls `pred` until true or `timeoutMs` elapses; throws on timeout (avoids fixed sleeps). */
async function waitUntil(pred: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function noopCallbacks(overrides: Partial<GatewayLegCallbacks> = {}): GatewayLegCallbacks {
  return {
    onOpen: () => {},
    onOpenFailed: () => {},
    onEvent: () => {},
    onClose: () => {},
    ...overrides,
  };
}

/** Opens a leg against a fresh mock gateway and waits for the first-frames handshake to settle
 *  (session-update + greeting response-create, T04.4) so tests can start from a clean frame
 *  count when asserting on subsequently-sent server events. */
async function openLeg(
  callSid: string,
  overrides: Partial<GatewayLegCallbacks> = {},
): Promise<{ mock1: Awaited<ReturnType<typeof startMockGateway>>; leg: ReturnType<typeof openGatewayLeg>; closed: () => boolean }> {
  const mock1 = await startMockGateway();
  const cfg = loadConfig({ ...BASE });
  const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
  let opened = false;
  let closedFlag = false;
  const leg = openGatewayLeg({
    mint,
    callSid,
    tools: [],
    formats: FORMATS,
    config: cfg,
    callbacks: noopCallbacks({
      onOpen: () => {
        opened = true;
      },
      onClose: () => {
        closedFlag = true;
      },
      ...overrides,
    }),
  });
  await waitUntil(() => opened);
  await waitUntil(() => mock1.frames.length >= 2); // session-update + greeting settled
  return { mock1, leg, closed: () => closedFlag };
}

describe('isBenignGatewayError (A9, R10 heuristic)', () => {
  it('matches all four documented-benign substring classes', () => {
    assert.equal(
      isBenignGatewayError({ type: 'error', message: 'No active response to cancel', raw: {} }),
      true,
    );
    assert.equal(
      isBenignGatewayError({ type: 'error', message: 'Cannot cancel response: nothing in flight', raw: {} }),
      true,
    );
    assert.equal(
      isBenignGatewayError({ type: 'error', message: 'audio_end_ms is out of range for item', raw: {} }),
      true,
    );
    assert.equal(
      isBenignGatewayError({ type: 'error', message: 'failed to truncate conversation item', raw: {} }),
      true,
    );
  });

  it('does not match an arbitrary unrecognized message', () => {
    assert.equal(isBenignGatewayError({ type: 'error', message: 'boom-unknown', code: 'weird_code', raw: {} }), false);
  });

  it('matches when ev.code is a member of BENIGN_ERROR_CODES', () => {
    assert.equal(BENIGN_ERROR_CODES.has('test_only_code'), false); // starts empty (S11) — sanity check
    BENIGN_ERROR_CODES.add('test_only_code');
    try {
      assert.equal(
        isBenignGatewayError({ type: 'error', message: 'anything at all', code: 'test_only_code', raw: {} }),
        true,
      );
    } finally {
      BENIGN_ERROR_CODES.delete('test_only_code');
    }
  });
});

describe('dispatch — A7 silent set (8 members: zero warn/error log lines, still forwarded)', () => {
  it('forwards all 8 in order and produces zero warn/error-level log lines', async () => {
    const log = spyOnLog();
    const received: string[] = [];
    const { mock1, leg, closed } = await openLeg('CA-silent', {
      onEvent: (ev) => {
        received.push(ev.type);
      },
    });
    try {
      const silentEvents = [
        { type: 'conversation-item-added', itemId: 'i1', item: {}, raw: {} },
        { type: 'output-item-done', responseId: 'r1', itemId: 'i1', raw: {} },
        { type: 'content-part-added', responseId: 'r1', itemId: 'i1', raw: {} },
        { type: 'content-part-done', responseId: 'r1', itemId: 'i1', raw: {} },
        { type: 'audio-done', responseId: 'r1', itemId: 'i1', raw: {} },
        { type: 'text-delta', responseId: 'r1', itemId: 'i1', delta: 'hi', raw: {} },
        { type: 'text-done', responseId: 'r1', itemId: 'i1', text: 'hi', raw: {} },
        { type: 'function-call-arguments-delta', responseId: 'r1', itemId: 'i1', callId: 'c1', delta: '{', raw: {} },
      ];
      for (const ev of silentEvents) mock1.send(ev);
      await waitUntil(() => received.length >= 8);
      assert.deepEqual(received, silentEvents.map((e) => e.type));
      const badLines = log.lines().filter((l) => l.level === 'warn' || l.level === 'error');
      assert.deepEqual(badLines, []);
    } finally {
      leg.close();
      await waitUntil(closed, 1000).catch(() => {});
      log.restore();
      await mock1.stop();
    }
  });
});

describe('dispatch — A7 act/log set (session-created + 12 forwarded-unchanged members)', () => {
  it('session-created logs gateway-session-created with .raw content verbatim, and reaches onEvent', async () => {
    const log = spyOnLog();
    const received: unknown[] = [];
    const { mock1, leg, closed } = await openLeg('CA-actlog', {
      onEvent: (ev) => {
        received.push(ev);
      },
    });
    try {
      const raw = { session: { id: 'sess_1' } };
      mock1.send({ type: 'session-created', sessionId: 'sess_1', raw });
      await waitUntil(() => received.length >= 1);
      assert.deepEqual(received[0], { type: 'session-created', sessionId: 'sess_1', raw });

      const line = log.lines().find((l) => l.event === 'gateway-session-created');
      assert.ok(line, 'expected a gateway-session-created log line');
      assert.equal(line!.callSid, 'CA-actlog');
      assert.equal(line!.sessionId, 'sess_1');
      // .raw is passed through safeRaw() (explicit-call convention, per T08.1 ledger note) —
      // assert content-equivalence via JSON round-trip rather than object identity.
      assert.deepEqual(JSON.parse(line!.raw as string), raw);
    } finally {
      leg.close();
      await waitUntil(closed, 1000).catch(() => {});
      log.restore();
      await mock1.stop();
    }
  });

  it('forwards the remaining 12 act-set members unchanged, in order', async () => {
    const received: unknown[] = [];
    const { mock1, leg, closed } = await openLeg('CA-act12', {
      onEvent: (ev) => {
        received.push(ev);
      },
    });
    try {
      const events = [
        { type: 'speech-started', raw: {} },
        { type: 'speech-stopped', raw: {} },
        { type: 'response-created', responseId: 'r1', raw: {} },
        { type: 'response-done', responseId: 'r1', status: 'completed', raw: {} },
        { type: 'output-item-added', responseId: 'r1', itemId: 'i1', raw: {} },
        { type: 'audio-delta', responseId: 'r1', itemId: 'i1', delta: 'AA==', raw: {} },
        { type: 'input-transcription-completed', itemId: 'i1', transcript: 'hello', raw: {} },
        { type: 'audio-transcript-delta', responseId: 'r1', itemId: 'i1', delta: 'he', raw: {} },
        { type: 'audio-transcript-done', responseId: 'r1', itemId: 'i1', transcript: 'hello', raw: {} },
        { type: 'function-call-arguments-done', responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'lookup', arguments: '{}', raw: {} },
        { type: 'audio-committed', itemId: 'i1', raw: {} },
      ];
      for (const ev of events) mock1.send(ev);
      await waitUntil(() => received.length >= events.length);
      assert.deepEqual(received, events);
    } finally {
      leg.close();
      await waitUntil(closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });
});

describe('dispatch — A9 error policy (never terminal; benign vs unknown levels)', () => {
  it('an unrecognized error does not close the socket or invoke onClose; the following audio-delta still arrives', async () => {
    const log = spyOnLog();
    const received: unknown[] = [];
    let closeFired = false;
    const { mock1, leg } = await openLeg('CA-err', {
      onEvent: (ev) => {
        received.push(ev);
      },
      onClose: () => {
        closeFired = true;
      },
    });
    try {
      mock1.send({ type: 'error', message: 'boom-unknown', code: 'weird_code', raw: {} });
      mock1.send({ type: 'audio-delta', responseId: 'r1', itemId: 'i1', delta: 'AA==', raw: {} });
      await waitUntil(() => received.length >= 2);
      assert.deepEqual(received[0], { type: 'error', message: 'boom-unknown', code: 'weird_code', raw: {} });
      assert.deepEqual(received[1], { type: 'audio-delta', responseId: 'r1', itemId: 'i1', delta: 'AA==', raw: {} });
      assert.equal(leg.isOpen, true);
      // give any (incorrect) close callback a moment to fire before asserting its absence
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(closeFired, false);

      const errLine = log.lines().find((l) => l.event === 'gateway-error-event');
      assert.ok(errLine, 'expected a gateway-error-event log line');
      assert.equal(errLine!.level, 'error');
      assert.equal(errLine!.code, 'weird_code');
      assert.deepEqual(JSON.parse(errLine!.raw as string), {});
    } finally {
      leg.close();
      log.restore();
      await mock1.stop();
    }
  });

  it('a benign-matching error (message contains "no active response") logs at info level', async () => {
    const log = spyOnLog();
    const { mock1, leg } = await openLeg('CA-err-benign');
    try {
      mock1.send({ type: 'error', message: 'no active response to cancel', raw: {} });
      await waitUntil(() => log.lines().some((l) => l.event === 'gateway-error-event'));
      const errLine = log.lines().find((l) => l.event === 'gateway-error-event');
      assert.ok(errLine);
      assert.equal(errLine!.level, 'info');
    } finally {
      leg.close();
      log.restore();
      await mock1.stop();
    }
  });
});

describe('dispatch — A8 custom-event policy (S4 fallback, rate limit, truncate ack)', () => {
  it('a custom speech_started rawType delivers a synthetic speech-started to onEvent identically to the normalized case', async () => {
    const log = spyOnLog();
    const received: unknown[] = [];
    const { mock1, leg } = await openLeg('CA-custom-speech', {
      onEvent: (ev) => {
        received.push(ev);
      },
    });
    try {
      const raw = { type: 'input_audio_buffer.speech_started', item_id: 'i1' };
      mock1.send({ type: 'custom', rawType: 'input_audio_buffer.speech_started', raw });
      await waitUntil(() => received.length >= 2);
      assert.deepEqual(received[0], { type: 'custom', rawType: 'input_audio_buffer.speech_started', raw });
      assert.deepEqual(received[1], { type: 'speech-started', raw });

      const line = log.lines().find((l) => l.event === 'gateway-custom');
      assert.ok(line, 'expected a rate-limited gateway-custom log line');
      assert.equal(line!.rawType, 'input_audio_buffer.speech_started');
    } finally {
      leg.close();
      log.restore();
      await mock1.stop();
    }
  });

  it('100 identical-rawType custom events within 1s produce <=2 gateway-custom log lines but all 100 reach onEvent', async () => {
    const log = spyOnLog();
    let eventCount = 0;
    const { mock1, leg } = await openLeg('CA-custom-flood', {
      onEvent: () => {
        eventCount++;
      },
    });
    try {
      for (let i = 0; i < 100; i++) {
        mock1.send({ type: 'custom', rawType: 'rate_limits.updated', raw: { n: i } });
      }
      await waitUntil(() => eventCount >= 100);
      const floodLines = log.lines().filter((l) => l.event === 'gateway-custom' && l.rawType === 'rate_limits.updated');
      assert.ok(floodLines.length <= 2, `expected <=2 gateway-custom lines, got ${floodLines.length}`);
    } finally {
      leg.close();
      log.restore();
      await mock1.stop();
    }
  });

  it('conversation.item.truncated rawType logs a gateway-custom line at info level (S9 truncate-ack evidence)', async () => {
    const log = spyOnLog();
    const { mock1, leg } = await openLeg('CA-truncate-ack');
    try {
      mock1.send({ type: 'custom', rawType: 'conversation.item.truncated', raw: { audio_end_ms: 1200 } });
      await waitUntil(() => log.lines().some((l) => l.event === 'gateway-custom' && l.rawType === 'conversation.item.truncated'));
      const line = log.lines().find((l) => l.event === 'gateway-custom' && l.rawType === 'conversation.item.truncated');
      assert.ok(line);
      assert.equal(line!.level, 'info');
    } finally {
      leg.close();
      log.restore();
      await mock1.stop();
    }
  });
});

describe('dispatch — unknown wire type (defensive default branch)', () => {
  it('logs one gateway-unknown-event line and does not crash', async () => {
    const log = spyOnLog();
    let eventCount = 0;
    const { mock1, leg } = await openLeg('CA-unknown', {
      onEvent: () => {
        eventCount++;
      },
    });
    try {
      mock1.send({ type: 'totally-new', raw: {} });
      await waitUntil(() => log.lines().some((l) => l.event === 'gateway-unknown-event'));
      const lines = log.lines().filter((l) => l.event === 'gateway-unknown-event');
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.type, 'totally-new');
      assert.equal(leg.isOpen, true);
    } finally {
      leg.close();
      log.restore();
      await mock1.stop();
    }
  });
});

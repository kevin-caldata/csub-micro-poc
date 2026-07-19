import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  openGatewayLeg,
  isBenignGatewayError,
  isCreateWhileActiveError,
  BENIGN_ERROR_CODES,
  type MintResult,
  type GatewayLegCallbacks,
} from '../src/gateway.js';
import { startMockGateway } from './gateway.mock.js';

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
  const writeMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return {
    lines: () =>
      writeMock.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0]));
          } catch {
            return undefined;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== undefined),
    restore: () => writeMock.mockRestore(),
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
    expect(isBenignGatewayError({ type: 'error', message: 'No active response to cancel', raw: {} })).toBe(true);
    expect(isBenignGatewayError({ type: 'error', message: 'Cannot cancel response: nothing in flight', raw: {} })).toBe(true);
    expect(isBenignGatewayError({ type: 'error', message: 'audio_end_ms is out of range for item', raw: {} })).toBe(true);
    expect(isBenignGatewayError({ type: 'error', message: 'failed to truncate conversation item', raw: {} })).toBe(true);
  });

  it('does not match an arbitrary unrecognized message', () => {
    expect(isBenignGatewayError({ type: 'error', message: 'boom-unknown', code: 'weird_code', raw: {} })).toBe(false);
  });

  it('matches when ev.code is a member of BENIGN_ERROR_CODES', () => {
    expect(BENIGN_ERROR_CODES.has('test_only_code')).toBe(false); // starts empty (S11) — sanity check
    BENIGN_ERROR_CODES.add('test_only_code');
    try {
      expect(isBenignGatewayError({ type: 'error', message: 'anything at all', code: 'test_only_code', raw: {} })).toBe(true);
    } finally {
      BENIGN_ERROR_CODES.delete('test_only_code');
    }
  });

  // Findings review (Important — R12 lost-race classification): the create-while-active shape
  // Spec 07 R12's deferred-retry ToolLoop gate is designed to survive previously matched NONE of
  // the four classes above, so a lost gate race classified as non-benign and session.ts tore the
  // call down mid-tool-answer instead of letting the retry engage.
  it('matches the create-while-active substring class ("already has an active response")', () => {
    expect(
      isBenignGatewayError({
        type: 'error',
        message: 'Conversation already has an active response',
        raw: {},
      }),
    ).toBe(true);
    // Case-insensitive, and the exact real-world phrasing this class targets.
    expect(
      isBenignGatewayError({
        type: 'error',
        message: 'conversation_already_has_active_response: this conversation ALREADY HAS AN ACTIVE RESPONSE',
        raw: {},
      }),
    ).toBe(true);
  });

  // S11 tuning (live-call evidence, call CAd9fff35837be498644789a9d485bf594): the truncate-
  // overshoot wording never contained 'truncat' or 'audio_end_ms', so it fell through every
  // pre-existing substring class and was misclassified non-benign, tearing the call down mid-
  // response for a functionally no-op complaint (the audio had already finished playing).
  it('matches the S11 truncate-overshoot shape: code invalid_value + "already shorter than"', () => {
    expect(
      isBenignGatewayError({
        type: 'error',
        code: 'invalid_value',
        message: 'Audio content of 10950ms is already shorter than 13160ms',
        raw: {},
      }),
    ).toBe(true);
    // Case-insensitive.
    expect(
      isBenignGatewayError({
        type: 'error',
        code: 'invalid_value',
        message: 'AUDIO CONTENT OF 1MS IS ALREADY SHORTER THAN 2MS',
        raw: {},
      }),
    ).toBe(true);
  });

  // The fix must be scoped to this exact message shape, never a blanket 'invalid_value' ->
  // benign — other invalid_value errors (e.g. a malformed tool argument) must stay fatal.
  it('does NOT match a different invalid_value error lacking the "already shorter than" phrasing', () => {
    expect(
      isBenignGatewayError({
        type: 'error',
        code: 'invalid_value',
        message: "Invalid value: 'bogus' is not a valid voice",
        raw: {},
      }),
    ).toBe(false);
  });
});

describe('isCreateWhileActiveError (Spec 07 R12 lost-race recovery narrow predicate)', () => {
  it('matches only the create-while-active shape, not the other benign classes', () => {
    expect(
      isCreateWhileActiveError({ type: 'error', message: 'Conversation already has an active response', raw: {} }),
    ).toBe(true);
    expect(isCreateWhileActiveError({ type: 'error', message: 'No active response to cancel', raw: {} })).toBe(false);
    expect(isCreateWhileActiveError({ type: 'error', message: 'audio_end_ms is out of range', raw: {} })).toBe(false);
    expect(isCreateWhileActiveError({ type: 'error', message: 'failed to truncate conversation item', raw: {} })).toBe(false);
    expect(isCreateWhileActiveError({ type: 'error', message: 'boom-unknown', raw: {} })).toBe(false);
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
      expect(received).toEqual(silentEvents.map((e) => e.type));
      const badLines = log.lines().filter((l) => l.level === 'warn' || l.level === 'error');
      expect(badLines).toEqual([]);
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
      expect(received[0]).toEqual({ type: 'session-created', sessionId: 'sess_1', raw });

      const line = log.lines().find((l) => l.event === 'gateway-session-created');
      expect(line, 'expected a gateway-session-created log line').toBeTruthy();
      expect(line!.callSid).toBe('CA-actlog');
      expect(line!.sessionId).toBe('sess_1');
      // .raw is passed through safeRaw() (explicit-call convention, per T08.1 ledger note) —
      // assert content-equivalence via JSON round-trip rather than object identity.
      expect(JSON.parse(line!.raw as string)).toEqual(raw);
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
      expect(received).toEqual(events);
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
      expect(received[0]).toEqual({ type: 'error', message: 'boom-unknown', code: 'weird_code', raw: {} });
      expect(received[1]).toEqual({ type: 'audio-delta', responseId: 'r1', itemId: 'i1', delta: 'AA==', raw: {} });
      expect(leg.isOpen).toBe(true);
      // give any (incorrect) close callback a moment to fire before asserting its absence
      await new Promise((r) => setTimeout(r, 150));
      expect(closeFired).toBe(false);

      const errLine = log.lines().find((l) => l.event === 'gateway-error-event');
      expect(errLine, 'expected a gateway-error-event log line').toBeTruthy();
      expect(errLine!.level).toBe('error');
      expect(errLine!.code).toBe('weird_code');
      expect(JSON.parse(errLine!.raw as string)).toEqual({});
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
      expect(errLine).toBeTruthy();
      expect(errLine!.level).toBe('info');
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
      expect(received[0]).toEqual({ type: 'custom', rawType: 'input_audio_buffer.speech_started', raw });
      expect(received[1]).toEqual({ type: 'speech-started', raw });

      const line = log.lines().find((l) => l.event === 'gateway-custom');
      expect(line, 'expected a rate-limited gateway-custom log line').toBeTruthy();
      expect(line!.rawType).toBe('input_audio_buffer.speech_started');
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
      expect(floodLines.length <= 2, `expected <=2 gateway-custom lines, got ${floodLines.length}`).toBeTruthy();
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
      expect(line).toBeTruthy();
      expect(line!.level).toBe('info');
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
      expect(lines.length).toBe(1);
      expect(lines[0]!.type).toBe('totally-new');
      expect(leg.isOpen).toBe(true);
    } finally {
      leg.close();
      log.restore();
      await mock1.stop();
    }
  });
});

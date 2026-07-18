import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openGatewayLeg, gatewayWsOptions, type MintResult, type GatewayLegCallbacks } from '../src/gateway.js';
import { startMockGateway, startPlainHttpServer } from './gateway.mock.js';

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
    // Tolerates any non-JSON write that lands on stdout while the spy is active (e.g. a stray
    // async log line from a socket event that resolves after `restore()` runs) by skipping it.
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

describe('gatewayWsOptions (A2)', () => {
  it('deep-equals the mandatory options object with default config', () => {
    const cfg = loadConfig({ ...BASE });
    expect(gatewayWsOptions(cfg)).toEqual({
      perMessageDeflate: false,
      handshakeTimeout: 5000,
      maxPayload: 16777216,
    });
  });
});

describe('openGatewayLeg — open path', () => {
  it('fires onOpen, sets isOpen, and logs gateway-open with a Δ-from-mint', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 3 };
    const log = spyOnLog();
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-open',
      tools: [],
      formats: FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      expect(leg.isOpen).toBe(true);
      const lines = log.lines();
      const openLine = lines.find((l) => l.event === 'gateway-open');
      expect(openLine, 'expected a gateway-open log line').toBeTruthy();
      expect(openLine.callSid).toBe('CA-open');
      expect(typeof openLine.sinceMintMs).toBe('number');
    } finally {
      leg.close();
      // Wait for the real (async) close to land while the spy is still active — otherwise its
      // gateway-close write leaks to real stdout after restore() (possibly into the NEXT test's spy).
      await waitUntil(() => closed, 1000).catch(() => {});
      log.restore();
      await mock1.stop();
    }
  });
});

describe('openGatewayLeg — send/appendAudio (never batch)', () => {
  it('appendAudio sends exactly one input-audio-append frame per call', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-append',
      tools: [],
      formats: FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      // T04.4 sends session-update + the greeting response-create automatically on 'open'
      // (Spec 04 R8) — wait for those two first frames before asserting on appendAudio's frame.
      await waitUntil(() => mock1.frames.length >= 2);
      const framesBefore = mock1.frames.length;
      await leg.appendAudio('AAAA');
      await waitUntil(() => mock1.frames.length >= framesBefore + 1);
      expect(mock1.frames.slice(framesBefore)).toEqual([{ type: 'input-audio-append', audio: 'AAAA' }]);
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });
});

describe('openGatewayLeg — receive path (A6 array frames, parse errors)', () => {
  it('handles an array frame: onEvent fires per element in order, plus a gateway-array-frame log line', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    const log = spyOnLog();
    let opened = false;
    let closed = false;
    const received: unknown[] = [];
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-array',
      tools: [],
      formats: FORMATS,
      config: cfg,
      callbacks: noopCallbacks({
        onOpen: () => { opened = true; },
        onEvent: (ev) => { received.push(ev); },
        onClose: () => { closed = true; },
      }),
    });
    try {
      await waitUntil(() => opened);
      mock1.send([
        { type: 'response-created', raw: {} },
        { type: 'audio-delta', raw: {}, responseId: 'r1', itemId: 'i1', delta: 'AA==' },
      ]);
      await waitUntil(() => received.length >= 2);
      expect(received).toEqual([
        { type: 'response-created', raw: {} },
        { type: 'audio-delta', raw: {}, responseId: 'r1', itemId: 'i1', delta: 'AA==' },
      ]);
      const lines = log.lines();
      const arrLine = lines.find((l) => l.event === 'gateway-array-frame');
      expect(arrLine, 'expected a gateway-array-frame log line').toBeTruthy();
      expect(arrLine.count).toBe(2);
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      log.restore();
      await mock1.stop();
    }
  });

  it('logs gateway-parse-error on invalid JSON, does not call onEvent, and keeps the socket open', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    const log = spyOnLog();
    let opened = false;
    let closed = false;
    let eventCount = 0;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-parse-error',
      tools: [],
      formats: FORMATS,
      config: cfg,
      callbacks: noopCallbacks({
        onOpen: () => { opened = true; },
        onEvent: () => { eventCount++; },
        onClose: () => { closed = true; },
      }),
    });
    try {
      await waitUntil(() => opened);
      mock1.sendRaw('not-json{{');
      // Give the message handler a beat to run, then assert nothing fired.
      await new Promise((r) => setTimeout(r, 200));
      expect(eventCount).toBe(0);
      expect(leg.isOpen).toBe(true);
      const lines = log.lines();
      const errLine = lines.find((l) => l.event === 'gateway-parse-error');
      expect(errLine, 'expected a gateway-parse-error log line').toBeTruthy();
      expect(typeof errLine.snippet === 'string' && errLine.snippet.length <= 200).toBeTruthy();
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      log.restore();
      await mock1.stop();
    }
  });
});

describe('openGatewayLeg — close handling (A10)', () => {
  it('onClose receives numeric code + string reason (Buffer decoded); gateway-close logs both verbatim; post-terminal sends are silent no-ops', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    const log = spyOnLog();
    let opened = false;
    let closeInfo: { code: number; reason: string } | undefined;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-close',
      tools: [],
      formats: FORMATS,
      config: cfg,
      callbacks: noopCallbacks({
        onOpen: () => { opened = true; },
        onClose: (info) => { closeInfo = info; },
      }),
    });
    try {
      await waitUntil(() => opened);
      mock1.close(4001, 'test-reason');
      await waitUntil(() => closeInfo !== undefined);
      expect(closeInfo?.code).toBe(4001);
      expect(closeInfo?.reason).toBe('test-reason');
      expect(typeof closeInfo?.reason).toBe('string');
      const lines = log.lines();
      const closeLine = lines.find((l) => l.event === 'gateway-close');
      expect(closeLine, 'expected a gateway-close log line').toBeTruthy();
      expect(closeLine.code).toBe(4001);
      expect(closeLine.reason).toBe('test-reason');

      // post-terminal guard (arbitrary no-payload ClientEvent — this asserts the generic
      // post-terminal send() no-op, not anything about a specific event type; `input-audio-
      // clear` stands in for whichever bare event happens to be handy — see Spec 05 A14's
      // source-grep acceptance criterion for why a certain other bare event never appears
      // literally in src/).
      expect(leg.isOpen).toBe(false);
      const framesBefore = mock1.frames.length;
      await leg.send({ type: 'input-audio-clear' });
      await leg.appendAudio('ZZZZ');
      expect(mock1.frames.length).toBe(framesBefore);
    } finally {
      log.restore();
      await mock1.stop();
    }
  });

  it('A10 non-101: onOpenFailed fires with statusCode, onClose does NOT fire, gateway-upgrade-refused is logged', async () => {
    const refused = await startPlainHttpServer(403);
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: refused.url, getTokenMs: 0 };
    const log = spyOnLog();
    let openFailedInfo: { statusCode?: number; message: string } | undefined;
    let closeFired = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-refused',
      tools: [],
      formats: FORMATS,
      config: cfg,
      callbacks: noopCallbacks({
        onOpenFailed: (info) => { openFailedInfo = info; },
        onClose: () => { closeFired = true; },
      }),
    });
    try {
      await waitUntil(() => openFailedInfo !== undefined);
      expect(openFailedInfo?.statusCode).toBe(403);
      // give any (incorrect) close callback a chance to fire before asserting its absence
      await new Promise((r) => setTimeout(r, 200));
      expect(closeFired).toBe(false);
      const lines = log.lines();
      const refusedLine = lines.find((l) => l.event === 'gateway-upgrade-refused');
      expect(refusedLine, 'expected a gateway-upgrade-refused log line').toBeTruthy();
      expect(refusedLine.statusCode).toBe(403);
    } finally {
      leg.close();
      log.restore();
      await refused.stop();
    }
  });
});

describe('openGatewayLeg — keepalive ping (A12)', () => {
  it('with GATEWAY_PING_SECONDS=1, the mock receives >=1 ping within ~1.5s and no more after close', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE, GATEWAY_PING_SECONDS: '1' });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-ping',
      tools: [],
      formats: FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.pingCount >= 1, 1500);
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      const afterClose = mock1.pingCount;
      await new Promise((r) => setTimeout(r, 1300));
      expect(mock1.pingCount, 'ping timer must be cleared on close').toBe(afterClose);
    } finally {
      await mock1.stop();
    }
  });

  it('with the default GATEWAY_PING_SECONDS=0, no ping arrives within ~1.5s', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-no-ping',
      tools: [],
      formats: FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await new Promise((r) => setTimeout(r, 1500));
      expect(mock1.pingCount).toBe(0);
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });
});

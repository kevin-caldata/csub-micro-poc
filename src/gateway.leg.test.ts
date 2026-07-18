import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';
import { openGatewayLeg, gatewayWsOptions, type MintResult, type GatewayLegCallbacks } from './gateway.js';
import { startMockGateway, startPlainHttpServer } from './gateway.mock.test.js';

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
    // Tolerates any non-JSON write that lands on stdout while the spy is active (e.g. a stray
    // async log line from a socket event that resolves after `restore()` runs) by skipping it.
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

describe('gatewayWsOptions (A2)', () => {
  it('deep-equals the mandatory options object with default config', () => {
    const cfg = loadConfig({ ...BASE });
    assert.deepEqual(gatewayWsOptions(cfg), {
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
      assert.equal(leg.isOpen, true);
      const lines = log.lines();
      const openLine = lines.find((l) => l.event === 'gateway-open');
      assert.ok(openLine, 'expected a gateway-open log line');
      assert.equal(openLine.callSid, 'CA-open');
      assert.equal(typeof openLine.sinceMintMs, 'number');
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
      await leg.appendAudio('AAAA');
      await waitUntil(() => mock1.frames.length >= 1);
      assert.deepEqual(mock1.frames, [{ type: 'input-audio-append', audio: 'AAAA' }]);
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
      assert.deepEqual(received, [
        { type: 'response-created', raw: {} },
        { type: 'audio-delta', raw: {}, responseId: 'r1', itemId: 'i1', delta: 'AA==' },
      ]);
      const lines = log.lines();
      const arrLine = lines.find((l) => l.event === 'gateway-array-frame');
      assert.ok(arrLine, 'expected a gateway-array-frame log line');
      assert.equal(arrLine.count, 2);
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
      assert.equal(eventCount, 0);
      assert.equal(leg.isOpen, true);
      const lines = log.lines();
      const errLine = lines.find((l) => l.event === 'gateway-parse-error');
      assert.ok(errLine, 'expected a gateway-parse-error log line');
      assert.ok(typeof errLine.snippet === 'string' && errLine.snippet.length <= 200);
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
      assert.equal(closeInfo?.code, 4001);
      assert.equal(closeInfo?.reason, 'test-reason');
      assert.equal(typeof closeInfo?.reason, 'string');
      const lines = log.lines();
      const closeLine = lines.find((l) => l.event === 'gateway-close');
      assert.ok(closeLine, 'expected a gateway-close log line');
      assert.equal(closeLine.code, 4001);
      assert.equal(closeLine.reason, 'test-reason');

      // post-terminal guard
      assert.equal(leg.isOpen, false);
      const framesBefore = mock1.frames.length;
      await leg.send({ type: 'response-cancel' });
      await leg.appendAudio('ZZZZ');
      assert.equal(mock1.frames.length, framesBefore);
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
      assert.equal(openFailedInfo?.statusCode, 403);
      // give any (incorrect) close callback a chance to fire before asserting its absence
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(closeFired, false);
      const lines = log.lines();
      const refusedLine = lines.find((l) => l.event === 'gateway-upgrade-refused');
      assert.ok(refusedLine, 'expected a gateway-upgrade-refused log line');
      assert.equal(refusedLine.statusCode, 403);
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
      assert.equal(mock1.pingCount, afterClose, 'ping timer must be cleared on close');
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
      assert.equal(mock1.pingCount, 0);
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });
});

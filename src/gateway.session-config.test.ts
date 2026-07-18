import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Experimental_RealtimeModelV4ToolDefinition as ToolDefinition } from '@ai-sdk/provider';
import { loadConfig } from './config.js';
import { openGatewayLeg, INSTRUCTIONS, type MintResult, type GatewayLegCallbacks } from './gateway.js';
import { startMockGateway } from './gateway.mock.test.js';

const BASE = {
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
};

const PCMU_FORMATS = {
  inputAudioFormat: { type: 'audio/pcmu' },
  outputAudioFormat: { type: 'audio/pcmu' },
};

const TRANSCODE_FORMATS = {
  inputAudioFormat: { type: 'audio/pcm', rate: 24000 },
  outputAudioFormat: { type: 'audio/pcm', rate: 24000 },
};

// Two-entry fixture matching Spec 07 R8's fetchToolDefs() output shape verbatim
// ({type:'function', name, description, parameters}) — injected untouched (R7 passthrough proof).
const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    name: 'lookup_order',
    description: 'Look up an order by its ID',
    parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  },
  {
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
];

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

describe('openGatewayLeg — session-update first frame + greeting (A3)', () => {
  it('frame #1 is session-update with full config, frame #2 is response-create with instructions', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-a3',
      tools: TOOLS,
      formats: PCMU_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 2);
      const [frame1, frame2] = mock1.frames as [Record<string, unknown>, Record<string, unknown>];

      assert.equal(frame1.type, 'session-update');
      const config = frame1.config as Record<string, unknown>;
      assert.equal(typeof config.instructions, 'string');
      assert.ok(
        (config.instructions as string).includes(
          "Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."
        ),
        'instructions must contain the BRD §5.7 tool-preamble sentence verbatim',
      );
      assert.equal(config.voice, 'marin');
      assert.deepEqual(config.turnDetection, {
        type: 'server-vad',
        silenceDurationMs: 500,
        threshold: 0.5,
        prefixPaddingMs: 300,
      });
      assert.deepEqual(config.inputAudioTranscription, {});
      assert.deepEqual(config.tools, TOOLS);

      assert.equal(frame2.type, 'response-create');
      const options = frame2.options as Record<string, unknown>;
      assert.equal(typeof options.instructions, 'string');
      assert.ok((options.instructions as string).length > 0);
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });

  it('INSTRUCTIONS export contains the verbatim tool-preamble sentence', () => {
    assert.ok(
      INSTRUCTIONS.includes(
        "Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."
      ),
    );
  });
});

describe('openGatewayLeg — format passthrough (A4)', () => {
  it('pcmu-mode: both sent format objects omit the rate key', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-a4-pcmu',
      tools: [],
      formats: PCMU_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 1);
      const config = (mock1.frames[0] as Record<string, unknown>).config as Record<string, unknown>;
      const input = config.inputAudioFormat as Record<string, unknown>;
      const output = config.outputAudioFormat as Record<string, unknown>;
      assert.equal('rate' in input, false);
      assert.equal('rate' in output, false);
      assert.deepEqual(input, { type: 'audio/pcmu' });
      assert.deepEqual(output, { type: 'audio/pcmu' });
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });

  it('transcode-mode: both sent format objects deep-equal {type:audio/pcm, rate:24000}', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE, AUDIO_MODE: 'transcode' });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-a4-transcode',
      tools: [],
      formats: TRANSCODE_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 1);
      const config = (mock1.frames[0] as Record<string, unknown>).config as Record<string, unknown>;
      assert.deepEqual(config.inputAudioFormat, { type: 'audio/pcm', rate: 24000 });
      assert.deepEqual(config.outputAudioFormat, { type: 'audio/pcm', rate: 24000 });
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });
});

describe('openGatewayLeg — WAIT_FOR_SESSION_UPDATED gate (A5, S6)', () => {
  it('waitForSessionUpdated:true defers response-create until session-updated arrives, and logs .raw verbatim', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE, WAIT_FOR_SESSION_UPDATED: 'true' });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    const log = spyOnLog();
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-a5-wait',
      tools: [],
      formats: PCMU_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 1);
      assert.equal(mock1.frames[0]!.type, 'session-update');

      // No second frame within a short window — greeting must be gated.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(mock1.frames.length, 1, 'response-create must not fire before session-updated');

      mock1.send({ type: 'session-updated', raw: { session: { voice: 'marin' } } });
      await waitUntil(() => mock1.frames.length >= 2);
      assert.equal(mock1.frames[1]!.type, 'response-create');

      const lines = log.lines();
      const updatedLine = lines.find((l) => l.event === 'session-updated');
      assert.ok(updatedLine, 'expected a verbatim session-updated log line');
      assert.deepEqual(updatedLine!.raw, { session: { voice: 'marin' } });
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      log.restore();
      await mock1.stop();
    }
  });

  it('waitForSessionUpdated:false (default) sends response-create right after session-update, no server event needed', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-a5-nowait',
      tools: [],
      formats: PCMU_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 2);
      assert.equal(mock1.frames[0]!.type, 'session-update');
      assert.equal(mock1.frames[1]!.type, 'response-create');
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });
});

describe('openGatewayLeg — GATEWAY_TAGS (S32)', () => {
  it('gatewayTags set: sent config contains providerOptions.gateway.tags', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE, GATEWAY_TAGS: 'poc' });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-tags-on',
      tools: [],
      formats: PCMU_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 1);
      const config = (mock1.frames[0] as Record<string, unknown>).config as Record<string, unknown>;
      assert.deepEqual(config.providerOptions, { gateway: { tags: ['poc'] } });
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });

  it('gatewayTags unset (default): sent config has no providerOptions key at all', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-tags-off',
      tools: [],
      formats: PCMU_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 1);
      const config = (mock1.frames[0] as Record<string, unknown>).config as Record<string, unknown>;
      assert.equal('providerOptions' in config, false);
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });
});

describe('openGatewayLeg — session-update-sent log line (Spec 04 R13)', () => {
  it('emits a session-update-sent log line with audioMode and voice', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE, AUDIO_MODE: 'transcode', VOICE: 'marin' });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    const log = spyOnLog();
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-log',
      tools: [],
      formats: TRANSCODE_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({ onOpen: () => { opened = true; }, onClose: () => { closed = true; } }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 1);
      const lines = log.lines();
      const sentLine = lines.find((l) => l.event === 'session-update-sent');
      assert.ok(sentLine, 'expected a session-update-sent log line');
      assert.equal(sentLine!.audioMode, 'transcode');
      assert.equal(sentLine!.voice, 'marin');
      assert.equal(sentLine!.callSid, 'CA-log');
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      log.restore();
      await mock1.stop();
    }
  });
});

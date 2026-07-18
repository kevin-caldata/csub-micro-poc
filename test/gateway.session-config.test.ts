import { describe, it, expect, vi } from 'vitest';
import type { Experimental_RealtimeModelV4ToolDefinition as ToolDefinition } from '@ai-sdk/provider';
import { loadConfig } from '../src/config.js';
import { openGatewayLeg, INSTRUCTIONS, type MintResult, type GatewayLegCallbacks } from '../src/gateway.js';
import { startMockGateway } from './gateway.mock.js';

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

      expect(frame1.type).toBe('session-update');
      const config = frame1.config as Record<string, unknown>;
      expect(typeof config.instructions).toBe('string');
      expect((config.instructions as string).includes(
          "Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."
        ), 'instructions must contain the BRD §5.7 tool-preamble sentence verbatim').toBeTruthy();
      expect(config.voice).toBe('marin');
      expect(config.turnDetection).toEqual({
        type: 'server-vad',
        silenceDurationMs: 500,
        threshold: 0.5,
        prefixPaddingMs: 300,
      });
      expect(config.inputAudioTranscription).toEqual({});
      expect(config.tools).toEqual(TOOLS);

      expect(frame2.type).toBe('response-create');
      const options = frame2.options as Record<string, unknown>;
      expect(typeof options.instructions).toBe('string');
      expect((options.instructions as string).length > 0).toBeTruthy();
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });

  it('INSTRUCTIONS export contains the verbatim tool-preamble sentence', () => {
    expect(INSTRUCTIONS.includes(
        "Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."
      )).toBeTruthy();
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
      expect('rate' in input).toBe(false);
      expect('rate' in output).toBe(false);
      expect(input).toEqual({ type: 'audio/pcmu' });
      expect(output).toEqual({ type: 'audio/pcmu' });
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
      expect(config.inputAudioFormat).toEqual({ type: 'audio/pcm', rate: 24000 });
      expect(config.outputAudioFormat).toEqual({ type: 'audio/pcm', rate: 24000 });
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
      expect(mock1.frames[0]!.type).toBe('session-update');

      // No second frame within a short window — greeting must be gated.
      await new Promise((r) => setTimeout(r, 300));
      expect(mock1.frames.length, 'response-create must not fire before session-updated').toBe(1);

      mock1.send({ type: 'session-updated', raw: { session: { voice: 'marin' } } });
      await waitUntil(() => mock1.frames.length >= 2);
      expect(mock1.frames[1]!.type).toBe('response-create');

      const lines = log.lines();
      const updatedLine = lines.find((l) => l.event === 'session-updated');
      expect(updatedLine, 'expected a verbatim session-updated log line').toBeTruthy();
      expect(updatedLine!.raw).toEqual({ session: { voice: 'marin' } });
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
      expect(mock1.frames[0]!.type).toBe('session-update');
      expect(mock1.frames[1]!.type).toBe('response-create');
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });
});

describe('openGatewayLeg — greeting decomposition callbacks (Spec 08 R7 follow-up)', () => {
  it('immediate path (default WAIT_FOR_SESSION_UPDATED=false): onSessionUpdateSent fires before onGreetingCreateSent; onSessionUpdated fires exactly once when session-updated arrives', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    const order: string[] = [];
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-greet-immediate',
      tools: [],
      formats: PCMU_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({
        onOpen: () => { opened = true; },
        onClose: () => { closed = true; },
        onSessionUpdateSent: () => order.push('sent'),
        onSessionUpdated: () => order.push('updated'),
        onGreetingCreateSent: () => order.push('greeting'),
      }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 2); // session-update, then response-create
      expect(order, 'onGreetingCreateSent fires right after the immediate response-create send, with no session-updated wait').toEqual(['sent', 'greeting']);

      mock1.send({ type: 'session-updated', raw: {} });
      await waitUntil(() => order.includes('updated'));
      expect(order).toEqual(['sent', 'greeting', 'updated']);

      // A second session-updated (rare, but the gateway may emit more than one) must not
      // double-fire the one-shot onSessionUpdated callback.
      mock1.send({ type: 'session-updated', raw: {} });
      await new Promise((r) => setTimeout(r, 100));
      expect(order.filter((o) => o === 'updated').length).toBe(1);
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      await mock1.stop();
    }
  });

  it('WAIT_FOR_SESSION_UPDATED=true path: onSessionUpdateSent -> onSessionUpdated -> onGreetingCreateSent fire in that deterministic order', async () => {
    const mock1 = await startMockGateway();
    const cfg = loadConfig({ ...BASE, WAIT_FOR_SESSION_UPDATED: 'true' });
    const mint: MintResult = { token: 'vcst_test', url: mock1.url, getTokenMs: 0 };
    const order: string[] = [];
    let opened = false;
    let closed = false;
    const leg = openGatewayLeg({
      mint,
      callSid: 'CA-greet-wait',
      tools: [],
      formats: PCMU_FORMATS,
      config: cfg,
      callbacks: noopCallbacks({
        onOpen: () => { opened = true; },
        onClose: () => { closed = true; },
        onSessionUpdateSent: () => order.push('sent'),
        onSessionUpdated: () => order.push('updated'),
        onGreetingCreateSent: () => order.push('greeting'),
      }),
    });
    try {
      await waitUntil(() => opened);
      await waitUntil(() => mock1.frames.length >= 1); // session-update only — greeting is gated
      expect(order).toEqual(['sent']);

      mock1.send({ type: 'session-updated', raw: {} });
      await waitUntil(() => order.length === 3);
      expect(order).toEqual(['sent', 'updated', 'greeting']);
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
      expect(config.providerOptions).toEqual({ gateway: { tags: ['poc'] } });
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
      expect('providerOptions' in config).toBe(false);
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
      expect(sentLine, 'expected a session-update-sent log line').toBeTruthy();
      expect(sentLine!.audioMode).toBe('transcode');
      expect(sentLine!.voice).toBe('marin');
      expect(sentLine!.callSid).toBe('CA-log');
    } finally {
      leg.close();
      await waitUntil(() => closed, 1000).catch(() => {});
      log.restore();
      await mock1.stop();
    }
  });
});

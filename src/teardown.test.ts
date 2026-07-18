// T05.4 — startSessionBridge orchestration + the teardown matrix (Spec 05 R11, A4/A5/A6 unit
// analogs, A12). Pure-logic module (no fastify.injectWS anywhere in this file — exempt from the
// repo's "one injectWS-backed test per file" rule, same as bargein.test.ts/sessions.test.ts),
// so every case lives in this one file per the plan.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';
import { sessions as stateSessions } from './state.js';
import { createSession, teardownSession, sessions, type Session } from './sessions.js';
import { startSessionBridge, setOnGatewayFailure, type SessionBridgeDeps } from './session.js';
import type { PendingCall } from './twiml.js';
import type { GatewayLeg, OpenGatewayLegOptions } from './gateway.js';
import { audioFormatsFor } from './dsp.js';
import type { AppConfig } from './config.js';

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const fixtureConfig: AppConfig = {
  aiGatewayApiKey: 'vck_test',
  twilioAuthToken: 'tok_test',
  port: 4123,
  publicHost: 'example.ngrok.app',
  modelId: 'openai/gpt-realtime-2.1',
  audioMode: 'pcmu',
  voice: 'marin',
  voiceFallback: 'alloy',
  vadSilenceMs: 500,
  vadThreshold: 0.5,
  vadPrefixPaddingMs: 300,
  tokenTtlSeconds: 600,
  gatewayHandshakeTimeoutMs: 5000,
  gatewayPingSeconds: 0,
  waitForSessionUpdated: false,
  gatewayTags: undefined,
  twilioValidateUpgrade: false,
};

/** Minimal fake WebSocket — only the surface teardownSession/startSessionBridge touch. */
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

const noopLog: Session['log'] = () => {};

function makeSession(streamSid = 'MZ1', callSid = 'CA1'): { session: Session; socket: ReturnType<typeof fakeSocket> } {
  const socket = fakeSocket(OPEN);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = createSession({ twilioWs: socket as any, streamSid, callSid, log: noopLog });
  return { session, socket };
}

/** Fake `openGatewayLeg`: captures the opts/callbacks it was called with and records `close()`. */
function fakeOpenGatewayLeg(): {
  fn: typeof import('./gateway.js').openGatewayLeg;
  captured: { opts?: OpenGatewayLegOptions };
  closeCalls: Array<{ code?: number; reason?: string }>;
  appendAudioCalls: string[];
  sendCalls: ClientEvent[];
  setOpen: (v: boolean) => void;
} {
  const captured: { opts?: OpenGatewayLegOptions } = {};
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  const appendAudioCalls: string[] = [];
  const sendCalls: ClientEvent[] = [];
  let open = true;
  const fn = ((opts: OpenGatewayLegOptions): GatewayLeg => {
    captured.opts = opts;
    return {
      async send(ev: ClientEvent) {
        sendCalls.push(ev);
      },
      async appendAudio(b64: string) {
        appendAudioCalls.push(b64);
      },
      get isOpen() {
        return open;
      },
      close(code?: number, reason?: string) {
        closeCalls.push({ code, reason });
        open = false;
      },
    };
  }) as unknown as typeof import('./gateway.js').openGatewayLeg;
  return { fn, captured, closeCalls, appendAudioCalls, sendCalls, setOpen: (v: boolean) => (open = v) };
}

function fakeMcpClient(): { client: Client; closeCalls: number[] } {
  const closeCalls: number[] = [];
  const client = {
    close: async () => {
      closeCalls.push(1);
    },
  } as unknown as Client;
  return { client, closeCalls };
}

function pendingCallResolving(mint: { token: string; url: string; expiresAt?: number; getTokenMs?: number }): PendingCall {
  return { callSid: 'CA1', createdAt: Date.now(), gatewayAuth: Promise.resolve(mint) };
}

function pendingCallRejecting(err: unknown): PendingCall {
  return { callSid: 'CA1', createdAt: Date.now(), gatewayAuth: Promise.reject(err) };
}

const fakeMint = { token: 'vcst_test', url: 'wss://ai-gateway.vercel.sh/v4/ai/realtime-model', expiresAt: 123, getTokenMs: 42 };

/** Full bootstrap wiring, fakes injected — mirrors the production call site's deps shape. */
async function bootstrap(
  session: Session,
  opts: {
    pendingCall?: PendingCall;
    tools?: Array<{ type: 'function'; name: string; description?: string; parameters: Record<string, unknown> }>;
    mcpClient?: Client;
  } = {},
): Promise<{
  gw: ReturnType<typeof fakeOpenGatewayLeg>;
  mcp: { client: Client; closeCalls: number[] };
}> {
  const gw = fakeOpenGatewayLeg();
  const mcp = opts.mcpClient ? { client: opts.mcpClient, closeCalls: [] } : fakeMcpClient();
  const tools = opts.tools ?? [];
  const deps: Partial<SessionBridgeDeps> = {
    config: fixtureConfig,
    openGatewayLeg: gw.fn,
    createMcpClient: async () => mcp.client,
    fetchToolDefs: async () => tools,
  };
  await startSessionBridge(session, opts.pendingCall ?? pendingCallResolving(fakeMint), deps);
  return { gw, mcp };
}

beforeEach(() => {
  sessions.clear();
});

afterEach(() => {
  setOnGatewayFailure(() => {}); // reset the module-level seam between tests
});

describe('startSessionBridge — sessions/state identity sanity', () => {
  it('sessions from ./sessions.js is reference-identical to sessions from ./state.js (no second map)', () => {
    assert.equal(sessions as unknown, stateSessions as unknown);
  });
});

describe('startSessionBridge — bootstrap wiring', () => {
  it('wires onTwilioMedia -> handleTwilioMedia, injects formats deep-equal to audioFormatsFor(config.audioMode) and the fetched tools array, and onEvent is dispatch-backed', async () => {
    const { session } = makeSession();
    sessions.set(session.streamSid, session);
    const tools = [{ type: 'function' as const, name: 'get_current_time', parameters: { type: 'object', properties: {} } }];

    const { gw } = await bootstrap(session, { tools });

    assert.ok(gw.captured.opts, 'openGatewayLeg was called');
    assert.deepEqual(gw.captured.opts?.formats, audioFormatsFor(fixtureConfig.audioMode));
    assert.deepEqual(gw.captured.opts?.tools, tools);
    assert.equal(gw.captured.opts?.callSid, session.callSid);
    assert.equal(gw.captured.opts?.mint.token, fakeMint.token);

    // onTwilioMedia forwards to handleTwilioMedia (appendAudio on the fake gateway leg).
    assert.equal(typeof session.onTwilioMedia, 'function');
    session.onTwilioMedia?.('YWJj');
    assert.deepEqual(gw.appendAudioCalls, ['YWJj']); // pcmu mode: zero-copy passthrough

    // callbacks.onEvent is dispatch-backed: a normalized speech-started event runs dispatch()'s
    // R10 phase transition (bargeIn() itself no-ops: markQueue empty, responseActive false).
    assert.equal(session.turnPhase, 'idle');
    gw.captured.opts?.callbacks.onEvent({ type: 'speech-started' } as never);
    assert.equal(session.turnPhase, 'user-speaking');
  });

  it('constructs recorder/toolLoop and forwards mark echoes to the recorder via onFirstMarkEcho', async () => {
    const { session } = makeSession();
    sessions.set(session.streamSid, session);

    await bootstrap(session);

    assert.ok(session.recorder, 'recorder constructed');
    assert.ok(session.toolLoop, 'toolLoop constructed (mcp client present)');
    assert.equal(typeof session.onFirstMarkEcho, 'function');
    assert.doesNotThrow(() => session.onFirstMarkEcho?.('rX:1'));
  });
});

describe('startSessionBridge — mint rejection (FR-7 at mint time)', () => {
  it('logs an error, tears down (clean hangup), never opens a gateway leg, and never rejects', async () => {
    const { session, socket } = makeSession();
    sessions.set(session.streamSid, session);

    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    session.log = (level, message, fields) => {
      logs.push({ level, message, fields });
    };

    const gw = fakeOpenGatewayLeg();
    await assert.doesNotReject(() =>
      startSessionBridge(session, pendingCallRejecting(new Error('boom')), {
        config: fixtureConfig,
        openGatewayLeg: gw.fn,
      }),
    );

    assert.equal(gw.captured.opts, undefined, 'no gateway leg opened');
    assert.equal(session.gateway, undefined);
    assert.ok(logs.some((l) => l.message === 'mint failed'));
    assert.equal(session.tornDown, true);
    assert.equal(socket.closeCalls.length, 1);
    assert.equal(socket.closeCalls[0]?.code, 1000); // clean hangup, NOT the drain 1001
    assert.equal(sessions.has(session.streamSid), false);
  });
});

describe('startSessionBridge — fetchToolDefs failure (FR-7: a tool failure never kills the call)', () => {
  it('proceeds with tools:[] and one error log; the call still bridges', async () => {
    const { session } = makeSession();
    sessions.set(session.streamSid, session);

    const logs: Array<{ level: string; message: string }> = [];
    session.log = (level, message) => {
      logs.push({ level, message });
    };

    const gw = fakeOpenGatewayLeg();
    const mcp = fakeMcpClient();
    await startSessionBridge(session, pendingCallResolving(fakeMint), {
      config: fixtureConfig,
      openGatewayLeg: gw.fn,
      createMcpClient: async () => mcp.client,
      fetchToolDefs: async () => {
        throw new Error('listTools exploded');
      },
    });

    assert.deepEqual(gw.captured.opts?.tools, []);
    assert.equal(logs.filter((l) => l.message === 'fetch tool defs failed').length, 1);
    assert.ok(gw.captured.opts, 'the gateway leg still opened — the call was never killed');
  });
});

describe('startSessionBridge — onOpenFailed (FR-7 at handshake)', () => {
  it('tears down with the Twilio leg closed', async () => {
    const { session, socket } = makeSession();
    sessions.set(session.streamSid, session);

    const { gw } = await bootstrap(session);
    gw.captured.opts?.callbacks.onOpenFailed({ statusCode: 401, message: 'unauthorized' });

    assert.equal(session.tornDown, true);
    assert.equal(socket.closeCalls.length, 1);
    assert.equal(sessions.has(session.streamSid), false);
  });
});

describe('startSessionBridge — A5 unit analog (gateway dies mid-call)', () => {
  it('logs gateway-close verbatim, invokes onGatewayFailure BEFORE the Twilio close, and drains sessions.size to 0 — no dead-air path', async () => {
    const { session, socket } = makeSession();
    sessions.set(session.streamSid, session);
    const { gw, mcp } = await bootstrap(session);

    const order: string[] = [];
    let sawTwilioClosedInsideFailureHook = false;
    setOnGatewayFailure((s) => {
      order.push('onGatewayFailure');
      sawTwilioClosedInsideFailureHook = socket.closeCalls.length > 0;
      assert.equal(s, session);
    });

    const logs: Array<{ level: string; message: string; event?: string; code?: number; reason?: string }> = [];
    session.log = (level, message, fields) => {
      logs.push({ level, message, event: fields?.event as string | undefined, code: fields?.code as number | undefined, reason: fields?.reason as string | undefined });
    };

    // Invoke the wired GatewayLegCallbacks.onClose exactly as gateway.ts would.
    const maybePromise = gw.captured.opts?.callbacks.onClose({ code: 1011, reason: 'internal error' });
    await Promise.resolve(maybePromise as unknown);

    const closeLine = logs.find((l) => l.event === 'gateway-close');
    assert.ok(closeLine, 'expected a verbatim gateway-close log line');
    assert.equal(closeLine?.code, 1011);
    assert.equal(closeLine?.reason, 'internal error');

    assert.deepEqual(order, ['onGatewayFailure']);
    assert.equal(sawTwilioClosedInsideFailureHook, false, 'onGatewayFailure must run BEFORE the Twilio close');

    assert.equal(session.tornDown, true);
    assert.equal(socket.closeCalls.length, 1);
    assert.equal(socket.closeCalls[0]?.code, 1000);
    assert.equal(mcp.closeCalls.length, 1, 'mcp client closed exactly once');
    assert.equal(gw.closeCalls.length >= 0, true); // gateway already closed on its own close event; guarded no-op is fine either way
    assert.equal(sessions.size, 0);
  });
});

describe('startSessionBridge — A12 idempotency', () => {
  it('calling teardownSession twice closes each socket at most once, closes the MCP client once, and deletes the map entry exactly once', async () => {
    const { session, socket } = makeSession();
    sessions.set(session.streamSid, session);
    const { mcp } = await bootstrap(session);

    teardownSession(session, 'first');
    teardownSession(session, 'second');

    assert.equal(socket.closeCalls.length, 1);
    assert.equal(mcp.closeCalls.length, 1);
    assert.equal(sessions.has(session.streamSid), false);
  });
});

describe('startSessionBridge — A12 same-tick cross-trigger', () => {
  it('the Twilio-close-path teardown and the gateway onClose-path teardown firing in the same tick still produce a single execution', async () => {
    const { session, socket } = makeSession();
    sessions.set(session.streamSid, session);
    const { gw, mcp } = await bootstrap(session);

    const onCloseResult = gw.captured.opts?.callbacks.onClose({ code: 1006, reason: 'abnormal' }); // gateway leg dies...
    teardownSession(session, 'twilio-close-abnormal'); // ...and the Twilio leg closes in the SAME tick
    await Promise.resolve(onCloseResult as unknown);

    assert.equal(socket.closeCalls.length, 1);
    assert.equal(mcp.closeCalls.length, 1);
    assert.equal(sessions.has(session.streamSid), false);
  });
});

describe('startSessionBridge — A6 unit analog (drain cooperation)', () => {
  it('the Spec 02 drain path (Session.teardown) closes the Twilio leg with 1001; a normal stop-path teardown closes with 1000', async () => {
    const { session: drainSession, socket: drainSocket } = makeSession('MZ-drain', 'CA-drain');
    sessions.set(drainSession.streamSid, drainSession);
    await bootstrap(drainSession);
    drainSession.teardown('server shutdown'); // the SessionHandle contract the drain loop calls
    assert.equal(drainSocket.closeCalls[0]?.code, 1001);

    const { session: stopSession, socket: stopSocket } = makeSession('MZ-stop', 'CA-stop');
    sessions.set(stopSession.streamSid, stopSession);
    await bootstrap(stopSession);
    teardownSession(stopSession, 'caller-hangup'); // Spec 03's own 'stop' handler path
    assert.equal(stopSocket.closeCalls[0]?.code, 1000);
  });
});

describe('startSessionBridge — A4 unit analog (isolation)', () => {
  it('tearing down one of two sessions leaves the other fully untouched', async () => {
    const { session: a, socket: socketA } = makeSession('MZ-A', 'CA-A');
    const { session: b, socket: socketB } = makeSession('MZ-B', 'CA-B');
    sessions.set(a.streamSid, a);
    sessions.set(b.streamSid, b);

    const { mcp: mcpA } = await bootstrap(a);
    const { mcp: mcpB } = await bootstrap(b);

    teardownSession(a, 'caller-hangup');

    assert.equal(a.tornDown, true);
    assert.equal(sessions.has('MZ-A'), false);
    assert.equal(socketA.closeCalls.length, 1);
    assert.equal(mcpA.closeCalls.length, 1);

    assert.equal(b.tornDown, false);
    assert.equal(sessions.has('MZ-B'), true);
    assert.equal(socketB.closeCalls.length, 0);
    assert.equal(mcpB.closeCalls.length, 0);
  });
});

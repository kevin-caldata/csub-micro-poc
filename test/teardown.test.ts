// T05.4 — startSessionBridge orchestration + the teardown matrix (Spec 05 R11, A4/A5/A6 unit
// analogs, A12). Pure-logic module (no fastify.injectWS anywhere in this file — exempt from the
// repo's "one injectWS-backed test per file" rule, same as bargein.test.ts/sessions.test.ts),
// so every case lives in this one file per the plan.

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';
import { sessions as stateSessions } from '../src/state.js';
import { createSession, teardownSession, sessions, type Session } from '../src/sessions.js';
import { startSessionBridge, setOnGatewayFailure, type SessionBridgeDeps } from '../src/session.js';
import { onMarkEcho } from '../src/bargein.js';
import type { PendingCall } from '../src/twiml.js';
import type { GatewayLeg, OpenGatewayLegOptions } from '../src/gateway.js';
import { audioFormatsFor } from '../src/dsp.js';
import type { AppConfig } from '../src/config.js';

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
  twilioPingSeconds: 0,
  waitForSessionUpdated: false,
  gatewayTags: undefined,
  twilioValidateUpgrade: false,
};

/** Minimal fake WebSocket — only the surface teardownSession/startSessionBridge touch. */
function fakeSocket(readyState: number): {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  closeCalls: Array<{ code?: number; reason?: string }>;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
} {
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  const sent: string[] = [];
  return {
    readyState,
    bufferedAmount: 0,
    sent,
    send(data: string) {
      sent.push(data);
    },
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

/** A manually-resolvable promise for race control (same idiom as test/tool-loop.test.ts). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Polls `pred` until true or `timeoutMs` elapses (same idiom as gateway.leg.test.ts et al.). */
async function waitUntil(pred: () => boolean, timeoutMs = 2000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
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
    expect(sessions as unknown).toBe(stateSessions as unknown);
  });
});

describe('startSessionBridge — bootstrap wiring', () => {
  it('wires onTwilioMedia -> handleTwilioMedia, injects formats deep-equal to audioFormatsFor(config.audioMode) and the fetched tools array, and onEvent is dispatch-backed', async () => {
    const { session } = makeSession();
    sessions.set(session.streamSid, session);
    const tools = [{ type: 'function' as const, name: 'get_current_time', parameters: { type: 'object', properties: {} } }];

    const { gw } = await bootstrap(session, { tools });

    expect(gw.captured.opts, 'openGatewayLeg was called').toBeTruthy();
    expect(gw.captured.opts?.formats).toEqual(audioFormatsFor(fixtureConfig.audioMode));
    expect(gw.captured.opts?.tools).toEqual(tools);
    expect(gw.captured.opts?.callSid).toBe(session.callSid);
    expect(gw.captured.opts?.mint.token).toBe(fakeMint.token);

    // onTwilioMedia forwards to handleTwilioMedia (appendAudio on the fake gateway leg).
    expect(typeof session.onTwilioMedia).toBe('function');
    session.onTwilioMedia?.('YWJj');
    expect(gw.appendAudioCalls).toEqual(['YWJj']); // pcmu mode: zero-copy passthrough

    // callbacks.onEvent is dispatch-backed: a normalized speech-started event runs dispatch()'s
    // R10 phase transition (bargeIn() itself no-ops: markQueue empty, responseActive false).
    expect(session.turnPhase).toBe('idle');
    gw.captured.opts?.callbacks.onEvent({ type: 'speech-started' } as never);
    expect(session.turnPhase).toBe('user-speaking');
  });

  it('constructs recorder/toolLoop and forwards mark echoes to the recorder via onFirstMarkEcho', async () => {
    const { session } = makeSession();
    sessions.set(session.streamSid, session);

    await bootstrap(session);

    expect(session.recorder, 'recorder constructed').toBeTruthy();
    expect(session.toolLoop, 'toolLoop constructed (mcp client present)').toBeTruthy();
    expect(typeof session.onFirstMarkEcho).toBe('function');
    expect(() => session.onFirstMarkEcho?.('rX:1')).not.toThrow();
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
    await (() =>
      startSessionBridge(session, pendingCallRejecting(new Error('boom')), {
        config: fixtureConfig,
        openGatewayLeg: gw.fn,
      }))();

    expect(gw.captured.opts, 'no gateway leg opened').toBe(undefined);
    expect(session.gateway).toBe(undefined);
    expect(logs.some((l) => l.message === 'mint failed')).toBeTruthy();
    expect(session.tornDown).toBe(true);
    expect(socket.closeCalls.length).toBe(1);
    expect(socket.closeCalls[0]?.code).toBe(1000); // clean hangup, NOT the drain 1001
    expect(sessions.has(session.streamSid)).toBe(false);
  });

  // Regression net (findings review): `onTeardown` (which calls `session.recorder?.onStreamStop()`
  // — the Spec 08 R12 percentile summary) used to be installed AFTER the mint-rejection catch's
  // `return`, so a mint failure tore down the session WITHOUT ever installing the hook and the
  // stream-stop summary line was silently never emitted — even though the file's own comment
  // claimed every call gets one. `onTeardown` is now installed immediately after the recorder is
  // constructed, before the mint await, so `teardownSession`'s `onTeardown?.()` call reaches it on
  // every path, mint-rejection included. This asserts the actual emitted line, not just that some
  // hook ran, per the same stdout-capture pattern the greeting-decomposition test below uses
  // (TurnRecorder's default emit is logEvent -> process.stdout.write).
  it('still emits the recorder stream-stop summary line (Spec 08 R12) even though the mint failed', async () => {
    const { session } = makeSession();
    sessions.set(session.streamSid, session);

    const originalWrite = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: any) => {
      chunks.push(String(chunk));
      return true;
    };

    try {
      const gw = fakeOpenGatewayLeg();
      await startSessionBridge(session, pendingCallRejecting(new Error('boom')), {
        config: fixtureConfig,
        openGatewayLeg: gw.fn,
      });

      const streamStopLines = chunks
        .map((c) => {
          try {
            return JSON.parse(c) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== undefined && v.event === 'stream-stop');

      expect(streamStopLines.length, 'expected exactly one stream-stop line even on mint failure').toBe(1);
      const line = streamStopLines[0]!;
      expect(line.n, 'no turns ever opened before the mint failure').toBe(0);
      expect(line.turns).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
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

    expect(gw.captured.opts?.tools).toEqual([]);
    expect(logs.filter((l) => l.message === 'fetch tool defs failed').length).toBe(1);
    expect(gw.captured.opts, 'the gateway leg still opened — the call was never killed').toBeTruthy();
  });
});

describe('startSessionBridge — onOpenFailed (FR-7 at handshake)', () => {
  it('tears down with the Twilio leg closed', async () => {
    const { session, socket } = makeSession();
    sessions.set(session.streamSid, session);

    const { gw } = await bootstrap(session);
    gw.captured.opts?.callbacks.onOpenFailed({ statusCode: 401, message: 'unauthorized' });

    expect(session.tornDown).toBe(true);
    expect(socket.closeCalls.length).toBe(1);
    expect(sessions.has(session.streamSid)).toBe(false);
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
      expect(s).toBe(session);
    });

    const logs: Array<{ level: string; message: string; event?: string; code?: number; reason?: string }> = [];
    session.log = (level, message, fields) => {
      logs.push({ level, message, event: fields?.event as string | undefined, code: fields?.code as number | undefined, reason: fields?.reason as string | undefined });
    };

    // Invoke the wired GatewayLegCallbacks.onClose exactly as gateway.ts would.
    const maybePromise = gw.captured.opts?.callbacks.onClose({ code: 1011, reason: 'internal error' });
    await Promise.resolve(maybePromise as unknown);

    const closeLine = logs.find((l) => l.event === 'gateway-close');
    expect(closeLine, 'expected a verbatim gateway-close log line').toBeTruthy();
    expect(closeLine?.code).toBe(1011);
    expect(closeLine?.reason).toBe('internal error');

    expect(order).toEqual(['onGatewayFailure']);
    expect(sawTwilioClosedInsideFailureHook, 'onGatewayFailure must run BEFORE the Twilio close').toBe(false);

    expect(session.tornDown).toBe(true);
    expect(socket.closeCalls.length).toBe(1);
    expect(socket.closeCalls[0]?.code).toBe(1000);
    expect(mcp.closeCalls.length, 'mcp client closed exactly once').toBe(1);
    expect(gw.closeCalls.length >= 0).toBe(true); // gateway already closed on its own close event; guarded no-op is fine either way
    expect(sessions.size).toBe(0);
  });
});

describe('startSessionBridge — A12 idempotency', () => {
  it('calling teardownSession twice closes each socket at most once, closes the MCP client once, and deletes the map entry exactly once', async () => {
    const { session, socket } = makeSession();
    sessions.set(session.streamSid, session);
    const { mcp } = await bootstrap(session);

    teardownSession(session, 'first');
    teardownSession(session, 'second');

    expect(socket.closeCalls.length).toBe(1);
    expect(mcp.closeCalls.length).toBe(1);
    expect(sessions.has(session.streamSid)).toBe(false);
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

    expect(socket.closeCalls.length).toBe(1);
    expect(mcp.closeCalls.length).toBe(1);
    expect(sessions.has(session.streamSid)).toBe(false);
  });
});

describe('startSessionBridge — A6 unit analog (drain cooperation)', () => {
  it('the Spec 02 drain path (Session.teardown) closes the Twilio leg with 1001; a normal stop-path teardown closes with 1000', async () => {
    const { session: drainSession, socket: drainSocket } = makeSession('MZ-drain', 'CA-drain');
    sessions.set(drainSession.streamSid, drainSession);
    await bootstrap(drainSession);
    drainSession.teardown('server shutdown'); // the SessionHandle contract the drain loop calls
    expect(drainSocket.closeCalls[0]?.code).toBe(1001);

    const { session: stopSession, socket: stopSocket } = makeSession('MZ-stop', 'CA-stop');
    sessions.set(stopSession.streamSid, stopSession);
    await bootstrap(stopSession);
    teardownSession(stopSession, 'caller-hangup'); // Spec 03's own 'stop' handler path
    expect(stopSocket.closeCalls[0]?.code).toBe(1000);
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

    expect(a.tornDown).toBe(true);
    expect(sessions.has('MZ-A')).toBe(false);
    expect(socketA.closeCalls.length).toBe(1);
    expect(mcpA.closeCalls.length).toBe(1);

    expect(b.tornDown).toBe(false);
    expect(sessions.has('MZ-B')).toBe(true);
    expect(socketB.closeCalls.length).toBe(0);
    expect(mcpB.closeCalls.length).toBe(0);
  });
});

// Findings review (Important — teardown/bootstrap race leaks a live gateway WS + MCP client):
// `startSessionBridge` has several awaits (mint, MCP connect, fetchToolDefs) before it ever opens
// the gateway leg. If the Twilio WS dies WHILE parked on one of those awaits, `teardownSession`
// runs to completion right then — but at that instant `onTeardown`'s closure sees
// `gateway`/`mcpClient`/`toolLoop` all still `undefined`, so it does nothing for them. Once the
// awaited promise resolves, execution resumes and (absent this fix) goes on to actually create
// those resources — a live gateway WS and a live MCP client that `onTeardown` already ran and,
// being a one-shot latch (`teardownSession`'s `if (s.tornDown) return`), will never run again to
// close them. These two tests park `startSessionBridge` on each await in turn, tear the session
// down mid-flight via the exact same `teardownSession` call path Spec 02/03's real Twilio-close
// handlers use, then let the parked promise resolve — and assert nothing was left open.
describe('startSessionBridge — teardown mid-bootstrap race (Important finding)', () => {
  it('teardown while parked on a slow mint: no gateway leg opens and no MCP client is ever created', async () => {
    const { session, socket } = makeSession();
    sessions.set(session.streamSid, session);

    const mint = deferred<typeof fakeMint>();
    const pendingCall: PendingCall = { callSid: 'CA1', createdAt: Date.now(), gatewayAuth: mint.promise };

    const gw = fakeOpenGatewayLeg();
    let mcpCreateCalls = 0;
    const bridgePromise = startSessionBridge(session, pendingCall, {
      config: fixtureConfig,
      openGatewayLeg: gw.fn,
      createMcpClient: async () => {
        mcpCreateCalls += 1;
        return fakeMcpClient().client;
      },
      fetchToolDefs: async () => [],
    });

    // startSessionBridge runs synchronously up to its first `await` before ever returning
    // control here — so by this point it is guaranteed to be parked on the mint await above.
    // Simulate the Twilio WS dying right there (Spec 02/03's real close handlers call exactly
    // this function).
    teardownSession(session, 'twilio-closed-mid-mint');
    expect(session.tornDown).toBe(true);
    expect(socket.closeCalls.length).toBe(1);

    mint.resolve(fakeMint); // let the parked bootstrap resume
    await bridgePromise;

    expect(gw.captured.opts, 'the gateway leg must never open once the session is torn down').toBe(undefined);
    expect(mcpCreateCalls, 'no MCP client should ever be created once the session is torn down').toBe(0);
    // teardownSession is idempotent — the resumed bootstrap bailing must not close the socket twice.
    expect(socket.closeCalls.length).toBe(1);
  });

  it('teardown while parked on a slow MCP connect: the newly-created client is closed, not leaked, and no gateway leg opens', async () => {
    const { session, socket } = makeSession();
    sessions.set(session.streamSid, session);

    const mcp = fakeMcpClient();
    const mcpConnect = deferred<Client>();
    const gw = fakeOpenGatewayLeg();
    let mcpCreateCalled = false;

    const bridgePromise = startSessionBridge(session, pendingCallResolving(fakeMint), {
      config: fixtureConfig,
      openGatewayLeg: gw.fn,
      createMcpClient: async () => {
        mcpCreateCalled = true;
        return mcpConnect.promise;
      },
      fetchToolDefs: async () => [],
    });

    // Wait until execution has actually reached (and parked on) the MCP-connect await — the
    // mint promise above resolves asynchronously (Promise.resolve), so this needs at least one
    // real tick, unlike the synchronous-parking guarantee in the slow-mint case above.
    await waitUntil(() => mcpCreateCalled);

    teardownSession(session, 'twilio-closed-mid-mcp-connect');
    expect(session.tornDown).toBe(true);

    mcpConnect.resolve(mcp.client); // let the parked bootstrap resume
    await bridgePromise;

    expect(gw.captured.opts, 'the gateway leg must never open once the session is torn down').toBe(undefined);
    expect(mcp.closeCalls.length, 'the MCP client created just before teardown must be closed, not leaked').toBe(1);
    expect(socket.closeCalls.length).toBe(1);
  });
});

// Follow-up (Spec 08 R7/A7): gateway.ts now exposes onSessionUpdateSent/onSessionUpdated/
// onGreetingCreateSent, and startSessionBridge wires them straight to the matching TurnRecorder
// hooks. This proves the WIRING end to end: replaying the exact callback sequence gateway.ts's
// closure fires (immediate-greeting path), through a minimal greeting turn (response-created ->
// audio-delta -> mark echo), yields a 'greeting' line whose newly-wired segment fields are
// present (numbers), not just the pre-existing gatewayOpenMs.
describe('startSessionBridge — greeting decomposition wiring (Spec 08 R7 follow-up)', () => {
  it('the recorder greeting line carries sessionUpdateAckMs/greetingTtfbMs/greetingBridgeMs/greetingPlaybackConfirmMs/greetingTotalMs', async () => {
    const { session } = makeSession('MZ-greet', 'CA-greet');
    sessions.set(session.streamSid, session);

    // TurnRecorder's default emit is logEvent -> process.stdout.write; capture that stream the
    // same way twilio-media.test.ts's spyOnLog()/sessions.test.ts's captureStdout() do, rather
    // than reach into the recorder's private `emit` field.
    const originalWrite = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: any) => {
      chunks.push(String(chunk));
      return true;
    };

    try {
      const { gw } = await bootstrap(session);
      const callbacks = gw.captured.opts?.callbacks;
      expect(callbacks).toBeTruthy();

      // gatewayOpenMs needs tGatewayOpen stamped first (already-wired T05.4 hook).
      callbacks!.onOpen();

      // Exactly gateway.ts's own call sequence for the immediate (non-WAIT_FOR_SESSION_UPDATED)
      // greeting path: session-update sent -> session-updated ack -> greeting response-create sent.
      callbacks!.onSessionUpdateSent?.();
      callbacks!.onSessionUpdated?.();
      callbacks!.onGreetingCreateSent?.();

      // Minimal greeting turn: response-created (attributes via isGreetingResponse, since no
      // speech-stopped ever opened a real turn) -> audio-delta (stamps tFirstAudioDelta, forwards
      // to Twilio, pushes the response's first mark) -> that mark's echo (fires emitGreetingLine).
      const responseId = 'greet-r1';
      callbacks!.onEvent({ type: 'response-created', responseId, raw: {} } as never);
      callbacks!.onEvent({ type: 'audio-delta', responseId, itemId: 'greet-item1', delta: 'AAAA', raw: {} } as never);

      const markName = session.firstMarkNameOfResponse;
      expect(markName, 'expected the greeting audio-delta to have pushed a mark').toBeTruthy();
      onMarkEcho(session, markName!);

      const greetingLines = chunks
        .map((c) => {
          try {
            return JSON.parse(c) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== undefined && v.event === 'greeting');

      expect(greetingLines.length, 'expected exactly one greeting line to have been emitted').toBe(1);
      const line = greetingLines[0]!;
      for (const field of [
        'gatewayOpenMs',
        'sessionUpdateAckMs',
        'greetingTtfbMs',
        'greetingBridgeMs',
        'greetingPlaybackConfirmMs',
        'greetingTotalMs',
      ]) {
        expect(typeof line[field], `${field} must be a present numeric segment`).toBe('number');
      }
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

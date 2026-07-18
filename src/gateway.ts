import {
  gateway,
  GatewayError,
  GatewayAuthenticationError,
  GatewayInvalidRequestError,
  GatewayRateLimitError,
  GatewayModelNotFoundError,
  GatewayInternalServerError,
  GatewayFailedDependencyError,
  GatewayForbiddenError,
} from '@ai-sdk/gateway';
import WebSocket from 'ws';
import type {
  Experimental_RealtimeModelV4ClientEvent as ClientEvent,
  Experimental_RealtimeModelV4ServerEvent as ServerEvent,
  Experimental_RealtimeModelV4SessionConfig as SessionConfig,
  Experimental_RealtimeModelV4ToolDefinition as ToolDefinition,
} from '@ai-sdk/provider';
import type { AppConfig } from './config.js';
import { logEvent, ms, now } from './logger.js';

/**
 * Result of a successful `mintRealtimeToken` call.
 * Verbatim shape from Spec 04 R3.
 */
export interface MintResult {
  token: string; // 'vcst_...' single-use client secret — never cache/reuse across sessions
  url: string; // computed server-side by getToken; model id is percent-encoded — never build by hand
  expiresAt?: number; // unix seconds
  getTokenMs: number; // wall-clock duration of the mint call
}

/** `GatewayMintError.errorType` maps 1:1 to the SDK class / body `error.type` (Spec 04 R3, findings/01 §9). */
export type GatewayMintErrorType =
  | 'authentication_error'
  | 'invalid_request_error'
  | 'rate_limit_exceeded'
  | 'model_not_found'
  | 'internal_server_error'
  | 'failed_dependency'
  | 'forbidden'
  | 'unknown';

export class GatewayMintError extends Error {
  constructor(
    public readonly errorType: GatewayMintErrorType,
    public readonly statusCode: number | undefined,
    public readonly getTokenMs: number,
    cause: unknown,
  ) {
    super(`gateway mint failed: ${errorType}`, { cause });
  }
}

/**
 * Classification rules (Spec 04 R3): instanceof checks on the exported classes first,
 * else read `GatewayError.statusCode`, else 'unknown'.
 */
function classifyMintError(err: unknown): { errorType: GatewayMintErrorType; statusCode: number | undefined } {
  if (err instanceof GatewayAuthenticationError) return { errorType: 'authentication_error', statusCode: err.statusCode };
  if (err instanceof GatewayInvalidRequestError) return { errorType: 'invalid_request_error', statusCode: err.statusCode };
  if (err instanceof GatewayRateLimitError) return { errorType: 'rate_limit_exceeded', statusCode: err.statusCode };
  if (err instanceof GatewayModelNotFoundError) return { errorType: 'model_not_found', statusCode: err.statusCode };
  if (err instanceof GatewayInternalServerError) return { errorType: 'internal_server_error', statusCode: err.statusCode };
  if (err instanceof GatewayFailedDependencyError) return { errorType: 'failed_dependency', statusCode: err.statusCode };
  if (err instanceof GatewayForbiddenError) return { errorType: 'forbidden', statusCode: err.statusCode };
  if (err instanceof GatewayError) return { errorType: 'unknown', statusCode: err.statusCode };
  return { errorType: 'unknown', statusCode: undefined };
}

/**
 * Mints a per-call gateway realtime token at webhook time via the factory-form API
 * (`gateway.experimental_realtime.getToken`) — never a model-instance method (BRD §5.2 bug,
 * findings/01 C1: calling getToken on the model instance throws a TypeError).
 *
 * Signature deviation-by-design (recorded in the T04.2 completion report): the Spec 04 R3
 * snippet reads `config.modelId` and `callSid` from ambient scope. Spec 01 R5 forbids a
 * config singleton (pure `loadConfig`, no import-time side effects), so `cfg` and `callSid`
 * are explicit parameters here; `modelId` defaults to `cfg.modelId`.
 */
export async function mintRealtimeToken(
  cfg: AppConfig,
  callSid: string,
  modelId: string = cfg.modelId,
): Promise<MintResult> {
  const t0 = performance.now();
  try {
    const { token, url, expiresAt } = await gateway.experimental_realtime.getToken({
      model: modelId, // required
      expiresAfterSeconds: cfg.tokenTtlSeconds, // renamed to `expiresIn` on the wire (SDK-internal)
    });
    const getTokenMs = Math.round(performance.now() - t0);
    logEvent({ level: 'info', message: 'get-token', event: 'get-token', callSid, getTokenMs, expiresAt });
    return { token, url, expiresAt, getTokenMs };
  } catch (cause) {
    const getTokenMs = Math.round(performance.now() - t0);
    const { errorType, statusCode } = classifyMintError(cause);
    logEvent({
      level: 'error',
      message: 'get-token-failed',
      event: 'get-token-failed',
      callSid,
      errorType,
      statusCode,
      getTokenMs,
    });
    if (errorType === 'model_not_found') {
      logEvent({
        level: 'error',
        message: `model not found for ${modelId}; set MODEL_ID=openai/gpt-realtime-2`,
        event: 'get-token-failed-model-not-found',
        callSid,
        modelId,
      });
    }
    throw new GatewayMintError(errorType, statusCode, getTokenMs, cause);
  }
}

/**
 * Callback surface Spec 05's Session consumes for the lifetime of one gateway WS leg
 * (Spec 04 R5, verbatim). `onOpenFailed` and `onClose` are mutually exclusive terminal
 * signals — exactly one of them fires, ever, per `GatewayLeg`.
 */
export interface GatewayLegCallbacks {
  /** WS open. In this task (T04.3) no frames are sent automatically; T04.4 sends session-update here. */
  onOpen(): void;
  /** Handshake refused (non-101 upgrade) or timed out — FR-7 path. `onClose` will NOT also fire. */
  onOpenFailed(info: { statusCode?: number; message: string }): void;
  /** Every normalized server event, forwarded as-is (T04.5 builds the full dispatch table). */
  onEvent(ev: ServerEvent): void;
  /** ALWAYS terminal for the call once it fires (Spec 04 R11) — `onOpenFailed` will NOT also fire. */
  onClose(info: { code: number; reason: string }): void;
}

/**
 * Options for `openGatewayLeg` (Spec 04 R5) plus one amendment: `config: AppConfig` is added —
 * same no-singleton rationale as T04.2's `mintRealtimeToken(cfg, ...)` (Spec 01 R5 forbids a
 * config singleton; the R5 snippet reads `config.*` from ambient scope, which this repo's
 * `loadConfig()` does not provide). Recorded as deviation-by-design in the completion report.
 */
export interface OpenGatewayLegOptions {
  mint: MintResult;
  callSid: string; // for structured log lines
  tools: ToolDefinition[]; // from MCP listTools, already mapped by Spec 07 — passed through untouched here
  formats: { inputAudioFormat: Record<string, unknown>; outputAudioFormat: Record<string, unknown> };
  // from Spec 06's audioFormatsFor(config.audioMode); unused by T04.3's openGatewayLeg body
  // (no session-update is sent yet — see T04.4), but part of the stable public signature.
  config: AppConfig; // deviation-by-design (see interface doc above)
  callbacks: GatewayLegCallbacks;
}

/** Public handle for one gateway WS leg (Spec 04 R5, verbatim). One `GatewayLeg` per call. */
export interface GatewayLeg {
  send(ev: ClientEvent): Promise<void>; // R6 helper — Session uses this for truncate/item-create/response-create
  appendAudio(base64: string): Promise<void>; // hot path: send({type:'input-audio-append', audio}) with OPEN guard
  readonly isOpen: boolean; // gw.readyState === WebSocket.OPEN
  close(code?: number, reason?: string): void; // default close(1000, 'call ended')
}

/**
 * The mandatory `ws` client options for the gateway leg (Spec 04 R4, findings/08 V5/gotcha 11).
 * Pure + exported so A2 is unit-testable against a recorded options object; `openGatewayLeg`
 * MUST construct its `WebSocket` with exactly this helper's output.
 */
export function gatewayWsOptions(
  cfg: AppConfig,
): { perMessageDeflate: false; handshakeTimeout: number; maxPayload: number } {
  return {
    perMessageDeflate: false, // ws client default is ON — must disable (findings/08 V5)
    handshakeTimeout: cfg.gatewayHandshakeTimeoutMs, // no ws default; unset hangs ~75-130s (findings/08 gotcha 11)
    maxPayload: 16 * 1024 * 1024, // >> gateway's 256 KB message cap (findings/08 snippet)
  };
}

/**
 * Default assistant persona for a phone call (Spec 04 R8, verbatim text). MUST contain the
 * BRD §5.7 tool-preamble sentence verbatim — asserted by A3's test on the exact substring.
 * Exported so it is overridable later without touching `buildCallSessionConfig`.
 */
export const INSTRUCTIONS =
  "You are a friendly, concise voice assistant on a phone call. Keep answers short and " +
  'conversational — one to three sentences. Before calling any tool, briefly say you\'re ' +
  "checking (e.g., 'One moment, let me look that up').";

/** Greeting variant 1 (findings/04 D5): per-response instruction override, no synthetic
 *  conversation items. Verbatim text from Spec 04 R8. */
const GREETING_INSTRUCTIONS = 'Greet the caller warmly in one short sentence and ask how you can help.';

/**
 * Builds the full `session-update` config for a call (Spec 04 R8 snippet). `formats` comes
 * from Spec 06's `audioFormatsFor(config.audioMode)` — the single source of format objects;
 * this function never hand-builds them, only spreads what it is given (R7-style passthrough).
 *
 * Deviation-by-design (same rationale as `mintRealtimeToken`/`gatewayWsOptions`): the Spec 04
 * R8 snippet reads `config.*` from ambient scope; this repo's `loadConfig()` forbids a config
 * singleton (Spec 01 R5), so `cfg` is an explicit parameter here.
 */
function buildCallSessionConfig(
  tools: ToolDefinition[],
  formats: OpenGatewayLegOptions['formats'],
  cfg: AppConfig,
): SessionConfig {
  return {
    instructions: INSTRUCTIONS,
    voice: cfg.voice, // 'marin' default; S8 unverified — boot-config fallback via VOICE_FALLBACK, no runtime auto-retry
    ...(formats as unknown as Pick<SessionConfig, 'inputAudioFormat' | 'outputAudioFormat'>),
    inputAudioTranscription: {}, // {} valid, all fields optional (findings/02 correction 6)
    turnDetection: {
      type: 'server-vad',
      silenceDurationMs: cfg.vadSilenceMs,
      threshold: cfg.vadThreshold,
      prefixPaddingMs: cfg.vadPrefixPaddingMs,
    },
    tools, // verbatim passthrough (R7) — no schema manipulation
    ...(cfg.gatewayTags
      ? { providerOptions: { gateway: { tags: cfg.gatewayTags } } } // S32; default off
      : {}),
  };
}

/**
 * Opens and owns one gateway-leg `ws` client connection (Spec 04 R4/R5/R6/R8/R11/R12).
 *
 * T04.3 implemented construction, the lifecycle/terminal-signal contract, typed send/receive
 * plumbing (including array-frame normalization), and the optional keepalive ping. This task
 * (T04.4) adds the first-frame contract on `'open'`: `session-update` (always first — the
 * gateway's 30-s first-client-message rule) then the greeting `response-create`, either
 * immediately or deferred to the first `session-updated` event via `WAIT_FOR_SESSION_UPDATED`
 * (S6 fallback). `handleEvent` still only forwards to `callbacks.onEvent` for every event
 * except the interim `session-updated` pre-forward check below; T04.5 builds the full
 * 23-event dispatch table (Spec 04 R9/R10).
 */
export function openGatewayLeg(opts: OpenGatewayLegOptions): GatewayLeg {
  const { mint, callSid, tools, formats, config, callbacks } = opts;

  const rt = gateway.experimental_realtime(config.modelId);
  const wsCfg = rt.getWebSocketConfig({ token: mint.token, url: mint.url });
  const gw = new WebSocket(wsCfg.url, wsCfg.protocols, gatewayWsOptions(config));

  const t0 = now();
  let opened = false;
  let terminal = false; // true once onOpenFailed or onClose has fired — enforces R5 mutual exclusivity
  let upgradeStatusCode: number | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  // R8/S6: when WAIT_FOR_SESSION_UPDATED, the greeting thunk waits here for the FIRST
  // 'session-updated' event (fired once from handleEvent below, then cleared).
  let pendingGreeting: (() => Promise<void>) | undefined;

  // Attach ALL listeners synchronously at construction — an unhandled 'error' crashes the
  // process and kills every concurrent call (findings/08 gotcha 10).
  gw.on('open', () => {
    opened = true;
    logEvent({
      level: 'info',
      message: 'gateway-open',
      event: 'gateway-open',
      callSid,
      sinceMintMs: ms(t0, now()), // Δ from leg construction (Spec 04 R13's "Δ from mint")
    });
    if (config.gatewayPingSeconds > 0) {
      // R12: diagnostics-only keepalive, never load-bearing. Started on 'open', cleared on 'close'.
      pingTimer = setInterval(() => {
        if (gw.readyState === WebSocket.OPEN) gw.ping();
      }, config.gatewayPingSeconds * 1000);
    }
    // R8: session-update MUST be the first client frame (gateway's 30-s first-message rule),
    // then the greeting response-create — back-to-back, ordering enforced by `await send(...)`
    // resolving before `greet()` is ever invoked. Fire-and-forget from this synchronous handler;
    // `onOpen` below fires once the frames are queued (GatewayLegCallbacks.onOpen doc comment).
    void sendFirstFrames();
    callbacks.onOpen();
  });

  gw.on('unexpected-response', (_req, res) => {
    // Non-101 handshake answer (bad/expired/reused vcst_ token, possibly concurrency rejection).
    // ws quirk NOT stated by findings/08's snippet: `EventEmitter.emit` reports "handled" as
    // soon as ANY 'unexpected-response' listener exists, which suppresses ws's own automatic
    // abortHandshake call — attaching this listener means WE must terminate the socket
    // ourselves, or the connection hangs open in CONNECTING state forever (verified against
    // ws@8.21.1 source, lib/websocket.js: `!websocket.emit('unexpected-response', ...)`).
    upgradeStatusCode = res.statusCode;
    logEvent({
      level: 'error',
      message: 'gateway-upgrade-refused',
      event: 'gateway-upgrade-refused',
      callSid,
      statusCode: res.statusCode,
    });
    if (!terminal) {
      terminal = true;
      callbacks.onOpenFailed({ statusCode: res.statusCode, message: `Unexpected server response: ${res.statusCode}` });
    }
    gw.terminate(); // triggers 'error' + 'close' for cleanup; both are no-ops now that terminal=true
  });

  gw.on('error', (err: Error) => {
    if (!opened && !terminal) {
      // Handshake timed out (no unexpected-response — e.g. a black-holed connect) before 'open'.
      terminal = true;
      callbacks.onOpenFailed({ statusCode: upgradeStatusCode, message: err.message });
      return;
    }
    if (opened && !terminal) {
      // 'error' after open: log only — teardown happens only in 'close', which always follows
      // (findings/08 error/close-code matrix).
      logEvent({ level: 'error', message: 'gateway-ws-error', event: 'gateway-ws-error', callSid, error: err.message });
    }
    // else: terminal already set (e.g. our own gw.terminate() cleanup above) — ignore.
  });

  gw.on('close', (code: number, reasonBuf: Buffer) => {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    const reason = reasonBuf.toString(); // reason is a Buffer (findings/08 gotcha 9) — decode before logging
    logEvent({ level: 'info', message: 'gateway-close', event: 'gateway-close', callSid, code, reason });
    if (!terminal) {
      terminal = true;
      callbacks.onClose({ code, reason });
    }
  });

  gw.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) return; // the gateway protocol is text JSON only
    let parsed: ServerEvent | ServerEvent[];
    try {
      parsed = rt.parseServerEvent(JSON.parse(data.toString())) as ServerEvent | ServerEvent[];
    } catch {
      logEvent({
        level: 'error',
        message: 'gateway-parse-error',
        event: 'gateway-parse-error',
        callSid,
        snippet: data.toString().slice(0, 200),
      });
      return;
    }
    // parseServerEvent may return ONE event or an ARRAY — handle both (findings/02 claim 4, S13).
    const events = Array.isArray(parsed) ? parsed : [parsed];
    if (Array.isArray(parsed)) {
      logEvent({ level: 'info', message: 'gateway-array-frame', event: 'gateway-array-frame', callSid, count: events.length });
    }
    for (const ev of events) handleEvent(ev);
  });

  function handleEvent(ev: ServerEvent): void {
    // Interim pre-forward check (T04.4 scope): T04.5 folds this into the full R9/R10 dispatch
    // table. `session-updated` is the only ground truth for the applied audio format/voice
    // (S1/S2/S8) — log `.raw` verbatim every time, and fire the deferred greeting (S6) on the
    // FIRST occurrence only.
    if (ev.type === 'session-updated') {
      logEvent({ level: 'info', message: 'session-updated', event: 'session-updated', callSid, raw: ev.raw });
      if (pendingGreeting) {
        const greet = pendingGreeting;
        pendingGreeting = undefined;
        void greet();
      }
    }
    // T04.3 scope ends here; T04.5 inserts the full R9/R10 dispatch table before this forward.
    callbacks.onEvent(ev);
  }

  async function send(ev: ClientEvent): Promise<void> {
    if (gw.readyState !== WebSocket.OPEN) return; // post-terminal / pre-open guard: silent no-op
    gw.send(JSON.stringify(await rt.serializeClientEvent(ev))); // ALWAYS await — typed unknown | PromiseLike<unknown>
  }

  /**
   * Spec 04 R8: on 'open', send `session-update` as the first frame, then the greeting
   * `response-create`. Ordering is normative — never `response-create` before `session-update`
   * (the model would answer in PCM16@24k default voice with no instructions, findings/04 D5).
   * `WAIT_FOR_SESSION_UPDATED` (S6 fallback) defers the greeting to the first `session-updated`
   * event instead of firing it immediately (still within the FR-1 2s greeting budget).
   */
  async function sendFirstFrames(): Promise<void> {
    await send({ type: 'session-update', config: buildCallSessionConfig(tools, formats, config) });
    logEvent({
      level: 'info',
      message: 'session-update sent',
      event: 'session-update-sent',
      callSid,
      audioMode: config.audioMode,
      voice: config.voice,
    });
    const greet = () => send({ type: 'response-create', options: { instructions: GREETING_INSTRUCTIONS } });
    if (config.waitForSessionUpdated) {
      pendingGreeting = greet; // fired on first 'session-updated' in handleEvent above
    } else {
      await greet();
    }
  }

  async function appendAudio(base64: string): Promise<void> {
    // One input-audio-append per call — never batch (Spec 04 R6; 256 KB cap rejects the message silently).
    await send({ type: 'input-audio-append', audio: base64 });
  }

  function close(code = 1000, reason = 'call ended'): void {
    if (gw.readyState === WebSocket.OPEN || gw.readyState === WebSocket.CONNECTING) {
      gw.close(code, reason);
    }
  }

  return {
    send,
    appendAudio,
    get isOpen() {
      return gw.readyState === WebSocket.OPEN;
    },
    close,
  };
}

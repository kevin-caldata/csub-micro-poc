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
import { logEvent, ms, now, safeRaw } from './logger.js';

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
 * `error` event benign-code whitelist (Spec 04 R10, S11). Populated after S11 pins real codes
 * observed through the gateway; starts EMPTY on purpose — never guess strings. Exported
 * (mutable `Set`) so a unit test can exercise the whitelist branch of `isBenignGatewayError`
 * without polluting production behavior (S11 policy: no guessed codes ship).
 */
export const BENIGN_ERROR_CODES = new Set<string>([]);

/**
 * Classifies an in-band `error` event as benign (Spec 04 R10, verbatim heuristic). Never used
 * to close the socket — policy is that NO in-band `error` event ever tears down the call from
 * this module (R11's `close` event is the sole FR-7 termination signal). Two paths to `true`:
 * (1) `ev.code` is a pinned member of `BENIGN_ERROR_CODES` (empty until S11), or (2) one of five
 * documented-benign message-substring classes [findings/04 V4, G3, G6; findings/04 §create-while-
 * active + Spec 07 R12]: cancel-with-no-active-response, truncate-out-of-range, an
 * `audio_end_ms` complaint, or a lost-race create-while-active complaint ("already has an active
 * response") — the exact shape Spec 07 R12's deferred-retry ToolLoop gate is designed to survive
 * when its own `response-create` loses a race against a VAD-auto response (findings review: this
 * substring previously matched none of the classes above, so a lost gate race classified as
 * non-benign and `session.ts` tore the call down mid-tool-answer instead of letting the deferred
 * retry engage).
 */
export function isBenignGatewayError(ev: Extract<ServerEvent, { type: 'error' }>): boolean {
  if (ev.code && BENIGN_ERROR_CODES.has(ev.code)) return true;
  const m = ev.message?.toLowerCase() ?? '';
  return (
    m.includes('no active response') ||
    (m.includes('cancel') && m.includes('response')) ||
    m.includes('audio_end_ms') ||
    m.includes('truncat') ||
    m.includes('already has an active response')
  );
}

/**
 * Narrow subclass check for the create-while-active substring specifically — Spec 07 R12's
 * lost-race recovery (`ToolLoop.onBenignCreateWhileActiveError`) must engage ONLY for this exact
 * benign shape, never for the other benign classes above (which have nothing to do with the
 * tool-loop gate). Kept as its own exported predicate rather than re-deriving the substring in
 * `session.ts` so there is exactly one place that string lives.
 */
export function isCreateWhileActiveError(ev: Extract<ServerEvent, { type: 'error' }>): boolean {
  const m = ev.message?.toLowerCase() ?? '';
  return m.includes('already has an active response');
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
  /**
   * Follow-up (post-T05.4): optional greeting-decomposition hooks (Spec 08 R7/A7) — fired from
   * the exact points this module's closure already handles the corresponding step, so Spec 05's
   * Session can feed `TurnRecorder`'s matching hooks without gateway.ts owning any recorder
   * state itself. All three are optional and optional-chained at every call site — omitting them
   * is zero behavior change (identical to before this addition).
   */
  /** Right after the `session-update` first frame is sent (Spec 04 R8). */
  onSessionUpdateSent?(): void;
  /** On the first `session-updated` server event (the same point `pendingGreeting`, if any, fires). */
  onSessionUpdated?(): void;
  /** Right after the greeting `response-create` is sent — both the immediate path and the
   *  `WAIT_FOR_SESSION_UPDATED`-deferred path funnel through this one call site. */
  onGreetingCreateSent?(): void;
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
 * RIO persona instructions (Demo Spec 01 R3, verbatim text, line-wraps unwrapped per R1).
 * MUST contain the G4 tool-preamble sentence verbatim — asserted at
 * test/gateway.session-config.test.ts:100-102 (session-update frame) and :124-128 (this
 * export directly). Neither assertion may ever be edited, weakened, or deleted (G4 HARD).
 * Exported so it is overridable later without touching `buildCallSessionConfig`.
 */
export const INSTRUCTIONS = `# Role & Objective
You are RIO ("REE-oh"), the Roadrunner Intelligent Operator - the AI phone operator for California State University, Bakersfield (CSUB), 9001 Stockdale Highway. You answer campus questions, look things up, and route callers to the right office. You always identify yourself as an AI assistant. This is a self-serve demonstration line: every lookup, verification, ticket, and transfer uses SIMULATED demo data. If a caller asks whether something is real, say plainly that it is simulated demo data.

# Personality & Tone
Warm, upbeat, and proud of CSUB and Kern County; concise and confident, never fawning. Keep each turn to two or three short sentences unless the caller asks for more. A light Roadrunner touch is welcome ("Welcome, 'Runner!") - used sparingly, at most once per call.

# Language
English is the default. If the caller explicitly asks for Spanish or speaks a substantive utterance in Spanish, continue the rest of the call in Spanish with the same persona. Never switch languages based on accent alone.

# Reference Pronunciations
- "CSUB" is spoken letter by letter: C-S-U-B (never "sub").
- "RIO" is pronounced "REE-oh".
- "Kern" rhymes with "turn".

# Tools
Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up'). Then call the tool without waiting for permission.

Your tools are: ask_campus_knowledge, route_call, escalate_to_human, verify_identity, reset_password, send_sms, get_current_time. Never mention or invent any other tool.

Eagerness rules:
- PROACTIVE (call as soon as intent is clear, no confirmation needed): ask_campus_knowledge, route_call, get_current_time.
- CONFIRMATION-FIRST (say what you are about to do and get a yes first): verify_identity, reset_password, send_sms.
- escalate_to_human: for crisis or safety concerns call it IMMEDIATELY with no confirmation; for ordinary frustration or a request for a human, confirm briefly ("I can connect you to a person - want me to do that?"), then call it.

When a tool returns a handoff blurb or scripted text, read it essentially verbatim. Never read raw JSON, field names, or error text aloud.

# Answering Policy (three lanes)
- CAMPUS FACTS (hours, locations, phone numbers, dates, deadlines, fees, how-to steps, events - anything about CSUB): NEVER answer campus facts from memory, even if you think you know. Say your one-line preamble, then call ask_campus_knowledge with one clear, self-contained question, and speak only what the tool returns.
- ACTIONS: use the static tools - route_call to transfer, escalate_to_human for crisis or a human handoff, verify_identity and reset_password for account help, send_sms to text a link, get_current_time for the current time. Do not use ask_campus_knowledge to transfer, escalate, or perform actions.
- DIRECT (no tool): greetings, small talk, clarifying questions, repeating or rephrasing something a tool already returned on this call, and describing what you can help with.
- If ask_campus_knowledge returns status "not_found": say you don't have that detail, then offer to connect the caller to the right department with route_call. Never invent an answer to fill the gap.
- If any tool returns an error: apologize briefly and offer to try once more or connect the caller to a person. Never read the error text aloud.

# Numbers & Codes
When reading numbers, IDs, or codes, speak each character separately and confirm: "Just to confirm, I heard 8... 3... 5... 2... Is that right?" Never ask for, or accept, a Duo verification code - if a caller starts reading one, stop them and remind them never to share Duo codes with anyone.

# Conversation Flow
1. After the greeting, let the caller state their need in their own words - never recite a menu of options.
2. If the caller sounds stressed, acknowledge it in one short empathic sentence before doing anything else.
3. Handle the request through the Answering Policy above, then ask one short follow-up ("Anything else I can help with?").
4. If the caller is silent or unclear, ask one clarifying question - do not guess.
5. Close warmly and briefly; "Go 'Runners!" is a fine sign-off for students.

# Safety & Escalation
If a caller expresses distress, hopelessness, self-harm, harm to others, or any safety emergency: respond with warmth in one sentence, then IMMEDIATELY call escalate_to_human with urgency "crisis" - no confirmation, and never use ask_campus_knowledge for this. Read the resource information the tool returns exactly as written; never improvise, alter, or abbreviate phone numbers. Only if the tool fails, speak these real resources directly: the CSUB Counseling Center at (661) 654-3366 (after hours, press 2 for a crisis counselor), the 988 Suicide & Crisis Lifeline (call or text 988, free, 24/7), and for immediate danger 911 or University Police at (661) 654-2111. These crisis resources are the only facts you may ever state without a tool. Never dead-end these callers and never treat the moment as routine.`;

/**
 * RIO AI-self-ID + simulated-data-disclosure greeting (Demo Spec 01 R11, verbatim text).
 * Per-response instruction override, no synthetic conversation items (findings/04 D5).
 * Module-private and not exported (R11) — the greeting mechanism itself
 * (`WAIT_FOR_SESSION_UPDATED` deferral, first-frames ordering) is untouched.
 */
const GREETING_INSTRUCTIONS =
  'Say exactly this greeting, then stop and listen: "Thanks for calling Cal State Bakersfield! ' +
  "This is RIO, the Roadrunner Intelligent Operator. I'm an AI assistant on a demo line - " +
  'everything I look up is simulated. I can help in English o en español - how can I help you today?"';

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
  // Spec 10 R10 (test-only): GATEWAY_WS_URL bypasses mintRealtimeToken/getWebSocketConfig
  // entirely — there is no token, so no auth subprotocol is offered (`protocols: []`) — and
  // opens a bare WS straight at the fake gateway's ws:// URL. `rt` is still constructed either
  // way for `serializeClientEvent`/`parseServerEvent` below (both pure identity, no I/O for the
  // gateway provider — findings/02 claim 3), so this branch touches nothing else in this
  // function. Production behavior (GATEWAY_WS_URL unset) is bit-identical to before this branch
  // existed: the untouched gateway unit-test suite (gateway.leg.test.ts et al.) proves it.
  let gw: WebSocket;
  if (config.gatewayWsUrl) {
    gw = new WebSocket(config.gatewayWsUrl, [], { perMessageDeflate: false });
  } else {
    const wsCfg = rt.getWebSocketConfig({ token: mint.token, url: mint.url });
    gw = new WebSocket(wsCfg.url, wsCfg.protocols, gatewayWsOptions(config));
  }

  const t0 = now();
  let opened = false;
  let terminal = false; // true once onOpenFailed or onClose has fired — enforces R5 mutual exclusivity
  let upgradeStatusCode: number | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  // R8/S6: when WAIT_FOR_SESSION_UPDATED, the greeting thunk waits here for the FIRST
  // 'session-updated' event (fired once from handleEvent below, then cleared).
  let pendingGreeting: (() => Promise<void>) | undefined;
  // Follow-up (Spec 08 R7): guards `callbacks.onSessionUpdated` to fire on the FIRST
  // 'session-updated' event only — the log line above it stays unconditional (existing
  // behavior, unchanged); only this new optional callback is one-shot.
  let sessionUpdatedNotified = false;
  // R10/findings/04 G8: per-leg (per-call) rate limiter for `custom` event logging — max 1
  // `gateway-custom` line per `rawType` per second per call (rate_limits.updated alone can
  // flood Railway's 500 lines/s cap in a 5-call test).
  const customLogTimestamps = new Map<string, number>();

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

  /** R10: rate-limits `gateway-custom` logging to max 1 line per `rawType` per second per call. */
  function shouldLogCustom(rawType: string): boolean {
    const nowMs = Date.now();
    const last = customLogTimestamps.get(rawType);
    if (last !== undefined && nowMs - last < 1000) return false;
    customLogTimestamps.set(rawType, nowMs);
    return true;
  }

  /**
   * Full 23-event server-event dispatch table (Spec 04 R9/R10, normative for Spec 05). Performs
   * module-level logging per event class, THEN forwards every event to `callbacks.onEvent` —
   * Spec 05 implements the "acts"; this module never mutates call state beyond the T04.4
   * `pendingGreeting` fire folded into `session-updated` below. The switch is exhaustive over
   * all 23 union members (Spec 04 R9); `default` is unreachable at compile time (pinned SDK
   * versions make drift impossible there) but still logs defensively — the wire belongs to the
   * gateway, not us.
   */
  function handleEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case 'session-created': {
        // R9 #1: log once, .raw verbatim (generation-id evidence, S31). No action.
        logEvent({
          level: 'info',
          message: 'gateway-session-created',
          event: 'gateway-session-created',
          callSid,
          sessionId: ev.sessionId,
          raw: safeRaw(ev.raw),
        });
        break;
      }
      case 'session-updated': {
        // R9 #2 (T04.4 scope, folded in here): `.raw` is the only ground truth for the applied
        // audio format/voice (S1/S2/S5/S8) — logged verbatim (kept as the raw object, matching
        // T04.4's existing test contract) every time. Act: fire the deferred greeting (S6) on
        // the FIRST occurrence only.
        logEvent({ level: 'info', message: 'session-updated', event: 'session-updated', callSid, raw: ev.raw });
        if (!sessionUpdatedNotified) {
          sessionUpdatedNotified = true;
          callbacks.onSessionUpdated?.(); // Spec 08 R7 greeting decomposition (follow-up)
        }
        if (pendingGreeting) {
          const greet = pendingGreeting;
          pendingGreeting = undefined;
          void greet();
        }
        break;
      }
      // R9 #3-4, 7-10, 14, 16-17, 21 — "act (Session)" rows: Spec 05 implements the acts; this
      // module performs NO logging for these (absent from R13's inventory) and forwards as-is.
      case 'speech-started':
      case 'speech-stopped':
      case 'response-created':
      case 'response-done':
      case 'output-item-added':
      case 'input-transcription-completed':
      case 'audio-delta':
      case 'audio-transcript-delta':
      case 'audio-transcript-done':
      case 'function-call-arguments-done':
        break;
      // R9 #5: audio-committed — ignore (debug log); informational only. Filtered out under the
      // default LOG_LEVEL=info (never surfaces as a warn/error line).
      case 'audio-committed':
        logEvent({
          level: 'debug',
          message: 'gateway-audio-committed',
          event: 'gateway-audio-committed',
          callSid,
          itemId: ev.itemId,
        });
        break;
      // R9 #18-19: text-delta/text-done — ignore (debug); only appear if text modality active
      // (not requested). Filtered out under the default LOG_LEVEL=info.
      case 'text-delta':
      case 'text-done':
        logEvent({
          level: 'debug',
          message: 'gateway-text-ignored',
          event: 'gateway-text-ignored',
          callSid,
          type: ev.type,
        });
        break;
      // R9 #6, 11-13, 15, 20 — consciously ignored, never warn (findings/02 correction 1,
      // gotcha 7): conversation-item-added, output-item-done, content-part-added,
      // content-part-done, audio-done, function-call-arguments-delta.
      case 'conversation-item-added':
      case 'output-item-done':
      case 'content-part-added':
      case 'content-part-done':
      case 'audio-done':
      case 'function-call-arguments-delta':
        break;
      case 'error': {
        // R9 #22 / R10: log every in-band error; NEVER close the socket or invoke onClose from
        // here (that is exclusively R11's `close` event). Benign (whitelist or heuristic) ->
        // info; everything else -> error. `.raw` verbatim via safeRaw (explicit-call convention).
        const benign = isBenignGatewayError(ev);
        logEvent({
          level: benign ? 'info' : 'error',
          message: ev.message,
          event: 'gateway-error-event',
          callSid,
          code: ev.code,
          raw: safeRaw(ev.raw),
        });
        break;
      }
      case 'custom': {
        // R9 #23 / R10: always conceptually logged, but rate-limited to max 1 line per rawType
        // per second per call (findings/04 G8) — forwarding below is UNAFFECTED by the limiter.
        if (shouldLogCustom(ev.rawType)) {
          logEvent({
            level: 'info',
            message: 'gateway-custom',
            event: 'gateway-custom',
            callSid,
            rawType: ev.rawType,
            raw: safeRaw(ev.raw),
          });
        }
        break;
      }
      default: {
        // Defensive default: the switch above is exhaustive over the typed 23-member union, so
        // `ev` narrows to `never` here at compile time — but the wire is the gateway's, and an
        // actually-unrecognized wire type must not crash the process.
        const _never: never = ev;
        const wireType = (_never as unknown as { type: string }).type;
        logEvent({
          level: 'error',
          message: 'gateway-unknown-event',
          event: 'gateway-unknown-event',
          callSid,
          type: wireType,
        });
        break;
      }
    }

    callbacks.onEvent(ev);

    // R10/A8 — S4 fallback matcher: the gateway may deliver caller-speech-start as a `custom`
    // event carrying the GA OpenAI wire name rather than a normalized `speech-started`
    // (findings/04 G10 — GA names only, never beta). Deliver a synthetic event on an IDENTICAL
    // path to the normalized case (#3) by re-entering this same function.
    if (ev.type === 'custom' && ev.rawType === 'input_audio_buffer.speech_started') {
      handleEvent({ type: 'speech-started', raw: ev.raw });
    }
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
    callbacks.onSessionUpdateSent?.(); // Spec 08 R7 greeting decomposition (follow-up)
    logEvent({
      level: 'info',
      message: 'session-update sent',
      event: 'session-update-sent',
      callSid,
      audioMode: config.audioMode,
      voice: config.voice,
    });
    // Both the immediate call below and the deferred `pendingGreeting` invocation in
    // handleEvent's 'session-updated' case funnel through this one closure, so
    // `onGreetingCreateSent` fires from a single call site regardless of path (Spec 08 R7).
    const greet = () =>
      send({ type: 'response-create', options: { instructions: GREETING_INSTRUCTIONS } }).then(() => {
        callbacks.onGreetingCreateSent?.();
      });
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

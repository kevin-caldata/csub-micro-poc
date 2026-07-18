---
# Spec 04 — Vercel AI Gateway Realtime WebSocket Leg (`gateway.ts`)
Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Draft for review
Depends on: 01 (scaffold / config.ts / logger.ts) · Enables: 05 (session bridge & barge-in), 07 (MCP tool loop), 08 (latency instrumentation)
Findings referenced: findings/01 (claims 1–20, Impl 1–3, 9–10, gotchas 1–15), findings/02 (full vendored protocol, corrections 1–11, gotchas 1–15), findings/04 (V5, V9, V11, V12, D1, D4, D5, D6, G3, G8), findings/06 (C2/C3, session-update snippets), findings/08 (V5, V12, gateway-client snippet, error/close matrix, gotchas 9–11), findings/09 (§3 greeting timestamps, open item 7), findings/10 (C1–C3, C7, C9, C10, C15, G3, T2, Part 4 spike list)
---

## Objective

When this spec is done, `src/gateway.ts` exists: a self-contained module that (a) mints a per-call gateway realtime token at webhook time via the **corrected** factory API, (b) opens and owns the `ws` client connection to `wss://ai-gateway.vercel.sh`, (c) sends the full `session-update` as the first frame plus the greeting `response-create`, (d) provides typed, forward-compatible send/receive helpers over the normalized AI SDK event protocol, and (e) normalizes error/close handling into a small callback surface the Session (Spec 05) consumes. It also normatively defines the full 23-event server-event dispatch table that Spec 05 implements against.

## Deliverables

- `src/gateway.ts` — new file; everything below.
- `src/config.ts` — modify: add/confirm the env keys in R2 (parsing + boot validation).
- `.env.example` — modify: add the same keys with defaults.

No other file is touched by this spec. `gateway.ts` must not import from `session.ts`, `twiml.ts`, `dsp.ts`, or `tools.ts` (tool definitions and audio-format objects are injected as parameters — see R5/R7/R8).

## Requirements

### R1 — Packages and imports (exact pins)

Use exactly these (already pinned by Spec 01; do not drift):

- `@ai-sdk/gateway` **4.0.23 exact** (`save-exact`). Never `@canary` (4.0.0-canary.107 is *older* than latest) [findings/01 claim 17, findings/02 claim 1]. Transitive `@ai-sdk/provider@4.0.3` is exact-pinned by the gateway package and supplies all types [findings/02 claim 2].
- `ws` **8.21.1 exact** (the resolution verified in findings/08 V2).
- No `ai`, no `@ai-sdk/react`, no `openai` package anywhere [findings/02 claim 13].

Import surface (verbatim names from findings/02 §Exported names):

```ts
import { gateway, GatewayError } from '@ai-sdk/gateway';
import WebSocket from 'ws';
import type {
  Experimental_RealtimeModelV4ClientEvent as ClientEvent,
  Experimental_RealtimeModelV4ServerEvent as ServerEvent,
  Experimental_RealtimeModelV4SessionConfig as SessionConfig,
  Experimental_RealtimeModelV4ToolDefinition as ToolDefinition,
} from '@ai-sdk/provider';
```

### R2 — Config keys (env, parsed and validated at boot in `config.ts`)

| Env var | Default | Type/range | Used for |
|---|---|---|---|
| `MODEL_ID` | `openai/gpt-realtime-2.1` | string | Model id. Fallback on connect failure is a **manual one-line env change** to `openai/gpt-realtime-2` — do NOT auto-fallback (keeps M1 measurements clean) [S7]. |
| `VOICE` | `marin` | string | `session-update.config.voice`. `marin` is **unverified** through the gateway [findings/10 G3, S8]; fallback strategy in R8. |
| `VOICE_FALLBACK` | `alloy` | string | Documented fallback value; operator sets `VOICE=alloy` if the M1 spike shows `marin` rejected. |
| `AUDIO_MODE` | `transcode` | `pcmu` \| `transcode` | Selects audio format objects (R8). |
| `VAD_SILENCE_MS` | `500` | int | `turnDetection.silenceDurationMs`. Tuning guidance: 400–450 for latency after M2 [findings/04 D6]. |
| `VAD_THRESHOLD` | `0.5` | float 0.0–1.0 | `turnDetection.threshold`. Raise to 0.6 on spurious barge-ins [findings/04 D6]. |
| `VAD_PREFIX_PADDING_MS` | `300` | int | `turnDetection.prefixPaddingMs`. |
| `TOKEN_TTL_SECONDS` | `600` | int | `getToken({ expiresAfterSeconds })`. Realtime default/max TTL undocumented [S15]; log returned `expiresAt`. |
| `GATEWAY_HANDSHAKE_TIMEOUT_MS` | `5000` | int | ws client `handshakeTimeout` — **no ws default**; unset would hang ~75–130 s of dead air [findings/08 gotcha 11, findings/10 C15]. |
| `GATEWAY_PING_SECONDS` | `0` (off) | int | Optional ws-protocol ping interval on the gateway leg (R12). |
| `WAIT_FOR_SESSION_UPDATED` | `false` | bool | S6 fallback: gate the greeting `response-create` on `session-updated` (costs ~1 RTT) if M1 shows out-of-order config application. |
| `GATEWAY_TAGS` | unset (off) | comma list | If set, adds `providerOptions: { gateway: { tags: [...] } }` to the session config for spend attribution — unverified for realtime [S32]; default off. |

Boot validation (Spec 01 owns `config.ts`, this spec adds the rule): **fail fast at boot if `AI_GATEWAY_API_KEY` is unset** — otherwise the SDK silently falls back to Vercel OIDC and fails late with a confusing `GatewayAuthenticationError` about `vc env pull` [findings/01 gotcha 5, findings/10 G2].

### R3 — Token mint: `mintRealtimeToken()` (webhook time, off the audio path)

Exact API — the BRD §5.2 sample is a **known bug (C1)**: `getToken` lives on the **factory object**, not the model instance; `rt.getToken(...)` throws `TypeError` [findings/01 claim 2]. Never copy BRD §5.2 or the broken ternary in findings/02's "canonical connect sequence" [findings/10 T1 — findings/01 Impl 1 is authoritative].

```ts
export interface MintResult {
  token: string;        // 'vcst_...' single-use client secret — never cache/reuse across sessions
  url: string;          // 'wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1'
  expiresAt?: number;   // unix seconds
  getTokenMs: number;   // wall-clock duration of the mint call
}

export async function mintRealtimeToken(modelId: string = config.modelId): Promise<MintResult> {
  const t0 = performance.now();
  const { token, url, expiresAt } = await gateway.experimental_realtime.getToken({
    model: modelId,                                  // required
    expiresAfterSeconds: config.tokenTtlSeconds,     // 600; renamed to `expiresIn` on the wire (SDK-internal)
  });
  const getTokenMs = Math.round(performance.now() - t0);
  log('info', 'get-token', { event: 'get-token', callSid, getTokenMs, expiresAt }); // Spec 08 R1 log() shape; per findings/09 §3 + open item 7
  return { token, url, expiresAt, getTokenMs };
}
```

Facts the implementation must respect [findings/01 claims 3–6, gotchas 2–3, 10; findings/02 claim 7–8]:
- The returned `url` is computed server-side inside `getToken`; the model id is percent-encoded (`%2F`). **Never build the URL by hand**; never string-compare against the unencoded form.
- `sessionConfig` passed to `getToken` is **intentionally ignored** by the gateway — do not pass it; session config goes over the WS (R8).
- The token is single-use: one `MintResult` feeds exactly one `GatewayLeg`; any reconnect requires a fresh mint. There is **no reconnect/resume logic in this PoC** (R11).
- Called from the `POST /twiml` handler (Spec 02/05 wiring) so the ~100 ms mint is off the audio path; `getTokenMs` must be logged per call because it gates the FR-1 2 s greeting budget [findings/09 §3].

**Error handling by `GatewayError` type** [findings/01 Impl 9]. Wrap in try/catch; classify and rethrow a typed error so the webhook handler can drive FR-7:

```ts
export class GatewayMintError extends Error {
  constructor(
    public readonly errorType:            // maps 1:1 to the SDK class / body error.type
      'authentication_error' | 'invalid_request_error' | 'rate_limit_exceeded' |
      'model_not_found' | 'internal_server_error' | 'failed_dependency' |
      'forbidden' | 'unknown',
    public readonly statusCode: number | undefined,
    public readonly getTokenMs: number,
    cause: unknown,
  ) { super(`gateway mint failed: ${errorType}`, { cause }); }
}
```

Classification rules: instanceof checks on the exported classes (`GatewayAuthenticationError`, `GatewayInvalidRequestError`, `GatewayRateLimitError`, `GatewayModelNotFoundError`, `GatewayInternalServerError`, `GatewayFailedDependencyError`, `GatewayForbiddenError`), else read `GatewayError.statusCode`, else `'unknown'`. Log one structured line `{ event: 'get-token-failed', errorType, statusCode, getTokenMs }`. A `rate_limit_exceeded` or early rejection here may be where the unpublished team concurrency limit manifests (mint vs WS-open is unknown — [S24]); both paths must reach FR-7 (the caller decides: apology TwiML at webhook time). `model_not_found` for `openai/gpt-realtime-2.1` → log a line explicitly saying "set MODEL_ID=openai/gpt-realtime-2" [S7].

### R4 — WS client construction

```ts
const rt = gateway.experimental_realtime(modelId);          // stateless identity codec instance
const cfg = rt.getWebSocketConfig({ token: mint.token, url: mint.url });
// cfg.url === mint.url (echoed); cfg.protocols === ['ai-gateway-realtime.v1', `ai-gateway-auth.${token}`]
const gw = new WebSocket(cfg.url, cfg.protocols, {
  perMessageDeflate: false,                    // ws CLIENT defaults ON — must disable [findings/08 V5, findings/10 C15]
  handshakeTimeout: config.gatewayHandshakeTimeoutMs,  // 5000; no default in ws [findings/08 gotcha 11]
  maxPayload: 16 * 1024 * 1024,                // >> gateway 256 KB message cap [findings/08 snippet]
});
```

- Auth rides exclusively in the subprotocols; no headers needed. A third `ai-gateway-team.<base64url>` protocol appears only with `createGateway({teamIdOrSlug})` — not used here (default `gateway` singleton) [findings/01 claim 7].
- Attach `open`, `message`, `error`, `close`, and `unexpected-response` listeners **synchronously at construction** — an unhandled `'error'` crashes the process and kills all concurrent calls [findings/08 gotcha 10].
- `unexpected-response` (non-101 upgrade: bad/expired/reused `vcst_` token, possibly concurrency rejection [S24]): log `{ event: 'gateway-upgrade-refused', statusCode: res.statusCode }` and capture the response body if small; `'error'` fires next with `Unexpected server response: <status>` and `'open'` never fires [findings/08 V12, findings/01 Impl 10].
- `handshakeTimeout` expiry surfaces as `'error'` — treat identically to upgrade-refused (FR-7 path via `onOpenFailed`, R11).

### R5 — Public module interface

```ts
export interface GatewayLegCallbacks {
  onOpen(): void;                                            // WS open; session-update already queued (R8)
  onOpenFailed(info: { statusCode?: number; message: string }): void;  // handshake refused/timeout → FR-7
  onEvent(ev: ServerEvent): void;          // every normalized event, post module-level logging (R9/R10)
  onClose(info: { code: number; reason: string }): void;     // ALWAYS terminal for the call (R11)
}

export interface OpenGatewayLegOptions {
  mint: MintResult;
  callSid: string;                         // for structured log lines
  tools: ToolDefinition[];                 // from MCP listTools, already mapped by Spec 07
  formats: { inputAudioFormat: Record<string, unknown>; outputAudioFormat: Record<string, unknown> };
                                           // from Spec 06's audioFormatsFor(config.audioMode), injected by
                                           // Spec 05 like `tools` — gateway.ts never hand-builds format objects
  callbacks: GatewayLegCallbacks;
}

export function openGatewayLeg(opts: OpenGatewayLegOptions): GatewayLeg;

export interface GatewayLeg {
  send(ev: ClientEvent): Promise<void>;    // R6 helper — Session uses this for truncate/item-create/response-create
  appendAudio(base64: string): Promise<void>; // hot path: send({type:'input-audio-append', audio}) with OPEN guard
  readonly isOpen: boolean;                // gw.readyState === WebSocket.OPEN
  close(code?: number, reason?: string): void;  // default close(1000, 'call ended')
}
```

Lifecycle contract: one `GatewayLeg` per call; `onOpenFailed` and `onClose` are mutually exclusive terminal signals; after either, all `send` calls are silent no-ops (guarded, logged at debug once). `'error'` after open is logged (`{ event: 'gateway-ws-error', message }`) but teardown happens only in `'close'`, which always follows [findings/08 error matrix].

### R6 — Typed send/receive helpers (forward-compat rules)

Both codec calls are identity for the gateway **today** but are `experimental_` and sanctioned to change in patch releases — keep the ceremony [findings/01 claim 15, gotcha 15; findings/02 claims 3–5]:

```ts
// send: ALWAYS await serializeClientEvent (typed unknown | PromiseLike<unknown>)
async function send(ev: ClientEvent): Promise<void> {
  if (gw.readyState !== WebSocket.OPEN) return;
  gw.send(JSON.stringify(await rt.serializeClientEvent(ev)));
}

// receive: parseServerEvent may return ONE event or an ARRAY — handle both [findings/02 claim 4, S13]
gw.on('message', (data) => {
  let parsed: ServerEvent | ServerEvent[];
  try { parsed = rt.parseServerEvent(JSON.parse(data.toString())) as any; }
  catch (e) { log('error', 'gateway parse error', { event: 'gateway-parse-error', callSid, snippet: data.toString().slice(0, 200) }); return; }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  if (Array.isArray(parsed)) log('info', 'gateway array frame', { event: 'gateway-array-frame', callSid, count: events.length }); // S13 evidence
  for (const ev of events) handleEvent(ev);   // R9/R10 then callbacks.onEvent(ev)
});
```

Never batch audio frames into one message: one `input-audio-append` per Twilio media frame (a 20 ms μ-law frame is ~214 B base64; the 256 KB cap rejects the *message* silently, not the session) [findings/01 gotcha 8].

### R7 — Tools input

`openGatewayLeg` receives `tools: ToolDefinition[]` fully formed (`{type:'function', name, description?, parameters: JSONSchema7}`) from Spec 07's per-call `fetchToolDefs()` mapping (which strips `$schema` and selects fields explicitly per findings/10 C11). `gateway.ts` passes the array through into `session-update.config.tools` verbatim and performs no schema manipulation. This preserves FR-5 (add a tool = zero bridge changes).

### R8 — First message: `session-update` with the full config, then the greeting `response-create`

On `'open'`, send `session-update` as the **first frame** — this satisfies the gateway's 30-s first-client-message rule [findings/01 claim 8/§7]. Then send the greeting `response-create`. Both from within the `'open'` handler, back-to-back; client events are applied in order on the OpenAI side and the reference implementation relies on this — through the gateway it is spike **S6**; if M1 shows the greeting arriving with default format/voice, set `WAIT_FOR_SESSION_UPDATED=true`, which defers the `response-create` until the first `session-updated` event (~1 RTT, still inside the 2 s FR-1 budget) [findings/04 V11, D5, O3].

```ts
function buildCallSessionConfig(tools: ToolDefinition[], formats: OpenGatewayLegOptions['formats']): SessionConfig {
  // `formats` comes from Spec 06's audioFormatsFor(config.audioMode) — the single source of format objects:
  //   pcmu:      { type: 'audio/pcmu' }              // NO rate key — G.711 is fixed 8 kHz; GA schema
  //                                                  // defines no rate on pcmu [findings/06 C2, findings/10 C8; S3]
  //   transcode: { type: 'audio/pcm', rate: 24000 }  // 24000 is the ONLY supported PCM rate [findings/06 C2]
  return {
    instructions: INSTRUCTIONS,                    // below
    voice: config.voice,                           // 'marin' default; S8 unverified — see fallback note
    ...formats,                                    // spreads inputAudioFormat + outputAudioFormat (Spec 06 R2)
    inputAudioTranscription: {},                   // {} valid, all fields optional [findings/02 correction 6]
    turnDetection: {
      type: 'server-vad',
      silenceDurationMs: config.vadSilenceMs,      // 500
      threshold: config.vadThreshold,              // 0.5
      prefixPaddingMs: config.vadPrefixPaddingMs,  // 300
    },
    tools,
    ...(config.gatewayTags
      ? { providerOptions: { gateway: { tags: config.gatewayTags } } }   // S32; default off
      : {}),
  };
}
```

- **Instructions** (exported constant `INSTRUCTIONS` in `gateway.ts`, overridable later): a short assistant persona for a phone call, and it MUST contain the BRD §5.7 tool preamble verbatim: *"Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."* Default full text: `"You are a friendly, concise voice assistant on a phone call. Keep answers short and conversational — one to three sentences. Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."`
- **`turnDetection` limits**: the normalized shape cannot express `create_response` / `interrupt_response` / `idle_timeout_ms`; the design relies on OpenAI defaults (both `true`), which is exactly what barge-in needs [findings/04 V12, findings/10 C10]. Do not attempt `providerOptions` for these (root-level merge clobbers the whole `audio` subtree in the public codec; unverified through the gateway — S10).
- **Voice fallback strategy (boot-config, per S8):** the value is fixed at boot from `VOICE` (default `marin`). No runtime auto-retry. If, during M1, `session-updated.raw` shows the voice was not applied or an `error` event references the voice, the log line makes it obvious and the operator redeploys with `VOICE=alloy` (`VOICE_FALLBACK` documents the known-good value). To make the check trivial, the `session-updated` log line (R10) must always include the full `.raw` verbatim.
- **`outputModalities`**: omit (provider default). Model-speech transcripts arrive via `audio-transcript-delta/done` regardless.
- **Greeting** — variant 1 from findings/04 D5 (per-response instruction override; no synthetic conversation items):

```ts
await send({ type: 'session-update', config: buildCallSessionConfig(opts.tools, opts.formats) });
log('info', 'session-update sent', { event: 'session-update-sent', callSid, audioMode: config.audioMode, voice: config.voice });
const greet = () => send({
  type: 'response-create',
  options: { instructions: 'Greet the caller warmly in one short sentence and ask how you can help.' },
});
if (config.waitForSessionUpdated) pendingGreeting = greet;   // fired on first 'session-updated' (S6 fallback)
else await greet();
```

Do NOT send `response-create` before `session-update` (the model would answer in PCM16@24k default voice with no instructions) [findings/04 D5]. Never send `input-audio-commit` under server-vad [findings/02 client-event union].

### R9 — Full server-event dispatch table (normative for Spec 05)

`gateway.ts` performs the module-level logging below, then forwards **every** event to `callbacks.onEvent`. Spec 05 implements the "acts" column. The union has exactly 23 members [findings/02 §Server → client events]; the switch must be exhaustive (a `default` branch is unreachable for typed input but must still log `{ event: 'gateway-unknown-event', type }` defensively — pinned versions make drift impossible at compile time, but the wire is the gateway's).

| # | Event type | Disposition | Detail |
|---|---|---|---|
| 1 | `session-created` | **log** | `{ event: 'gateway-session-created', callSid, sessionId, raw }` — `.raw` verbatim once (generation-id evidence, S31). No action. |
| 2 | `session-updated` | **log + act** | `{ event: 'session-updated', callSid, raw }` — `.raw` **verbatim**; this is the only ground truth for the applied audio format and voice [findings/01 gotcha 11; S1, S2, S5, S8]. Act: if `WAIT_FOR_SESSION_UPDATED`, fire `pendingGreeting`. |
| 3 | `speech-started` | **act** (Session) | Barge-in trigger — forwarded; Spec 05 runs the corrected §5.6 sequence (C2/C3 fixes, findings/04 D4). |
| 4 | `speech-stopped` | **act** (Session) | Instrumentation `tSpeechStopped` anchor (FR-6). Forwarded. |
| 5 | `audio-committed` | **ignore** (debug log) | Server-vad committed the buffer; informational. |
| 6 | `conversation-item-added` | **ignore** | Consciously ignored — never warn [findings/02 correction 1, gotcha 7]. |
| 7 | `input-transcription-completed` | **act** (Session) | `{itemId, transcript}` (itemId is required, C9) — caller transcript log line (M2). |
| 8 | `response-created` | **act** (Session) | New response epoch: reset `responseStartTimestamp` etc. (C2 stale-epoch fix — Spec 05). |
| 9 | `response-done` | **act** (Session) | `{responseId, status}`; `status` is a plain string — match defensively, log the value (`cancelled` after barge-in is normal) [findings/02 gotcha 6; S12]. Gates the tool-loop `response-create` (Spec 07). |
| 10 | `output-item-added` | **act** (Session) | Capture `itemId` → `lastAssistantItemId` for truncate. |
| 11 | `output-item-done` | **ignore** | — |
| 12 | `content-part-added` | **ignore** | — |
| 13 | `content-part-done` | **ignore** | — |
| 14 | `audio-delta` | **act** (Session) | `{responseId, itemId, delta}` — forward to Twilio **immediately**, never wait for `audio-done`; also re-arms barge-in epoch + mark queue (Spec 05). |
| 15 | `audio-done` | **ignore** | — |
| 16 | `audio-transcript-delta` | **act** (Session) | Accumulate model-speech transcript. |
| 17 | `audio-transcript-done` | **act** (Session) | Log completed model transcript (M2). |
| 18 | `text-delta` | **ignore** (debug) | Only appears if text modality active; not requested. |
| 19 | `text-done` | **ignore** (debug) | — |
| 20 | `function-call-arguments-delta` | **ignore** | Only `-done` matters [findings/02 correction 1]. |
| 21 | `function-call-arguments-done` | **act** (Session→Spec 07) | `{callId, name, arguments: JSON-string}` → tool loop. |
| 22 | `error` | **log + classify** | R10 whitelist. **Never** terminates the call from `gateway.ts`. |
| 23 | `custom` | **always log** | R10. Includes the S4 `speech-started` fallback matcher. |

### R10 — `error` and `custom` event policy

**`error` events (in-band):** log every one as `{ event: 'gateway-error-event', callSid, message: ev.message, code: ev.code, raw: ev.raw }` with `.raw` verbatim — the exact `code` strings through the gateway are unknown until M1/M2 pins them [S11]. Classification:

```ts
// Populated after S11 pins real codes; starts EMPTY on purpose — no guessed strings.
const BENIGN_ERROR_CODES = new Set<string>([]);

export function isBenignGatewayError(ev: Extract<ServerEvent, {type:'error'}>): boolean {
  if (ev.code && BENIGN_ERROR_CODES.has(ev.code)) return true;
  // Heuristic until S11 lands: cancel-with-no-active-response and truncate-out-of-range are
  // documented-benign classes [findings/04 V4, G3, G6] — match on message substrings:
  const m = ev.message?.toLowerCase() ?? '';
  return m.includes('no active response') || m.includes('cancel') && m.includes('response')
      || m.includes('audio_end_ms') || m.includes('truncat');
}
```

Policy (design decision): **no in-band `error` event ever tears down the call from this module.** Benign → `level: 'info'`; unknown → `level: 'error'`; either way the session continues and FR-7 termination is driven solely by the WS `close` event (R11). Rationale: `response.cancel` with no active response and truncate races are explicitly session-safe [findings/04 V4, G6], and killing a live call on an unrecognized-but-harmless error is the worse failure mode for a PoC whose deliverable is the logs. After S11, move pinned codes into `BENIGN_ERROR_CODES` and delete the substring heuristic.

**`custom` events:** always log `{ event: 'gateway-custom', callSid, rawType: ev.rawType, raw: ev.raw }` — but rate-limited to **max 1 line per `rawType` per second per call** (`rate_limits.updated` alone can flood Railway's 500 lines/s cap in a 5-call test) [findings/04 G8]. Two rawTypes get special handling:
- `input_audio_buffer.speech_started` → forward to Session as a synthetic barge-in trigger (identical path to event #3) — the S4 fallback matcher; GA wire names only, never beta names [findings/04 V9, G10].
- `conversation.item.truncated` → log at info (truncate ack; the M2 evidence that barge-in memory alignment worked, S9).

### R11 — Close handling: every close is call-ending

```ts
gw.on('close', (code: number, reason: Buffer) => {
  clearInterval(pingTimer);
  log('info', 'gateway close', { event: 'gateway-close', callSid, code, reason: reason.toString() });  // reason is a Buffer [findings/08 gotcha 9]
  callbacks.onClose({ code, reason: reason.toString() });
});
```

- Log `code`/`reason` **verbatim on every close** — the gateway's close-code vocabulary (25-min cap, 5-min idle, 30-s no-first-message, concurrency rejection, expired/reused token) is undocumented and must be recorded empirically [findings/01 Impl 10, S14]. Expect 1000/1001 normal-ish, 1006/1011/4xxx abnormal [findings/08 close matrix].
- **No session resume, no reconnect**: reconnecting never resumes a gateway session and the `vcst_` token is single-use [findings/01 claims 10, gotcha 10]. Design decision: any gateway close while the Twilio leg is up is terminal for the call — `onClose` fires and Spec 05 runs the FR-7 path (spoken fallback or clean hangup, never dead air; mechanism per findings/10 G4 is Spec 09's decision, plugged in via Spec 05's `onGatewayFailure` hook).
- `close(code = 1000, reason = 'call ended')` is the normal-teardown API the Session calls on Twilio `stop`.

### R12 — Keepalive (optional, never load-bearing)

If `GATEWAY_PING_SECONDS > 0`, run `setInterval(() => gw.ping(), GATEWAY_PING_SECONDS * 1000)` started on `'open'`, cleared on `'close'`. Default **off**: during calls, 20 ms media frames keep the connection busy in both directions, and no SDK-level health-check protocol exists (`getHealthCheckResponse` is absent on the gateway model) [findings/02 gotcha 9, findings/10 T2]. It is **unknown whether transport-level pings count against the gateway's 5-min idle timer** [S23] — therefore nothing in the bridge may *rely* on pings to hold an audio-silent session open; they are diagnostics only.

### R13 — Structured log events emitted by this module (flat fields, one line per event, never per frame)

`get-token`, `get-token-failed`, `gateway-open` (with Δ from mint), `gateway-upgrade-refused`, `gateway-ws-error`, `session-update-sent`, `gateway-session-created`, `session-updated`, `gateway-error-event`, `gateway-custom`, `gateway-array-frame`, `gateway-parse-error`, `gateway-close`. All lines carry `callSid`. Per-`audio-delta` / per-`input-audio-append` logging is forbidden (Railway 500 lines/s cap); frame-level instrumentation belongs to Spec 08's aggregated turn lines [findings/09].

## Acceptance criteria

- A1 — `mintRealtimeToken` calls `gateway.experimental_realtime.getToken({model, expiresAfterSeconds})` (factory form). A unit test stubbing `gateway.experimental_realtime` asserts the factory function object's `getToken` was invoked; nothing in the repo calls `.getToken` on a model instance or copies BRD §5.2 (grep for `rt.getToken` finds zero hits). [C1]
- A2 — The gateway WS is constructed with `perMessageDeflate: false` and `handshakeTimeout: 5000` (default config), verified by unit test against a recorded options object. [C15]
- A3 — Against a local mock ws server (vitest, **node environment — never jsdom**, per findings/10 G6 and findings/01 gotcha 6): the **first frame received** after upgrade is a valid `session-update` whose config contains `instructions` (including the exact tool-preamble sentence), `voice`, `turnDetection {type:'server-vad', silenceDurationMs:500, threshold:0.5, prefixPaddingMs:300}`, `inputAudioTranscription: {}`, and the injected `tools` array verbatim; the **second frame** is `response-create` with `options.instructions` non-empty. (Enables BRD FR-1 / M1, M2 greeting.)
- A4 — With `AUDIO_MODE=pcmu`, both format objects in the sent `session-update` (injected via `opts.formats` from Spec 06's `audioFormatsFor`) are exactly `{"type":"audio/pcmu"}` with **no `rate` key present** (assert `'rate' in obj === false`); with `AUDIO_MODE=transcode`, exactly `{"type":"audio/pcm","rate":24000}`. [findings/06 C2, C8]
- A5 — With `WAIT_FOR_SESSION_UPDATED=true`, `response-create` is not sent until a `session-updated` event has been delivered; with `false` (default), it is sent immediately after `session-update`. [S6]
- A6 — The receive path handles both a single JSON event and a JSON array frame: mock server sends `[{type:'response-created',...},{type:'audio-delta',...}]` in one frame → `onEvent` fires twice in order and a `gateway-array-frame` log line is emitted. [findings/02 claim 4, S13]
- A7 — The event switch covers all 23 union members: `#6, 11, 12, 13, 15, 18, 19, 20` produce no warn/error log lines (silent or debug only); every event reaches `callbacks.onEvent`. Compile-time exhaustiveness enforced (no `default`-only catchall for typed members).
- A8 — A `custom` event with `rawType:'input_audio_buffer.speech_started'` reaches the Session identically to a normalized `speech-started` (S4 fallback); a `custom` with any rawType is logged with `rawType` and `.raw`; 100 identical `custom` events within 1 s produce ≤2 log lines (rate limit). [findings/04 G8]
- A9 — An in-band `error` event never closes the socket or invokes `onClose` (test: mock sends `error` then `audio-delta`; the delta still arrives). Benign-matching errors log at info; others at error, with `.raw` present. [S11 policy]
- A10 — On socket close, `onClose` receives the numeric code and the reason **string** (Buffer decoded), and a `gateway-close` line with both verbatim is logged; on a non-101 upgrade response, `onOpenFailed` fires with the HTTP status and `onClose` does not. (BRD FR-7 kill-test hook; S14 evidence.)
- A11 — `getTokenMs` and `expiresAt` are logged for every successful mint; `GatewayMintError` carries `errorType` + `statusCode` for every failure class in the findings/01 §9 table (parameterized unit test over mocked responses). [FR-6/FR-7, S15, S24]
- A12 — With `GATEWAY_PING_SECONDS=0` (default) no ping timer is created; with `25`, pings are sent every 25 s and the timer is cleared on close. [T2]
- A13 — `package.json` pins `@ai-sdk/gateway` at exactly `4.0.23` and `ws` at exactly `8.21.1`; no `openai`, `ai`, or `@ai-sdk/react` dependency exists. (BRD §5.1 as corrected.)

## Out of scope

- The Twilio Media Streams leg, TwiML, and webhook signature validation (Spec 02/03).
- The Session state machine, barge-in sequence, mark-queue accounting (Spec 05), and the FR-7 spoken-fallback mechanism choice (Spec 09, wired via Spec 05 — this module only signals via `onOpenFailed`/`onClose`).
- DSP / transcoding (Spec 06): `appendAudio` receives already-encoded base64 for the configured mode; the format objects arrive pre-built via `opts.formats` (Spec 06 `audioFormatsFor`).
- MCP server and client, tool schema mapping, and the tool-loop `response-create` gate (Spec 07).
- Latency turn-level aggregation (Spec 08) and the M5 findings report (Spec 10).
- Reconnect/resume logic — deliberately nonexistent (R11).
- `semantic-vad`, `idle_timeout_ms`, `providerOptions` OpenAI-session escape hatches (S10 — not built).

## Open items deferred to runtime spikes (findings/10 Part 4)

- **S1/S2/S3** — pcmu honored end-to-end; default output really PCM16@24k; behavior if `rate` accompanies pcmu. R8 omits `rate`; R10's verbatim `session-updated.raw` log is the observation instrument.
- **S4** — `speech-started` normalized vs `custom`; both paths implemented (R9 #3, R10).
- **S5** — `.raw` passthrough shape (esp. `session-updated.raw`); logged verbatim.
- **S6** — in-order `session-update` → `response-create` through the gateway; `WAIT_FOR_SESSION_UPDATED` flag is the fallback.
- **S7** — `gpt-realtime-2.1` connect acceptance; manual env fallback to `openai/gpt-realtime-2`.
- **S8** — `VOICE=marin` validity; boot-config fallback `alloy` per R8.
- **S11** — exact benign error `code` strings; `BENIGN_ERROR_CODES` starts empty, heuristic removed after pinning.
- **S12** — observed `response-done.status` values (logged, matched defensively).
- **S13** — whether the gateway ever sends array frames (handled + logged regardless).
- **S14** — WS close-code vocabulary (logged verbatim on every close).
- **S15** — realtime token TTL semantics and `getTokenMs` distribution (logged per call).
- **S16** — `response-created`-before-first-`audio-delta` ordering (Spec 05/08 consume; this module preserves wire order).
- **S23** — whether ws-protocol pings hold the 5-min idle timer; R12 pings are diagnostics-only.
- **S24** — where concurrency rejection manifests (mint vs WS-open); both paths instrumented (R3, R4).
- **S31/S32** — generation IDs in `session-created.raw` (logged); `providerOptions.gateway.tags` honored for realtime (off by default behind `GATEWAY_TAGS`).

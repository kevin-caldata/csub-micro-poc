# Findings 01 — Vercel AI Gateway Realtime API Surface & Constraints

**Date:** 2026-07-18
**Scope:** Independent verification and deepening of BRD §3 (gateway constraints), §5.1 (package pins), §5.2 (gateway connection), §5.3 (event protocol), plus model availability/pricing, auth, error codes, and observability. Evidence gathered from: the published `@ai-sdk/gateway@4.0.23` and `@ai-sdk/provider@4.0.3` tarballs (installed and read locally), the live `https://ai-gateway.vercel.sh/v1/models` endpoint (fetched 2026-07-18), and official Vercel docs (fetched 2026-07-18).

Local evidence tree (installed from npm, exact pins):
`scratchpad/gw/node_modules/@ai-sdk/gateway/dist/index.js` (+ `.d.ts`) and `scratchpad/gw/node_modules/@ai-sdk/provider/dist/index.d.ts` under `C:\Users\kevin\AppData\Local\Temp\claude\D--projects-linean-CSUB-RIO-POC\2b673856-d2e2-4653-a80a-85f159b53749\scratchpad\`.

---

## Verified claims

| # | Claim (BRD) | Verdict | Evidence |
|---|---|---|---|
| 1 | `gateway.experimental_realtime(model)` exists in **stable** `@ai-sdk/gateway@4.0.23` (`latest`) | **VERIFIED** | `dist/index.js` line 2912: `provider.experimental_realtime = Object.assign((modelId) => createRealtimeModel(modelId), { getToken: ... })`. Installed cleanly from npm; dist-tag `latest = 4.0.23` (published 2026-07-17). |
| 2 | BRD §5.2 code: `const rt = gateway.experimental_realtime(MODEL); await rt.getToken({...})` | **WRONG — BRD code bug** | `getToken` lives on the **factory function object** (`gateway.experimental_realtime.getToken`), NOT on the model instance. The model instance (`GatewayRealtimeModel`) exposes only `doCreateClientSecret`, `getWebSocketConfig`, `parseServerEvent`, `serializeClientEvent`, `buildSessionConfig` (dist/index.js 2236–2283; `RealtimeFactoryV4` interface in `@ai-sdk/provider/dist/index.d.ts` 6862–6865). Calling `rt.getToken(...)` throws `TypeError: rt.getToken is not a function`. Correct call: `await gateway.experimental_realtime.getToken({ model: MODEL, expiresAfterSeconds: 600 })`. All official docs use this form. |
| 3 | `getToken({model, expiresAfterSeconds})` → `{token, url}` | **VERIFIED** (plus optional `expiresAt`) | `RealtimeFactoryV4GetTokenResult = { token: string; url: string; expiresAt?: number }` (provider d.ts 6857–6861). `expiresAt` is unix **seconds**. Options type: `{ model: string } & { expiresAfterSeconds?: number; sessionConfig?: RealtimeModelV4SessionConfig }` (6854–6856, 6512–6522). |
| 4 | Token is a single-use, short-lived `vcst_` client secret minted via `POST /v1/realtime/client-secrets` | **VERIFIED** | Source JSDoc (dist/index.js 2243–2252): "Mints a single-use, short-lived client secret (`vcst_`)…". Mint endpoint: `new URL("/v1/realtime/client-secrets", baseURL)` → `https://ai-gateway.vercel.sh/v1/realtime/client-secrets` (line 2687). Docs confirm "single-use, short-lived client secret" (realtime modality page). Note: this endpoint is **not** in the public REST API reference — SDK-internal surface. |
| 5 | `sessionConfig` passed to `getToken` is intentionally ignored | **VERIFIED** | Source JSDoc line 2250: "`sessionConfig` is intentionally unused here — it is applied later via the normalized `session-update` event." `doCreateClientSecret` forwards only `expiresAfterSeconds` (2253–2259). Session config MUST go over the WS as the first `session-update`. |
| 6 | `getWebSocketConfig` → `wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=...` | **VERIFIED** (with encoding nuance) | Default `baseURL = "https://ai-gateway.vercel.sh/v4/ai"` (line 2648); `toGatewayRealtimeUrl` replaces `http`→`ws` and appends `/realtime-model` with `url.searchParams.set("ai-model-id", modelId)` (2284–2288). Because `URLSearchParams` percent-encodes `/`, the actual URL is `wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1`. Note: the URL is computed **server-side inside `getToken`** and returned; `getWebSocketConfig({token, url})` just echoes the url and builds protocols (2266–2273). |
| 7 | Protocols `['ai-gateway-realtime.v1', 'ai-gateway-auth.<vcst_token>']` | **VERIFIED** | Constants at dist/index.js 2–4; `buildGatewayProtocols` (16–24). A third subprotocol `ai-gateway-team.<base64url(teamIdOrSlug)>` is appended only if the provider was created with `teamIdOrSlug` (default `gateway` singleton: none). |
| 8 | 25-min max session / 5-min idle / first client message within 30 s / 256 KB max message | **VERIFIED** | Official docs, Session limits table (vercel.com/docs/ai-gateway/modalities/realtime, last_updated 2026-06-20). Exceed behavior: 25-min → "closes gracefully"; idle → closes; no first message in 30 s → closes; >256 KB → "The message is rejected" (message, not session). |
| 9 | Team concurrent-session limit exists but number is unpublished | **VERIFIED (unpublished)** | Docs: "Teams also have a limit on concurrent realtime sessions. Additional connection attempts beyond the limit are rejected until a session ends." No number anywhere in docs, blog, or changelog. Web search found nothing. BRD M4 empirical plan stands. |
| 10 | Reconnect does NOT resume a session | **VERIFIED** | Docs Limitations: "Reconnecting does not resume a previous session. Start a new session and replay any context you need." Also: image input not supported in realtime sessions. |
| 11 | `openai/gpt-realtime-2.1` is live on the gateway | **VERIFIED** | Live `GET https://ai-gateway.vercel.sh/v1/models` (2026-07-18, 302 models): `openai/gpt-realtime-2.1` present, `"type": "realtime"`, `context_window: 128000`, `max_tokens: 32000`, released epoch 1783555200. Also in the typed union `GatewayRealtimeModelId` in gateway d.ts line 74: `'openai/gpt-realtime-1.5' | 'openai/gpt-realtime-2' | 'openai/gpt-realtime-2.1' | 'openai/gpt-realtime-mini' | 'xai/grok-voice-think-fast-1.0' | (string & {})`. |
| 12 | Pricing $4/M input, $24/M output, $0.40/M cached; no audio-specific rate | **VERIFIED** | Live models JSON for `openai/gpt-realtime-2.1`: `"pricing": {"input":"0.000004","output":"0.000024","input_cache_read":"0.0000004","web_search":"10"}` (per-token USD strings → $4/M, $24/M, $0.40/M). **No audio-token field exists in the pricing schema** — the models API has no way to express OpenAI's higher audio-token rates. Open question stands (see below). No-markup pass-through confirmed by docs/changelog ("no markup or platform fees"). |
| 13 | `gpt-realtime-2.1` lacks the `websocket-realtime` tag while `gpt-realtime-2` has it | **VERIFIED** | Live models JSON: `gpt-realtime-2` has `"tags":["websocket-realtime"]`; `gpt-realtime-2.1` has **no** `tags` field at all. Likely metadata lag (2.1 is typed in the SDK's realtime model-id union and is `type:"realtime"`), but the BRD's one-connect-attempt-then-fallback plan at M1 is the right hedge. |
| 14 | `AI_GATEWAY_API_KEY` env var auth | **VERIFIED** | `getGatewayAuthToken` (dist/index.js 2935–2951): `options.apiKey` else env `AI_GATEWAY_API_KEY` → `{token, authMethod:'api-key'}`; **falls back to Vercel OIDC** (`getVercelOidcToken()` from `@vercel/oidc`) if neither present — on Railway that fallback throws, surfaced as `GatewayAuthenticationError` with a contextual message. Mint request headers: `Authorization: Bearer <key>`, `ai-gateway-protocol-version: 0.0.1`, `ai-gateway-auth-method: api-key`, UA suffix `ai-sdk/gateway/4.0.23`. |
| 15 | Wire format is the normalized AI SDK protocol (identity codec); `parseServerEvent` may return an array; `serializeClientEvent` possibly async | **VERIFIED** | Gateway impl: `parseServerEvent(raw){ return raw; }`, `serializeClientEvent(event){ return event; }`, `buildSessionConfig(config){ return config; }` (2274–2282) — pure identity; the JSON on the wire IS the normalized protocol, translation happens gateway-side. Interface types allow `RealtimeModelV4ServerEvent | RealtimeModelV4ServerEvent[]` and `unknown \| PromiseLike<unknown>` (provider d.ts 6832, 6837) — handle both for forward-compat, as BRD says. |
| 16 | Event protocol as vendored in BRD §5.3 | **VERIFIED** | Full unions read from `@ai-sdk/provider@4.0.3` d.ts 6389–6781. BRD's table is accurate. Additions worth knowing: server events also include `conversation-item-added`, `output-item-done`, `content-part-added/done`, `audio-done`, `text-delta/done`, `function-call-arguments-delta`; session config also supports `outputModalities?: ('text'|'audio')[]`, `outputAudioTranscription?`, `providerOptions?`; `turnDetection` supports `'semantic-vad'` and `'disabled'`/`null`. `input-transcription-completed` carries `itemId` too. See full schemas below. |
| 17 | "Do NOT install `@canary` — canary (4.0.0-canary.107) is older than latest; docs saying canary are stale" | **VERIFIED** | `npm view @ai-sdk/gateway dist-tags`: `latest: 4.0.23`, `canary: 4.0.0-canary.107`, `beta: 4.0.0-beta.114`. Vercel docs (last_updated 2026-06-20/29) still say "Realtime support … is available on the canary releases … `pnpm add ai@canary @ai-sdk/gateway@canary`" — but the changelog (2026-06-29) says "available via AI SDK 7" and stable 4.0.23 demonstrably contains the full realtime surface. Docs note is stale; pin `4.0.23` exact. |
| 18 | Realtime is `experimental_`-prefixed and may change in patch releases | **VERIFIED** | ai-sdk.dev provider page: realtime is experimental and "the API may change in patch releases". Exact-pin rationale confirmed. |
| 19 | `getToken` must run server-side | **VERIFIED (new detail)** | `assertGatewayClientSecretServerEnvironment()` throws if `globalThis.window !== undefined` (dist/index.js 2952–2958). Irrelevant to the Node bridge but documents intent. |
| 20 | `expiresAfterSeconds: 600` is a valid value for realtime | **LIKELY** | Official ai-sdk.dev provider docs use `expiresAfterSeconds: 60 * 10` for realtime `getToken`. But the neighboring **transcription** getToken d.ts says "Gateway default is 60s (max 300s)" — no such comment exists for realtime, and the realtime default TTL is undocumented. Check the returned `expiresAt` at runtime; in this design the bridge connects within ~1 s of minting, so TTL is a non-issue unless `getToken` is done at webhook time and the WS opens much later. |

---

## Implementation-grade detail

### 1. Correct connection sequence (fixes BRD §5.2 sample)

```ts
import { gateway } from '@ai-sdk/gateway';   // singleton created with default options
import WebSocket from 'ws';

const MODEL = 'openai/gpt-realtime-2.1';     // fallback: 'openai/gpt-realtime-2'

// SERVER-SIDE, per call (HTTP POST under the hood; needs AI_GATEWAY_API_KEY):
const { token, url, expiresAt } = await gateway.experimental_realtime.getToken({
  model: MODEL,               // required; string
  expiresAfterSeconds: 600,   // optional; forwarded to mint endpoint as `expiresIn`
});
// token: 'vcst_...' single-use client secret
// url:   'wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1'
// expiresAt?: number (unix seconds)

// Codec instance (stateless; identity for gateway):
const rt = gateway.experimental_realtime(MODEL);
const cfg = rt.getWebSocketConfig({ token, url });
// cfg.url === url (echoed unchanged)
// cfg.protocols === ['ai-gateway-realtime.v1', `ai-gateway-auth.${token}`]
//   (+ 'ai-gateway-team.<base64url>' only if provider built with teamIdOrSlug)

const gw = new WebSocket(cfg.url, cfg.protocols, { perMessageDeflate: false });

// Sending (serializeClientEvent is identity for gateway but typed maybe-async):
gw.send(JSON.stringify(await rt.serializeClientEvent({ type: 'session-update', config })));

// Receiving (parseServerEvent is identity; type allows single event OR array):
const parsed = rt.parseServerEvent(JSON.parse(data.toString()));
for (const ev of Array.isArray(parsed) ? parsed : [parsed]) { /* ... */ }
```

Key API shapes (from `@ai-sdk/provider@4.0.3` d.ts):

```ts
interface RealtimeFactoryV4 {                                  // = Experimental_RealtimeFactoryV4
  (modelId: string): RealtimeModelV4;
  getToken(options: { model: string; expiresAfterSeconds?: number;
                      sessionConfig?: RealtimeModelV4SessionConfig }   // IGNORED by gateway
          ): Promise<{ token: string; url: string; expiresAt?: number }>;
}

type RealtimeModelV4 = {
  specificationVersion: 'v4';
  provider: string;    // 'gateway.realtime'
  modelId: string;     // 'openai/gpt-realtime-2.1'
  doCreateClientSecret(o): PromiseLike<{token; url; expiresAt?}>;  // internal ("do" prefix)
  getWebSocketConfig(o: {token: string; url: string}): { url: string; protocols?: string[] };
  parseServerEvent(raw: unknown): RealtimeModelV4ServerEvent | RealtimeModelV4ServerEvent[];
  serializeClientEvent(e: RealtimeModelV4ClientEvent): unknown | PromiseLike<unknown>;
  buildSessionConfig(c: RealtimeModelV4SessionConfig): unknown;
  getHealthCheckResponse?(raw: unknown): unknown | null;  // optional; NOT implemented by gateway model
};
```

### 2. The mint endpoint (what `getToken` does on the wire)

```
POST https://ai-gateway.vercel.sh/v1/realtime/client-secrets
Authorization: Bearer <AI_GATEWAY_API_KEY>          (or Vercel OIDC token)
ai-gateway-protocol-version: 0.0.1
ai-gateway-auth-method: api-key                     (or 'oidc')
x-vercel-ai-gateway-team: <teamIdOrSlug>            (only if configured)
Content-Type: application/json

{ "model": "openai/gpt-realtime-2.1", "expiresIn": 600 }
```

- Note the field rename: SDK option `expiresAfterSeconds` → request body **`expiresIn`** (dist/index.js 2695–2697). If you ever bypass the SDK, use `expiresIn`.
- A `routeKind` body field exists but is only set for transcription (`routeKind: "transcription"`); realtime omits it.
- Response schema (zod, dist/index.js 2638–2641): `{ token: string, expiresAt?: number | null }` — `expiresAt` in unix seconds.
- This endpoint is **absent from the public REST API reference** (which documents only `/v1/models`, `/v1/models/{creator}/{model}/endpoints`, `/v1/credits`, `/v1/generation`, `/v1/report`). Treat it as SDK-internal; do not hand-roll unless forced.

### 3. WebSocket subprotocol auth (server-side constants exported by the package)

`@ai-sdk/gateway` exports (usable if we ever need to introspect): `GATEWAY_REALTIME_SUBPROTOCOL = 'ai-gateway-realtime.v1'`, `GATEWAY_AUTH_SUBPROTOCOL_PREFIX = 'ai-gateway-auth.'`, `GATEWAY_TEAM_SUBPROTOCOL_PREFIX = 'ai-gateway-team.'`, plus helpers `getGatewayRealtimeAuthToken(secWebSocketProtocolHeader)` and `getGatewayRealtimeTeamIdOrSlug(...)`. Team slug is base64url-encoded (no padding) to fit subprotocol token grammar.

### 4. Full normalized session config (client → gateway inside `session-update`)

```ts
type RealtimeModelV4SessionConfig = {
  instructions?: string;
  voice?: string;                                   // e.g. 'alloy', 'marin'
  outputModalities?: Array<'text' | 'audio'>;
  inputAudioFormat?:  { type: string; rate?: number };  // 'audio/pcm' | 'audio/pcmu' | 'audio/pcma'; rate PCM-only
  outputAudioFormat?: { type: string; rate?: number };
  inputAudioTranscription?:  { model?: string; language?: string; prompt?: string };
  outputAudioTranscription?: { model?: string; language?: string; prompt?: string };
  turnDetection?: {
    type: 'server-vad' | 'semantic-vad' | 'disabled';
    threshold?: number;          // 0.0–1.0
    silenceDurationMs?: number;
    prefixPaddingMs?: number;
  } | null;                      // null = VAD off (push-to-talk)
  tools?: Array<{ type: 'function'; name: string; description?: string; parameters: JSONSchema7 }>;
  providerOptions?: Record<string, unknown>;   // gateway options (tags, user, BYOK) go under providerOptions.gateway
};
```

### 5. Full client-event union (client → gateway)

```ts
type RealtimeModelV4ClientEvent =
  | { type: 'session-update'; config: RealtimeModelV4SessionConfig }
  | { type: 'input-audio-append'; audio: string }              // base64
  | { type: 'input-audio-commit' }                             // NOT needed under server-vad
  | { type: 'input-audio-clear' }
  | { type: 'conversation-item-create'; item:
        | { type: 'text-message'; role: 'user'; text: string }
        | { type: 'audio-message'; role: 'user'; audio: string }          // base64, complete
        | { type: 'function-call-output'; callId: string; name?: string; output: string } }  // output = JSON string
  | { type: 'conversation-item-truncate'; itemId: string; contentIndex: number; audioEndMs: number }
  | { type: 'response-create'; options?: { modalities?: string[]; instructions?: string; metadata?: Record<string, unknown> } }
  | { type: 'response-cancel' };
```

### 6. Full server-event union (gateway → client) — every event has `.raw`

```ts
type RealtimeModelV4ServerEvent =
  | { type: 'session-created'; sessionId?: string; raw }
  | { type: 'session-updated'; raw }                                  // check .raw for applied audio format
  | { type: 'speech-started'; itemId?: string; raw }                  // barge-in trigger
  | { type: 'speech-stopped'; itemId?: string; raw }
  | { type: 'audio-committed'; itemId?: string; previousItemId?: string; raw }
  | { type: 'conversation-item-added'; itemId: string; item: unknown; raw }
  | { type: 'input-transcription-completed'; itemId: string; transcript: string; raw }
  | { type: 'response-created'; responseId: string; raw }
  | { type: 'response-done'; responseId: string; status: string; raw }
  | { type: 'output-item-added'; responseId; itemId; raw }            // capture itemId for truncate
  | { type: 'output-item-done'; responseId; itemId; raw }
  | { type: 'content-part-added'; responseId; itemId; raw }
  | { type: 'content-part-done'; responseId; itemId; raw }
  | { type: 'audio-delta'; responseId; itemId; delta: string; raw }   // base64 audio chunk
  | { type: 'audio-done'; responseId; itemId; raw }
  | { type: 'audio-transcript-delta'; responseId; itemId; delta: string; raw }
  | { type: 'audio-transcript-done'; responseId; itemId; transcript?: string; raw }
  | { type: 'text-delta'; responseId; itemId; delta: string; raw }
  | { type: 'text-done'; responseId; itemId; text?: string; raw }
  | { type: 'function-call-arguments-delta'; responseId; itemId; callId; delta: string; raw }
  | { type: 'function-call-arguments-done'; responseId; itemId; callId; name: string; arguments: string; raw }
  | { type: 'error'; message: string; code?: string; raw }
  | { type: 'custom'; rawType: string; raw };                         // unmapped provider events — log these
```

### 7. Session limits (official, exact)

| Limit | Value | Exceed behavior |
|---|---|---|
| Maximum session duration | 25 minutes | Session closes gracefully |
| Idle timeout | 5 minutes (nothing sent **or received**) | Session closes |
| First client message | within 30 s of connect | Session closes |
| Maximum message size | 256 KB | **Message rejected** (not session close) |
| Concurrent sessions per team | **unpublished** | "Additional connection attempts beyond the limit are rejected until a session ends" |

Limitations: no image input in realtime sessions; reconnect never resumes — new session + replay context.

### 8. Live model catalog & pricing (fetched 2026-07-18, `GET /v1/models`, 302 models)

```json
{ "id": "openai/gpt-realtime-2.1", "name": "gpt-realtime-2.1", "type": "realtime",
  "context_window": 128000, "max_tokens": 32000,
  "description": "GPT-Realtime-2.1 updates GPT-Realtime-2 with improved alphanumeric recognition, silence and noise handling, and interruption behavior. ...",
  "pricing": { "input": "0.000004", "output": "0.000024", "input_cache_read": "0.0000004", "web_search": "10" } }
```
- No `tags` on 2.1. `openai/gpt-realtime-2`: identical pricing, `"tags":["websocket-realtime"]`, context_window 0 / max_tokens 0 (metadata sparse).
- `openai/gpt-realtime-mini`: input $0.60/M, output $2.40/M, cached $0.06/M — the cheap fallback if cost matters.
- `openai/gpt-realtime-1.5`: input $4/M, output $16/M, cached $0.40/M.
- `xai/grok-voice-think-fast-1.0`: `"pricing": {}` (unpriced), speech-to-speech only (no transcription/translation per docs).
- Pricing strings are USD **per token**. No audio-token rate field exists anywhere in the schema (the only audio-duration pricing in the catalog is `gpt-realtime-whisper`'s `transcription_duration_cost_per_second`).

### 9. Error taxonomy (HTTP surface — applies to `getToken` failures)

`createGatewayErrorFromResponse` (dist/index.js 376–474) maps the response body `{ error: { message, type, param?, code? }, generationId? }` by `error.type`:

| `error.type` | SDK error class |
|---|---|
| `authentication_error` | `GatewayAuthenticationError` (contextual message incl. key-creation URL) |
| `invalid_request_error` | `GatewayInvalidRequestError` |
| `rate_limit_exceeded` | `GatewayRateLimitError` |
| `model_not_found` | `GatewayModelNotFoundError` (`.modelId` from `error.param`) |
| `internal_server_error` | `GatewayInternalServerError` |
| `failed_dependency` | `GatewayFailedDependencyError` |
| `forbidden` | `GatewayForbiddenError` (`.ruleId` from `error.param`) |
| anything else / unparsable | `GatewayInternalServerError` / `GatewayResponseError` |

All extend `GatewayError` with `.statusCode`. Also exported: `GatewayTimeoutError`. Documented REST status codes: 400 invalid request, 401 auth failed, 403 plan-gated, 404 not found, 500 internal, 503 backing service unavailable. **Wrap `getToken` in try/catch and branch on `GatewayError.statusCode` / class — a concurrency-limit rejection at connect time is the FR-7 "spoken fallback" trigger** (whether the limit manifests at mint or at WS-open is a runtime spike — see Open questions).

### 10. WebSocket-level errors and close codes

**Not documented anywhere.** The docs never enumerate WS close codes for the realtime surface. What is knowable:
- In-band errors arrive as normalized `{type:'error', message, code?, raw}` server events — log `code` and `raw` verbatim; this is the primary error channel.
- Unmapped provider events arrive as `{type:'custom', rawType, raw}`.
- Limit enforcement ("session closes gracefully" / "rejected") close codes are unspecified. The reference `useRealtime` hook does not branch on close codes. Instrument: log `code` and `reason` from the `ws` `close` event for every session; expect 1000 (normal), possibly 1008 (policy) or 4xxx app codes — **record empirically at M1/M4**.
- A failed subprotocol handshake (bad/expired/reused `vcst_` token) will surface in `ws` as an `error` + `unexpected-response` (HTTP 4xx on upgrade) — attach an `unexpected-response` listener to capture status + body.

### 11. Observability & usage (for M5 findings report)

- **Dashboard:** Vercel dashboard → team sidebar → **AI Gateway**: Usage (Requests by model, TTFT, input/output token counts, Spend graphs; longer retention needs Observability Plus), Requests (summaries by project and API key: request count, avg tokens, P75 duration, P75 TTFT, cost; detailed per-request log "including all token types and the cost for each request", sortable/exportable). Team scope by default; project scope via dropdown.
- **Docs do not state how realtime sessions are represented** in these views (one row per session? token buckets for audio?) — check after first billed call (M1). This is where the audio-token pricing question resolves.
- **Programmatic** (all available in-SDK, useful for cost-per-call in the findings report):
  - `GET /v1/credits` → `{"balance":"95.50","total_used":"4.50"}` (USD strings). SDK: `gateway.getCredits()` → `{balance, totalUsed}`.
  - `GET /v1/generation?id=gen_<ulid>` → cost/latency/token detail incl. `native_tokens_cached`, `native_tokens_reasoning`, `total_cost`. **Unknown whether realtime sessions emit generation IDs** (they're documented for chat completions responses; the realtime WS protocol has no id field for this — check `session-created.raw` / dashboard).
  - `GET /v1/report?start_date&end_date&group_by=model|day|user|tag|provider|api_key_name...` → aggregated spend. **Hobby and Pro-trial plans cannot use `/v1/report` (403)** — dashboard + `/v1/credits` delta are the fallback for cost measurement.
  - Spend attribution: tags/user go in `providerOptions.gateway` in session config (per ai-sdk.dev provider docs) — worth setting `tags: ['voice-poc']` in the `session-update` to isolate PoC spend, though whether the gateway honors it for realtime is unverified.
- The SDK auto-attaches `ai-o11y-*` headers (deployment id, env, region, request id, project id) from `VERCEL_*` env vars — absent on Railway, harmless.

---

## Gotchas & pitfalls

1. **BRD §5.2 sample code will throw.** `rt.getToken` does not exist on the model instance. Use `gateway.experimental_realtime.getToken({ model, expiresAfterSeconds })`. (The rest of the BRD's claims about getToken behavior are accurate; only the receiver object is wrong.)
2. **`expiresAfterSeconds` → `expiresIn` rename** at the HTTP boundary. Only matters if bypassing the SDK.
3. **Model id is percent-encoded in the WS URL** (`ai-model-id=openai%2Fgpt-realtime-2.1`). Don't string-compare URLs against an unencoded form; don't build the URL by hand — use the `url` returned by `getToken`.
4. **Vercel docs' "install canary" note is stale.** `canary` dist-tag = `4.0.0-canary.107` (pre-stable, older than `latest`). Realtime is fully present in stable `4.0.23`. Following the docs verbatim would install an older API surface.
5. **Missing `AI_GATEWAY_API_KEY` fails late and obscurely**: the SDK silently falls back to Vercel OIDC (`@vercel/oidc`), which throws off-Vercel; you get a `GatewayAuthenticationError` whose message talks about OIDC/`vc env pull`. Validate the env var at boot (config.ts) for a clean failure.
6. **`getToken` throws in any environment where `globalThis.window` is defined** — never import bridge gateway code into anything DOM-adjacent (tests with jsdom will hit this).
7. **Idle timeout counts both directions** ("if nothing is sent or received") — a call on hold with continuous Twilio media frames forwarded as `input-audio-append` will never idle out; but if you pause forwarding during silence (don't), a 5-min mute could kill the session.
8. **256 KB limit rejects the message, not the session** — but there is no documented ack/nack; a silently-dropped oversized message would be invisible. Never batch audio frames (BRD already mandates per-frame append; a 20 ms μ-law frame is ~214 B base64).
9. **The concurrent-session limit "rejects connection attempts"** — phrasing suggests WS-open-time rejection, but it could also/instead reject at mint. Handle both: try/catch on `getToken` AND `unexpected-response`/`error`/early-`close` on the WS, both mapping to FR-7's spoken-fallback path.
10. **`vcst_` tokens are single-use** — a reconnect (e.g., after gateway close) requires a fresh `getToken` round trip (~100 ms) before the new WS. Never cache/reuse tokens across sessions.
11. **`session-created` vs `session-updated`:** send `session-update` immediately on open (satisfies the 30 s first-message rule); verify the applied config via `session-updated.raw` — the gateway is an identity codec for events, but the **provider-side mapping of session config is closed-source**; `.raw` is the only ground truth for what OpenAI actually accepted (critical for the §5.5 pcmu spike).
12. **`getHealthCheckResponse` is optional and NOT implemented by the gateway model** — no SDK-level ping/pong protocol; rely on `ws`-level ping or the constant media traffic.
13. **`web_search: "10"` in realtime pricing** ($10 per 1k calls? per call? — units undocumented for this field; docs elsewhere say "cost per web search request"): irrelevant unless a web-search tool is exposed; do not expose one in this PoC.
14. **`/v1/report` is plan-gated** (403 on Hobby/Pro-trial). Cost measurement fallback: dashboard + `/v1/credits` before/after test batches.
15. **`parseServerEvent`/`serializeClientEvent` are identity today** — do keep calling them (and `Array.isArray` + `await`) so a future patch release that makes them real doesn't break the bridge (they're allowed to change in patches).

---

## Open questions (need runtime spike)

1. **Does the gateway honor `inputAudioFormat/outputAudioFormat: {type:'audio/pcmu'}` for openai realtime models?** Protocol types allow it; provider-side mapping is closed-source. M1 Path A spike; verify via `session-updated.raw` + audible output. (BRD already flags this.)
2. **Audio-token pricing.** The models API prices realtime models per text-ish token ($4/$24/M) with no audio-token field, but OpenAI bills realtime audio tokens at different (higher) rates. Whether the gateway bills at the listed rates, at OpenAI's audio rates via hidden metering, or maps audio to token counts differently is unobservable pre-billing. Check dashboard Requests log ("all token types") + `/v1/credits` delta after first call.
3. **Team concurrent-session limit number** — unpublished. M4 empirical ramp + ask Vercel support. Also determine **where** rejection happens (mint vs WS-open) and what the close/HTTP code is.
4. **WS close codes** for: 25-min cap, 5-min idle, 30-s no-first-message, concurrency rejection, expired/reused token. Log `code`/`reason` on every close + `unexpected-response` on upgrade; record at M1/M4.
5. **Realtime token TTL**: default and max for `expiresAfterSeconds` on the realtime route (transcription documents 60 s default / 300 s max; realtime undocumented; official example uses 600). Inspect returned `expiresAt`.
6. **Do realtime sessions surface generation IDs** (usable with `GET /v1/generation`) and how do they appear in the dashboard Requests log (per-session? per-response?)? Check `session-created.raw` and dashboard after M1.
7. **Does `providerOptions.gateway` (tags/user) inside `session-update` get honored for realtime spend attribution?** Documented for the provider generally; unverified for the realtime route.
8. **`speech-started` normalized vs `custom` passthrough** through the gateway's openai mapping (BRD §11) — M1; the `custom.rawType === 'input_audio_buffer.speech_started'` fallback matcher stands.
9. **Whether `gpt-realtime-2.1` actually accepts realtime WS connects** despite the missing `websocket-realtime` tag (metadata lag likely — it's in the SDK's typed model union and `type:"realtime"`). One connect attempt at M1; fallback `openai/gpt-realtime-2`.

---

## Sources

- Package source (installed from npm registry, read directly):
  - `@ai-sdk/gateway@4.0.23` → `scratchpad/gw/node_modules/@ai-sdk/gateway/dist/index.js` (realtime auth constants L1–60; error mapping L376–487; models/credits API L648–736; spend report L748+; realtime model L2235–2288; provider factory/mint L2637–2933; auth token L2935–2951; server-env assert L2952–2958) and `dist/index.d.ts` (model-id unions L74–84; provider interface L740–800)
  - `@ai-sdk/provider@4.0.3` → `scratchpad/gw/node_modules/@ai-sdk/provider/dist/index.d.ts` (tool def L6365–6383; session config L6389–6506; client-secret options/result L6512–6541; conversation items L6547–6587; client events L6594–6633; server events L6642–6781; RealtimeModelV4 L6790–6852; factory L6854–6865)
  - `npm view @ai-sdk/gateway dist-tags` (2026-07-18): latest=4.0.23, canary=4.0.0-canary.107, beta=4.0.0-beta.114
- Live API: `GET https://ai-gateway.vercel.sh/v1/models` (fetched 2026-07-18; 302 models; realtime entries quoted above)
- Vercel docs (fetched 2026-07-18):
  - https://vercel.com/docs/ai-gateway/modalities/realtime (session limits table, limitations, session config, Node example; last_updated 2026-06-20)
  - https://vercel.com/docs/ai-gateway/getting-started/realtime (quickstart, token route, PCM16@24k note)
  - https://vercel.com/docs/ai-gateway/observability-and-spend/observability (dashboard metrics)
  - https://vercel.com/docs/ai-gateway/observability-and-spend/usage (credits, generation lookup, generation IDs)
  - https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api (endpoints, error responses/status codes, /v1/report plan gating)
  - https://vercel.com/docs/ai-gateway (docs index)
- https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway (realtime section: getToken with `expiresAfterSeconds: 60 * 10`, experimental/patch-release caveat, providerOptions.gateway)
- https://vercel.com/changelog/realtime-voice-speech-and-transcription-now-supported-on-ai-gateway (2026-06-29; beta via AI SDK 7; no markup)
- https://vercel.com/blog/realtime-voice-agents-on-ai-gateway (architecture; no limits detail)
- https://github.com/vercel/ai/issues/13897 (Realtime API tracking issue; no close-code detail)

# Findings 02 — The Normalized AI SDK Realtime Event Protocol (from package source)

**Date:** 2026-07-18
**Scope:** Independent verification of BRD §5.1 (pins/dist-tags), §5.2 (gateway connection), and §5.3 (normalized event protocol) by installing the exact pinned packages and reading the published source. Packages inspected: `@ai-sdk/gateway@4.0.23` and its transitive dependency `@ai-sdk/provider@4.0.3`, installed fresh into a scratchpad (`npm install --save-exact @ai-sdk/gateway@4.0.23`). All type excerpts below are copied verbatim from the installed `dist/index.d.ts` files; runtime behavior of the gateway model class was additionally verified by executing the installed `dist/index.js` in Node. This document vendors the complete protocol — a build agent should never need the package docs.

Evidence file paths (scratchpad install):
- `.../scratchpad/gw-inspect/node_modules/@ai-sdk/provider/dist/index.d.ts` (protocol types, lines ~6361–6865)
- `.../scratchpad/gw-inspect/node_modules/@ai-sdk/gateway/dist/index.js` (gateway realtime impl, lines 1–48, 2235–2288, 2634–2958)
- `.../scratchpad/gw-inspect/node_modules/@ai-sdk/gateway/dist/index.d.ts` (exports, model-id unions, provider settings)

---

## Verified claims

| # | Claim (BRD ref) | Verdict | Evidence |
|---|---|---|---|
| 1 | `@ai-sdk/gateway` `latest` dist-tag is **4.0.23**; `canary` is **4.0.0-canary.107** (older than latest) — do not install `@canary` (§5.1) | **VERIFIED** | `npm view @ai-sdk/gateway dist-tags` → `{latest: "4.0.23", canary: "4.0.0-canary.107", beta: "4.0.0-beta.114", alpha: "1.0.0-alpha.6", ai-v5: "2.0.115", ai-v6: "3.0.153", snapshot: "0.0.0-8c583466-20260715165145"}`. Canary 4.0.0-canary.x semver-sorts *before* 4.0.23 — installing `@canary` would be a downgrade. |
| 2 | `@ai-sdk/gateway@4.0.23` depends on `@ai-sdk/provider@4.0.3`, which defines the protocol (§5.1) | **VERIFIED** | `npm view @ai-sdk/gateway@4.0.23 dependencies` → `{"@vercel/oidc": "3.2.0", "@ai-sdk/provider": "4.0.3", "@ai-sdk/provider-utils": "5.0.11"}` (exact pins, no ranges — the transitive version cannot drift). Installed `@ai-sdk/provider/package.json` version confirmed 4.0.3, which is also `latest` for that package. All realtime types live in `@ai-sdk/provider/dist/index.d.ts` as `RealtimeModelV4*`, exported with `Experimental_` prefixes. |
| 3 | The gateway model is an **identity codec** — JSON on the WS *is* the normalized protocol (§5.2) | **VERIFIED** | `gateway-realtime-model.ts` in dist/index.js: `parseServerEvent(raw) { return raw; }`, `serializeClientEvent(event) { return event; }`, `buildSessionConfig(config) { return config; }`. Executed at runtime: identity confirmed (same object reference returned, synchronously). Translation to OpenAI wire format happens server-side inside the gateway. |
| 4 | `parseServerEvent` may return an event **or an array** (§5.2) | **VERIFIED (interface); gateway impl passes raw through** | Interface: `parseServerEvent(raw: unknown): RealtimeModelV4ServerEvent \| RealtimeModelV4ServerEvent[]`. JSDoc: "Returns an array when a single provider message maps to multiple normalized events (e.g. Google's serverContent…)". The gateway implementation is `return raw` — so if the gateway *server* ever sends a JSON array, the identity parse returns an array. Handle both shapes. Whether the gateway server actually batches is a runtime question (see Open questions). |
| 5 | `serializeClientEvent` is "typed async — always await" (§5.2) | **VERIFIED (with precision)** | Type is `unknown \| PromiseLike<unknown>` — *possibly* async. The gateway impl is synchronous identity (runtime-checked: not a Promise). `await`-ing a non-promise is a no-op, so `await rt.serializeClientEvent(e)` is correct and forward-compatible. |
| 6 | `sessionConfig` passed to `getToken` is **intentionally ignored** by the gateway provider (§5.2) | **VERIFIED** | Source comment on `doCreateClientSecret` in dist/index.js: "`sessionConfig` is intentionally unused here — it is applied later via the normalized `session-update` event." The implementation forwards only `expiresAfterSeconds`; `sessionConfig` is silently dropped. Session config MUST be sent as a `session-update` client event after WS open. |
| 7 | Token is a `vcst_` client secret minted via `POST /v1/realtime/client-secrets` (§5.2) | **VERIFIED** | Source comment: "Mints a single-use, short-lived client secret (`vcst_`)…". Mint URL built as `new URL("/v1/realtime/client-secrets", baseURL)` → resolves to `https://ai-gateway.vercel.sh/v1/realtime/client-secrets` (NOTE: absolute path — the `/v4/ai` prefix of baseURL is *dropped* for the mint call). Body: `{ model: "<modelId>", expiresIn: <expiresAfterSeconds> }` — the SDK renames `expiresAfterSeconds` → `expiresIn` on the wire. Realtime mint sends **no** `routeKind` (transcription mint sends `routeKind: "transcription"`). Response schema (zod): `{ token: string, expiresAt: number \| null \| undefined }`. Auth: `Authorization: Bearer <AI_GATEWAY_API_KEY or OIDC token>` + `ai-gateway-protocol-version: 0.0.1` header. Minting throws if `globalThis.window` exists (server-side only). |
| 8 | WS URL is `wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai/gpt-realtime-2.1`; protocols `['ai-gateway-realtime.v1', 'ai-gateway-auth.<vcst_token>']` (§5.2) | **VERIFIED (one cosmetic detail)** | `toGatewayRealtimeUrl` = baseURL with `http`→`ws` + `/realtime-model` + `searchParams.set('ai-model-id', modelId)`. Actual URL has the slash percent-encoded: `wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1`. Protocols runtime-verified: `["ai-gateway-realtime.v1","ai-gateway-auth.vcst_TESTTOKEN"]`. If `createGateway({teamIdOrSlug})` is used, a third protocol `ai-gateway-team.<base64url(teamIdOrSlug)>` is appended. Default `gateway` singleton has no team protocol. |
| 9 | Event catalog in BRD §5.3 | **VERIFIED, but incomplete** — see corrections below and the full vendored protocol in the next section | `@ai-sdk/provider@4.0.3` dist/index.d.ts lines 6361–6865. |
| 10 | Every server event carries `.raw` (§5.3) | **VERIFIED** | Every member of the `RealtimeModelV4ServerEvent` union has a required `raw: unknown` field. JSDoc: "Every event includes a `raw` field with the original provider-specific event data for debugging and provider-specific access." |
| 11 | `inputAudioFormat`/`outputAudioFormat` support `audio/pcmu` (§5.3, §5.5) | **VERIFIED at the type level, with a caveat** | The `type` field is declared as plain `string`, NOT a literal union. `"audio/pcm"`, `"audio/pcmu"`, `"audio/pcma"` appear only in the JSDoc comment ("Audio format type (e.g. …)"). So the protocol *names* pcmu as an intended value but the compiler will accept anything and nothing in the SDK validates it — whether the gateway honors pcmu remains the M1 runtime spike, exactly as the BRD says. |
| 12 | `gpt-realtime-2.1` is a known gateway realtime model id (§11 risk table) | **VERIFIED (SDK-side)** | `@ai-sdk/gateway/dist/index.d.ts` line 74: `type GatewayRealtimeModelId = 'openai/gpt-realtime-1.5' \| 'openai/gpt-realtime-2' \| 'openai/gpt-realtime-2.1' \| 'openai/gpt-realtime-mini' \| 'xai/grok-voice-think-fast-1.0' \| (string & {})`. The SDK shipped 2026-07 with `2.1` in its typed union — strong corroboration (though not proof of live availability; the factory itself accepts any `string`). |
| 13 | Not needed: `ai`, `@ai-sdk/react`, `openai` packages (§5.1) | **VERIFIED** | Everything the bridge needs (`gateway.experimental_realtime`, `getToken`, `getWebSocketConfig`, the event types) is exported from `@ai-sdk/gateway` / `@ai-sdk/provider`. The install pulls only `@vercel/oidc`, `@ai-sdk/provider`, `@ai-sdk/provider-utils` transitively. No `ws` implementation is bundled for realtime — bring your own (BRD's `ws@^8` is right; note `GatewayProviderSettings.webSocket` option exists but is used only for streaming *transcription*, not realtime). |

### BRD corrections / omissions (§5.3 event table)

1. **Missing server events** (all exist in the union and can arrive on the wire): `conversation-item-added`, `output-item-done`, `content-part-added`, `content-part-done`, `text-delta`, `text-done`, `function-call-arguments-delta` (the BRD sequence diagram only shows `-done`). A bridge switch statement should at minimum ignore these explicitly rather than logging them as unknown.
2. **`input-transcription-completed` has a required `itemId: string`** in addition to `transcript` (BRD lists only `{transcript}`).
3. **Missing client conversation item type:** `audio-message` (`{type:'audio-message', role:'user', audio: base64}`) — complete (non-streamed) user audio. Not needed for this PoC but part of the protocol.
4. **`RealtimeModelV4SessionConfig` fields the BRD omits:** `outputModalities?: Array<'text'|'audio'>`, `outputAudioTranscription?: {model?, language?, prompt?}` (makes model-speech transcripts explicit rather than provider-default), and `providerOptions?: Record<string, unknown>` (pass-through escape hatch — potentially useful in the M1 spike to reach OpenAI-native session fields the normalized config doesn't cover).
5. **`turnDetection` is wider than BRD states:** `type: 'server-vad' | 'semantic-vad' | 'disabled'`, and the whole field can be `null` (both `null` and `{type:'disabled'}` mean push-to-talk / VAD off).
6. **`inputAudioTranscription` is not `{}`-only:** it accepts `{model?, language?, prompt?}`. `{}` is valid (all fields optional) and matches the BRD's usage.
7. **`response-create` options shape** (BRD leaves it unspecified): `{ modalities?: string[]; instructions?: string; metadata?: Record<string, unknown> }`. Per-response `instructions` is a useful lever (e.g. a greeting response with one-off instructions).
8. **`audio-delta` carries required `responseId` and `itemId`** — the BRD's §5.6 note that `lastAssistantItemId` can come from `audio-delta.itemId` is confirmed by the type; `output-item-added` also carries `{responseId, itemId}`.
9. **`function-call-arguments-done` also carries `responseId` and `itemId`** (BRD lists `{callId, name, arguments}`); `arguments` is a JSON *string* — confirmed.
10. **The `-2.1` model id aside, the typed union also offers `openai/gpt-realtime-mini`** — a possible cheaper fallback the BRD doesn't mention.
11. **Cosmetic:** the live WS URL query encodes the model id as `openai%2Fgpt-realtime-2.1` (BRD shows it unencoded — harmless, but log-grep patterns should expect `%2F`).

---

## Implementation-grade detail — the vendored protocol

All excerpts verbatim from `@ai-sdk/provider@4.0.3` `dist/index.d.ts` (internal names `RealtimeModelV4*`; exported as `Experimental_RealtimeModelV4*`). `JSONSchema7` is re-exported from the `json-schema` types package (`import { JSONSchema7 } from 'json-schema'`).

### Exported names (import surface)

```ts
// from '@ai-sdk/provider' (types only):
import type {
  Experimental_RealtimeModelV4,                    // the model interface
  Experimental_RealtimeModelV4ClientEvent,         // client -> server union
  Experimental_RealtimeModelV4ServerEvent,         // server -> client union
  Experimental_RealtimeModelV4SessionConfig,
  Experimental_RealtimeModelV4ToolDefinition,
  Experimental_RealtimeModelV4ConversationItem,
  Experimental_RealtimeModelV4TextMessage,
  Experimental_RealtimeModelV4AudioMessage,
  Experimental_RealtimeModelV4FunctionCallOutput,
  Experimental_RealtimeModelV4ClientSecretOptions,
  Experimental_RealtimeModelV4ClientSecretResult,
  Experimental_RealtimeFactoryV4,
  Experimental_RealtimeFactoryV4GetTokenOptions,   // { model: string } & ClientSecretOptions
  Experimental_RealtimeFactoryV4GetTokenResult,    // { token; url; expiresAt? }
  JSONSchema7,
} from '@ai-sdk/provider';

// from '@ai-sdk/gateway' (values):
import {
  gateway,                        // default provider singleton (env AI_GATEWAY_API_KEY or Vercel OIDC)
  createGateway,                  // createGateway({ apiKey?, baseURL?, teamIdOrSlug?, headers?, fetch?, ... })
  GATEWAY_REALTIME_SUBPROTOCOL,   // "ai-gateway-realtime.v1"
  GATEWAY_AUTH_SUBPROTOCOL_PREFIX,// "ai-gateway-auth."
  GATEWAY_TEAM_SUBPROTOCOL_PREFIX,// "ai-gateway-team."
  getGatewayRealtimeProtocols,    // (token, {teamIdOrSlug?}?) => string[]
  VERSION,                        // "4.0.23"
} from '@ai-sdk/gateway';
```

### Session config (payload of `session-update`)

```ts
type RealtimeModelV4SessionConfig = {
  /** System instructions for the model. */
  instructions?: string;
  /** Voice to use for audio output. */
  voice?: string;
  /** Which output modalities the model should produce. */
  outputModalities?: Array<'text' | 'audio'>;
  /** Audio format configuration for input audio. */
  inputAudioFormat?: {
    /** Audio format type (e.g. "audio/pcm", "audio/pcmu", "audio/pcma"). */
    type: string;              // NOTE: plain string, not a literal union
    /** Sample rate in Hz. Only applicable for PCM format. */
    rate?: number;
  };
  /** When enabled, providers that support input transcription emit normalized
      `input-transcription-completed` events. */
  inputAudioTranscription?: {
    model?: string;            // provider-specific transcription model
    language?: string;         // optional language hint
    prompt?: string;           // optional prompt to guide transcription
  };
  /** When enabled, providers emit normalized `audio-transcript-delta`/`-done`
      for the model's spoken response (some providers do this by default). */
  outputAudioTranscription?: {
    model?: string;
    language?: string;
    prompt?: string;
  };
  /** Audio format configuration for output audio. */
  outputAudioFormat?: {
    type: string;              // same open-string caveat
    rate?: number;
  };
  /** VAD config. Set to null or type 'disabled' to turn off VAD (push-to-talk). */
  turnDetection?: {
    type: 'server-vad' | 'semantic-vad' | 'disabled';
    threshold?: number;          // VAD activation threshold 0.0-1.0
    silenceDurationMs?: number;  // silence before server ends the turn
    prefixPaddingMs?: number;    // audio included before detected speech start
  } | null;
  /** Tool definitions available to the model in this session. */
  tools?: RealtimeModelV4ToolDefinition[];
  /** Provider-specific options passed through to the provider. */
  providerOptions?: Record<string, unknown>;
};

type RealtimeModelV4ToolDefinition = {
  type: 'function';          // always 'function'
  name: string;              // unique within the session
  description?: string;
  parameters: JSONSchema7;   // JSON Schema for the tool's parameters
};
```

### Client → server events (complete union)

```ts
type RealtimeModelV4ClientEvent =
  | { type: 'session-update';
      config: RealtimeModelV4SessionConfig }
  | { type: 'input-audio-append';
      /** Base64-encoded audio chunk to append to the input buffer. */
      audio: string }
  | { type: 'input-audio-commit' }            // no payload; NOT used under server-vad
  | { type: 'input-audio-clear' }             // no payload
  | { type: 'conversation-item-create';
      item: RealtimeModelV4ConversationItem }
  | { type: 'conversation-item-truncate';
      /** The ID of the assistant message item to truncate. */
      itemId: string;
      /** The index of the content part to truncate. */
      contentIndex: number;                   // required (use 0)
      /** Truncate audio after this many milliseconds. */
      audioEndMs: number }                    // required
  | { type: 'response-create';
      options?: {
        modalities?: string[];
        instructions?: string;
        metadata?: Record<string, unknown>;
      } }
  | { type: 'response-cancel' };              // no payload

type RealtimeModelV4ConversationItem =
  | RealtimeModelV4TextMessage
  | RealtimeModelV4AudioMessage
  | RealtimeModelV4FunctionCallOutput;

type RealtimeModelV4TextMessage = {
  type: 'text-message';
  role: 'user';              // only 'user'
  text: string;
};

type RealtimeModelV4AudioMessage = {
  type: 'audio-message';
  role: 'user';
  audio: string;             // base64, complete audio (not streamed)
};

type RealtimeModelV4FunctionCallOutput = {
  type: 'function-call-output';
  /** Must match the callId from function-call-arguments-done. */
  callId: string;
  /** Required by some providers (e.g. Google) for tool response routing. */
  name?: string;             // include it — harmless for OpenAI, required for Google
  /** JSON string containing the function call result. */
  output: string;            // JSON.stringify(...) the result
};
```

### Server → client events (complete union — every member has required `raw: unknown`)

```ts
type RealtimeModelV4ServerEvent =
  | { type: 'session-created';   sessionId?: string; raw: unknown }
  | { type: 'session-updated';   raw: unknown }   // applied config only via .raw
  | { type: 'speech-started';    itemId?: string; raw: unknown }
  | { type: 'speech-stopped';    itemId?: string; raw: unknown }
  | { type: 'audio-committed';   itemId?: string; previousItemId?: string; raw: unknown }
  | { type: 'conversation-item-added'; itemId: string; item: unknown; raw: unknown }
  | { type: 'input-transcription-completed'; itemId: string; transcript: string; raw: unknown }
  | { type: 'response-created';  responseId: string; raw: unknown }
  | { type: 'response-done';     responseId: string; status: string; raw: unknown }
  | { type: 'output-item-added'; responseId: string; itemId: string; raw: unknown }
  | { type: 'output-item-done';  responseId: string; itemId: string; raw: unknown }
  | { type: 'content-part-added'; responseId: string; itemId: string; raw: unknown }
  | { type: 'content-part-done';  responseId: string; itemId: string; raw: unknown }
  | { type: 'audio-delta';       responseId: string; itemId: string;
      delta: string;             // base64-encoded audio chunk
      raw: unknown }
  | { type: 'audio-done';        responseId: string; itemId: string; raw: unknown }
  | { type: 'audio-transcript-delta'; responseId: string; itemId: string;
      delta: string;             // text chunk of the audio transcript
      raw: unknown }
  | { type: 'audio-transcript-done';  responseId: string; itemId: string;
      transcript?: string; raw: unknown }
  | { type: 'text-delta';        responseId: string; itemId: string; delta: string; raw: unknown }
  | { type: 'text-done';         responseId: string; itemId: string; text?: string; raw: unknown }
  | { type: 'function-call-arguments-delta'; responseId: string; itemId: string; callId: string;
      delta: string;             // partial JSON string of arguments
      raw: unknown }
  | { type: 'function-call-arguments-done';  responseId: string; itemId: string; callId: string;
      name: string;              // function to call
      arguments: string;         // complete JSON string of arguments
      raw: unknown }
  | { type: 'error';   message: string; code?: string; raw: unknown }
  | { type: 'custom';
      rawType: string;           // original provider event type string
      raw: unknown };            // unmapped provider events land here
```

### The model interface and factory

```ts
type RealtimeModelV4 = {
  readonly specificationVersion: 'v4';
  readonly provider: string;   // gateway instance reports 'gateway.realtime'
  readonly modelId: string;

  /** Server-side. Mints ephemeral client secret. */
  doCreateClientSecret(options: RealtimeModelV4ClientSecretOptions):
    PromiseLike<RealtimeModelV4ClientSecretResult>;

  /** Client-side. URL + subprotocols for new WebSocket(url, protocols). */
  getWebSocketConfig(options: { token: string; url: string }):
    { url: string; protocols?: string[] };

  /** Client-side. May return ONE event or an ARRAY of events. */
  parseServerEvent(raw: unknown):
    RealtimeModelV4ServerEvent | RealtimeModelV4ServerEvent[];

  /** Client-side. Possibly async — always await. */
  serializeClientEvent(event: RealtimeModelV4ClientEvent):
    unknown | PromiseLike<unknown>;

  /** Client-side. Builds provider-native session config payload. */
  buildSessionConfig(config: RealtimeModelV4SessionConfig): unknown;

  /** Optional keepalive hook (ping/pong). NOT implemented by the gateway
      model (runtime-verified undefined) — no app-level ping needed. */
  getHealthCheckResponse?(raw: unknown): unknown | null;
};

type RealtimeModelV4ClientSecretOptions = {
  expiresAfterSeconds?: number;
  sessionConfig?: RealtimeModelV4SessionConfig;  // IGNORED by the gateway provider
};

type RealtimeModelV4ClientSecretResult = {
  token: string;      // 'vcst_...' — used in the auth subprotocol
  url: string;        // full wss:// URL incl. ?ai-model-id=
  expiresAt?: number; // unix seconds
};

type RealtimeFactoryV4GetTokenOptions = { model: string } & RealtimeModelV4ClientSecretOptions;
type RealtimeFactoryV4GetTokenResult  = { token: string; url: string; expiresAt?: number };

interface RealtimeFactoryV4 {
  (modelId: string): RealtimeModelV4;   // note: plain string, GatewayRealtimeModelId not enforced
  getToken(options: RealtimeFactoryV4GetTokenOptions): Promise<RealtimeFactoryV4GetTokenResult>;
}
// gateway.experimental_realtime: Experimental_RealtimeFactoryV4
```

### Gateway implementation facts (from `@ai-sdk/gateway@4.0.23` dist/index.js, runtime-verified)

- **Identity codec:** `parseServerEvent`, `serializeClientEvent`, `buildSessionConfig` all return their argument unchanged. The JSON frames on the gateway WS ARE the normalized events above, both directions. Send `JSON.stringify(clientEvent)`; parse `JSON.parse(frame)` and treat as `ServerEvent | ServerEvent[]`.
- **Default baseURL:** `https://ai-gateway.vercel.sh/v4/ai` (trailing slash stripped).
- **WS URL construction:** baseURL `http`→`ws` regex swap + `/realtime-model`, query `ai-model-id=<modelId>` (slash %2F-encoded): `wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1`.
- **Subprotocols:** `["ai-gateway-realtime.v1", "ai-gateway-auth.<token>"]`, plus `"ai-gateway-team.<base64url(teamIdOrSlug)>"` iff `createGateway({teamIdOrSlug})`. The marker exists so servers can echo a negotiated subprotocol on the 101. Source JSDoc: token must satisfy the RFC subprotocol token grammar (vcst_ tokens do); keep total `Sec-WebSocket-Protocol` under ~8 KiB.
- **Token mint (`getToken`):** `POST https://ai-gateway.vercel.sh/v1/realtime/client-secrets` (absolute path — NOT under `/v4/ai`) with headers `Authorization: Bearer <key-or-oidc>`, `ai-gateway-protocol-version: 0.0.1`, `ai-gateway-auth-method: api-key|oidc`, optional `x-vercel-ai-gateway-team`, user-agent suffix `ai-sdk/gateway/4.0.23`. Body `{ model, expiresIn? }` (`expiresAfterSeconds` renamed to `expiresIn`; no `routeKind` for realtime). Response `{ token, expiresAt? }` (zod: `expiresAt` nullish). Throws in a browser (`globalThis.window` check). Auth resolution: explicit `apiKey` option → env `AI_GATEWAY_API_KEY` → Vercel OIDC token; failures become `GatewayAuthenticationError` (statusCode 401).
- **Model:** `gateway.experimental_realtime('openai/gpt-realtime-2.1')` → `{specificationVersion:'v4', provider:'gateway.realtime', modelId:'openai/gpt-realtime-2.1'}` (runtime-verified).
- **Error classes exported** (thrown by getToken, not on the WS): `GatewayError`, `GatewayAuthenticationError`, `GatewayInvalidRequestError`, `GatewayRateLimitError`, `GatewayModelNotFoundError`, `GatewayForbiddenError`, `GatewayInternalServerError`, `GatewayFailedDependencyError`, `GatewayResponseError`. WS-side errors arrive as the normalized `error` server event.
- **Typed realtime model ids** (informational; not enforced): `'openai/gpt-realtime-1.5' | 'openai/gpt-realtime-2' | 'openai/gpt-realtime-2.1' | 'openai/gpt-realtime-mini' | 'xai/grok-voice-think-fast-1.0' | (string & {})`.

### Canonical bridge connect sequence (assembled from the above; matches BRD §5.2)

```ts
import { gateway } from '@ai-sdk/gateway';
import WebSocket from 'ws';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent,
              Experimental_RealtimeModelV4ServerEvent as ServerEvent } from '@ai-sdk/provider';

const MODEL = 'openai/gpt-realtime-2.1';
const rt = gateway.experimental_realtime(MODEL);

// server-side, per call, at webhook time:
const { token, url, expiresAt } = await rt.getToken
  ? await gateway.experimental_realtime.getToken({ model: MODEL, expiresAfterSeconds: 600 })
  : never; // use the factory getToken — do not call doCreateClientSecret directly

const cfg = rt.getWebSocketConfig({ token, url });
const gw = new WebSocket(cfg.url, cfg.protocols, { perMessageDeflate: false });

gw.on('open', async () => {
  const send = async (e: ClientEvent) => gw.send(JSON.stringify(await rt.serializeClientEvent(e)));
  await send({ type: 'session-update', config: { /* instructions, voice, turnDetection,
    inputAudioFormat, outputAudioFormat, inputAudioTranscription: {}, tools */ } });
  await send({ type: 'response-create', options: { instructions: 'Greet the caller briefly.' } });
});

gw.on('message', (data) => {
  const parsed = rt.parseServerEvent(JSON.parse(data.toString()));
  const events: ServerEvent[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const ev of events) { /* switch (ev.type) { ... } — handle ALL 23 types incl. custom */ }
});
```

---

## Gotchas & pitfalls

1. **Do not install `@canary`** — it is 4.0.0-canary.107, an *older* line than latest 4.0.23. Also present and to be avoided: `beta` (4.0.0-beta.114), `ai-v5`/`ai-v6` back-compat lines, `alpha` (1.0.0-alpha.6 — a different, future major). Pin `4.0.23` exact with `save-exact`; `@ai-sdk/provider@4.0.3` is exact-pinned transitively so no separate direct dependency is needed (adding one anyway is harmless documentation).
2. **`audio/pcmu` is not compiler-guaranteed.** `inputAudioFormat.type`/`outputAudioFormat.type` are `string`; the pcm/pcmu/pcma values are documentation, not a union. TypeScript will not catch typos and nothing client-side validates gateway support — confirm via `session-updated.raw` (M1 spike).
3. **`session-updated` is opaque** — its only field beyond `type` is `raw`. Confirmation of the applied audio format MUST come from inspecting `.raw` (provider-native shape, e.g. OpenAI's `session.updated`).
4. **`conversation-item-truncate` requires `contentIndex` and `audioEndMs`** (both non-optional numbers). Omitting `contentIndex: 0` is a type error and likely a wire error.
5. **Include `name` in `function-call-output`** even though optional — required by some providers for routing, harmless for OpenAI, and keeps the bridge provider-neutral.
6. **`response-done.status` is a plain `string`** (not an enum). Expect provider-native values (e.g. `'completed'`, `'cancelled'`, `'failed'`, `'incomplete'` for OpenAI) but match defensively; log the value.
7. **Unhandled event types will occur.** The union has 23 server event types; the BRD's bridge acts on ~12. `content-part-*`, `output-item-done`, `conversation-item-added`, `text-delta`/`text-done` (if `outputModalities` includes 'text') should be consciously ignored or logged at debug, not treated as errors. Anything the gateway cannot normalize arrives as `custom {rawType, raw}` — log always.
8. **`parseServerEvent` array handling is a contract, not an observation.** For the gateway it is identity, so an array only appears if the gateway server sends one. Handle both anyway — it is 3 lines and protects against gateway server changes without an SDK release (the gateway explicitly reserves the right to evolve service-side: see `GatewayProviderOptions` "Service-owned options may be added by the Gateway without requiring an SDK release").
9. **No keepalive needed at the app layer:** `getHealthCheckResponse` is optional in the interface and absent on the gateway model (runtime-verified `undefined`). WS-level ping/pong is the transport's business; with 20 ms media frames the connection is never idle mid-call anyway.
10. **`getToken` mint endpoint is NOT under `/v4/ai`** — if you ever build custom fetch/proxy logic or allowlist egress paths, allow both `https://ai-gateway.vercel.sh/v1/realtime/client-secrets` (HTTP mint) and `wss://ai-gateway.vercel.sh/v4/ai/realtime-model` (WS).
11. **Minting is server-only by explicit guard** — a `globalThis.window !== 'undefined'` check throws. Irrelevant for the Node bridge but explains the error if code is ever bundled client-side.
12. **`expiresAfterSeconds` becomes `expiresIn` on the wire.** If you ever mint via raw HTTP instead of the SDK, the body field is `expiresIn`.
13. **`role` on `text-message`/`audio-message` items is only `'user'`** — the normalized protocol cannot inject assistant/system conversation items. System-style steering mid-call = `session-update` with new `instructions`, or `response-create.options.instructions`.
14. **`response-cancel` and `input-audio-commit`/`-clear` carry no payload** — no response id targeting; `response-cancel` cancels the in-progress response.
15. **`experimental_` really does mean patch-level drift is sanctioned** — the exported names all carry the `Experimental_` prefix and Vercel documents that experimental APIs may change in patch releases. The exact pin plus this vendored doc is the mitigation.

---

## Open questions (need runtime spike)

1. Does the gateway server honor `inputAudioFormat/outputAudioFormat {type:'audio/pcmu'}` for OpenAI models end-to-end? (Type-level yes; closed-source mapping unverified — BRD M1 Path A spike.)
2. Does the gateway server ever send a JSON **array** of normalized events in one WS frame? (Identity parse would surface it; handle both regardless.)
3. Are ALL provider events normalized by the gateway, or do some (e.g. `input_audio_buffer.speech_started`) arrive as `custom {rawType, raw}`? BRD's §5.6 fallback matcher remains prudent until observed. Note: since the codec is identity, normalization happens server-side in the closed-source gateway — the SDK source cannot answer this.
4. Exact shape of `session-updated.raw` through the gateway (OpenAI-native `session.updated` vs some gateway-massaged form) — needed for the M1 format-confirmation check.
5. Whether the `vcst_` token is strictly single-use (source comment says "single-use"; reconnect behavior — new getToken per reconnect — should be assumed and is what the BRD designs for).
6. Actual `response-done.status` string values seen through the gateway (expected OpenAI-native: completed/cancelled/failed/incomplete).
7. Whether `providerOptions` in `session-update.config` passes through to OpenAI session params via the gateway (potential escape hatch if pcmu needs OpenAI-native `audio.output.format` syntax) — worth one M1 experiment if Path A fails via the normalized fields.

---

## Sources

- `@ai-sdk/gateway@4.0.23` (npm tarball, installed 2026-07-18): `node_modules/@ai-sdk/gateway/dist/index.js` (realtime auth: lines 1–48; `GatewayRealtimeModel`: lines 2235–2288; `createGateway`/mint/factory: lines 2634–2958), `dist/index.d.ts` (subprotocol contract: lines 7–72; `GatewayRealtimeModelId`: line 74; `GatewayProvider.experimental_realtime`: line 750; `GatewayProviderSettings`: lines 787–822).
- `@ai-sdk/provider@4.0.3` (exact transitive dependency, installed alongside): `node_modules/@ai-sdk/provider/dist/index.d.ts` lines 6361–6865 (all `RealtimeModelV4*` types, quoted verbatim above); export aliases (`Experimental_*`) from the final export statement; `JSONSchema7` re-export at lines 1–2.
- `npm view @ai-sdk/gateway dist-tags --json` (registry.npmjs.org, 2026-07-18): latest=4.0.23, canary=4.0.0-canary.107, beta=4.0.0-beta.114, alpha=1.0.0-alpha.6, ai-v5=2.0.115, ai-v6=3.0.153.
- `npm view @ai-sdk/gateway@4.0.23 dependencies --json`: `@ai-sdk/provider@4.0.3` (exact), `@ai-sdk/provider-utils@5.0.11`, `@vercel/oidc@3.2.0`.
- `npm view @ai-sdk/provider dist-tags --json`: latest=4.0.3.
- Runtime verification script (Node 22, scratchpad `gw-inspect/`): identity codec, WS config/protocols, provider/modelId/spec-version, absent `getHealthCheckResponse`, URL derivations.
- Scratchpad install root: `C:\Users\kevin\AppData\Local\Temp\claude\D--projects-linean-CSUB-RIO-POC\2b673856-d2e2-4653-a80a-85f159b53749\scratchpad\gw-inspect`.

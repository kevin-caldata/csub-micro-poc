# Findings 04 — Barge-in Mechanics & the Canonical Twilio+OpenAI Realtime Bridge Pattern

**Date:** 2026-07-18
**Researcher:** subagent (barge-in / realtime voice patterns domain)
**Status:** Complete — all claims sourced from published package code, the actual reference-implementation source, and official docs.

## Scope

Verifies and deepens BRD §5.3 (normalized event protocol), §5.4 (Twilio mark/clear), §5.6 (barge-in sequence), and the greeting/turn-taking aspects of §2 (FR-1/FR-2). Primary evidence:

- `twilio-samples/speech-assistant-openai-realtime-api-node` — full `index.js` fetched from GitHub `main` (276 lines, saved to scratchpad; quoted below).
- `@ai-sdk/provider@4.0.3` — normalized realtime protocol (`RealtimeModelV4*` types), read from installed tarball.
- `@ai-sdk/openai@4.0.16` — the **public OpenAI wire↔normalized mapper** (`src/realtime/openai-realtime-event-mapper.ts` compiled into `dist/index.js` lines ~3220–3607). This is the best available proxy for what the gateway's closed-source translation does.
- `@ai-sdk/gateway@4.0.23` — `GatewayRealtimeModel` (identity codec) read from installed tarball.
- `openai@6.48.0` — `resources/realtime/realtime.d.ts` doc comments = verbatim OpenAI API reference text for every realtime event (the API reference website serves the same strings).
- Twilio Media Streams WebSocket messages docs; OpenAI realtime VAD guide; Vercel AI Gateway realtime docs.

---

## Verified claims

### V1. The canonical per-call state (BRD §5.6/§5.8) — **VERIFIED**

The reference implementation keeps exactly this connection-scoped state (index.js lines 71–76):

```js
let streamSid = null;
let latestMediaTimestamp = 0;          // from every inbound Twilio media.timestamp
let lastAssistantItem = null;          // from response.output_audio.delta.item_id
let markQueue = [];                    // one entry per outbound media chunk sent
let responseStartTimestampTwilio = null; // latestMediaTimestamp at first audio delta of a response
```

Source: https://raw.githubusercontent.com/twilio-samples/speech-assistant-openai-realtime-api-node/main/index.js (fetched 2026-07-18).

### V2. audioEndMs math — **VERIFIED** (with a correction, see G1)

Reference implementation (lines 129–155):

```js
const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
// truncate: { type:'conversation.item.truncate', item_id: lastAssistantItem,
//             content_index: 0, audio_end_ms: elapsedTime }
```

`latestMediaTimestamp` works as a playback clock because Twilio's inbound `media.timestamp` is the "Presentation Timestamp in Milliseconds from the start of the stream" (Twilio docs, verbatim) and inbound frames flow continuously (silence included), so the delta ≈ wall-time the caller has been hearing this response ≈ ms of assistant audio actually played. **BRD §5.6 math confirmed** — but the reference implementation has a stale-epoch bug the BRD partially inherits (Gotcha G1).

### V3. `conversation.item.truncate` semantics — **VERIFIED** (openai@6.48.0 `realtime.d.ts`, verbatim API-reference text)

- "Send this event to truncate a previous assistant message's audio. The server will produce audio faster than realtime, so this event is useful when the user interrupts to truncate audio that has already been sent to the client but not yet played."
- "**Truncating audio will delete the server-side text transcript** to ensure there is not text in the context that hasn't been heard by the user."
- `audio_end_ms`: "Inclusive duration up to which audio is truncated, in milliseconds. **If the audio_end_ms is greater than the actual audio duration, the server will respond with an error.**"
- `content_index`: "The index of the content part to truncate. **Set this to `0`.**"
- `item_id`: "The ID of the assistant message item to truncate. **Only assistant message items can be truncated.**"
- Success ack: server responds with `conversation.item.truncated {audio_end_ms, content_index, item_id, event_id}`.
- Truncating an **already-completed** item is the *normal* case (audio is generated faster than realtime; the response is usually `done` server-side while still playing at the caller). There is no "already done" error — only: item not found, not an assistant message item, or `audio_end_ms` > actual duration.

### V4. `response.cancel` semantics — **VERIFIED** (openai@6.48.0, verbatim)

- "Send this event to cancel an in-progress response. The server will respond with a `response.done` event with a status of `response.status=cancelled`. **If there is no response to cancel, the server will respond with an error. It's safe to call `response.cancel` even if no response is in progress — an error will be returned [and] the session will remain unaffected.**"
- Optional `response_id` field ("if not provided, will cancel an in-progress response in the default conversation"). The normalized `response-cancel` event does **not** expose `response_id` (mapper emits bare `{type:'response.cancel'}`).
- `response.done.response.status` ∈ `'completed' | 'cancelled' | 'failed' | 'incomplete' | 'in_progress'`; `response.status_details.reason` for cancelled ∈ `'turn_detected'` (server VAD detected new speech) `| 'client_cancelled'`.

### V5. Server VAD auto-interruption — **VERIFIED** (types verbatim) / defaults **VERIFIED via docs**

`turn_detection: {type:'server_vad'}` fields (openai@6.48.0 + https://platform.openai.com/docs/guides/realtime-vad + API reference):

| Field | Default | Verbatim semantics |
|---|---|---|
| `threshold` | **0.5** | "Activation threshold for VAD (0.0 to 1.0)… A higher threshold will require louder audio to activate the model, and thus might perform better in noisy environments." |
| `prefix_padding_ms` | **300** | "Amount of audio to include before the VAD detected speech (in milliseconds)." |
| `silence_duration_ms` | **500** | "Duration of silence to detect speech stop… With shorter values the model will respond more quickly, but may jump in on short pauses from the user." |
| `create_response` | **true** | "Whether or not to automatically generate a response when a VAD stop event occurs. If `interrupt_response` is set to `false` this may fail to create a response if the model is already responding." |
| `interrupt_response` | **true** | "Whether or not to automatically interrupt (cancel) any ongoing response with output to the default conversation (i.e. `conversation` of `auto`) when a VAD start event occurs." |
| `idle_timeout_ms` | off (range 5000–30000) | "Optional timeout after which a model response will be triggered automatically… useful for situations in which a long pause from the user is unexpected, **such as a phone call**. Applied after the last model response's audio has finished playing (`response.done` time + audio playback duration). Emits `input_audio_buffer.timeout_triggered` plus Response events. Only supported for `server_vad`." |

**Consequence (important):** with defaults, the OpenAI server *already cancels* the in-flight response the moment `speech_started` fires. The client-side work of barge-in is only (a) stopping Twilio playback (`clear`) and (b) aligning conversation memory (`truncate`). This is exactly why the reference implementation **never sends `response.cancel` at all**. See G3 for what this means for BRD §5.6 step 3.

### V6. `input_audio_buffer.*` server events — **VERIFIED** (openai@6.48.0, verbatim)

- `speech_started {audio_start_ms, item_id, event_id}` — "Sent by the server when in `server_vad` mode to indicate that speech has been detected in the audio buffer. **This can happen any time audio is added to the buffer (unless speech is already detected).** The client may want to use this event to interrupt audio playback…" `audio_start_ms` is ms from start of all session audio written to the buffer, and "includes the `prefix_padding_ms`". `item_id` = ID of the user item that *will be created* when speech stops.
- `speech_stopped {audio_end_ms, item_id}` — emitted when VAD detects end of speech; `audio_end_ms` "includes the `min_silence_duration_ms`". Note the event *arrives* ≈`silence_duration_ms` after the user actually stopped — so wall-clock `speech_stopped → first audio delta` measures model+gateway TTFB *excluding* the VAD wait (relevant to BRD §5.9/FR-6 leg accounting).
- `committed {item_id, previous_item_id}` — "either by the client or automatically in server VAD mode… will trigger input audio transcription (if enabled) but will not create a response from the model." Under server-VAD never send `input_audio_buffer.commit` yourself — **BRD §5.3 claim confirmed.**
- `timeout_triggered {audio_start_ms, audio_end_ms, item_id}` — fires on `idle_timeout_ms`; commits empty audio and generates a response (model re-prompts the caller). **Not in the normalized mapper** → arrives as `custom` (see mapping table).

### V7. Twilio `mark` / `clear` semantics — **VERIFIED** (Twilio Media Streams WebSocket-messages docs, verbatim)

- Send `{event:'mark', streamSid, mark:{name}}` after each `media` send; "When that `media` message's playback is complete, Twilio sends a `mark` message to your server using the same `mark.name`."
- `clear`: "Send a `clear` message if you want to interrupt the audio that has been sent in various `media` messages. This empties all buffered audio **and causes any `mark` messages to be sent back** to your WebSocket server." → **after `clear`, all still-pending marks are echoed back anyway.** This drives Gotcha G2.
- Outbound `media` requires only `{event, streamSid, media:{payload}}`, base64 `audio/x-mulaw` @8000; "buffered and played in the order received"; **no pacing required, size unrestricted** (BRD §5.4 confirmed).
- Inbound `media.timestamp` = presentation timestamp in ms from stream start; `start` message carries `streamSid, callSid, accountSid, tracks, customParameters, mediaFormat {encoding:'audio/x-mulaw', sampleRate:8000, channels:1}` (BRD §5.4 confirmed).

### V8. Normalized AI SDK event protocol (BRD §5.3) — **VERIFIED**, with additions

Read directly from `@ai-sdk/provider@4.0.3` `dist/index.d.ts` lines 6360–6850. The BRD's §5.3 table is accurate. The full server-event union contains **more events than BRD §5.3 lists** — the bridge should at least not warn on: `conversation-item-added`, `output-item-done`, `content-part-added`, `content-part-done`, `audio-done`, `text-delta`, `text-done`, `function-call-arguments-delta`. Every server event carries `raw`. `speech-started`/`speech-stopped` carry optional `itemId`. `audio-delta` carries `responseId` **and** `itemId` (so `lastAssistantItemId` can come from either `output-item-added` or `audio-delta` — BRD correct). `parseServerEvent` is typed to return event **or array** (BRD correct; for the gateway model it is identity and returns whatever the wire delivered).

### V9. OpenAI-wire ↔ normalized mapping — **VERIFIED** from `@ai-sdk/openai@4.0.16` mapper (see full table in Implementation-grade detail)

`input_audio_buffer.speech_started` **is mapped** to `speech-started` in the public SDK mapper. This makes the BRD's [SPIKE] "speech-started normalized vs custom through the gateway" **LIKELY-normalized** — the gateway is documented as translating "between normalized AI SDK events and the provider's wire format" (vercel.com/docs/ai-gateway/modalities/realtime, last_updated 2026-06-20) and the only public reference translation maps it. Keep the fallback matcher; it is cheap insurance. Events **not** in the mapper surface as `custom {rawType, raw}` — notably `conversation.item.truncated` (the truncate ack), `input_audio_buffer.timeout_triggered`, `rate_limits.updated`, `conversation.item.done`, `conversation.item.input_audio_transcription.delta/failed`, and `input_audio_buffer.cleared`.

### V10. Gateway identity codec + connection details (BRD §5.2) — **VERIFIED** from `@ai-sdk/gateway@4.0.23` source

`GatewayRealtimeModel`: `parseServerEvent(raw){return raw}`, `serializeClientEvent(e){return e}`, `buildSessionConfig(c){return c}` — the JSON on the gateway WS **is** the normalized protocol. `doCreateClientSecret` source comment verbatim: "`sessionConfig` is intentionally unused here — it is applied later via the normalized `session-update` event." URL = `baseURL('https://ai-gateway.vercel.sh/v4/ai') → wss…/realtime-model?ai-model-id=<model>`. Subprotocols = `['ai-gateway-realtime.v1', 'ai-gateway-auth.<token>']` (+ optional `ai-gateway-team.<slug>`). Mint endpoint `POST /v1/realtime/client-secrets` with `{model, expiresIn}`. All BRD §5.2 claims confirmed against source.

### V11. Greeting pattern in the reference implementation — **VERIFIED**

The sample greets (when enabled) by sending, immediately after `session.update` **without waiting for `session.updated`**: a `conversation.item.create` (user text item instructing the model to greet) followed by `response.create` (index.js lines 108–126). WS client events are applied in order server-side, so config-then-respond back-to-back is the canonical pattern. The sample also delays `initializeSession` by `setTimeout(…, 100)` after WS open — a historical workaround, not a protocol requirement. Note the sample masks connection setup latency with a `<Say>` + `<Pause>` before `<Connect>` in the TwiML; the BRD design goes straight to `<Connect>`, so greeting latency budget = stream-start → gateway-open → session-update → response-create → first delta.

### V12. Normalized `turnDetection` cannot express `create_response` / `interrupt_response` / `idle_timeout_ms` / semantic-VAD `eagerness` — **VERIFIED** (gap the BRD does not mention)

`@ai-sdk/provider@4.0.3` `turnDetection` = `{type: 'server-vad'|'semantic-vad'|'disabled', threshold?, silenceDurationMs?, prefixPaddingMs?} | null`. That's all. The `@ai-sdk/openai` mapper likewise only maps those four. The bridge therefore **relies on OpenAI's defaults** `create_response:true, interrupt_response:true` (which is exactly what this design needs) and **cannot** turn on `idle_timeout_ms` through typed config. Possible escape hatch: `sessionConfig.providerOptions` — but in the public OpenAI codec it is `Object.assign`-ed **at the session root**, so `providerOptions: {audio: {...}}` would *replace* the entire built `audio` object (formats + turn_detection + transcription). If you use it, provide the complete `audio` subtree yourself. Whether the gateway's server-side mapping honors `providerOptions` at all is unverified → Open question O4.

### V13. `output_audio_buffer.clear` is WebRTC/SIP-only — **VERIFIED** (openai@6.48.0: "**WebRTC/SIP Only:** Emit to cut off the current audio response…")

Irrelevant on the WebSocket path; Twilio `clear` is the playback-stop mechanism. OpenAI docs (realtime-conversations guide) confirm: WebRTC/SIP interruption is server-managed; **WebSocket clients manage playback and must handle truncation manually** — which is this entire document.

---

## Implementation-grade detail

### D1. Complete OpenAI-wire ↔ normalized mapping table (from `@ai-sdk/openai@4.0.16` mapper — authoritative reference for gateway behavior)

**Server events (OpenAI → normalized):**

| OpenAI wire type | Normalized type | Field mapping |
|---|---|---|
| `session.created` | `session-created` | `sessionId ← session.id` |
| `session.updated` | `session-updated` | (inspect `.raw.session.audio` for applied formats) |
| `input_audio_buffer.speech_started` | `speech-started` | `itemId ← item_id` |
| `input_audio_buffer.speech_stopped` | `speech-stopped` | `itemId ← item_id` |
| `input_audio_buffer.committed` | `audio-committed` | `itemId, previousItemId` |
| `conversation.item.added` | `conversation-item-added` | `itemId ← item.id ?? item_id`, `item` |
| `conversation.item.input_audio_transcription.completed` | `input-transcription-completed` | `itemId, transcript ← transcript ?? ''` |
| `response.created` | `response-created` | `responseId ← response.id ?? response_id` |
| `response.done` | `response-done` | `responseId`, `status ← response.status ?? 'completed'` |
| `response.output_item.added` | `output-item-added` | `responseId, itemId ← item.id ?? item_id` |
| `response.output_item.done` | `output-item-done` | same |
| `response.content_part.added` / `.done` | `content-part-added` / `-done` | `responseId, itemId` |
| `response.output_audio.delta` | `audio-delta` | `responseId, itemId, delta` (base64) |
| `response.output_audio.done` | `audio-done` | `responseId, itemId` |
| `response.output_audio_transcript.delta` / `.done` | `audio-transcript-delta` / `-done` | `…, delta` / `…, transcript` |
| `response.output_text.delta` / `.done` | `text-delta` / `text-done` | `…, delta` / `…, text` |
| `response.function_call_arguments.delta` | `function-call-arguments-delta` | `responseId, itemId, callId, delta` |
| `response.function_call_arguments.done` | `function-call-arguments-done` | `responseId, itemId, callId, name, arguments` |
| `error` | `error` | `message ← error.message ?? message`, `code ← error.code ?? code` |
| **anything else** | `custom` | `rawType ← type`, `raw` — includes `conversation.item.truncated`, `input_audio_buffer.timeout_triggered`, `rate_limits.updated`, `conversation.item.done`, `conversation.item.input_audio_transcription.delta`, `input_audio_buffer.cleared`, `conversation.created`, `conversation.item.retrieved` |

**Client events (normalized → OpenAI):**

| Normalized | OpenAI wire |
|---|---|
| `session-update {config}` | `session.update {session: buildOpenAISessionConfig(config)}` — session gets `type:'realtime', model`, `instructions`, `output_modalities`, `audio.input.format {type[,rate]}`, `audio.input.turn_detection {type:'server_vad'\|'semantic_vad', threshold?, silence_duration_ms?, prefix_padding_ms?}` (or `null` for `'disabled'`), `audio.input.transcription {model: default 'gpt-realtime-whisper', language?, prompt?}`, `audio.output.format`, `audio.output.voice`, `tools[] + tool_choice:'auto'` (auto-set whenever tools non-empty), then `Object.assign(session, providerOptions)` |
| `input-audio-append {audio}` | `input_audio_buffer.append {audio}` |
| `input-audio-commit` / `input-audio-clear` | `input_audio_buffer.commit` / `.clear` |
| `conversation-item-create {item:{type:'text-message',role,text}}` | `conversation.item.create {item:{type:'message',role,content:[{type:'input_text',text}]}}` |
| `conversation-item-create {item:{type:'function-call-output',callId,output}}` | `conversation.item.create {item:{type:'function_call_output', call_id, output}}` (normalized `name` is dropped for OpenAI) |
| `conversation-item-truncate {itemId, contentIndex, audioEndMs}` | `conversation.item.truncate {item_id, content_index, audio_end_ms}` |
| `response-create {options?}` | `response.create {response:{output_modalities?, instructions?, metadata?}}` |
| `response-cancel` | `response.cancel` (no response_id) |

### D2. Response lifecycle (event order per turn, GA wire names)

```
response.created (status in_progress)
└─ response.output_item.added         (item_id of assistant message — capture!)
   └─ response.content_part.added
      ├─ response.output_audio.delta ×N        ← forward each to Twilio immediately
      ├─ response.output_audio_transcript.delta ×N
      ├─ response.output_audio.done
      └─ response.output_audio_transcript.done
   └─ response.content_part.done
└─ response.output_item.done
response.done {status: completed|cancelled|failed|incomplete, status_details.reason?}
```

For a function call, the output item is a `function_call` item instead: `function_call_arguments.delta ×N → …done {call_id, name, arguments}` then `response.done`. A single response can contain multiple output items (e.g., a function_call; audio usually arrives in a separate response after the tool output + `response.create`).

### D3. Per-call state — validated & extended

```ts
interface Session {
  twilioWs: WebSocket; gatewayWs: WebSocket;
  streamSid: string; callSid: string;
  // --- barge-in state ---
  latestMediaTimestamp: number;        // ms; ← every inbound Twilio media.timestamp
  responseStartTimestamp: number|null; // latestMediaTimestamp at FIRST audio-delta of the CURRENT response
  currentResponseId: string|null;      // ← audio-delta.responseId / response-created.responseId
  lastAssistantItemId: string|null;    // ← audio-delta.itemId (or output-item-added.itemId)
  markQueue: string[];                 // names of marks sent but not yet echoed  (length>0 ⇒ assistant audio buffered/playing)
  markSeq: number;                     // for unique mark names
  responseActive: boolean;             // response-created seen, response-done not yet (gates tool-flow response-create)
  pendingToolCalls: Map<string,…>;
  timestamps: …;                       // latency instrumentation (§5.9)
}
```

### D4. Event handlers — pseudocode (normalized event names, gateway leg)

```ts
// ── Twilio → bridge ─────────────────────────────────────────────
onTwilioMessage(msg):
  switch (msg.event):
    case 'start':
      streamSid = msg.start.streamSid; verify customParameters.token
      latestMediaTimestamp = 0; responseStartTimestamp = null; markQueue = []
    case 'media':
      latestMediaTimestamp = msg.media.timestamp
      if (gatewayWs.OPEN) send({type:'input-audio-append', audio: msg.media.payload})
      // (Path A pcmu: payload passes through unchanged; Path B: transcode first)
    case 'mark':
      // only pop if it matches; stale echoes after a clear must not corrupt the queue
      const i = markQueue.indexOf(msg.mark.name); if (i !== -1) markQueue.splice(i, 1)
      if (markQueue.length === 0) responseStartTimestamp = null   // playback finished → disarm truncate math
    case 'stop': teardown()

// ── gateway → bridge ────────────────────────────────────────────
onGatewayEvent(ev):                       // ev = JSON.parse(data); may be an array — iterate
  switch (ev.type):
    case 'response-created':
      responseActive = true
      // NEW response epoch: disarm stale math (fixes reference-impl bug, see G1)
      responseStartTimestamp = null; currentResponseId = ev.responseId
    case 'audio-delta':
      twilioWs.send({event:'media', streamSid, media:{payload: ev.delta}})  // immediately, never batch
      if (responseStartTimestamp == null || ev.responseId !== currentResponseId) {
        responseStartTimestamp = latestMediaTimestamp; currentResponseId = ev.responseId
      }
      lastAssistantItemId = ev.itemId
      const name = `r${ev.responseId}:${markSeq++}`
      twilioWs.send({event:'mark', streamSid, mark:{name}}); markQueue.push(name)
    case 'speech-started':            bargeIn()
    case 'custom':
      if (ev.rawType === 'input_audio_buffer.speech_started') bargeIn()  // [SPIKE] fallback
      else log(ev.rawType, ev.raw)    // e.g. conversation.item.truncated ack, timeout_triggered
    case 'response-done':
      responseActive = false; maybeSendPendingToolResponseCreate()
      // ev.status === 'cancelled' after barge-in is normal (raw.status_details.reason 'turn_detected')
    case 'function-call-arguments-done': runToolLoop(ev)     // §5.7
    case 'error':
      if (isBenignCancelError(ev)) log-and-ignore            // see G3
      else handle per FR-7

// ── barge-in (BRD §5.6, corrected) ──────────────────────────────
bargeIn():
  if (markQueue.length === 0 || responseStartTimestamp == null) return   // nothing audible → no-op
  const audioEndMs = Math.max(0, latestMediaTimestamp - responseStartTimestamp)
  twilioWs.send({event:'clear', streamSid})                 // 1. stop playback NOW (perceived latency)
  if (lastAssistantItemId != null)
    gwSend({type:'conversation-item-truncate', itemId: lastAssistantItemId,
            contentIndex: 0, audioEndMs})                   // 2. align model memory with heard audio
  // 3. response-cancel: OPTIONAL. Server already cancelled via interrupt_response default=true.
  //    If sent, expect+swallow a "no active response" error event. (See G3.)
  markQueue = []; lastAssistantItemId = null; responseStartTimestamp = null; currentResponseId = null
```

Ordering notes: `clear` and `truncate` go to *different* sockets, so no cross-ordering exists; send `clear` first (it is the caller-audible action). The reference impl sends truncate first — functionally equivalent. Within the gateway socket, `truncate` before any later `response-create` matters (in-order application).

### D5. Greeting-on-pickup (FR-1, "greets within ~2 s")

Two working variants, both canonical:

1. **`response-create` with instruction override** (cleanest, no conversation pollution):
   ```ts
   // on gateway WS open:
   gwSend({type:'session-update', config: {...full config incl. tools...}})   // FIRST message (30s rule)
   gwSend({type:'response-create', options:{instructions:
     'Greet the caller warmly in one short sentence and ask how you can help.'}})
   ```
   `response.create.response.instructions` "override the Session's configuration for this Response only" (openai@6.48.0, verbatim).
2. **Reference-impl variant:** `conversation-item-create {type:'text-message', role:'user', text:'Greet the user with …'}` then bare `response-create`. Leaves a synthetic user item in history.

Timing: no need to wait for `session-updated` — client events are applied in order (the reference impl relies on this). Caveat for the gateway hop: confirm at M1 that the greeting audio arrives in the format set by the immediately-preceding `session-update` (Open question O3); the conservative fallback (wait for `session-updated`, costs one RTT ≈ 50–100 ms) still fits the 2 s budget. Do NOT send `response-create` before `session-update`: the model would answer with defaults (PCM16@24k, default voice, no instructions).

The mark queue also gives a free "greeting finished" signal (queue drains) if you ever need it.

### D6. Server VAD tuning for PSTN (8 kHz μ-law narrowband)

| Knob | Default | PSTN guidance | Tradeoff |
|---|---|---|---|
| `silenceDurationMs` | 500 | **Start 500; try 400–450 for latency.** This is the *dominant, irreducible* term in voice-to-voice latency (BRD §3 budget assumes ~500). | Lower → snappier but the model "jumps in on short pauses" (docs verbatim) — clips slow/thinking speakers; phone speech has more mid-utterance pauses than desktop mic speech. |
| `threshold` | 0.5 | **Start 0.5; raise to 0.6 if spurious barge-ins** from line noise/background (cars, speakerphone). PSTN AGC boosts noise floors. | Higher → misses soft-spoken callers / first syllables (partially rescued by prefix padding). |
| `prefixPaddingMs` | 300 | **Keep 300.** Retrospective — does not add turn latency; ensures word onsets reach the model after threshold-crossing detection. | Lower risks clipped first words → worse transcription; higher adds nothing for phone audio. |
| `idle_timeout_ms` | off | Docs explicitly recommend for phone calls ("prompt the user to continue") — e.g. 8000–10000 to break dead-air stalemates. | **Not expressible through the normalized protocol** (V12) — needs providerOptions spike (O4) or accept absence for the PoC. |
| `semantic-vad` | — | Normalized type `'semantic-vad'` exists, but `eagerness` is not expressible (V12) → default eagerness `auto`(=medium, max 4 s wait). Not recommended for a latency-measurement PoC; adds variable turn-end latency. | Better end-of-turn detection vs. worse/variable latency. |

Every barge-in has an intrinsic floor of ~`audio_start_ms` detection lag + one leg of network: the model keeps "hearing" ~threshold-crossing-lag after the caller starts, and the Twilio `clear` takes bridge→Twilio→carrier time. FR-2's <500 ms stop target is comfortably achievable since `clear` is sent on `speech-started` which fires as soon as VAD trips (not after silence_duration).

---

## Gotchas & pitfalls

### G1. **The reference implementation's truncate math breaks on turn ≥ 2 — and BRD §5.6 as written inherits it** (CONFIRMED by code reading)

The sample only resets `responseStartTimestampTwilio` (a) on stream `start` and (b) inside the barge-in handler. On the *normal* path — response plays to completion, all marks echo, queue empties — it is **never reset**. The guard `if (!responseStartTimestampTwilio)` then skips re-arming on the next response's first delta, so a barge-in during any later response computes `audio_end_ms` from the *first* response's epoch → value far exceeds the item's real audio duration → OpenAI answers with an **error** (V3) and the conversation memory is never truncated (model believes the caller heard everything; playback still stops because `clear` is unconditional). Fixes (use both):
- Reset `responseStartTimestamp = null` on `response-created` (new epoch), and re-arm on first `audio-delta` keyed by `responseId` change (D4).
- Reset `responseStartTimestamp = null` when the mark queue drains to 0 (playback finished).

BRD §5.6 says "responseStartTimestamp (at first audio-delta of each response)" — correct intent, but its reset list (step 4: only on barge-in) reproduces the bug if implemented literally. **BRD correction required.**

### G2. Mark-echo storm after `clear` corrupts naive mark accounting (CONFIRMED via Twilio docs)

Twilio echoes **all pending marks back after a `clear`** (V7). The sample resets `markQueue = []` at barge-in; the stale echoes then arrive and, with a constant mark name (`'responsePart'`) and blind `shift()`, they decrement marks belonging to the *next* response → queue undercounts → a subsequent barge-in's `markQueue.length > 0` guard can fail → truncate/clear skipped (model keeps talking in memory; audio keeps playing). Fix: unique mark names per response (`r<responseId>:<seq>`) and remove-by-name only (D4). Low probability at PoC scale (requires user speech starting within the echo window) but it is the exact kind of intermittent turn-taking weirdness that wastes a debugging day.

### G3. `response-cancel` "belt-and-braces" (BRD §5.6 step 3) usually produces an error event — treat as benign

With `interrupt_response` defaulting to `true` (V5, and not overridable through the normalized config, V12), the server cancels the active response *itself* when speech starts; `response.done {status:'cancelled', reason:'turn_detected'}` follows. A client `response-cancel` sent right after will typically find no active response → server returns an `error` event (session unaffected, V4). Either drop step 3 entirely (the reference impl does) or whitelist that error (match on raw error code/message, e.g. codes like `response_cancel_not_active`; log `.raw` at M1 to pin the exact code). Do NOT let FR-7 error handling treat it as fatal.

### G4. `speech-started` with no active/audible response is normal — the guard is mandatory

Fires on every user utterance, including turn-1 before any response, during the tool-execution gap, and after playback finished. The `markQueue.length > 0 && responseStartTimestamp != null` guard makes those no-ops. Also: if the caller barges in *before the first delta arrives* (model still thinking), there is nothing at Twilio to clear and no item to truncate; server-side auto-cancel handles it. Rare residue: deltas already in flight/buffered at Twilio when you decided not to clear — if logs show this, extend barge-in to always send `clear` when `responseActive` even if `markQueue` is empty (but never truncate without an armed epoch).

### G5. Multiple barge-ins inside one response

After the first barge-in resets state, further `speech-started` events no-op until the next response's first delta re-arms the epoch. Correct and self-healing — provided G1/G2 fixes are in. Also expect `speech-started` → `speech-stopped` → `committed` → (auto) `response-created` cascades in quick succession; the state machine above needs no special casing.

### G6. Truncate `audio_end_ms` edge races (accept + log, don't crash)

Even with correct math, a mark echo can be in flight when `speech-started` arrives → elapsed slightly exceeds real heard duration; or elapsed exceeds *total* item audio duration in the final ~20 ms window → error from OpenAI (V3). Clamp is impossible client-side (you don't know the item's true duration cheaply); just treat truncate errors as non-fatal, log with `.raw`, and move on — playback is already stopped by `clear`. Truncating to `audioEndMs: 0` is legal (removes all audio+transcript from the item).

### G7. Tool-flow `response-create` can collide with a VAD-auto-created response

`create_response:true` means the caller speaking right after a tool call spawns a response automatically. If the bridge then fires its tool-output `response-create` while that response is active → error `conversation_already_has_active_response`-class failure. The BRD §5.7 gate (wait for `response-done` AND all pending outputs) is necessary but not sufficient — also check `responseActive === false` at send time and defer to the next `response-done` otherwise (D4). Out-of-band responses (`conversation:'none'`) exist on the OpenAI wire but are not expressible through the normalized `response-create.options` — don't design around them.

### G8. Unmapped events arrive as `custom` — log, never warn-loop

Per V9 the truncate ack (`conversation.item.truncated`), `timeout_triggered`, `rate_limits.updated`, transcription deltas/failures etc. arrive as `custom`. Use the truncate-ack `custom` event as the M2 acceptance signal that barge-in memory-alignment actually worked (its `audio_end_ms` echoes what the server applied). One structured log line per `custom.rawType`, rate-limited — Railway's 500 lines/s cap (§5.9) is reachable if you log every `rate_limits.updated` in a 5-call test.

### G9. `latestMediaTimestamp` is the *inbound* (caller) clock

It advances only while Twilio sends inbound media. Twilio sends continuous frames including silence, so it is a reliable wall clock in practice; but if inbound media ever pauses (hold, some SIP forwarding paths), the epoch math freezes and `audio_end_ms` undercounts (harmless: truncation errs toward keeping more context). Do not substitute `Date.now()` deltas — Twilio's clock is the one aligned to what the caller hears.

### G10. Do not reuse beta wire names

The GA API (and everything above) uses `response.output_audio.delta`, `conversation.item.added`, `session:{type:'realtime', audio:{input:{format:{type:'audio/pcmu'}}}}`. Older blog posts/samples use beta names (`response.audio.delta`, `input_audio_format:'g711_ulaw'`, `conversation.item.created`). The `@ai-sdk/openai` mapper handles **GA names only**; if any raw-fallback matching is written (per BRD §5.3 [SPIKE]), match GA names.

---

## Open questions (need runtime spike)

- **O1 (BRD M1 [SPIKE], unchanged):** Does the gateway emit `speech-started` normalized, or as `custom {rawType:'input_audio_buffer.speech_started'}`? Public-mapper evidence says normalized (V9) but the gateway's server-side translator is closed-source. The D4 handler covers both.
- **O2:** Does the gateway forward `conversation-item-truncate` → OpenAI `conversation.item.truncate` faithfully, and does the `conversation.item.truncated` ack come back (as `custom`)? No public evidence either way; the client event exists in the normalized protocol (V8) so it should. M2 acceptance: after a barge-in, ask the model "what did you just say?" — it should only recall the heard portion.
- **O3:** In-order application of `session-update` → `response-create` sent back-to-back *through the gateway* (greeting arrives in pcmu with the configured voice?). Direct-OpenAI ordering is guaranteed; the gateway adds a hop. Cheap test at M1; fallback = wait for `session-updated`.
- **O4:** Does the gateway pass `sessionConfig.providerOptions` through to the provider session (needed for `interrupt_response`, `idle_timeout_ms`, semantic-VAD `eagerness`)? If yes, what merge shape (root-level Object.assign clobbers `audio`, V12)? Test by sending `providerOptions` and diffing `session-updated.raw`.
- **O5:** Exact error `code` strings surfaced through the gateway for (a) cancel-with-no-active-response, (b) truncate-out-of-range, (c) create-while-active — needed for the G3/G6/G7 whitelists. Log `.raw` on every `error` event at M1/M2 and pin the codes.
- **O6:** Whether `response-done.status === 'cancelled'` arrives normalized with the `turn_detected` reason accessible in `.raw.response.status_details` (useful for the §5.9 barge-in log line).
- **O7:** Typical `audio-delta` chunk cadence/size through the gateway for pcmu output (affects mark granularity — one mark per delta is fine for Twilio, but 100+ marks per response is log noise; if deltas are very small, consider marking every Nth delta while keeping accounting exact).

---

## BRD corrections (delta vs. BRD_Micro_Voice_PoC.md)

1. **§5.6 (must fix):** add "reset `responseStartTimestamp` on every `response-created` and re-arm on first `audio-delta` per `responseId`; also reset when the mark queue drains" — otherwise the literal reading reproduces the reference implementation's stale-epoch bug (G1) and truncate errors on every barge-in after the first non-interrupted turn.
2. **§5.6 step 3 (soften):** `response-cancel` is redundant under server-VAD defaults (`interrupt_response:true`) and will typically return an error event; either omit (canonical sample omits it) or explicitly whitelist the resulting error (G3).
3. **§5.6/§5.4 (accounting):** after Twilio `clear`, pending marks are echoed back; use unique per-response mark names + remove-by-name, not a bare `shift()` (G2). BRD wording "mark … powers the barge-in `audioEndMs` math" is slightly off: marks gate *whether* barge-in handling runs (audio still audible?); `audioEndMs` comes from media timestamps.
4. **§5.3 (addition):** normalized `turnDetection` cannot express `create_response` / `interrupt_response` / `idle_timeout_ms` / `eagerness` (V12); design depends on OpenAI defaults (both `true`). `providerOptions` escape hatch is root-level-merge (clobbers `audio`) in the public codec and unverified through the gateway.
5. **§5.3 (completeness):** server-event union also includes `conversation-item-added`, `output-item-done`, `content-part-added/done`, `audio-done`, `text-delta/done`, `function-call-arguments-delta` — bridge should silently accept these.

## Sources

- https://raw.githubusercontent.com/twilio-samples/speech-assistant-openai-realtime-api-node/main/index.js (full source, fetched 2026-07-18; local copy: `scratchpad/refs/twilio-sample-index.js`)
- https://github.com/twilio-samples/speech-assistant-openai-realtime-api-node (README: barge-in description)
- `@ai-sdk/provider@4.0.3` → `node_modules/@ai-sdk/provider/dist/index.d.ts` lines 6360–6850 (RealtimeModelV4 protocol)
- `@ai-sdk/openai@4.0.16` → `node_modules/@ai-sdk/openai/dist/index.js` lines ~3220–3607 (`parseOpenAIRealtimeServerEvent`, `serializeOpenAIRealtimeClientEvent`, `buildOpenAISessionConfig`, `OpenAIRealtimeModel`)
- `@ai-sdk/gateway@4.0.23` → `node_modules/@ai-sdk/gateway/dist/index.js` lines 1–40 (subprotocols), 2235–2290 (`GatewayRealtimeModel` identity codec, token mint), 2648 (default baseURL)
- `openai@6.48.0` → `node_modules/openai/resources/realtime/realtime.d.ts` (verbatim API-reference doc comments: ConversationItemTruncateEvent/TruncatedEvent, InputAudioBufferSpeechStarted/Stopped/Committed/TimeoutTriggered, ResponseCancelEvent, ResponseCreateEvent, RealtimeResponseStatus, RealtimeAudioInputTurnDetection.ServerVad/SemanticVad, OutputAudioBufferClearEvent)
- https://platform.openai.com/docs/guides/realtime-vad (→ developers.openai.com/api/docs/guides/realtime-vad) — server VAD semantics, semantic VAD
- https://developers.openai.com/api/docs/guides/realtime-conversations — WS-vs-WebRTC interruption responsibilities
- https://developers.openai.com/api/reference/resources/realtime/client-events — VAD defaults (0.5 / 300 ms / 500 ms, idle_timeout_ms 5000–30000)
- https://www.twilio.com/docs/voice/media-streams/websocket-messages — media/mark/clear/start message semantics (incl. mark echo after clear)
- https://vercel.com/docs/ai-gateway/modalities/realtime.md (last_updated 2026-06-20) — gateway codec roles, session limits, Node.js WS pattern

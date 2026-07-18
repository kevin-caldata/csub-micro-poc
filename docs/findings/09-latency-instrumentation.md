# Findings 09 — Latency Instrumentation & Structured Logging (FR-6)

**Date:** 2026-07-18
**Scope:** Verification and implementation-grade deepening of BRD §5.9 (logging & latency instrumentation), the NFR latency target (§3), FR-1 greeting latency, FR-6 per-turn instrumentation, M3 tool-round-trip measurement, and M5 findings report. Covers: what to timestamp per turn, honest voice-to-voice measurement (server-observable vs not), monotonic clocks in Node, per-call percentile computation, structured JSON log-line design, Railway Log Explorer query syntax, published comparable latency numbers, and the logger implementation recommendation (pino vs hand-rolled).

---

## Verified claims

### V1. Railway structured JSON logs: `message` + `level` fields, custom attributes queryable — **VERIFIED**
Railway parses single-line JSON emitted to stdout. Special fields: `message` (required — the log content) and `level` (`debug` | `info` | `warn` | `error`, colorized in the explorer). Any additional JSON field becomes a queryable custom attribute via `@name:value`. Logs emitted to **stderr are forced to `level: error`** and display red regardless of their JSON `level` field. The **entire JSON object must be on a single line** or Railway treats it as plain text.
Source: https://docs.railway.com/observability/logs (fetched 2026-07-18).

### V2. Railway rate limit: 500 log lines/sec/replica — **VERIFIED**
Exact docs language: threshold is "500 log lines per second per replica" across all plans. Excess lines are **dropped** and Railway injects a warning line: `"Railway rate limit of 500 logs/sec reached for replica, update your application to reduce the logging rate. Messages dropped: 50"`. This confirms the BRD §5.9 rule "one line per event, never per frame" (Twilio sends ~50 media frames/sec/call; gateway sends many audio-deltas/sec — logging either per-frame would burn the budget at ~5 concurrent calls).
Source: https://docs.railway.com/observability/logs

### V3. Railway Log Explorer filter syntax, incl. `@callSid:<sid>` — **VERIFIED**
The BRD's `@callSid:<sid>` example is valid syntax. Full verified syntax:
- `<keyword>` / `"key phrase"` — partial substring match
- `@attribute:value` — custom attribute filter (e.g. `@callSid:CAxxxx`, `@level:error`)
- `@arrayAttribute[i]:value` — array element
- `replica:<replica_id>`, `@service:<service_id>`
- Boolean: `AND`, `OR`, `-` (negation), parentheses for grouping
- Numeric (works for deployment logs with JSON logging): `>`, `>=`, `<`, `<=`, `..` inclusive range — e.g. `@ttfbMs:>800`, `@retries:1..3`, `@httpStatus:500..599`
- Verbatim doc examples: `@level:error AND "failed to send batch"`, `@task_duration:>=600`, `@batch_size:>100`
Source: https://docs.railway.com/observability/logs

### V4. Railway log retention: **7 days on Hobby** — **VERIFIED** (not in BRD — see Gotchas)
Hobby/Trial: 7 days. Pro: 30 days. Enterprise: up to 90 days. The PoC's measured latency data (the M5 deliverable) evaporates 7 days after each test call unless extracted.
Source: https://docs.railway.com/observability/logs

### V5. Normalized event names used for instrumentation hooks — **VERIFIED against published package source**
Grep of the installed tarball `@ai-sdk/provider@4.0.3` (`node_modules/@ai-sdk/provider/src/realtime-model/v4/realtime-model-v4-server-event.ts` and `dist/index.d.ts`) confirms the exact discriminated-union event types the instrumentation keys on: `speech-started`, `speech-stopped`, `audio-committed`, `response-created {responseId}`, `response-done {responseId, status}`, `output-item-added {responseId, itemId}`, `audio-delta {responseId, itemId, delta}`, `function-call-arguments-done {responseId, itemId, callId, name, arguments}`, `input-transcription-completed {itemId, transcript}`, `error {message, code?}`, `custom {rawType, raw}`. Every server event carries `.raw`.
**Critical instrumentation detail:** the normalized `speech-stopped` event carries **only `{type, itemId?, raw}` — no timing fields whatsoever**. Any VAD-timing detail (OpenAI's `audio_end_ms`) is only available via `.raw`, IF the gateway passes the raw OpenAI event through (see Open Questions).
Source: `@ai-sdk/provider@4.0.3` installed from npm, file path above.

### V6. OpenAI server_vad defaults: threshold 0.5, prefix_padding_ms 300, **silence_duration_ms 500** — **VERIFIED**
OpenAI docs confirm server_vad is the default turn-detection mode and `silence_duration_ms` defaults to **500 ms** ("With shorter values the model will respond more quickly, but may jump in on short pauses from the user"). This is the deterministic floor under caller-perceived latency: the model cannot begin responding until 500 ms of silence has elapsed after the caller's last word. The BRD's "server-VAD silence ~500 ms" term in the NFR decomposition is correct.
Sources: https://developers.openai.com/api/docs/guides/realtime-vad ; https://platform.openai.com/docs/guides/realtime-vad (301 → same page).

### V7. Twilio `media.timestamp` semantics — **VERIFIED**
Inbound `media.timestamp` = "Presentation Timestamp in Milliseconds from the start of the stream". So it is **stream-relative media time**, not wall time — usable for barge-in `audioEndMs` math and for cross-checking the VAD window, but never comparable to `performance.now()` or `Date.now()` without anchoring at the `start` event.
Source: https://www.twilio.com/docs/voice/media-streams/websocket-messages

### V8. Twilio `mark` echo = playback-complete signal — **VERIFIED**
"Send a `mark` event message after sending a `media` event message to be notified when the audio that you have sent has been completed." Twilio echoes the same `mark.name` "when that media message's playback is complete". A `clear` message "empties all buffered audio and causes any mark messages to be sent back". Consequence for instrumentation: a mark queued **immediately after the first outbound media chunk of a response** is echoed at ≈ (moment the caller starts hearing audio) + (chunk duration) + (Twilio→bridge WS one-way). This is the only server-side proxy for "caller heard it".
Source: https://www.twilio.com/docs/voice/media-streams/websocket-messages

### V9. `performance.now()` is monotonic; `Date.now()` is not — **VERIFIED**
MDN (normative reference to W3C hr-time): "`Date.now()` may have been impacted by system and user clock adjustments, clock skew, etc. ... `performance.now()` ... is relative to the `timeOrigin` property which is a monotonic clock: **its current time never decreases and isn't subject to adjustments**." Node docs: `performance.now()` "returns the current high resolution millisecond timestamp, where 0 represents the start of the current node process"; `performance.timeOrigin` is the Unix-time instant the process began. `performance` is a global in Node ≥16 (confirmed on local Node v22.14.0: `typeof performance.now === 'function'`, `performance.timeOrigin` populated). `process.hrtime.bigint()` is the nanosecond-resolution alternative; sub-millisecond precision is irrelevant at voice-latency scale, so `performance.now()` (fractional ms) is the right tool.
Sources: https://developer.mozilla.org/en-US/docs/Web/API/Performance/now ; https://nodejs.org/api/perf_hooks.html ; local run on Node v22.14.0.

### V10. pino's default output is INCOMPATIBLE with Railway's expected shape — **VERIFIED** (drives the logger recommendation)
pino's default line: `{"level":30,"time":1531254555820,"pid":55956,"hostname":"x","msg":"hello"}` — `level` is a **number** (30 = info), message key is **`msg`** (default `messageKey: 'msg'`), plus `pid`/`hostname` noise from `base`. Railway expects `message` (string key) and `level` as a **string label**. Making pino Railway-native requires `messageKey: 'message'`, `formatters: { level: (label) => ({ level: label }) }`, and `base: undefined`. Possible, but at ~10–30 log lines/sec total, pino's performance machinery (sonic-boom, worker transports) buys nothing. See Implementation-grade detail for the recommendation.
Source: https://raw.githubusercontent.com/pinojs/pino/main/docs/api.md (defaults table + formatters section).

### V11. BRD NFR decomposition (silence 500 + TTFB ~500 + network 100–200) is consistent with published numbers — **VERIFIED as plausible / LIKELY as achievable**
- **Twilio's own latency guide (Nov 2025):** end-to-end "mouth-to-ear turn gap" target **1,115 ms median / 1,400 ms upper limit**; platform turn gap 885 ms median / 1,100 ms upper. Waterfall components: audio→media edge 40 ms, buffering 30 ms, decoding 25 ms; cascaded budget STT 350 / LLM TTFT 375 / TTS TTFB 100. "At least ten network traversals: two voice legs over the public network (internet or PSTN) and eight inter-service handoffs." Twilio ConversationRelay managed service: "<0.5 s median latency, <0.725 s at p95" (platform-side). Source: https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents
- **techsy.io (May 2026, 40 PSTN test calls, server colocated near OpenAI's region):** `gpt-realtime-2` + `semantic_vad` + low reasoning: **p50 1.1 s / p95 1.9 s** round-trip; `server_vad` + low reasoning: **~1.4 s p50 / ~2.3 s p95**; `semantic_vad` + medium reasoning: ~1.8 s / ~3.1 s. Source: https://techsy.io/en/blog/openai-realtime-api-voice-agent (independent blog; methodology thin — treat as indicative, not authoritative).
- **Softcery / Artificial Analysis (Apr 2026):** model TTFA (time-to-first-audio): OpenAI gpt-realtime-1.5 ~0.82 s; "Phone networks add 100–200 ms fixed latency"; human baseline ~200 ms. Source: https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture
- **dev.to "Sub-200ms" article:** headline claim ("roughly 200 ms from when someone finishes speaking to when the agent starts responding") has **no instrumentation methodology at all** — qualitative only. **Do not cite as a comparable.** Source: https://dev.to/ryancwynar/sub-200ms-voice-ai-bridging-twilio-and-openai-realtime-api-21g3

Net read: the BRD's **1.0–1.5 s p50 target is realistic but tight with `server_vad`** (best published server_vad comparable is ~1.4 s p50 direct-to-OpenAI, i.e. *without* a gateway hop). If measurements land 1.4–1.7 s, the first knob is the VAD (`silenceDurationMs` below 500, or semantic VAD if the gateway's normalized `turnDetection` exposes it), not the bridge.

### V12. BRD §5.9 event list and FR-6 acceptance — **VERIFIED as internally consistent**
The three FR-6 timestamps (speech-stopped → first audio-delta → first byte to Twilio) are all bridge-observable and correctly decompose into (model+gateway TTFB) + (bridge cost). No BRD claim in this domain was found wrong. Gaps (retention, non-audio turns, barge-in contamination of stats) are covered below.

---

## Implementation-grade detail

### 1. Clock discipline

- **All deltas:** `performance.now()` (monotonic, fractional ms, process-relative). Never subtract two `Date.now()` values for a latency metric (NTP slew on the Railway host would silently corrupt tails).
- **One wall-clock field per line** for cross-correlation with Twilio Call logs / Vercel dashboard: `ts: new Date().toISOString()`. Railway also stamps its own ingest time, but the app-side wall clock survives log export.
- **Twilio media time** (`media.timestamp`, stream-relative ms) is a third clock. Anchor it once: at the `start` message record `tStreamStartPerf = performance.now()`; then `mediaTsToPerf(t) = tStreamStartPerf + t` is approximately comparable (±jitter) to perf timestamps. Use only for barge-in math and VAD cross-checks, never for headline metrics.
- Round all logged deltas to 1 decimal: `Math.round(x * 10) / 10` — keeps lines compact, sub-0.1 ms precision is noise.

### 2. Per-turn timestamp set (the core of FR-6)

Add to the per-call `Session` (BRD §5.8) a `currentTurn` and a `turns: TurnRecord[]`:

```ts
interface TurnRecord {
  turn: number;                    // 1-based
  responseId?: string;
  // perf.now() timestamps
  tSpeechStopped?: number;         // arrival of normalized 'speech-stopped'
  tResponseCreated?: number;       // 'response-created' (server-vad auto-creates)
  tFirstAudioDelta?: number;       // first 'audio-delta' with this responseId
  tFirstTwilioSend?: number;       // after twilioWs.send() of the first media frame
  tFirstMarkEcho?: number;         // echo of the mark queued after the first media frame
  tResponseDone?: number;
  // tool sub-record (may repeat if multiple calls in one turn)
  tools: ToolTiming[];
  bargedIn: boolean;               // speech-started arrived before response-done
  // derived (computed at close, logged in the 'turn' line)
  ttfbMs?: number;                 // tFirstAudioDelta - tSpeechStopped  → model+gateway TTFB
  bridgeMs?: number;               // tFirstTwilioSend - tFirstAudioDelta → decode+transcode+send
  turnMs?: number;                 // tFirstTwilioSend - tSpeechStopped  → server-observable voice-to-voice core
  playbackConfirmMs?: number;      // tFirstMarkEcho - tFirstTwilioSend  → Twilio buffer/WS proxy
}

interface ToolTiming {
  callId: string; name: string;
  tArgsDone: number;               // 'function-call-arguments-done' arrival
  tToolResolved?: number;          // MCP client.callTool() promise resolved
  tOutputSent?: number;            // conversation-item-create (function-call-output) sent
  tResponseCreateSent?: number;    // the gated follow-up 'response-create' sent
  tFollowupFirstDelta?: number;    // first audio-delta of the follow-up responseId
  // derived: mcpMs, gateWaitMs, secondTtfbMs, toolTotalMs
}
```

**Turn state machine** (server_vad flow is `speech-stopped` → `audio-committed` → `response-created` → `output-item-added` → `audio-delta`*):
1. On `speech-stopped`: close any dangling turn (mark incomplete), open `currentTurn = { turn: n++, tSpeechStopped: now(), tools: [], bargedIn: false }`.
2. On `response-created`: if `currentTurn` lacks a `responseId`, attach it + `tResponseCreated`. (Follow-up responses after tool output get attached to the pending `ToolTiming` instead — you sent that `response-create` yourself, so you know.)
3. On `audio-delta`: if `delta.responseId === currentTurn.responseId` and `tFirstAudioDelta` unset → stamp it; after the Twilio send of that first frame stamp `tFirstTwilioSend`, send a mark named `t<turn>-first`, and emit the `first-audio-delta` + `first-twilio-send` log events. **Do not log subsequent deltas.**
4. On mark echo `t<turn>-first`: stamp `tFirstMarkEcho`.
5. On `speech-started` before `response-done`: `bargedIn = true` (barge-in sequence runs per BRD §5.6; log a `barge-in` event with `msSinceFirstSend`).
6. On `response-done`: stamp, compute derived fields, `turns.push(currentTurn)`, emit ONE consolidated `turn` line (see §5), clear `currentTurn`.

**Edge cases that will otherwise corrupt the stats:**
- **Turn with no audio** (model goes straight to a function call): `tFirstAudioDelta` stays unset for R1; the caller-perceived response is the follow-up R2 audio. Log the turn with `ttfbMs` absent and `toolTotalMs` present; the honest caller-perceived number for that turn is `tools[last].tFollowupFirstDelta − tSpeechStopped`. (With the BRD's "say you're checking first" prompt, R1 usually *does* have audio and the tool wait is a second, separate gap — log both.)
- **Barge-in turns**: exclude from p50/p95 TTFB? No — TTFB is still valid (audio started before the interrupt). Exclude only turns where barge-in happened *before* first audio delta. Tag all with `bargedIn` so either cut can be computed offline.
- **Greeting** is not a VAD turn — separate record (§3).

### 3. Greeting latency (FR-1: "greets within ~2 s of pickup")

Timestamps: `tTwimlPost` (webhook handler entry) → `tWsStart` (Twilio `start` message — closest observable proxy for "pickup") → `tGatewayOpen` (gateway WS `open`) → `tSessionUpdateSent` → `tSessionUpdated` (ack) → `tGreetingCreateSent` (`response-create`) → `tFirstAudioDelta` → `tFirstTwilioSend` → `tFirstMarkEcho`.
Emit one `greeting` line with all consecutive deltas. Greeting budget decomposition against the ~2 s target: webhook→start is Twilio-internal (~300–700 ms, includes call setup); `getToken` runs at webhook time (BRD: ~100 ms, off the audio path — but **log `getTokenMs` anyway**, it gates how early the gateway WS can open); gateway open + session-update + response-create + TTFB is the part you own.

### 4. Tool round-trip (M3 acceptance: < 1.5 s in logs)

Per `ToolTiming` derived fields, logged in a single `tool-call` line:
- `mcpMs = tToolResolved − tArgsDone` (localhost MCP hop — expect single-digit ms)
- `gateWaitMs = tResponseCreateSent − tOutputSent` (time spent waiting on the BRD §5.7 gate, i.e. `response-done` of the tool-bearing response)
- `secondTtfbMs = tFollowupFirstDelta − tResponseCreateSent` (the second model inference — the dominant term)
- `toolTotalMs = tFollowupFirstDelta − tArgsDone`
This decomposition proves (or disproves) the BRD's claim that "the perceived cost is one extra model TTFB".

### 5. Log-line design (one line per event, flat fields)

Rules:
- **Never log:** `media` frames, `input-audio-append`, `audio-delta` after the first per response, `audio-transcript-delta`, mark echoes other than the instrumented first-mark. Everything else is fair game (~10–20 lines per turn max ⇒ ~2–6 lines/sec/call ⇒ ~30 lines/sec at 5 concurrent calls — 6% of the 500/s cap).
- **Flat, top-level fields only** for anything you want to query: Railway's documented filters are `@attr:value` and `@arr[i]:value`; nested-object filtering is not documented (see Open Questions). Numeric fields at top level enable `@ttfbMs:>800`.
- Constant field set: `message` (human-readable), `level`, `ts` (ISO wall), `callSid`, `streamSid`, `event` (machine-readable enum), plus event-specific deltas.

Event vocabulary (superset of BRD §5.9): `stream-start`, `gateway-open`, `session-updated` (include applied audio format from `.raw`), `greeting`, `speech-started`, `speech-stopped`, `first-audio-delta` (with `ttfbMs`), `first-twilio-send` (with `bridgeMs`), `turn` (consolidated — the line the analysis queries), `tool-call`, `barge-in`, `input-transcript`, `output-transcript`, `custom` (with `rawType` + serialized `.raw`), `error`, `gateway-close`, `stream-stop` (call summary).

Example lines:
```json
{"message":"turn 4 complete","level":"info","ts":"2026-07-18T17:03:22.114Z","callSid":"CAxxxx","event":"turn","turn":4,"responseId":"resp_abc","ttfbMs":612.4,"bridgeMs":3.1,"turnMs":615.5,"playbackConfirmMs":41.0,"bargedIn":false,"toolCalls":0}
{"message":"tool get_current_time round trip","level":"info","ts":"...","callSid":"CAxxxx","event":"tool-call","turn":5,"tool":"get_current_time","callId":"call_1","mcpMs":4.2,"gateWaitMs":112.0,"secondTtfbMs":540.8,"toolTotalMs":688.3}
{"message":"call summary","level":"info","ts":"...","callSid":"CAxxxx","event":"stream-stop","durationS":312.4,"turns":14,"bargeIns":2,"ttfbP50":598.2,"ttfbP95":901.4,"ttfbMax":1004.0,"bridgeP50":3.0,"bridgeP95":6.8,"turnP50":602.0,"turnP95":905.1,"toolCalls":2,"toolTotalP50":702.1,"loopP99Ms":12.4}
```

### 6. Minimal logger — recommendation: **hand-rolled (~25 lines), not pino**

Rationale: (a) pino's defaults mismatch Railway's parser (V10) and need three config overrides; (b) throughput here is ~30 lines/s vs pino's raison d'être of 10k+/s; (c) zero deps = zero version drift in a pinned-exact project; (d) `pino-pretty` for local dev is replaceable by piping through `npx pino-pretty` anyway or just reading JSON. If the team already standardizes on pino elsewhere, the exact Railway-compatible config is: `pino({ messageKey: 'message', base: undefined, timestamp: pino.stdTimeFunctions.isoTime, formatters: { level: (label) => ({ level: label }) } })`. Otherwise:

```ts
// src/logger.ts
type Level = 'debug' | 'info' | 'warn' | 'error';
const MIN: Level = (process.env.LOG_LEVEL as Level) ?? 'info';
const rank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (rank[level] < rank[MIN]) return;
  // Railway: single-line JSON on stdout; 'message' + string 'level' are the special fields.
  // Never write app logs to stderr (Railway forces stderr to level=error).
  process.stdout.write(
    JSON.stringify({ message, level, ts: new Date().toISOString(), ...fields }) + '\n',
  );
}

export const ms = (a: number, b: number): number => Math.round((b - a) * 10) / 10;
export const now = (): number => performance.now(); // monotonic; global in Node >=16
```

Notes: `JSON.stringify` drops `undefined` fields automatically (convenient for optional deltas). Guard the one place that serializes `.raw` with a try/catch + `String(err)` fallback. `process.stdout.write` is fire-and-forget; at these volumes backpressure is unreachable.

### 7. Percentiles: array + sort at call end (no streaming estimator)

Calls are 5–10 min ⇒ ~10–60 turns ⇒ a per-call `number[]` costs a few hundred bytes. Streaming percentile structures (t-digest, P²) are unjustifiable complexity here. Nearest-rank at `stream-stop`:

```ts
function pct(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
```

**Caveat to state in the findings report:** with n < 20 turns, "p95" is effectively the max — always log `max` and `n` alongside. Cross-call aggregate percentiles (the real M5 numbers) should be computed **offline** over the exported `event:turn` lines (Railway explorer filter `@event:turn`, download/copy, aggregate with a script), not by averaging per-call p50s (averaging percentiles is statistically wrong).

### 8. Event-loop lag guard (cheap, catches bridge-induced jitter at M4 concurrency)

```ts
import { monitorEventLoopDelay } from 'node:perf_hooks';
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
// in the stream-stop summary:  loopP99Ms: Math.round(loop.percentile(99) / 1e6 * 10) / 10
```
If `bridgeMs` degrades at 5 concurrent calls, `loopP99Ms` says whether it's the event loop (DSP on the main thread) or the network.

### 9. Honest voice-to-voice accounting (what the logs can and cannot claim)

Server-observable core: `turnMs = tFirstTwilioSend − tSpeechStopped`. The caller experiences approximately:

```
mouth-to-ear turn gap ≈
    uplink: last syllable → Twilio media edge → bridge → gateway → OpenAI   (~100–250 ms, unobservable)
  + VAD silence window (silence_duration_ms, default 500 ms, deterministic)
  + VAD processing + speech_stopped propagation back through gateway        (folded into measured TTFB start)
  + measured ttfbMs + bridgeMs                                              (the logs' contribution)
  + downlink: bridge → Twilio (~10–40 ms WS) → jitter/playout buffer → PSTN → ear (~100–200 ms)
```

So report honestly: **"measured server-side turn core X ms; estimated caller-perceived ≈ X + ~500 ms (VAD) + ~200–450 ms (PSTN/network legs, unmeasured)"**. With target turn core ~400–600 ms, this lands inside the BRD's 1.0–1.5 s window and matches Twilio's published 1,115 ms median mouth-to-ear target and techsy's 1.1–1.4 s p50 PSTN measurements (V11).

Server-side aids to tighten the estimate:
- **`playbackConfirmMs`** (first-mark echo) bounds the bridge→Twilio leg + Twilio buffering.
- **VAD cross-check:** at `speech-stopped` arrival, log `latestMediaTimestamp` (Twilio media clock) and, if `.raw` passes through, OpenAI's `audio_end_ms`; the arrival-time-minus-speech-end gap ≈ silence window + gateway propagation. Log it as `vadGapMs` [SPIKE — depends on raw passthrough].
- **Ground truth calibration (recommended for M5, fits the no-recording constraint):** make 2–3 test calls on speakerphone next to a laptop recording room audio (Audacity/QuickTime); measure the audible gap in the waveform; report the offset between waveform-measured and server-measured. One paragraph in the README turns "estimated" into "calibrated".

### 10. Railway Log Explorer queries to document in the README

```
@callSid:CAxxxxxxxx                          # one call, all events
@event:turn AND @ttfbMs:>800                 # slow turns across all calls
@event:turn AND @bargedIn:false              # clean turns for percentile extraction
@event:stream-stop                           # per-call summaries
@event:tool-call AND @toolTotalMs:>1500      # M3 acceptance violations
@level:error OR @event:custom                # anomalies incl. unmapped gateway events
@callSid:CAxxxx AND (@event:first-audio-delta OR @event:barge-in)
```

---

## Gotchas & pitfalls

1. **7-day Hobby log retention (V4)** — the M5 findings data self-destructs. Extract `@event:turn` and `@event:stream-stop` lines within days of each measurement session (or attach a Railway log-drain/Vector forwarder). *Biggest operational risk in this domain and absent from the BRD.*
2. **pino defaults break Railway parsing (V10)** — numeric `level:30` and `msg` key mean no level colorization and `@level:error` filters miss everything. Use the hand-rolled logger or the exact config in §6.
3. **stderr is forced to `level:error`** on Railway — never `console.error` for non-errors; route everything through the logger to stdout. Also beware libraries (Fastify default logger, ws debug) writing non-JSON or stderr lines.
4. **Multi-line JSON = plain text** to Railway's parser. Never `JSON.stringify(x, null, 2)` in production paths; never let stack traces print raw (put them in a `stack` field of a single-line error log).
5. **`Date.now()` deltas lie** under NTP adjustment; `performance.now()` deltas from *different processes/restarts* are incomparable. Keep both clocks, use each only for its job (V9, §1).
6. **`ws.send()` returns after enqueue, not flush.** `tFirstTwilioSend` stamped after `send()` measures bridge compute + enqueue. For full honesty stamp in the send callback (`twilioWs.send(data, () => stamp())`) — the delta between the two is normally <1 ms; if it grows, the socket is backpressured. Logging both once per turn is cheap.
7. **Don't log per audio-delta.** A talkative model emits tens of deltas/sec; multiplied by 5 calls this alone can brush the 500/s cap and, worse, adds JSON.stringify work on the hot path. First-delta-per-response only.
8. **`speech-stopped` arrival ≠ end of speech.** It fires after the silence window and one gateway hop. `ttfbMs` is honestly "model+gateway TTFB from VAD commit", not "from last word". Say so in the report; the VAD window is accounted separately (§9).
9. **Turn/response correlation must use `responseId`**, not "next audio-delta I see" — tool follow-ups, greeting, and barge-in retries create interleavings where the naive approach attributes audio to the wrong turn. `audio-delta` carries `responseId` (V5).
10. **Barge-in contaminates naive percentiles** — a turn interrupted before first audio has no TTFB; a truncated response has an artificially small mark count. Tag `bargedIn` and filter at analysis time.
11. **`session-updated` `.raw` is the only place** to confirm the applied audio format (BRD §5.5) — log it verbatim once per call; it is also evidence for the pcmu-vs-transcode finding in M5.
12. **Numeric attribute filters only work on JSON deployment logs** (documented constraint) — if a line accidentally goes out as plain text (gotcha 4), it silently drops out of `@ttfbMs:>800` queries.
13. **Percentile-of-percentiles is wrong** — aggregate raw per-turn values across calls offline, not per-call p50s (§7).

## Open questions (need runtime spike)

1. **Does the gateway pass OpenAI's raw events through in `.raw`** (specifically `input_audio_buffer.speech_stopped.audio_end_ms` / `speech_started.audio_start_ms`)? Determines whether `vadGapMs` cross-check (§9) is possible. Check first live call's logged `.raw` payloads. (Related BRD [SPIKE]: whether `speech-stopped` arrives normalized at all vs as `custom`.)
2. **Exact semantics of OpenAI `audio_end_ms`** (does it exclude the silence window?) — docs fetch did not surface field-level descriptions; verify against observed values on the first call.
3. **Event ordering guarantee** `response-created` → before first `audio-delta` of that response through the gateway — assumed by the state machine; verify in M1 logs (fallback: attach `responseId` lazily from the first delta).
4. **Gateway-added latency itself** — no published numbers exist for ai-gateway.vercel.sh realtime relay overhead; the instrumentation IS the measurement (BRD §11 already flags this).
5. **Railway Log Explorer behavior for nested JSON attributes** — undocumented; the flat-field rule (§5) sidesteps it, but verify `@event:turn` filtering works on the first deployed build before relying on it for M5 extraction.
6. **Does Railway's rate limiter count dropped-line warnings against retention/queries** — trivia; only matters if a bug floods logs.
7. **`getToken` latency distribution** (BRD says ~100 ms) — log `getTokenMs` per call; if it drifts to seconds it eats the FR-1 2 s greeting budget.

## Sources

- Railway logs (structured logs, rate limit, filter syntax, retention): https://docs.railway.com/observability/logs
- Twilio Media Streams WebSocket messages (`media.timestamp`, `mark`, `clear`): https://www.twilio.com/docs/voice/media-streams/websocket-messages
- OpenAI Realtime VAD guide (server_vad defaults incl. silence_duration_ms 500): https://developers.openai.com/api/docs/guides/realtime-vad and https://platform.openai.com/docs/guides/realtime-vad
- Normalized realtime event schema: `@ai-sdk/provider@4.0.3` (npm tarball), `src/realtime-model/v4/realtime-model-v4-server-event.ts` — installed and read at `C:\Users\kevin\AppData\Local\Temp\claude\D--projects-linean-CSUB-RIO-POC\2b673856-d2e2-4653-a80a-85f159b53749\scratchpad\pkg\node_modules\@ai-sdk\provider\`
- MDN `performance.now()` monotonicity: https://developer.mozilla.org/en-US/docs/Web/API/Performance/now (normative: https://w3c.github.io/hr-time/)
- Node.js perf_hooks (`performance.now`, `timeOrigin`, `monitorEventLoopDelay`): https://nodejs.org/api/perf_hooks.html (checked on local Node v22.14.0)
- pino defaults (`level:30`, `msg`, `messageKey`, `formatters.level`): https://raw.githubusercontent.com/pinojs/pino/main/docs/api.md
- Twilio "Core Latency in AI Voice Agents" (Nov 2025 targets & waterfall): https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents
- techsy.io gpt-realtime-2 PSTN measurements (p50 1.1 s / p95 1.9 s, 40 calls): https://techsy.io/en/blog/openai-realtime-api-voice-agent
- Softcery real-time vs turn-based (TTFA table, PSTN 100–200 ms): https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture
- dev.to "Sub-200ms" (rejected as comparable — no methodology): https://dev.to/ryancwynar/sub-200ms-voice-ai-bridging-twilio-and-openai-realtime-api-21g3
- BRD under verification: D:\projects-linean\CSUB-RIO-POC\BRD_Micro_Voice_PoC.md (§3, §5.8, §5.9, FR-1/FR-6, M3/M5)

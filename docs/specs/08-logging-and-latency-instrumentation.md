---
# Spec 08 — Structured Logging & Latency Instrumentation (FR-6)
Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Draft for review
Depends on: 01 (the `src/logger.ts` stub boundary, Spec 01 R12 — this spec ships the final implementation behind it; latency recorder is otherwise standalone) · Enables: the session/bridge spec's event handlers (05), the M4 concurrency test, and the M5 findings-report spec (10)
Findings referenced: findings/09 (all sections — the authoritative source for this spec), findings/07 (§V1–V4, §12, gotchas 7–8, "Structured log line contract"), findings/02 (vendored server-event union — exact event/field names), findings/10 (C6 n/a here; S5, S16, S33, S34, S35; gotcha context for G-items)
---

## Objective (what exists when this spec is done)

A zero-dependency stdout JSON logger (`src/logger.ts`) whose output Railway parses natively, plus a per-call turn/latency recorder (`src/latency.ts`) that implements the full FR-6 timestamp schema from findings/09: per-turn `tSpeechStopped → tFirstAudioDelta (ttfbMs) → tFirstTwilioSend (bridgeMs) → tFirstMarkEcho (playbackConfirmMs)` keyed by `responseId`, greeting decomposition, tool round-trip decomposition, and a `stream-stop` call summary with nearest-rank p50/p95. Because Railway Hobby retains logs only 7 days, this spec also defines the mandatory extraction procedure that lands measurement data in the repo, and the Log Explorer verification checklist (S33). The latency numbers these modules emit ARE the PoC's primary deliverable (BRD §1, FR-6, M5).

## Deliverables

Create:
- `D:\projects-linean\CSUB-RIO-POC\src\logger.ts` — hand-rolled logger (~25 lines) + `ms`/`now` helpers [findings/09 §6]
- `D:\projects-linean\CSUB-RIO-POC\src\latency.ts` — `TurnRecord`/`ToolTiming`/`GreetingRecord` types, `TurnRecorder` class (state machine + derived-metric computation + `pct` percentile helper + event-loop-delay summary hook)
- `D:\projects-linean\CSUB-RIO-POC\scripts\aggregate-latency.mjs` — offline cross-call aggregation over exported `event:turn` JSONL (never averages per-call percentiles) [findings/09 §7, gotcha 13]
- `D:\projects-linean\CSUB-RIO-POC\docs\measurements\README.md` — extraction procedure, query cookbook, directory/naming convention (content specified in R14–R16)
- `D:\projects-linean\CSUB-RIO-POC\docs\measurements\.gitkeep` (directory must exist in git so extracts have a home)

Modify (contract only — the session/bridge spec implements the call sites):
- `src/session.ts` — must call the `TurnRecorder` hook methods defined in R6–R10 from its gateway/Twilio event handlers
- `src/server.ts` — boot-time `monitorEventLoopDelay` enablement (R12) and the rule that NOTHING else writes to stdout/stderr (R3)

## Requirements

### R1 — Logger: hand-rolled, NOT pino

`src/logger.ts` is the hand-rolled logger from findings/09 §6, verbatim (adjusted only for repo lint style). Do **not** use pino: its defaults emit numeric `level:30`, message key `msg`, and `pid`/`hostname` noise — all incompatible with Railway's parser, which requires `message` (string key) and `level` as a **string label** (`debug|info|warn|error`) [findings/09 V10, gotcha 2; findings/07 §12]. At ~30 lines/s total there is no throughput argument for pino. The verified code:

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

// Spec 01 R12 boundary — MUST keep exporting logEvent (and LogFields/LogLevel types) so every
// module written against the stub keeps compiling (master plan R-2). Thin wrapper over log():
export function logEvent(fields: LogFields): void {
  const { level, message, ...rest } = fields;
  log(level, message, rest);
}
```

Notes carried from findings/09 §6: `JSON.stringify` drops `undefined` fields (convenient for optional deltas); `process.stdout.write` is fire-and-forget and backpressure is unreachable at this volume. Add one guard: the single place that serializes `.raw` payloads wraps in `try/catch` with a `String(err)` fallback so a circular/hostile `.raw` can never crash a handler.

### R2 — Log-line contract (Railway-parseable)

Every line the process emits [findings/09 V1–V3, §5; findings/07 §12]:
- **Single-line minified JSON on stdout.** Never `JSON.stringify(x, null, 2)`; never raw multi-line stack traces (put stacks in a `stack` string field of one error line) [findings/09 gotcha 4].
- **Top-level `message` (string) + `level` (string label)** — Railway's two special fields.
- **FLAT custom fields only.** Everything queryable must be a top-level key (`callSid`, `streamSid`, `event`, `ttfbMs`, …) — Railway documents only `@attr:value` / `@arr[i]:value`; nested-path filtering is undocumented and must not be relied on [findings/09 §5; findings/07 gotcha in §12; S33]. Numeric metrics stay JSON numbers (enables `@ttfbMs:>800`).
- **Constant field set on every event line:** `message`, `level`, `ts` (ISO wall clock), `callSid`, `streamSid`, `event` (machine enum per R11), plus event-specific fields.
- All logged deltas rounded to 1 decimal via the `ms()` helper (`Math.round(x*10)/10`) [findings/09 §1].

### R3 — One line per EVENT, never per frame; stderr rule

- Railway drops everything past **500 log lines/s/replica** (all plans) with a single warning line [findings/09 V2; findings/07 §12]. Per-frame logging at 5 calls × 50 frames/s × 2 directions = 500 lines/s — exactly at the drop threshold, so per-frame logging is banned outright.
- **Never log:** Twilio `media` frames, `input-audio-append`, any `audio-delta` after the first per response, `audio-transcript-delta` (accumulate; log once at `-done`), mark echoes other than the instrumented first-per-response mark [findings/09 §5, gotcha 7]. Budget check: ~10–20 lines/turn ⇒ ~30 lines/s at 5 concurrent calls ≈ 6% of cap.
- **stderr is forced to `level:error` by Railway** regardless of content [findings/09 V1, gotcha 3]. No `console.error` for non-errors; no library may write to stdout/stderr: Fastify is created with `logger: false`, and any unavoidable third-party output is routed through `log()`. This is a repo-wide rule the session/server specs must obey.

### R4 — Clock discipline (three clocks, one job each)

[findings/09 V7, V9, §1]
1. **All latency deltas: `performance.now()`** (monotonic, fractional ms, process-relative — global in Node ≥16). Never subtract two `Date.now()` values for a metric (NTP slew corrupts tails, gotcha 5).
2. **One wall-clock field per line: `ts: new Date().toISOString()`** — for cross-correlation with Twilio Call logs and the Vercel dashboard; survives log export. Emitted automatically by `log()`.
3. **Twilio `media.timestamp`** is stream-relative media time (ms since stream start), a third clock. Anchor once per call: at the Twilio `start` message record `tStreamStartPerf = performance.now()`; then `mediaTsToPerf(t) = tStreamStartPerf + t` is approximately perf-comparable (±jitter). Use only for barge-in `audioEndMs` math and the `vadGapMs` VAD cross-check — never for headline metrics.
- Perf timestamps from different processes/restarts are incomparable — the aggregation script (R16) must only ever use the pre-computed delta fields, never raw `t*` values across lines.

### R5 — Per-turn timestamp schema (`src/latency.ts` types)

Exactly the findings/09 §2 schema (do not rename fields — the M5 analysis and Log Explorer queries key on them):

```ts
interface TurnRecord {
  turn: number;                    // 1-based
  responseId?: string;
  // performance.now() timestamps
  tSpeechStopped?: number;         // arrival of normalized 'speech-stopped'
  tResponseCreated?: number;       // 'response-created' (server-vad auto-creates)
  tFirstAudioDelta?: number;       // first 'audio-delta' with this responseId
  tFirstTwilioSend?: number;       // after twilioWs.send() of the first media frame
  tFirstTwilioFlush?: number;      // stamped in the send callback (R8)
  tFirstMarkEcho?: number;         // echo of the mark queued after the first media frame
  tResponseDone?: number;
  tools: ToolTiming[];             // may repeat if multiple calls in one turn
  bargedIn: boolean;               // speech-started arrived before response-done
  // derived at turn close, logged in the 'turn' line
  ttfbMs?: number;                 // tFirstAudioDelta - tSpeechStopped  → model+gateway TTFB
  bridgeMs?: number;               // tFirstTwilioSend - tFirstAudioDelta → decode+transcode+send
  turnMs?: number;                 // tFirstTwilioSend - tSpeechStopped  → server-observable core
  playbackConfirmMs?: number;      // tFirstMarkEcho - tFirstTwilioSend  → Twilio buffer/WS proxy
}

interface ToolTiming {
  callId: string; name: string;
  tArgsDone: number;               // 'function-call-arguments-done' arrival
  tToolResolved?: number;          // MCP client.callTool() promise resolved
  tOutputSent?: number;            // conversation-item-create (function-call-output) sent
  tResponseCreateSent?: number;    // the gated follow-up 'response-create' sent
  tFollowupFirstDelta?: number;    // first audio-delta of the follow-up responseId
  // derived: mcpMs, gateWaitMs, secondTtfbMs, toolTotalMs (R10)
}
```

Correlation is **by `responseId`**, never by "next audio-delta I see" — `audio-delta` carries required `responseId` and `itemId` per the vendored union [findings/02 server-event union; findings/09 gotcha 9]. Tool follow-ups, the greeting, and barge-in retries interleave; naive attribution corrupts the data.

### R6 — Turn state machine (hook API `TurnRecorder` exposes; session.ts calls these)

Server-vad flow is `speech-stopped → audio-committed → response-created → output-item-added → audio-delta*` [findings/09 §2]:
1. **`onSpeechStopped()`**: close any dangling turn (mark incomplete), open `currentTurn = { turn: n++, tSpeechStopped: now(), tools: [], bargedIn: false }`. Also record `latestMediaTimestamp` at this instant and, if `.raw` carries OpenAI's `audio_end_ms`, log it — this is the `vadGapMs` cross-check [findings/09 §9; S5/S34].
2. **`onResponseCreated(responseId)`**: if `currentTurn` lacks a `responseId`, attach it + stamp `tResponseCreated`. Follow-up responses created by our own post-tool `response-create` attach to the pending `ToolTiming` instead — the bridge sent that `response-create` itself, so it knows. Ordering `response-created` before first `audio-delta` is assumed but unverified through the gateway (S16); fallback: attach `responseId` lazily from the first delta.
3. **`onAudioDelta(responseId)`**: if it matches `currentTurn.responseId` (or a pending `ToolTiming` follow-up) and the first-delta stamp is unset → stamp `tFirstAudioDelta`; after the Twilio send of that first frame stamp `tFirstTwilioSend`; send one mark for that response; emit the `first-audio-delta` (with `ttfbMs`) and `first-twilio-send` (with `bridgeMs`) log lines. **Never log subsequent deltas.** Mark naming follows resolution T3 [findings/10]: one namespace `r<responseId>:<seq>` shared with the barge-in queue; the **first** mark of each response doubles as the `tFirstMarkEcho` instrumentation point (no separate timing mark).
4. **`onMarkEcho(name)`**: if it is the first mark of the current/known response, stamp `tFirstMarkEcho`. Ignore (do not log) all other echoes; remember marks are also echoed on `clear`, so removal is by-name, never bare `shift()` [findings/10 C4].
5. **`onSpeechStarted()`** before `response-done`: set `bargedIn = true`; the barge-in spec runs its sequence; emit one `barge-in` line with `msSinceFirstSend`.
6. **`onResponseDone(responseId, status)`**: stamp `tResponseDone`, compute derived fields, push to `turns[]`, emit ONE consolidated `turn` line (R11), clear `currentTurn`. Log the raw `status` string (plain string, not an enum — S12).

**Edge cases (implement all three)** [findings/09 §2 "Edge cases", gotchas 8/10]:
- **Turn with no audio** (model goes straight to function call): `ttfbMs` stays absent; the honest caller-perceived number is `tools[last].tFollowupFirstDelta − tSpeechStopped` — log it as `perceivedMs` on the `turn` line when `ttfbMs` is absent and a tool follow-up produced audio.
- **Barge-in turns**: keep TTFB in the stats if audio started before the interrupt; exclude from percentile inputs only turns barged before first audio delta. Always tag `bargedIn` so either cut can be computed offline.
- **Greeting is not a VAD turn** — separate record (R7); never enters the turn percentiles.
- Semantics caveat to preserve in the M5 report: `speech-stopped` arrival ≠ end of speech — it fires after the ~500 ms VAD silence window plus one gateway hop, so `ttfbMs` is honestly "model+gateway TTFB from VAD commit" [findings/09 gotcha 8, V6].

### R7 — Greeting latency (FR-1: greet within ~2 s of pickup)

Separate `GreetingRecord` with the findings/09 §3 timestamp chain: `tTwimlPost` (webhook handler entry) → `tWsStart` (Twilio `start` message — closest proxy for pickup) → `tGatewayOpen` → `tSessionUpdateSent` → `tSessionUpdated` (ack) → `tGreetingCreateSent` → `tFirstAudioDelta` → `tFirstTwilioSend` → `tFirstMarkEcho`. Emit ONE `greeting` line containing all consecutive deltas as flat numeric fields (`webhookToStartMs`, `gatewayOpenMs`, `sessionUpdateAckMs`, `greetingTtfbMs`, `greetingBridgeMs`, `greetingPlaybackConfirmMs`, `greetingTotalMs = tFirstTwilioSend − tWsStart`).

**`getTokenMs` is mandatory**: stamp around `gateway.experimental_realtime.getToken(...)` at webhook time (the C1-corrected call — factory receiver, not the model instance [findings/10 C1]) and log it on the `greeting` line and as its own field on `stream-start`. BRD budgets ~100 ms; if it drifts to seconds it eats the 2 s greeting budget [findings/09 open question 7, S15 — also log the returned `expiresAt`].

### R8 — `tFirstTwilioSend` honesty (enqueue vs flush)

`ws.send()` returns after enqueue, not flush. Stamp `tFirstTwilioSend` after the `send()` call AND `tFirstTwilioFlush` in the send callback (`twilioWs.send(data, () => stamp())`). Log both once per turn as `bridgeMs` and `flushLagMs = tFirstTwilioFlush − tFirstTwilioSend`; normally <1 ms — growth means socket backpressure [findings/09 gotcha 6].

### R9 — What the recorder consumes (exact event/field names)

From the vendored `@ai-sdk/provider@4.0.3` union [findings/02]: `speech-started {itemId?}`, `speech-stopped {itemId?}`, `audio-committed`, `response-created {responseId}`, `response-done {responseId, status}`, `output-item-added {responseId, itemId}`, `audio-delta {responseId, itemId, delta}`, `function-call-arguments-done {responseId, itemId, callId, name, arguments}`, `input-transcription-completed {itemId, transcript}`, `audio-transcript-done {responseId, itemId, transcript?}`, `error {message, code?}`, `custom {rawType, raw}`. Every server event carries required `.raw`. Critical: normalized `speech-stopped` carries **no timing fields** — any VAD timing detail (`audio_end_ms`) exists only in `.raw` IF the gateway passes it through (S5/S34) [findings/09 V5]. If `speech-started`/`speech-stopped` arrive only as `custom {rawType:'input_audio_buffer.speech_started'/'...speech_stopped'}` (S4), the recorder hooks fire from the fallback matcher identically.

### R10 — Tool round-trip decomposition (M3 acceptance: < 1.5 s in logs)

Per `ToolTiming`, derived fields logged in a single `tool-call` line [findings/09 §4]:
- `mcpMs = tToolResolved − tArgsDone` (localhost MCP hop — expect single-digit ms)
- `gateWaitMs = tResponseCreateSent − tOutputSent` (time waiting on the BRD §5.7 response-done gate)
- `secondTtfbMs = tFollowupFirstDelta − tResponseCreateSent` (second model inference — expected dominant term)
- `toolTotalMs = tFollowupFirstDelta − tArgsDone`
This decomposition is what proves/disproves the BRD's claim that "the perceived cost is one extra model TTFB".

### R11 — Event vocabulary (the `event` field enum)

Superset of BRD §5.9 per findings/09 §5. All lines carry the constant field set (R2); event-specific fields listed:

| `event` | When | Extra fields |
|---|---|---|
| `stream-start` | Twilio `start` received, token verified | `accountSid`-free; `getTokenMs`, `tokenExpiresAt`, `mediaFormat` |
| `gateway-open` | gateway WS `open` | `gatewayOpenMs` (from connect start) |
| `session-updated` | ack received | **applied audio format extracted from `.raw`** + the serialized `.raw` verbatim, once per call (M1/pcmu evidence; findings/09 gotcha 11, S1/S2/S5) |
| `greeting` | first greeting audio sent | R7 delta set |
| `speech-started` | VAD start (normalized or custom fallback) | |
| `speech-stopped` | VAD commit | `latestMediaTimestamp`, `vadGapMs?` (if `.raw` passthrough, S5/S34) |
| `first-audio-delta` | first delta of a response | `responseId`, `ttfbMs` |
| `first-twilio-send` | first frame sent to Twilio | `responseId`, `bridgeMs`, `flushLagMs` |
| `turn` | `response-done` | consolidated: `turn`, `responseId`, `ttfbMs`, `bridgeMs`, `turnMs`, `playbackConfirmMs`, `perceivedMs?`, `bargedIn`, `toolCalls`, `status` |
| `tool-call` | follow-up first delta (or tool failure) | `turn`, `tool`, `callId`, `mcpMs`, `gateWaitMs`, `secondTtfbMs`, `toolTotalMs`, `isError?` |
| `barge-in` | speech-started during playback | `msSinceFirstSend`, `audioEndMs`, `itemId` |
| `input-transcript` | `input-transcription-completed` | `transcript`, `itemId` |
| `output-transcript` | `audio-transcript-done` | `transcript`, `responseId` |
| `custom` | any `custom` server event | `rawType`, serialized `raw` (try/catch-guarded) — always logged; these are the unmapped-gateway-event evidence [findings/02 gotcha 7] |
| `error` | `error` server event or bridge exception | `code?`, `errMessage`, `stack?` (single-line), serialized `raw` — needed for the benign-error whitelist spike S11 |
| `gateway-close` | gateway WS close | `closeCode`, `closeReason` (S14 close-code vocabulary evidence) |
| `stream-stop` | Twilio `stop` / teardown | call summary, R12 |

Example lines (canonical shapes from findings/09 §5 — the aggregation script parses these):

```json
{"message":"turn 4 complete","level":"info","ts":"2026-07-18T17:03:22.114Z","callSid":"CAxxxx","streamSid":"MZxxxx","event":"turn","turn":4,"responseId":"resp_abc","ttfbMs":612.4,"bridgeMs":3.1,"turnMs":615.5,"playbackConfirmMs":41.0,"bargedIn":false,"toolCalls":0,"status":"completed"}
{"message":"tool get_current_time round trip","level":"info","ts":"...","callSid":"CAxxxx","streamSid":"MZxxxx","event":"tool-call","turn":5,"tool":"get_current_time","callId":"call_1","mcpMs":4.2,"gateWaitMs":112.0,"secondTtfbMs":540.8,"toolTotalMs":688.3}
{"message":"call summary","level":"info","ts":"...","callSid":"CAxxxx","streamSid":"MZxxxx","event":"stream-stop","durationS":312.4,"turns":14,"n":12,"bargeIns":2,"ttfbP50":598.2,"ttfbP95":901.4,"ttfbMax":1004.0,"bridgeP50":3.0,"bridgeP95":6.8,"turnP50":602.0,"turnP95":905.1,"turnMax":998.7,"toolCalls":2,"toolTotalP50":702.1,"loopP99Ms":12.4}
```

### R12 — Call summary: percentiles + event-loop guard

At `stream-stop`, compute per-call percentiles by **array + sort, nearest-rank** — no streaming estimators (t-digest/P² are unjustifiable at 10–60 turns/call) [findings/09 §7]:

```ts
function pct(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
```

- Summary fields: `durationS`, `turns` (all turns), `n` (turns entering percentiles: complete, not barged-before-first-audio), `bargeIns`, `ttfbP50/P95/Max`, `bridgeP50/P95`, `turnP50/P95/Max`, `toolCalls`, `toolTotalP50`, `loopP99Ms`.
- **Always log `max` and `n` alongside p95** — with n < 20 turns, "p95" is effectively the max; the caveat must be stated wherever these numbers are reported [findings/09 §7].
- **Event-loop lag guard** [findings/09 §8]: at boot, `import { monitorEventLoopDelay } from 'node:perf_hooks'; const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();` — in each summary: `loopP99Ms: Math.round(loop.percentile(99) / 1e6 * 10) / 10`. This is the M4 diagnostic that separates event-loop (DSP-on-main-thread) degradation from network degradation. One process-wide histogram is sufficient (calls share the loop); do not reset between calls for the PoC.
- Cross-call aggregate percentiles (the real M5 numbers) are computed **offline** by `scripts/aggregate-latency.mjs` over exported raw `event:turn` lines — never by averaging per-call p50s (percentile-of-percentiles is statistically wrong) [findings/09 gotcha 13].

### R13 — Honest voice-to-voice accounting (report language, hard requirement for M5)

The logs measure the **server-observable turn core** `turnMs = tFirstTwilioSend − tSpeechStopped`. What they can NOT measure [findings/09 §9]:

```
mouth-to-ear turn gap ≈
    uplink: last syllable → Twilio edge → bridge → gateway → OpenAI   (~100–250 ms, unobservable)
  + VAD silence window (silence_duration_ms, default 500 ms, deterministic)
  + VAD processing + speech_stopped propagation                        (folded into measured ttfbMs)
  + measured ttfbMs + bridgeMs                                         (the logs' contribution)
  + downlink: bridge → Twilio WS (~10–40 ms) → jitter buffer → PSTN    (~100–200 ms, unobservable)
```

Mandatory report phrasing: **"measured server-side turn core X ms; estimated caller-perceived ≈ X + ~500 ms (VAD window) + ~200–450 ms (PSTN/network legs, unmeasured)"**. Server-side tighteners: `playbackConfirmMs` bounds the downlink-to-Twilio-buffer leg; `vadGapMs` (if S5 raw passthrough holds) cross-checks the VAD window.

**Calibration-call plan (M5, fits the no-recording constraint)** [findings/09 §9]: make 2–3 test calls on speakerphone next to a laptop recording room audio (Audacity/QuickTime); measure the audible speech-end → response-start gap in the waveform; report the offset between waveform-measured and server-measured (`turnMs`) values in `docs/measurements/` and the README findings section. One paragraph turns "estimated" into "calibrated". Context for interpreting results: best published server_vad PSTN comparable is ~1.4 s p50 direct-to-OpenAI (techsy.io), Twilio's mouth-to-ear target is 1,115 ms median — the BRD's 1.0–1.5 s p50 is realistic but tight; if measurements land 1.4–1.7 s the first knob is `silenceDurationMs`, not the bridge [findings/09 V11].

### R14 — Extraction procedure (7-day Hobby retention — data self-destructs)

Railway Hobby retains logs **7 days** [findings/09 V4, gotcha 1; findings/07 §12]. The M5 dataset must therefore be extracted **within a week of each test session — target: same day, hard deadline: 72 h** (leaves buffer for indexing lag and re-pulls). Procedure, documented verbatim in `docs/measurements/README.md`:

1. In Railway Log Explorer, scope to the test session's time window, then run and export (copy/download the raw JSON lines) each of:
   - `@event:turn` → `turns.jsonl`
   - `@event:stream-stop` → `summaries.jsonl`
   - `@event:tool-call` → `tools.jsonl`
   - `@event:greeting` → `greetings.jsonl`
   - `@event:session-updated` → `session-config.jsonl` (pcmu-vs-transcode evidence)
   - `@level:error OR @event:custom OR @event:gateway-close` → `anomalies.jsonl` (S11/S14 evidence)
2. Land the files in the repo at `docs/measurements/<YYYY-MM-DD>-<milestone-or-label>/` (e.g. `docs/measurements/2026-07-21-m2-bargein/`), one directory per test session, plus a `notes.md` (who called, how many calls, AUDIO_MODE, deploy SHA from `RAILWAY_GIT_COMMIT_SHA`, anything anomalous). Commit and push — the repo is the durable store; Railway is a 7-day cache.
3. Run `node scripts/aggregate-latency.mjs docs/measurements/<dir>/turns.jsonl` → prints cross-call nearest-rank p50/p95/max + n for `ttfbMs`, `bridgeMs`, `turnMs`, `playbackConfirmMs` (excluding `bargedIn` turns lacking `ttfbMs`), and for `tools.jsonl` the `mcpMs/gateWaitMs/secondTtfbMs/toolTotalMs` set. Output pasted into the M5 README findings section.

### R15 — Railway Log Explorer verification checklist (S33 — run on the FIRST deployed build, before any milestone relies on queries)

Documented as a checklist in `docs/measurements/README.md`; each item checked off with date on the first deploy:
1. A `stream-start` line renders with level colorization (i.e. parsed as JSON, not plain text).
2. `@callSid:<sid>` returns exactly that call's lines.
3. `@event:turn` and `@event:stream-stop` filter correctly (flat-field custom attributes work).
4. Numeric filter works: `@ttfbMs:>0` returns turn lines; `@ttfbMs:>800` returns the slow subset. (Numeric filters only work on JSON-parsed lines — a plain-text line silently drops out [findings/09 gotcha 12].)
5. Boolean combos: `@event:turn AND @bargedIn:false`, `@level:error OR @event:custom`, negation `-@event:speech-started`.
6. Burst check: after a call ends, confirm `@callSid` query completeness within ~a minute (indexing lag, findings/07 open question 6).
7. Confirm the 500/s warning line does NOT appear during a normal call (if it does, a per-frame log leaked — fix before any measurement session).

Query cookbook to include (findings/09 §10): `@callSid:CAxxxx` · `@event:turn AND @ttfbMs:>800` · `@event:turn AND @bargedIn:false` · `@event:stream-stop` · `@event:tool-call AND @toolTotalMs:>1500` (M3 violations) · `@level:error OR @event:custom` · `@callSid:CAxxxx AND (@event:first-audio-delta OR @event:barge-in)`.

### R16 — `scripts/aggregate-latency.mjs`

Plain Node ESM script, zero deps. Reads one or more `.jsonl` files (args), tolerates non-JSON lines (skip with count), filters `event==='turn'`, partitions by `bargedIn` and by presence of `ttfbMs`, computes nearest-rank p50/p95 (same `pct` algorithm as R12), max, and n per metric, and prints a markdown table ready to paste into the README. Must never average per-call percentiles; it aggregates raw per-turn values only [findings/09 §7]. Accepts `--metric` filter and a `--tools` mode for `tool-call` lines.

## Acceptance criteria

- A1 (FR-6): For any completed call on Railway, the Log Explorer query `@callSid:<sid>` returns, in order: `stream-start` (with `getTokenMs`), `gateway-open`, `session-updated` (with applied-format `.raw`), `greeting`, and per turn `speech-stopped` → `first-audio-delta` (with `ttfbMs`) → `first-twilio-send` (with `bridgeMs`) → `turn`, then `stream-stop`. This is the BRD FR-6 acceptance ("speech-stopped → first audio-delta → first byte to Twilio") plus the mark-echo extension.
- A2: Every emitted line is single-line minified JSON on stdout with top-level string `message` and string `level`, and all queryable fields flat at top level; zero lines are emitted to stderr during a normal call; `grep -c` of a local run confirms no `media`/`audio-delta`-per-chunk/`input-audio-append` lines exist.
- A3: A 10-minute talkative call at 5 concurrent calls stays under ~50 lines/s total (measured locally by piping stdout through `wc -l` per second) — an order of magnitude under the 500/s cap; the Railway rate-limit warning line never appears (R15.7).
- A4: All logged deltas are computed from `performance.now()` pairs via `ms()` (code review: no `Date.now()` subtraction anywhere in `latency.ts`/`session.ts` metric paths); every line carries ISO `ts`.
- A5: The `turn` line's derived fields satisfy `turnMs = ttfbMs + bridgeMs` (±0.2 rounding) whenever both present; turns keyed by `responseId` — a call containing a tool follow-up attributes the follow-up's first delta to `ToolTiming.tFollowupFirstDelta`, not to a new turn's `ttfbMs` (unit test with a scripted event sequence).
- A6 (M3): A `tool-call` line contains `mcpMs`, `gateWaitMs`, `secondTtfbMs`, `toolTotalMs`, and on a live call `toolTotalMs < 1500` is checkable via `@event:tool-call AND @toolTotalMs:>1500` returning nothing.
- A7 (FR-1): The `greeting` line decomposes webhook→start→gateway-open→session-updated→response-create→first-send with `greetingTotalMs` present; `getTokenMs` logged per call.
- A8: `stream-stop` carries `ttfbP50/P95/Max`, `turnP50/P95/Max`, `n`, `bargeIns`, and `loopP99Ms`; unit test of `pct()` against known arrays (empty → undefined; n=1; n=20 nearest-rank values).
- A9: Barge-in turns are tagged `bargedIn:true`; turns barged before first audio have no `ttfbMs` and are excluded from `n`; the greeting appears in no turn percentile (unit test).
- A10 (M5 enablement): `docs/measurements/README.md` exists with the R14 procedure, R15 checklist, and query cookbook; `scripts/aggregate-latency.mjs` run against a fixture `turns.jsonl` (≥2 synthetic calls) prints correct cross-call p50/p95/max/n and refuses/never computes percentile-of-percentiles.
- A11 (S33): The R15 checklist has been executed and dated on the first deployed build before any M2+ measurement session is treated as valid.
- A12: `custom` events always produce a `custom` line with `rawType` and serialized `raw`; a circular `.raw` does not throw (unit test with a cyclic object).

## Out of scope

- The session/bridge event loop, barge-in sequence, and mark-queue mechanics themselves (separate specs — this spec defines only the recorder hooks they must call and the mark-name convention shared per T3).
- DSP/transcode implementation (its cost shows up in `bridgeMs`; nothing here transcode-specific).
- Log drains / Vector forwarders / any observability stack beyond structured stdout logs (BRD non-goal; the R14 manual extraction is the retention answer for a PoC).
- Transcript content policy/redaction — transcripts are logged verbatim (PoC, test callers only).
- Alerting, dashboards, and cross-call aggregation at runtime (offline script only).
- The M5 findings report text itself (this spec supplies its data and required phrasing).

## Open items deferred to runtime spikes (findings/10 S-numbers)

- **S5/S34** — whether `.raw` passes OpenAI's `speech_stopped.audio_end_ms` through, and its exact semantics → gates the `vadGapMs` field (R6.1). Implement it optional/absent-safe; confirm on the first M1 call's logged `.raw`.
- **S16** — `response-created`-before-first-`audio-delta` ordering through the gateway → recorder ships with the lazy-`responseId`-attach fallback (R6.2); verify in M1 logs.
- **S33** — Log Explorer flat-field + numeric filtering behavior → R15 checklist on first deployed build; if numeric filters fail, extraction falls back to `@event:turn` export + offline filtering (R16 already covers it).
- **S15** — `getToken` latency distribution and token TTL → `getTokenMs` + `tokenExpiresAt` logged per call (R7); evaluated at M1.
- **S11/S14** — gateway `error.code` strings and WS close-code vocabulary → `error`/`gateway-close` lines capture the raw evidence; whitelists are tuned in the session spec after M1/M2.
- **S26** — event-loop `loopP99Ms` under 5 concurrent calls on Railway shared vCPU → read from M4 `stream-stop` summaries.
- **S35** — gateway-hop latency overhead: no published numbers exist; the `ttfbMs` dataset produced by this spec IS the measurement (gateway-only by design).

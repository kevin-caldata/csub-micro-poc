# Demo Spec 05 — Performance Optimization: Measured Experiments, Gates, and Revert Rules

Date: 2026-07-19 · Project: CSUB-RIO self-serve demo · Status: Draft for review
Depends on: demo Spec 01 (persona/voice — consumes the E3 voice verdict and the E4 preamble-length number), demo Spec 03 (knowledge tool — produces the `knowledgeMs` field and the `MCP_MODEL_*` env keys E4/E5 exercise), demo Spec 06 (announcement email — the deploy freeze that closes the experiment window) · Base specs: 06 (audio DSP / `AUDIO_MODE`), 08 (logging/latency — all field names), 00 (master plan spike register S1–S35, M3 gate)
Findings referenced: findings/09 (§2 timestamp schema, §5 log-line design, §7 offline aggregation, gotcha 13 percentile-of-percentiles), findings/15 (claims 12–14 thinking-budget latency, claim 19 client-side deadline, claim 21 implicit caching / cache-read $0.03/M), findings/16 (C5–C6 latency budget and preamble masking, C12 in-handler abort), findings/11 (C11 voice/S8, C1 preamble-sentence test constraint), findings/07 §12 (log retention)

---

## Objective

When this spec is done, every performance change to the live demo line is an **experiment**, never an edit: it has a written hypothesis, a single config change (a Railway environment-variable flip — no code), a measurement taken through the *existing* log fields and the *existing* extraction/aggregation pipeline, a numeric pass gate, and a revert rule. The prime directive is: **the live line never regresses** — a failed experiment is reverted by flipping the variable back, and the demo ships on whichever configuration last passed its gate. Six experiments (E1–E6) are defined below; E4 (delegated-tool latency baseline) is a hard prerequisite for sending the announcement email (demo Spec 06), because RIO's spoken tool preamble cannot be locked until the latency it must mask has been measured.

## Deliverables

- Modify `scripts/aggregate-latency.mjs` — add a `--knowledge` mode that aggregates the demo Spec 03 `knowledgeMs` field (R4). This is the only code change in this spec.
- `docs/measurements/<YYYY-MM-DD>-<experiment-label>/` — one dated directory per experiment session, per the existing extraction procedure (`docs/measurements/README.md`, Extraction procedure steps 1–3).
- `docs/measurements/EXPERIMENTS.md` — the experiment ledger (R12): one row per experiment run with config, gate result, and PASS / FAIL+REVERTED verdict.
- Answers to base-plan spikes **S1** (does the gateway honor `audio/pcmu`? — E1) and **S8** (is `marin` a valid voice? — E3), recorded in the ledger and in the S1–S35 answer table (`docs/specs/00-master-build-plan.md` §7 owner: Spec 10).

## Requirements

### The experiment framework

**R1 (experiment shape).** Every experiment MUST be written down in `docs/measurements/EXPERIMENTS.md` *before* it runs, with exactly these five parts:
1. **Hypothesis** — one sentence, falsifiable ("pcmu passthrough reduces `bridgeMs` with no audio-quality loss").
2. **Config change** — exactly one Railway environment variable and its new value. Experiments in this spec are env-flips only; any change that requires a code diff is out of scope here and belongs to the owning spec (E1–E3 satisfy this strictly; E4/E5 are measurement-only — their "config" is the demo Spec 03 defaults already deployed).
3. **Measurement** — which existing log fields, over how many calls/turns, aggregated how (always `scripts/aggregate-latency.mjs` over extracted JSONL — R3).
4. **Pass gate** — a numeric (or explicitly-subjective, R1a) criterion comparable against the baseline (R2).
5. **Revert rule** — the exact variable/value to restore on failure. Reverting is a Railway Variables edit + redeploy; **no git revert is ever needed for an env experiment**.

**R1a (subjective gates).** Two gates in this spec are partly subjective (E1 audio quality, E2 clipped turns). A subjective gate MUST name its procedure and judge count in the ledger entry (e.g., "2 listeners, A/B over 3 call pairs, blind to mode") — "sounded fine" with no procedure is not a recordable result.

**R1b (flip procedure — used by E1, E2, E3 and every revert).** Railway dashboard → service → Variables → edit the variable → deploy the staged change. A variable change redeploys the service (~2 min) and **severs any in-flight call** (established behavior — deploys sever calls; the announcement email warns callers of this, demo Spec 06). Therefore: flip only when no call is active, and never flip after the deploy freeze (R11). Record the resulting deploy SHA (`RAILWAY_GIT_COMMIT_SHA`, unchanged for env-only flips — record the deploy ID instead) in the session `notes.md` per `docs/measurements/README.md` step 2.

**R1c (never-regress rule).** The comparison baseline (R2) is the configuration of record. An experiment variable stays flipped **only** while its measurement session runs and only until its gate is evaluated. Gate FAIL → revert immediately (same day). Gate PASS → the new value becomes the configuration of record and the *new* baseline for subsequent experiments. Experiments run one at a time — never two flipped variables whose sessions overlap, or the measurements are confounded.

### Baseline and measurement protocol

**R2 (baseline session).** Before any experiment flips anything, run one baseline measurement session against the deployed demo build with all defaults (`AUDIO_MODE=transcode`, `VAD_SILENCE_MS=500`, `VOICE=marin`, demo Spec 03 defaults `MCP_MODEL_ID=google/gemini-3.1-flash-lite`, `MCP_MODEL_MAX_TOKENS=150`, `MCP_TOOL_TIMEOUT_MS=3500`): **≥ 5 calls, ≥ 25 non-barged turns, ≥ 10 `ask_campus_knowledge` invocations**. Extract to `docs/measurements/<date>-demo-baseline/` (R3) and record pooled p50/p95/max/n for `ttfbMs`, `bridgeMs`, `turnMs`, `toolTotalMs`, `knowledgeMs`, and the greeting fields (R10) in that directory's `notes.md`. All E1–E6 gates compare against this (or a superseding post-PASS baseline, R1c).

**R3 (extraction and aggregation — reuse, don't reinvent).** Every experiment session follows the existing procedure verbatim (`docs/measurements/README.md`, "Extraction procedure"; Spec 08 R14): export from Railway Log Explorer within the session's time window — `@event:turn` → `turns.jsonl`, `@event:tool-call` → `tools.jsonl`, `@event:greeting` → `greetings.jsonl`, `@event:stream-stop` → `summaries.jsonl`, `@event:session-updated` → `session-config.jsonl`, `@level:error OR @event:custom OR @event:gateway-close` → `anomalies.jsonl`, **plus (new for the demo build)** the demo Spec 03 knowledge line `@event:knowledge-call` → `knowledge.jsonl` (master plan D2). Land files in a dated subdirectory with `notes.md`, commit and push. Timing: target same-day extraction; **hard deadline 72 h** (Railway Hobby retains 7 days — the repo is the durable store, Railway is a cache [findings/07 §12; findings/09 gotcha 1]). Aggregate ONLY with `scripts/aggregate-latency.mjs` over the raw JSONL — never percentile-of-percentiles from per-call `stream-stop` summaries [findings/09 gotcha 13; Spec 08 R12/R16]. With n < 20 for any metric, p95 is effectively the max: report `max` and `n` alongside and say so (existing rule, `docs/measurements/README.md` "Honest accounting").

**R3a (field vocabulary — the ONLY measurement fields this spec uses; all already emitted or defined by demo Spec 03).**

| Field | Log line (`event:`) | Meaning | Source |
|---|---|---|---|
| `ttfbMs` | `turn` | `tFirstAudioDelta − tSpeechStopped` — model+gateway TTFB | `src/latency.ts:26,336` |
| `bridgeMs` | `turn` | `tFirstTwilioSend − tFirstAudioDelta` — decode+transcode+send | `src/latency.ts:27,371` |
| `turnMs` | `turn` | `tFirstTwilioSend − tSpeechStopped` — server-observable core | `src/latency.ts:28,454` |
| `playbackConfirmMs` | `turn` | `tFirstMarkEcho − tFirstTwilioSend` | `src/latency.ts:29,457` |
| `bargedIn` | `turn` | speech-started before response-done | `src/latency.ts:24` |
| `webhookToStartMs`, `gatewayOpenMs`, `sessionUpdateAckMs`, `greetingTtfbMs`, `greetingBridgeMs`, `greetingPlaybackConfirmMs`, `greetingTotalMs` | `greeting` | greeting decomposition; `greetingTotalMs = tFirstTwilioSend − tWsStart` | `src/latency.ts:241-251` |
| `mcpMs`, `gateWaitMs`, `secondTtfbMs`, `toolTotalMs`, `isError` | `tool-call` | tool round trip; `toolTotalMs = tFollowupFirstDelta − tArgsDone`, M3 number | `src/latency.ts:557-583`; Spec 07 R13 |
| `knowledgeMs` | knowledge line (demo Spec 03) | wall time of the in-handler `generateObject` call (gateway text hop), stamped inside the `ask_campus_knowledge` handler | demo Spec 03 |
| `.raw` on `session-updated` | `session-updated` | ground truth for applied voice/format config | `src/gateway.ts` session-updated logging [findings/11 C11] |

No new instrumentation is added by this spec. If a number cannot be derived from these fields, the experiment is out of scope (Non-goals).

**R4 (aggregator extension — REQUIRED; the script does not currently know `knowledgeMs`).** `scripts/aggregate-latency.mjs` today aggregates exactly two event types with fixed metric lists — `TURN_METRICS = ['ttfbMs', 'bridgeMs', 'turnMs', 'playbackConfirmMs']` and `TOOL_METRICS = ['mcpMs', 'gateWaitMs', 'secondTtfbMs', 'toolTotalMs']` (`scripts/aggregate-latency.mjs:26-27`), selected by the `--tools` flag (`:119-121`). Extend it, preserving its constraints (plain Node ESM, zero deps, no imports from `src/`, pooled-raw-values-only — header comment `:1-14`):
- Add `const KNOWLEDGE_METRICS = ['knowledgeMs'];` and a `--knowledge` flag. With `--knowledge`: `wantEvent` is the demo Spec 03 knowledge event name **`'knowledge-call'`** (demo Spec 03 R12; adjudicated by master plan D2) and the metric list is `KNOWLEDGE_METRICS`. `--metric knowledgeMs` must work with it (same filtering path as existing modes).
- `--tools` and `--knowledge` are mutually exclusive; passing both prints usage and exits 1.
- Usage line becomes: `node scripts/aggregate-latency.mjs [--tools|--knowledge] [--metric <name>] <file.jsonl> [more.jsonl...]`.
- Update `docs/measurements/README.md` "Aggregation" section with the new mode and the `knowledge.jsonl` export (R3).

### The experiments

**R5 (E1 — `AUDIO_MODE=pcmu`, spike S1 / Path A).**
- *Hypothesis:* the gateway honors `audio/pcmu` end-to-end (S1), letting the bridge run Path A zero-copy base64 passthrough instead of the Path B transcode DSP (`src/dsp.ts:167-181` — `'pcmu'` instances hold no DSP state), reducing `bridgeMs` and CPU with unchanged audio quality and no `ttfbMs` regression.
- *Config change:* `AUDIO_MODE=pcmu` (Railway variable; enum-guarded at boot, `src/config.ts:16`). Revert value: `AUDIO_MODE=transcode` (the default, `src/config.ts:16`).
- *Evidence to record (mandatory, this is the S1 answer):* the `session-updated` `.raw` from a pcmu-mode call, showing whether the applied session config echoes `inputAudioFormat`/`outputAudioFormat` of `{type:'audio/pcmu'}` **with structurally no `rate` key** (`src/dsp.ts:171-182`; master plan §5 C8, spike S1–S3). Save it in `session-config.jsonl` and quote the relevant fragment in `notes.md`. If the gateway rejects or silently substitutes the format, S1 is answered NO, Path A is dead, revert immediately (master plan risk R-3: Path B ships regardless; the flip is zero code).
- *Measurement:* ≥ 5 calls / ≥ 25 non-barged turns in pcmu mode; pool `ttfbMs`, `bridgeMs`, `playbackConfirmMs` and compare with the R2 baseline (`has-ttfbMs` partition).
- *Pass gate:* ALL of — (a) `session-updated.raw` confirms pcmu applied; (b) audio quality unchanged: blind A/B, 2 listeners, ≥ 3 call pairs, no reported degradation (R1a); (c) pooled `ttfbMs` p50 ≤ baseline p50 + 50 ms; (d) pooled `bridgeMs` p50 ≤ baseline p50 (this is the whole point of Path A — if bridgeMs doesn't improve, PASS is still possible on (a)–(c) but note the null result).
- *Revert rule:* any gate fails → `AUDIO_MODE=transcode`, same day, verdict FAIL+REVERTED in the ledger.

**R6 (E2 — `VAD_SILENCE_MS` 500 → 400).**
- *Hypothesis:* a 400 ms VAD silence window shaves ~100 ms off the caller-perceived turn gap without clipping caller turns. Note the win is **invisible to `ttfbMs`** — `ttfbMs` starts at `tSpeechStopped`, and the silence window sits *before* it in the mouth-to-ear chain (`docs/measurements/README.md` "Honest accounting": the VAD window is a separate, deterministic term). The measurement is therefore a *no-harm* check, not a win check.
- *Config change:* `VAD_SILENCE_MS=400` (`src/config.ts:19`, default 500, applied at `src/gateway.ts:271` as `turnDetection.silenceDurationMs`). Revert value: `VAD_SILENCE_MS=500`.
- *Measurement:* ≥ 10 calls / ≥ 40 caller turns at 400 ms, including deliberately slow, pause-heavy speech (read a phone number with mid-string pauses; think aloud mid-sentence). Evidence of clipping: (a) `input-transcript` lines (`src/session.ts:162-163`) cut mid-word/mid-clause where the caller had not finished; (b) the caller having to repeat themselves; (c) a rise in `bargedIn:true` turn share vs baseline (the model answering while the caller was still talking manifests as caller barge-ins).
- *Pass gate:* zero clipped caller turns across the session (judge: the caller themself, noted per call in `notes.md` — R1a), AND `bargedIn` share not more than 10 percentage points above baseline, AND pooled `ttfbMs` p50 within ±50 ms of baseline (sanity — the flip shouldn't move it).
- *Revert rule:* any clipped turn → `VAD_SILENCE_MS=500`, verdict FAIL+REVERTED.

**R7 (E3 — `VOICE=marin` verification, spike S8).**
- *Hypothesis:* `marin` is a valid voice for `openai/gpt-realtime-2.1` through the gateway (currently unverified — `src/gateway.ts:266`: "'marin' default; S8 unverified — boot-config fallback via VOICE_FALLBACK, no runtime auto-retry"; findings/11 C11).
- *Config change:* none — `marin` is already the default (`src/config.ts:17`). This is a verification, not a flip.
- *Measurement/evidence:* one call; read the logged `session-updated` `.raw` (findings/11 C11: "Ground truth for what voice actually applied is the `session-updated` event's `.raw`, logged verbatim per call"). Record the raw voice field value in `notes.md` and the ledger.
- *Pass gate:* `.raw` shows the applied voice is `marin` and the call's audio is audibly the marin voice (not a silent server-side substitution).
- *Revert rule (here: the fallback flip):* if `marin` is rejected (session-update error, or `.raw` shows a substituted voice), set `VOICE=alloy` (the `VOICE_FALLBACK` default, `src/config.ts:18` — fallback is manual by design, master plan G3/R-4), **and file the change against demo Spec 01** so the persona spec's voice statement is updated. Any Spec-01 persona copy that names the voice must then say alloy.
- *Ordering note:* run E3 before E4's 20-question session (no reason to collect a preamble-masking baseline in a voice that might change).

**R8 (E4 — delegated-tool latency baseline; PREREQUISITE for the announcement email).**
- *Hypothesis:* with thinking pinned minimal and `maxOutputTokens` capped (demo Spec 03: `MCP_MODEL_ID=google/gemini-3.1-flash-lite`, `MCP_MODEL_MAX_TOKENS=150`, in-handler abort `AbortSignal.any([extra.signal, AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS)])` with `MCP_TOOL_TIMEOUT_MS=3500` [findings/16 C12]), the delegated knowledge call lands at `knowledgeMs` p50 ≈ 0.7–1.2 s, p95 ≤ 3 s [findings/15 claim 14], and the full round trip meets the M3 gate `toolTotalMs < 1500` p50.
- *Config change:* none — measurement of the deployed demo Spec 03 defaults.
- *Measurement:* **≥ 20 live `ask_campus_knowledge` questions across ≥ 5 calls**, spanning ≥ 8 of the corpus's 12 sections plus ≥ 3 deliberately out-of-corpus questions (exercising the `not_found` envelope path). Extract `tools.jsonl` + `knowledge.jsonl`; run `node scripts/aggregate-latency.mjs --tools .../tools.jsonl` and `node scripts/aggregate-latency.mjs --knowledge .../knowledge.jsonl`. Record p50/p95/max/n for `knowledgeMs`, `toolTotalMs`, `secondTtfbMs`, and the count of `isError:true` / timeout results.
- *Thinking-minimal verification (does `providerOptions` pass through?):* the latency distribution IS the primary evidence. At default (unpinned) thinking, 3.1 Flash-Lite measures ~5.9 s TTFT [findings/15 claim 12] — every call would blow the 3.5 s in-handler abort and `knowledge.jsonl` would be a wall of timeouts. Pinned-minimal behavior is sub-second-to-~1.2 s p50 [findings/15 claims 13–14]. Decision rule: `knowledgeMs` p50 < 1500 ms with < 10% timeouts → passthrough confirmed; timeout rate ≥ 50% or p50 pinned at the 3500 ms ceiling → passthrough is NOT working — stop, fix the `providerOptions` syntax in demo Spec 03 (verify the exact passthrough shape per findings/15 claim 12: `providerOptions.google.thinkingConfig`), redeploy, re-run. Secondary evidence (Spec 03 R12 logs it — master plan D11): the `reasoningTokens` count on the `knowledge-call` line — near-zero thinking tokens corroborates minimal.
- *Pass gate (this gate LOCKS the preamble and releases the email):* `toolTotalMs` p50 < 1500 ms (the M3 gate, carried forward — master plan M3; Spec 07 R13) AND `knowledgeMs` p95 ≤ 3000 ms (500 ms headroom under the 3500 ms abort) AND error/timeout share < 10%.
- *Output consumed by demo Spec 01:* the measured `knowledgeMs` p50/p95 pair, written in the ledger. RIO's always-on spoken preamble must be long enough to mask p50 comfortably (tool execution overlaps preamble audio — findings/16 C6: "any tool time that fits inside the preamble's spoken duration is free"). **Do not lock the preamble phrasing before this number exists** — that is why E4 precedes the email (R11). Constraint carried from the base build: the test-asserted preamble sentence in `INSTRUCTIONS` must survive any rewording — `test/gateway.session-config.test.ts:101,126` asserts the exact substring `"Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."` (`src/gateway.ts:241-244`; findings/11 C1) — demo Spec 01 owns how RIO's persona composes around it.
- *Revert rule:* nothing to revert (no flip). A FAIL blocks the email send until demo Spec 03 is fixed and E4 re-passes.

**R9 (E5 — prompt-cache verification; cost check, non-blocking).**
- *Hypothesis:* the corpus-first / question-last prompt order (demo Spec 03) triggers Gemini implicit caching, so repeat questions bill most corpus input tokens at the cache-read rate ($0.03/M vs $0.25/M for `google/gemini-3.1-flash-lite` [findings/15 claims 9, 21]).
- *Config change:* none.
- *Measurement:* during the E4 session (piggyback — same calls), ask ≥ 5 knowledge questions within a few minutes of each other. Evidence that COUNTS (either suffices):
  1. **Gateway usage dashboard:** Vercel dashboard → AI Gateway → usage/observability for `google/gemini-3.1-flash-lite` shows nonzero **cached input tokens** (cache-read line items) for the session window, covering the bulk of the ~corpus-sized input on questions 2..n.
  2. **Response metadata:** demo Spec 03 R12 logs the `generateObject` result's `usage` (`cachedInputTokens` etc. — master plan D11); `knowledge.jsonl` shows cached tokens ≥ 50% of input tokens on repeat questions.
  Screenshot or copied numbers land in the session `notes.md`.
- *Pass gate:* cache reads observed by either evidence class. **FAIL does not revert anything and does not block the email** — corpus-first ordering costs nothing even uncached, and worst-case uncached spend is ~$0.0005/question [findings/15 claims 22, 24]. A FAIL is recorded as a known cost fact in the ledger, nothing more.

**R10 (E6 — turn-level conversation-quality budget; the gates of record for the demo).**
This is not a flip; it is the standing budget every configuration of record must satisfy, evaluated on the R2 baseline and re-evaluated after any PASS that changes the configuration (R1c), and finally on the pre-freeze session (R11):
- **Greeting:** `greetingTotalMs` p50 < 2000 ms (`event:greeting`, `src/latency.ts:238-251` — `tWsStart → tFirstTwilioSend`, the "instant pickup" beat). Also record the decomposition (`webhookToStartMs`, `gatewayOpenMs`, `sessionUpdateAckMs`, `greetingTtfbMs`) so a miss is attributable.
- **Simple (non-tool) turn:** pooled `ttfbMs` p50 ≤ 900 ms over the `has-ttfbMs` partition of `bargedIn:false` turns (server-side core; caller-perceived ≈ this + VAD window + ~200–450 ms network legs, and every reported number MUST use the mandatory honest-accounting phrasing from `docs/measurements/README.md`). The 900 ms target is set by this spec (Open items) from the findings/09 design example (`secondTtfbMs 540.8`) plus headroom; it is a demo-quality bar, not a contractual SLA.
- **Tool turn:** `toolTotalMs` p50 < 1500 ms — **the M3 gate, unchanged** (master plan M3; Spec 07 A6). This applies to the pooled `tool-call` population *including* `ask_campus_knowledge` — the delegated tool does not get a laxer budget; that is exactly what E4 proves is achievable.
- *Miss handling:* an E6 miss is not "revert" (there is nothing to revert to) — it opens a named follow-up experiment (new ledger row, R1 shape) or an accepted, documented exception in the ledger before freeze. The email does not go out with an undocumented E6 miss.

### Ordering and the freeze

**R11 (experiment ordering).**
1. R2 baseline first — nothing flips before it exists.
2. **E3 (voice) early** — it can invalidate persona copy (R7 ordering note).
3. **E4 (and its piggybacked E5) MUST complete and PASS before the announcement email is sent** (demo Spec 06) — the preamble phrasing locks on E4's number.
4. E1 and E2 may run any time between baseline and freeze, one at a time (R1c), in either order.
5. E6 is evaluated on the baseline, after any configuration change, and finally on the last pre-freeze session.
6. **After the email goes out, the deploy freeze (demo Spec 06) is in force: no flips, no experiments, no deploys** — a deploy severs in-flight calls from real invitees. Any experiment not finished before freeze waits for the post-demo window. Every experiment variable must be at its configuration-of-record value at freeze time (i.e., all FAILs reverted, ledger current).

**R12 (the experiment ledger).** `docs/measurements/EXPERIMENTS.md` is a markdown table, one row per experiment run: `date | experiment | variable=value | measurement dir | gate | result (numbers) | verdict PASS / FAIL+REVERTED / BLOCKED | notes`. E3's row records the S8 answer; E1's row records the S1 answer. The ledger is committed with each session's measurement directory (same 72 h deadline, R3). The configuration of record at any moment is derivable from the ledger alone.

## Interfaces

**Consumes (existing base build):**
- Env keys (`src/config.ts`): `AUDIO_MODE` (`'pcmu'|'transcode'`, default `'transcode'`, line 16), `VAD_SILENCE_MS` (default 500, line 19), `VOICE` (default `'marin'`, line 17), `VOICE_FALLBACK` (default `'alloy'`, line 18).
- Log fields per R3a from `event:turn`, `event:tool-call`, `event:greeting`, `event:stream-stop`, `event:session-updated` lines (`src/latency.ts`, `src/logger.ts`).
- `scripts/aggregate-latency.mjs` CLI and `docs/measurements/README.md` extraction procedure + S33 checklist (no M2+-style session is valid before S33 is dated).

**Consumes (demo specs, parallel):**
- Demo Spec 03: env keys `MCP_MODEL_ID` (default `'google/gemini-3.1-flash-lite'`), `MCP_MODEL_MAX_TOKENS` (default `150`), `MCP_TOOL_TIMEOUT_MS` (default `3500`); the `knowledgeMs` flat numeric log field on the `knowledge-call` log line (master plan D2); the logged `usage` token counters `inputTokens`/`outputTokens`/`cachedInputTokens`/`reasoningTokens` (Spec 03 R12, confirmed by master plan D11 — E5/E4 secondary evidence).
- Demo Spec 06: the deploy-freeze rule and email-send event that closes the experiment window.

**Produces:**
- Extended `scripts/aggregate-latency.mjs`: new `--knowledge` flag, `KNOWLEDGE_METRICS = ['knowledgeMs']`, event filter `'knowledge-call'`; `--tools`/`--knowledge` mutually exclusive.
- `docs/measurements/EXPERIMENTS.md` (ledger, R12) and dated measurement directories (R3).
- Verdicts consumed by others: E3 voice verdict → demo Spec 01 (persona copy; `VOICE=alloy` flip if S8 fails); E4 `knowledgeMs` p50/p95 → demo Spec 01 (preamble length) and demo Spec 06 (email release gate); E1 verdict → S1 answer table; E6 numbers → demo Spec 06 email claims (any latency brag in the email must match measured numbers).

## Acceptance criteria

- **A1 (aggregator extension):** `node scripts/aggregate-latency.mjs --knowledge fixture.jsonl` — where `fixture.jsonl` contains three `{"event":"knowledge-call","knowledgeMs":<n>}` lines and one non-JSON line — prints a markdown table with a `knowledgeMs` row, `n`=3, correct nearest-rank p50, and reports 1 skipped line. `--tools --knowledge` together prints usage and exits nonzero. `--metric knowledgeMs` filters to the single row. The script still runs on bare `node` with zero imports from `src/` (`head -20` shows no new imports beyond `node:fs`).
- **A2 (baseline exists):** `docs/measurements/<date>-demo-baseline/` contains the R3 JSONL set incl. `knowledge.jsonl`, a `notes.md` with call count, `AUDIO_MODE`, deploy SHA, and pooled p50/p95/max/n for every R3a metric; committed within 72 h of the session.
- **A3 (E1 evidence):** the E1 measurement dir contains a `session-config.jsonl` whose pcmu-call `session-updated.raw` fragment is quoted in `notes.md`, answering S1 YES or NO explicitly; the ledger row records the verdict; if FAIL, current Railway config shows `AUDIO_MODE=transcode`.
- **A4 (E2 evidence):** the E2 `notes.md` lists per-call clipping observations for ≥ 10 calls including the pause-heavy scripts, plus baseline-vs-400ms `bargedIn` shares; verdict recorded; if FAIL, `VAD_SILENCE_MS=500` restored.
- **A5 (E3 / S8):** the ledger row for E3 quotes the applied-voice value from `session-updated.raw`. If marin was rejected: Railway shows `VOICE=alloy` and a demo Spec 01 change is filed/linked.
- **A6 (E4 gate):** `aggregate-latency.mjs --tools` and `--knowledge` outputs for ≥ 20 knowledge questions are pasted in the E4 `notes.md`; `toolTotalMs` p50 < 1500 and `knowledgeMs` p95 ≤ 3000 and timeout share < 10%; the thinking-passthrough decision rule outcome is stated in one sentence ("p50 = X ms → passthrough confirmed"). The measured p50/p95 pair appears in the ledger row marked "consumed by Spec 01 preamble".
- **A7 (E4 blocks email):** demo Spec 06's email is demonstrably sent only after the E4 ledger row reads PASS (ledger dates prove ordering).
- **A8 (E5 evidence):** the E5 ledger row cites its evidence class (dashboard numbers or logged cached-token counts) or records FAIL-accepted with the uncached cost figure (~$0.0005/question [findings/15 claim 22]).
- **A9 (E6 budget):** the pre-freeze session's `notes.md` states all three E6 numbers (`greetingTotalMs` p50, `ttfbMs` p50, `toolTotalMs` p50) against their gates, using the mandatory honest-accounting phrasing for any turn-latency number; misses have a named follow-up or documented exception.
- **A10 (never-regress audit):** at freeze time, every FAIL row in the ledger has a matching revert (variable back at configuration-of-record value, verifiable in Railway Variables), and no two experiment sessions' time windows overlap.
- **A11 (existing tests unbroken):** the full vitest suite stays green — in particular `test/gateway.session-config.test.ts` (the preamble-substring assertions at lines 101 and 126) is untouched by anything this spec does; this spec changes no `src/` file.

## Non-goals / out of scope

- **No region changes** — Railway stays us-east4; the gateway edge path is not a knob here [findings/15 claim 16].
- **No model swaps and no fallback chains** — `google/gemini-3.1-flash-lite` is the single model by binding decision; no `providerOptions.gateway.models` array, no alternate-model experiments, no realtime-model change. A latency problem is fixed inside the single-model envelope (thinking pin, token cap, timeout) or accepted.
- **No new instrumentation frameworks** — no OpenTelemetry, no APM, no new log events or fields beyond consuming what Spec 08 and demo Spec 03 already emit. The one code change is the R4 aggregator flag.
- **No code-path performance work** — no DSP rewrites, no streaming `generateObject`, no RAG/pre-filtering (whole-corpus stuffing is the bound design [findings/16 C16]), no bridge refactors. Every experiment is an env flip or a pure measurement.
- **No load/concurrency testing** — `scripts/concurrency-probe.ts` and capacity questions stay with the base plan's M4.
- **No post-freeze tuning** — the freeze (R11.6 / demo Spec 06) ends this spec's activity until the demo window closes.

## Open items

- **Knowledge log-line contract (demo Spec 03) — RESOLVED (master plan D2):** the event name is `'knowledge-call'` carrying flat numeric `knowledgeMs`; R4's `wantEvent`, the R3 export query, and A1's fixture lines use it. Field name `knowledgeMs` itself is fixed by the master plan.
- **Usage/metadata logging (demo Spec 03) — RESOLVED (master plan D11):** Spec 03 R12 logs `inputTokens`/`outputTokens`/`cachedInputTokens`/`reasoningTokens` (omit-if-undefined), so E4's secondary thinking-token evidence and E5's evidence class 2 are both available.
- **`ttfbMs` p50 ≤ 900 ms (E6):** target chosen by this spec from findings/09 design numbers, not measured precedent; the human may re-set it after seeing the R2 baseline — record any change in the ledger.
- **Subjective gates need a human:** E1 audio A/B and E2 clipping judgment cannot be run by an agent; they join the M1–M5 "needs the human" queue.

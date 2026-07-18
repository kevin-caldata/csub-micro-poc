# Measurements

This directory is the durable home for latency/logging data extracted from
Railway before it expires, plus the procedures and language required to turn
that data into the M5 findings report. See `docs/specs/08-logging-and-latency-instrumentation.md`
(R13–R16, acceptance A10/A11) and `docs/findings/09-latency-instrumentation.md`
(§9, §10, gotchas 1, 12, 13) for the source material this README transcribes.

## Why this directory exists

Railway Hobby retains logs for only **7 days** [findings/09 V4, gotcha 1].
The M5 dataset — every `stream-start`/`turn`/`tool-call`/`stream-stop`/etc.
line this PoC's logger emits — self-destructs on Railway a week after each
test session unless it is extracted. This repo is the durable store; Railway
is a 7-day cache, nothing more. Every measurement session must be exported
into a dated subdirectory here before the retention window closes (see
Extraction procedure below).

## Extraction procedure

Documented verbatim from Spec 08 R14. Follow these three steps for every
test/measurement session:

1. In Railway Log Explorer, scope to the test session's time window, then run
   and export (copy/download the raw JSON lines) each of:
   - `@event:turn` → `turns.jsonl`
   - `@event:stream-stop` → `summaries.jsonl`
   - `@event:tool-call` → `tools.jsonl`
   - `@event:greeting` → `greetings.jsonl`
   - `@event:session-updated` → `session-config.jsonl` (pcmu-vs-transcode evidence)
   - `@level:error OR @event:custom OR @event:gateway-close` → `anomalies.jsonl` (S11/S14 evidence)

2. Land the files in the repo at `docs/measurements/<YYYY-MM-DD>-<milestone-or-label>/`
   (e.g. `docs/measurements/2026-07-21-m2-bargein/`), one directory per test
   session, plus a `notes.md` containing:
   - who called
   - how many calls
   - `AUDIO_MODE`
   - deploy SHA from `RAILWAY_GIT_COMMIT_SHA`
   - anything anomalous

   Commit and push — the repo is the durable store; Railway is a 7-day cache.

3. Run `node scripts/aggregate-latency.mjs docs/measurements/<dir>/turns.jsonl`
   → prints cross-call nearest-rank p50/p95/max + n for `ttfbMs`, `bridgeMs`,
   `turnMs`, `playbackConfirmMs` (excluding `bargedIn` turns lacking
   `ttfbMs`), and for `tools.jsonl` the `mcpMs`/`gateWaitMs`/`secondTtfbMs`/`toolTotalMs`
   set. Output pasted into the M5 README findings section.

**Timing:** target extraction the **same day** as the test session; **hard
deadline: 72 h** (leaves buffer for indexing lag and re-pulls). Do not let a
measurement session cross the 7-day retention wall unextracted.

## Aggregation

The extraction procedure's step 3 uses `scripts/aggregate-latency.mjs`
(T08.4), a zero-dependency Node ESM script with CLI shape:

```
node scripts/aggregate-latency.mjs [--tools] [--metric <name>] <file.jsonl> [more.jsonl...]
```

Commands to run against a landed measurement directory:

```
node scripts/aggregate-latency.mjs docs/measurements/<dir>/turns.jsonl
node scripts/aggregate-latency.mjs --tools docs/measurements/<dir>/tools.jsonl
```

Optional flags: `--metric <name>` restricts output to a single metric
(`ttfbMs`, `bridgeMs`, `turnMs`, `playbackConfirmMs` in default mode;
`mcpMs`, `gateWaitMs`, `secondTtfbMs`, `toolTotalMs` in `--tools` mode). The
script tolerates non-JSON lines (reports a skipped count) and pools raw
per-turn/per-tool-call values across every file argument.

**Hard rule (R12/R14, gotcha 13):** cross-call percentiles reported in any
findings section come **only** from running this script over raw
`event:turn` (or `event:tool-call`) lines. Never compute cross-call
percentiles by averaging per-call p50s — percentile-of-percentiles is
statistically wrong. `stream-stop` lines carry per-call `*P50`/`*P95` fields
for live sanity-checking during a call, but the M5 numbers always come from
this script over the raw turn lines.

## Log Explorer verification checklist (S33 — run on the FIRST deployed build)

Per Spec 08 R15. Run every item below against the first deployed build and
date each one as it is confirmed. **No M2+ measurement session is valid
before this checklist is dated** (A11).

- [ ] 1. A `stream-start` line renders with level colorization (i.e. parsed as JSON, not plain text). Date checked: ____
- [ ] 2. `@callSid:<sid>` returns exactly that call's lines. Date checked: ____
- [ ] 3. `@event:turn` and `@event:stream-stop` filter correctly (flat-field custom attributes work). Date checked: ____
- [ ] 4. Numeric filter works: `@ttfbMs:>0` returns turn lines; `@ttfbMs:>800` returns the slow subset. (Numeric filters only work on JSON-parsed lines — a plain-text line silently drops out.) Date checked: ____
- [ ] 5. Boolean combos: `@event:turn AND @bargedIn:false`, `@level:error OR @event:custom`, negation `-@event:speech-started`. Date checked: ____
- [ ] 6. Burst check: after a call ends, confirm `@callSid` query completeness within ~a minute (indexing lag). Date checked: ____
- [ ] 7. Confirm the 500/s warning line does NOT appear during a normal call (if it does, a per-frame log leaked — fix before any measurement session). Date checked: ____

**Numeric-filter fallback (S33):** if `@ttfbMs:>800` fails to return results,
export `@event:turn` and filter offline instead — `scripts/aggregate-latency.mjs`
(R16) already reads raw exported lines and does not depend on Railway's
numeric filter working, so the extraction procedure above is unaffected.

## Query cookbook

The seven queries from Spec 08 R15 / findings/09 §10:

```
@callSid:CAxxxxxxxx                          # one call, all events
@event:turn AND @ttfbMs:>800                 # slow turns across all calls
@event:turn AND @bargedIn:false              # clean turns for percentile extraction
@event:stream-stop                           # per-call summaries
@event:tool-call AND @toolTotalMs:>1500      # M3 acceptance violations
@level:error OR @event:custom                # anomalies incl. unmapped gateway events
@callSid:CAxxxx AND (@event:first-audio-delta OR @event:barge-in)
```

## Honest accounting & calibration

Per Spec 08 R13. The logs measure the **server-observable turn core**
`turnMs = tFirstTwilioSend − tSpeechStopped`. What they can NOT measure:

```
mouth-to-ear turn gap ≈
    uplink: last syllable → Twilio edge → bridge → gateway → OpenAI   (~100–250 ms, unobservable)
  + VAD silence window (silence_duration_ms, default 500 ms, deterministic)
  + VAD processing + speech_stopped propagation                        (folded into measured ttfbMs)
  + measured ttfbMs + bridgeMs                                         (the logs' contribution)
  + downlink: bridge → Twilio WS (~10–40 ms) → jitter buffer → PSTN    (~100–200 ms, unobservable)
```

Every M5 report section that cites a turn-latency number **must** use this
mandatory phrasing:

> **"measured server-side turn core X ms; estimated caller-perceived ≈ X + ~500 ms (VAD window) + ~200–450 ms (PSTN/network legs, unmeasured)"**

Server-side tighteners: `playbackConfirmMs` bounds the downlink-to-Twilio-buffer
leg; `vadGapMs` (if S5 raw passthrough holds) cross-checks the VAD window.

**Caveat (R12):** with n < 20 turns, "p95" is effectively the max — always
report `max` and `n` alongside any p95, and state this caveat wherever these
numbers appear.

**Calibration-call plan (M5, fits the no-recording constraint):** make 2–3
test calls on speakerphone next to a laptop recording room audio
(Audacity/QuickTime); measure the audible speech-end → response-start gap in
the waveform; report the offset between waveform-measured and
server-measured (`turnMs`) values. One paragraph turns "estimated" into
"calibrated". Context for interpreting results: best published server_vad
PSTN comparable is ~1.4 s p50 direct-to-OpenAI (techsy.io), Twilio's
mouth-to-ear target is 1,115 ms median — the BRD's 1.0–1.5 s p50 is realistic
but tight; if measurements land 1.4–1.7 s the first knob is
`silenceDurationMs`, not the bridge.

Results of the calibration calls land in a dated subdirectory of this
directory (per the extraction procedure's naming convention, e.g.
`docs/measurements/<YYYY-MM-DD>-calibration/notes.md`) and are summarized in
the M5 README findings section.

# T08.2 — TurnRecorder core: types, `pct`, per-turn state machine

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Create `src/latency.ts` with the FR-6 record types, the nearest-rank `pct` helper, and the `TurnRecorder` per-turn state machine (speech-stopped → response-created → first delta → first send/flush → mark echo → response-done) keyed by `responseId`, emitting the `speech-started`/`speech-stopped`/`first-audio-delta`/`first-twilio-send`/`barge-in`/`turn` log lines.

**Wave:** B · **Depends on:** T08.1 · **Blocks:** T08.3, T05, T10

**References:**
- `docs/specs/08-logging-and-latency-instrumentation.md` — R4 (clock discipline), R5 (types, verbatim), R6 (state machine + all three edge cases), R8 (send-vs-flush honesty), R9 (consumed event/field names), R11 (event vocabulary rows: `speech-started`, `speech-stopped`, `first-audio-delta`, `first-twilio-send`, `barge-in`, `turn`), R12 (`pct` code, verbatim), acceptance A4, A5, A8 (pct half), A9
- `docs/findings/09-latency-instrumentation.md` — §1–§2, §5, §7, gotchas 5–10
- `docs/findings/02-ai-sdk-realtime-event-protocol.md` — server-event union (exact field names the hooks consume)
- `docs/findings/10-gap-analysis-and-contradictions.md` — T3 (mark namespace `r<responseId>:<seq>`), C4 (mark echo tolerance)
- `docs/specs/05-session-bridge-and-barge-in.md` — R6 + R10 (read only to see how session.ts will call these hooks; do NOT create or edit `src/session.ts`)
- `plans/08-logging-latency/01-final-logger.md` — Produces section (logger surface)

## Interfaces

**Consumes** (from T08.1 `src/logger.ts`): `logEvent`, `LogFields`, `ms`, `now`, `safeRaw`.

**Produces** (exported from `src/latency.ts`; T08.3 extends this same file, T05 calls the hooks):
- `interface TurnRecord`, `interface ToolTiming` — field names EXACTLY as Spec 08 R5 (declare `ToolTiming` now; its hooks land in T08.3)
- `pct(values: number[], p: number): number | undefined` — verbatim Spec 08 R12 code block
- `type EmitFn = (fields: LogFields) => void`
- `class TurnRecorder`:
  - `constructor(ids: { callSid: string; streamSid: string }, emit?: EmitFn)` — `emit` defaults to `logEvent`; every emitted line carries `callSid`, `streamSid`, `event` (Spec 08 R2 constant field set; `ts` is added by the logger)
  - `onSpeechStarted(): void` — emits `speech-started`; if a response is active (post-first-delta, pre-response-done) sets `bargedIn = true` (R6.5)
  - `onSpeechStopped(info?: { latestMediaTimestamp?: number; rawAudioEndMs?: number }): void` — R6.1: closes any dangling turn as incomplete, opens the next `TurnRecord`, emits `speech-stopped` with `latestMediaTimestamp` and absent-safe `vadGapMs` (S5/S34 — field simply omitted when `rawAudioEndMs` undefined)
  - `onResponseCreated(responseId: string): void` — R6.2 attach + stamp; ignores responseIds it cannot attribute (greeting/tool-follow-up attribution is added by T08.3 — leave a clearly marked seam)
  - `onAudioDelta(responseId: string): boolean` — R6.3; returns `true` exactly when this is the first tracked delta of that response (the session uses the return value to know it must call the two send hooks and queue the instrumented mark); stamps `tFirstAudioDelta` with lazy `responseId` attach fallback (S16); emits `first-audio-delta` with `ttfbMs`; returns `false` for every subsequent delta and never emits for them
  - `onFirstTwilioSend(responseId: string): void` — stamps `tFirstTwilioSend`, emits `first-twilio-send` with `bridgeMs` and (once flush is stamped) `flushLagMs` — see R8; if flush hasn't landed yet emit `flushLagMs` on the consolidated `turn` line instead
  - `onFirstTwilioFlush(responseId: string): void` — R8 send-callback stamp
  - `onMarkEcho(name: string): void` — parses the T3 namespace `r<responseId>:<seq>`; stamps `tFirstMarkEcho` iff it is the first mark of a known response and unset; silently ignores all other echoes incl. post-`clear` storms (R6.4, C4)
  - `onBargeIn(info?: { audioEndMs?: number; itemId?: string }): void` — emits one `barge-in` line with `msSinceFirstSend` (computed from `tFirstTwilioSend`) + passthrough fields (R6.5; Spec 05's `bargeIn()` calls this)
  - `onResponseDone(responseId: string, status: string): void` — R6.6: stamps, computes `ttfbMs`/`bridgeMs`/`turnMs`/`playbackConfirmMs` via `ms()`, computes `perceivedMs` when applicable (edge case 1 — full wiring in T08.3), pushes to an internal `turns: TurnRecord[]` (readable by T08.3's summary), emits ONE consolidated `turn` line matching the canonical example in Spec 08 R11 (`status` logged as the raw string, S12), clears `currentTurn`
- Internal invariant (A4): every timestamp uses `now()`; every logged delta uses `ms()`; `Date.now()` appears nowhere in this file.

## Steps

- [ ] Read the References. Note the canonical `turn` line JSON example in Spec 08 R11 — the test asserts that exact field set.
- [ ] Write `src/latency.test.ts` (`node:test` + `node:assert/strict`, Spec 01 R7 conventions) using an injected `emit` spy that collects `LogFields[]` (no stdout parsing needed here). Script event sequences with small real waits or by asserting relative ordering/derivation rather than absolute times. Test cases:
  1. `pct`: empty → `undefined`; n=1 → that value; n=20 known array → nearest-rank p50/p95 values as computed by hand (A8).
  2. Happy turn: `onSpeechStopped → onResponseCreated('r1') → onAudioDelta('r1')` returns `true` → `onFirstTwilioSend('r1')` → `onFirstTwilioFlush('r1')` → `onMarkEcho('rr1:0')` → `onResponseDone('r1','completed')` emits exactly one `turn` line with `turn:1`, `responseId:'r1'`, numeric `ttfbMs`/`bridgeMs`/`turnMs`/`playbackConfirmMs`, `bargedIn:false`, `status:'completed'`, and `turnMs === ttfbMs + bridgeMs` within ±0.2 (A5).
  3. Second `onAudioDelta('r1')` returns `false` and emits nothing (R3 discipline).
  4. Lazy attach (S16): delta arrives before `response-created` — `onAudioDelta('r2')` after `onSpeechStopped` still returns `true` and the turn ends keyed `r2`.
  5. Foreign responseId: `onAudioDelta('rX')` for an untracked response returns `false`, emits nothing (responseId keying, gotcha 9).
  6. Barge-in after first delta: `onSpeechStarted` mid-response sets `bargedIn:true` on the `turn` line; `ttfbMs` still present (A9 first half). `onBargeIn({audioEndMs:1234})` emits a `barge-in` line with numeric `msSinceFirstSend`.
  7. Barge-in before first delta: turn closes with no `ttfbMs` (A9 exclusion input — the `n` exclusion itself is asserted in T08.3's summary test).
  8. Mark echo tolerance: unknown/duplicate mark names and post-clear echoes never throw and never restamp `tFirstMarkEcho` (C4).
  9. Dangling turn: a second `onSpeechStopped` before `response-done` closes the first turn as incomplete (no derived metrics, no crash) and opens turn 2 (R6.1).
- [ ] Run `npx tsx --test src/latency.test.ts` — expect FAIL (module missing).
- [ ] Implement `src/latency.ts` per Spec 08 R5/R6/R8/R11/R12 (types and `pct` verbatim from the spec's code blocks; state machine per R6 steps 1–6). Do NOT touch `src/session.ts`, `src/server.ts`, or `src/logger.ts`.
- [ ] Run `npx tsx --test src/latency.test.ts` — expect PASS.
- [ ] Run `npm test && npm run typecheck` — expect PASS / exit 0.
- [ ] Grep gate (A4): `node -e "const s=require('fs').readFileSync('src/latency.ts','utf8'); if(/Date\.now\(\)/.test(s)){console.log('FAIL Date.now in latency.ts');process.exit(1)};console.log('ok')"` — expect `ok`.
- [ ] Commit with message:
  `feat(latency): TurnRecorder per-turn state machine, pct helper, FR-6 record types`
  plus the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 08 **A4** (no `Date.now()` metric paths in `latency.ts`), **A5** (responseId keying + `turnMs = ttfbMs + bridgeMs` unit test; follow-up-attribution half completed in T08.3), **A8** (`pct()` unit tests), **A9** (bargedIn tagging + missing-`ttfbMs` behavior; percentile exclusion asserted in T08.3). Runtime halves of A1 are discharged at M1+ via T05.

## Completion Report

```
Task: T08.2 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec A-numbers verified: [A4, A5 partial, A8 partial, A9 partial]
Deviations from plan: [none | list]
New interfaces exposed: TurnRecord, ToolTiming, pct, EmitFn, TurnRecorder + hook methods (src/latency.ts)
Notes for ledger: [exact hook signatures if they differ from plan — T05 consumes them]
```
(keep under ~20 lines)

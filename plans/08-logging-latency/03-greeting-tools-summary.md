# T08.3 — Greeting record, tool round-trip decomposition, stream-stop summary + event-loop guard

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Extend T08.2's `TurnRecorder` in `src/latency.ts` with the FR-1 `GreetingRecord`, the R10 `ToolTiming` hook set (M3 `toolTotalMs` decomposition), and the `stream-stop` per-call percentile summary with the `monitorEventLoopDelay` guard.

**Wave:** B · **Depends on:** T08.2 · **Blocks:** T05, T09, T10

**References:**
- `docs/specs/08-logging-and-latency-instrumentation.md` — R7 (greeting chain + `getTokenMs`), R10 (tool derived fields), R11 (rows `greeting`, `tool-call`, `stream-stop` + canonical example lines), R12 (summary fields + `monitorEventLoopDelay` snippet, verbatim), R6.2 (follow-up attribution: "the bridge sent that response-create itself, so it knows"), acceptance A5, A6, A7, A8, A9
- `docs/findings/09-latency-instrumentation.md` — §3 (greeting), §4 (tool round trip), §7 (percentile caveats: always log `max` and `n`), §8 (event-loop lag guard, verbatim code)
- `docs/specs/02-http-server-and-twiml-webhook.md` — Interfaces/Produces section ONLY (where `getTokenMs`/`tTwimlPost` originate: the webhook mints the token, so the greeting seed values are handed to the Session via the pendingCalls claim — the recorder just accepts them as a seed object)
- `plans/08-logging-latency/02-turn-recorder-core.md` — Interfaces section (hook surface being extended)

## Interfaces

**Consumes:** T08.2's `TurnRecorder`, `pct`, `ToolTiming`, internal `turns[]`; T08.1's `logEvent`/`ms`/`now`.

**Produces** (added to `src/latency.ts`):
- `interface GreetingRecord` — perf timestamps `tTwimlPost?`, `tWsStart?`, `tGatewayOpen?`, `tSessionUpdateSent?`, `tSessionUpdated?`, `tGreetingCreateSent?`, `tFirstAudioDelta?`, `tFirstTwilioSend?`, `tFirstMarkEcho?` plus `getTokenMs?`, `tokenExpiresAt?` (Spec 08 R7)
- New `TurnRecorder` methods (T05 calls all of these):
  - `seedGreeting(seed: { tTwimlPost?: number; getTokenMs?: number; tokenExpiresAt?: string }): void`
  - `onWsStart(): void` — Twilio `start`; also anchors `tStreamStartPerf` for R4 media-clock math and starts call duration
  - `onGatewayOpen(): void` · `onSessionUpdateSent(): void` · `onSessionUpdated(): void` · `onGreetingCreateSent(): void`
  - Greeting response attribution: the first `onResponseCreated`/lazy first delta arriving after `onGreetingCreateSent` and before any `onSpeechStopped` belongs to the greeting, NOT a turn (Spec 08 R6 edge case 3 / A9); greeting audio reuses `onAudioDelta`/`onFirstTwilioSend`/`onFirstTwilioFlush`/`onMarkEcho` (return-value contract unchanged)
  - Emission rule for the ONE `greeting` line (R7 fields `webhookToStartMs`, `gatewayOpenMs`, `sessionUpdateAckMs`, `greetingTtfbMs`, `greetingBridgeMs`, `greetingPlaybackConfirmMs`, `greetingTotalMs`, `getTokenMs`, `tokenExpiresAt`): emit at the greeting's first mark echo; fallback-emit at the greeting response-done if no echo arrived (line must never be lost); all deltas absent-safe
  - `onToolArgsDone(callId: string, name: string): void` — opens a `ToolTiming` on the current turn (R10)
  - `onToolResolved(callId: string, isError?: boolean): void` · `onToolOutputSent(callId: string): void`
  - `onToolResponseCreateSent(callId: string): void` — marks the NEXT `response-created`/first-delta as this tool's follow-up (R6.2); the follow-up's first delta stamps `tFollowupFirstDelta` (never a new turn's `ttfbMs` — A5) and emits the `tool-call` line with `mcpMs`, `gateWaitMs`, `secondTtfbMs`, `toolTotalMs`, `isError?` (R10, R11); on tool failure with no follow-up audio, emit the `tool-call` line at turn close with the available deltas + `isError:true`
  - `onStreamStop(): void` — emits the `stream-stop` summary line (R12): `durationS`, `turns`, `n` (complete turns not barged before first audio; greeting never included — A9), `bargeIns`, `ttfbP50/ttfbP95/ttfbMax`, `bridgeP50/bridgeP95`, `turnP50/turnP95/turnMax`, `toolCalls`, `toolTotalP50`, `loopP99Ms`; all percentiles via `pct` (nearest-rank); idempotent (second call no-ops)
  - `perceivedMs` wiring (R6 edge case 1): on the `turn` line when `ttfbMs` absent and a tool follow-up produced audio, `perceivedMs = tools[last].tFollowupFirstDelta − tSpeechStopped`
- `startLoopMonitor(): void` and `loopP99Ms(): number | undefined` — module-level `monitorEventLoopDelay({ resolution: 20 })` per Spec 08 R12 (one process-wide histogram, never reset between calls). This is the "ready-to-paste block" the master plan assigns here: `server.ts` is owned by T02/T05, so this task ships the function; the ONE boot call site `startLoopMonitor()` is added by T05 at Session-bridge integration (record this in the completion report so the orchestrator wires it at the Wave D merge).

## Steps

- [ ] Read the References; re-read Spec 08 R11's canonical `tool-call` and `stream-stop` example lines — tests assert those exact field names.
- [ ] Extend `src/latency.test.ts` with new `node:test` cases (injected `emit` spy as in T08.2):
  1. Greeting flow: `seedGreeting({tTwimlPost, getTokenMs:87.2, tokenExpiresAt}) → onWsStart → onGatewayOpen → onSessionUpdateSent → onSessionUpdated → onGreetingCreateSent → onResponseCreated('g1') → onAudioDelta('g1')` (returns `true`) `→ onFirstTwilioSend('g1') → onMarkEcho('rg1:0')` emits ONE `greeting` line with all R7 delta fields numeric, `getTokenMs` present (A7), and NO `turn` line for `g1` (A9).
  2. Greeting fallback: same flow without any mark echo → `greeting` line emitted at `onResponseDone('g1', 'completed')`, `greetingPlaybackConfirmMs` absent.
  3. Tool follow-up attribution (A5): turn with `onToolArgsDone('call_1','get_current_time') → onToolResolved → onToolOutputSent → onResponseDone('r1',…) → onToolResponseCreateSent('call_1') → onResponseCreated('r2') → onAudioDelta('r2')` → `tFollowupFirstDelta` stamped on the ToolTiming, `tool-call` line emitted with numeric `mcpMs`/`gateWaitMs`/`secondTtfbMs`/`toolTotalMs` (A6), and NO new turn opened for `r2`.
  4. Tool failure: `onToolResolved('call_1', true)` with no follow-up audio → `tool-call` line carries `isError:true` and no `secondTtfbMs`.
  5. Summary (A8/A9): drive ≥3 complete turns + 1 barged-before-first-audio turn + the greeting, then `onStreamStop()` → one `stream-stop` line where `turns` counts all turns, `n` = complete turns only (excludes the barged-no-audio turn AND the greeting), `bargeIns` correct, `ttfbP50/P95/Max`, `turnP50/P95/Max`, `bridgeP50/P95`, `toolCalls`, `loopP99Ms` present and numeric.
  6. `onStreamStop()` twice emits exactly one summary.
  7. `loopP99Ms()` after `startLoopMonitor()` returns a finite number ≥ 0.
- [ ] Run `npx tsx --test src/latency.test.ts` — expect FAIL (new hooks missing).
- [ ] Implement in `src/latency.ts` per Spec 08 R7/R10/R12 (loop-guard code verbatim from R12/findings-09 §8). No edits outside `src/latency.ts` and its test.
- [ ] Run `npx tsx --test src/latency.test.ts` — expect PASS.
- [ ] Run `npm test && npm run typecheck` — expect PASS / exit 0.
- [ ] Re-run the A4 grep gate: `node -e "const s=require('fs').readFileSync('src/latency.ts','utf8'); if(/Date\.now\(\)/.test(s)){console.log('FAIL');process.exit(1)};console.log('ok')"` — expect `ok`.
- [ ] Commit with message:
  `feat(latency): greeting record, tool round-trip decomposition, stream-stop summary with loop guard`
  plus the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 08 **A5** (follow-up attribution half), **A6** (unit-level; live `<1500 ms` check happens at M3), **A7** (unit-level; live check at M1), **A8** (summary fields incl. `loopP99Ms`), **A9** (greeting + barged-turn percentile exclusion). A1's live ordered-line check remains with T05/M1.

## Completion Report

```
Task: T08.3 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec A-numbers verified: [A5, A6 unit, A7 unit, A8, A9]
Deviations from plan: [none | list]
New interfaces exposed: GreetingRecord, greeting/tool/stream-stop hooks, startLoopMonitor, loopP99Ms
Notes for ledger: REMIND orchestrator — T05 must call startLoopMonitor() once at boot and wire all hook call sites (Spec 08 R6/R7/R10)
```
(keep under ~20 lines)

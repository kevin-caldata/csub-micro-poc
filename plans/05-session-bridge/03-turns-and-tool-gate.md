# T05.3 — Turn lifecycle wiring & tool-flow response-create gate

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Wire Spec 08's `TurnRecorder` hook call sites and Spec 07's `ToolLoop` into the dispatch loop, implementing the R10 turn-phase machine and the R8 double-gated post-tool `response-create` (re-checked on every `response-done`).

**Wave:** D · **Depends on:** T05.2, T07, T08 · **Blocks:** T05.4, T10

**References:**
- `docs/specs/05-session-bridge-and-barge-in.md` — R2 (rows: `speech-stopped`, `response-created`, `response-done`, `function-call-arguments-done`, `audio-transcript-delta/done`, `input-transcription-completed`), R8 (tool gate), R10 (turn lifecycle table + correlation-by-responseId rule), A3
- `docs/specs/07-mcp-server-and-tool-loop.md` — R10–R14 (`ToolLoop` state, event handling, `tryReleaseGate` double gate, `ToolTiming`, `dispose`)
- `docs/specs/08-logging-and-latency-instrumentation.md` — R5 (`TurnRecord`/`ToolTiming` schema), R6 (hook API `TurnRecorder` exposes — session.ts calls these), R9 (exact consumed event/field names), R11 (`turn`, `tool-call`, `input-transcript`, `output-transcript` lines)
- `docs/findings/09-latency-instrumentation.md` — §2 (turn timestamps, steps 1–6, edge cases), gotcha 9 (never "next delta I see")
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — G7 (why the BRD gate alone is insufficient)

## Interfaces

**Consumes:**
- `dispatch` / `Session` from T05.2 (`src/session.ts`, `src/sessions.ts`).
- `TurnRecorder` from `src/latency.ts` (Spec 08 R6 — exact as-built constructor/hook names; expected hooks: `onSpeechStopped`, `onResponseCreated(responseId)`, `onAudioDelta(responseId)`, `onMarkEcho(name)`, `onSpeechStarted`, `onResponseDone(responseId, status)`).
- `ToolLoop` from `src/tools.ts` (Spec 07 R10–R12 — exact as-built API; expected surface: a `function-call-arguments-done` handler, a `response-done` notification that internally calls `tryReleaseGate()`, and `dispose()`; constructed with `{ client, gwSend, log }` and a way to read `session.responseActive`).
- Logger (Spec 08 R1/R11 line shapes).

**Produces:**
- Modified `src/session.ts`: dispatch rows now drive `s.recorder` and `s.toolLoop`; `turnPhase` transitions per Spec 05 R10 table; transcript accumulation; `pendingToolCalls`/`toolResponseCreatePending` state per Spec 05 R1/R8 (state may live inside the as-built `ToolLoop` — do NOT duplicate it in two places; the Session fields defer to `ToolLoop`'s state where Spec 07 already owns it).
- `src/session-turns.test.ts`. (Interim `src/` location per the `npm test` glob `src/**/*.test.ts`; T10.1 migrates it under `test/`.)

## Steps

- [ ] Read the References, then the as-built `src/latency.ts` and `src/tools.ts` — record the EXACT exported names/signatures of `TurnRecorder` and `ToolLoop` (Spec 07/08 are authoritative for behavior; the as-built exports are authoritative for names). If either export is missing or shaped differently, adapt the call sites — never re-implement recorder/loop logic here.
- [ ] Write `src/session-turns.test.ts` (same runner style as prior tasks) driving `dispatch` on a fake Session carrying a REAL `TurnRecorder` and a REAL `ToolLoop` (fake MCP client whose `callTool` resolves canned output; captured `gateway.send`). Required cases:
  - Plain turn: `speech-stopped → response-created(r1) → audio-delta(r1) → response-done(r1, 'completed')` emits exactly ONE consolidated `turn` line with `responseId: r1`, numeric `ttfbMs`/`bridgeMs`/`turnMs`, `bargedIn: false`; `turnPhase` walks `user-speaking?/awaiting-response → responding → idle` per Spec 05 R10 (phase is advisory — assert it never gates `bargeIn`).
  - Correlation: an `audio-delta` for an unrelated responseId does not stamp the current turn's `tFirstAudioDelta` (findings/09 gotcha 9).
  - Tool gate happy path: `function-call-arguments-done(callId c1)` while `responseActive === true` → tool output `conversation-item-create` (with `name` included) sent, but NO `response-create` until `response-done` for the tool-bearing response arrives → then exactly ONE `response-create` (Spec 05 R8 conditions a+b re-checked at `response-done`).
  - Deferral/re-check: after outputs are sent, a VAD-created response (`response-created(r2)`) is active at gate time → no `response-create`; the NEXT `response-done(r2)` releases exactly one (Spec 05 R8 "defer to the next response-done"; Spec 07 R12 gate c/d).
  - Idempotence: further `response-done` events after release send no second `response-create`.
  - No-audio turn (straight to function call): `ttfbMs` absent on the `turn` line; no crash (findings/09 §2 edge case).
  - Greeting: a response with no preceding `speech-stopped` (turn 0) flows through dispatch with zero special casing and no spurious `turn`-machine corruption of turn 1.
  - Transcripts: `audio-transcript-delta` accumulates silently (no per-delta log); `audio-transcript-done` emits one `output-transcript` line; `input-transcription-completed` emits one `input-transcript` line with `itemId`.
- [ ] Run the suite; expect FAIL.
- [ ] Implement the wiring in `src/session.ts` per Spec 05 R2 rows + R8 + R10, delegating: recorder stamps to `TurnRecorder` (Spec 08 R6 steps 1–6), tool execution/gating to `ToolLoop` (Spec 07 R11–R12). `response-done` must (in order): set `responseActive = false`, notify the recorder, notify the ToolLoop (its deferred-retry path), set `turnPhase = 'idle'`. `response-created` attribution: bridge-initiated post-tool responses attach to the pending `ToolTiming`, VAD responses to `currentTurn` (Spec 05 R10 table row 3 — the bridge knows because ToolLoop sent that `response-create` itself; use its `awaitingFollowup` flag).
- [ ] Run targeted suite; expect PASS. Run `npm test`; expect all suites green (T05.1/T05.2/T07/T08 suites must not regress).
- [ ] Run `npm run typecheck && npm run build`; expect exit 0.
- [ ] Commit with message:
  `feat(session): turn lifecycle machine and double-gated tool response-create wiring` and trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Acceptance

Discharges Spec 05 **A3** (unit: one consolidated `turn` line per turn, no per-delta logs) and the offline verification of **R8** (gate re-check on every `response-done`). Live M3 (`toolTotalMs < 1500`) and A1 are milestone checks executed via T10.

## Completion Report

```
Task: T05.3 — Turn lifecycle & tool gate wiring
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <command → outcome, one line each>
Spec A-numbers verified: <A3 + R8 gate cases with test names>
Deviations from plan: <none | list>
New interfaces exposed: <Session.recorder/toolLoop wiring; any adapter shims written>
Notes for ledger: <exact as-built TurnRecorder/ToolLoop API names found; where pendingToolCalls state actually lives>
```

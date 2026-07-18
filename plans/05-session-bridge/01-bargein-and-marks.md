# T05.1 — Barge-in module & unified mark registry (`src/bargein.ts`)

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Implement the corrected barge-in sequence (C2/C3/C4 fixes, no `response-cancel`) and the unique-name mark registry as a pure-logic, unit-tested module.

**Wave:** D · **Depends on:** T01, T03, T04, T06 · **Blocks:** T05.2, T05.3, T05.4, T10

**References:**
- `docs/specs/05-session-bridge-and-barge-in.md` — R1 (state shape), R5 (barge-in sequence, verbatim logic), R6 (mark registry rules), A7–A11, A13, A14
- `docs/specs/03-twilio-media-ws-leg.md` — R4 (`mark` message case), R5 (send helpers + mark naming rule), R9 (`Session` interface / `sessions` registry)
- `docs/specs/04-gateway-realtime-leg.md` — R5 (`GatewayLeg.send`)
- `docs/specs/06-audio-dsp-transcoding.md` — R3 (`Transcoder.resetOutbound`), R11 (call-site contract)
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — V3, V4, G1–G6, D4
- `docs/findings/03-twilio-media-streams.md` — claims 5, 16.3, gotcha 3
- `docs/findings/10-gap-analysis-and-contradictions.md` — C2, C3, C4, T3, T4
- `docs/specs/00-master-build-plan.md` — §8 R-1 (test-runner adjudication)

## Interfaces

**Consumes:**
- `Session` interface and `sessions` map from `src/sessions.ts` (Spec 03 R9) — fields `markQueue`, `markSeq`, `responseStartTimestamp`, `currentResponseId`, `lastAssistantItemId`, `responseActive`, `latestMediaTimestamp`, `twilioWs`, `streamSid`, `callSid`, plus hooks `onPlaybackDrained?`, `onFirstMarkEcho?`.
- `GatewayLeg.send(ev: ClientEvent): Promise<void>` on `session.gateway` from `src/gateway.ts` (Spec 04 R5) — carries the `conversation-item-truncate`.
- `Transcoder.resetOutbound(): void` on `session.transcoder` from `src/dsp.ts` (Spec 06 R3).
- Shared logger (`logEvent`/`log` per Spec 01 R12 boundary; Spec 08 R1 final shape).
- `sendMark` / `sendClear` helpers from `src/twilio-media.ts` (Spec 03 R5) — reuse, do not re-implement the wire format.

**Produces:**
- `src/bargein.ts` exporting exactly:
  - `export function bargeIn(s: Session): void` — Spec 05 R5
  - `export function pushMark(s: Session, name: string): void` — Spec 05 R6.1 (composes Spec 03's `sendMark`, adds `firstMarkNameOfResponse` bookkeeping)
  - `export function onMarkEcho(s: Session, name: string): void` — Spec 05 R6.2 (remove-by-name splice, first-mark hook, drain → `responseStartTimestamp = null`)
- `src/bargein.test.ts` — Spec 05 A8, A9, A10, A11 + the bargeIn half of A13 + static half of A14. (Interim `src/` location so T01's `npm test` glob `src/**/*.test.ts` picks it up — ledger pre-declared runner rule; T10.1 migrates it under `test/` and T10.4 absorbs it.)
- Additive edit to `src/sessions.ts`: field `firstMarkNameOfResponse: string | null` on `Session` (Spec 05 R1) if not already declared. No renames of existing fields.

## Steps

- [ ] Read the References, then read the as-built `src/sessions.ts`, `src/twilio-media.ts`, `src/gateway.ts`, `src/dsp.ts` to confirm exact exported names and the current `mark`-case implementation in the Twilio route.
- [ ] Determine the repo's test runner (inspect `package.json` `"test"` script — master plan §8 R-1 says either node:test-via-tsx or vitest is acceptable until T10 consolidates). Write the new suite in the SAME style as the existing suites (interim location `src/*.test.ts`, matching the `npm test` glob `src/**/*.test.ts`). Targeted-run command is `npx vitest run src/bargein.test.ts` (vitest) or `npx tsx --test src/bargein.test.ts` (node:test) accordingly.
- [ ] Write `src/bargein.test.ts` with a minimal Session-shaped fixture (fake `twilioWs` capturing `send`/`readyState`, fake `gateway.send` capture, spy `transcoder.resetOutbound`) covering exactly these named cases:
  - A9 no-op guard: `markQueue.length === 0 && !responseActive` → nothing sent on either socket.
  - A10 pre-delta barge-in: `responseActive === true`, epoch `null` → `clear` sent, NO truncate.
  - A11 multiple barge-ins: second `bargeIn` after the first (state disarmed) is a no-op; after simulating the next response's first delta re-arm, `bargeIn` fires again.
  - A8 mark storm: after `bargeIn` flushes the queue, `onMarkEcho` replays of the flushed names leave `markQueue` empty and do not remove marks pushed (via `pushMark`) for the next response; a barge-in on that next response still fires.
  - Epoch arithmetic: with `responseStartTimestamp` and `latestMediaTimestamp` set, the truncate event carries `audioEndMs = max(0, latestMediaTimestamp - responseStartTimestamp)` and `itemId = lastAssistantItemId`, `contentIndex: 0` (Spec 05 R5 step 2). `audioEndMs: 0` is legal.
  - A13 (bargeIn half): `transcoder.resetOutbound` called exactly once per EFFECTIVE barge-in (i.e., not on the A9 no-op path).
  - Post-bargeIn state: `markQueue` empty, `firstMarkNameOfResponse`/`responseStartTimestamp`/`lastAssistantItemId`/`currentResponseId` all `null`, `currentTurn.bargedIn` set when a turn is open without `tResponseDone`.
  - Drain disarm: `onMarkEcho` removing the LAST queued name sets `responseStartTimestamp = null` (Spec 05 R4 rule 3).
- [ ] Run the suite; expect FAIL (module does not exist yet).
- [ ] Implement `src/bargein.ts` per Spec 05 R5 (the code block there is normative — clear-first ordering, truncate guard, NO `response-cancel`, flush+disarm block) and R6 rules 1–3. Mark names are `` `r${responseId}:${s.markSeq++}` `` (Spec 03 R5 naming rule / findings/10 T3). `onMarkEcho` must: splice by `indexOf` (never `shift()`), silently ignore unknown names, invoke `s.onFirstMarkEcho?.(name)` when `name === s.firstMarkNameOfResponse`, invoke `s.onPlaybackDrained?.()` and set `responseStartTimestamp = null` on drain to 0.
- [ ] Reconcile with Spec 03's route so exactly ONE remove-by-name implementation exists process-wide (Spec 05 R6 note; master plan single-seam rule): preferred — refactor the `mark` case in `src/twilio-media.ts` to delegate wholly to `onMarkEcho(session, msg.mark.name)`. If the as-built route structure makes that refactor unsafe, keep the route's splice and make it call the helper — but do NOT leave two independent splice bodies. Spec 03's `src/twilio-media.test.ts` suite (plus any T03 sibling suites) must stay green either way.
- [ ] Run targeted suite; expect PASS. Then run `npm test`; expect ALL suites green (especially Spec 03's).
- [ ] Static A14 check: run `git grep -n "response-cancel" -- src` — expected outcome: no output (no matches). If any hit appears in `src/`, remove it (comments referencing the decision are allowed only in `docs/`).
- [ ] Run `npm run typecheck` and `npm run build`; expect both to exit 0.
- [ ] Commit everything with message:
  `feat(bargein): corrected barge-in sequence and unified mark registry (C2/C3/C4)` and trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Acceptance

Discharges Spec 05 **A8, A9, A10, A11** (unit), the bargeIn call-site half of **A13**, and the static-grep half of **A14**. (A7's full-sequence regression lands in T05.2; the runtime halves of A1/A2/A14 are verified live at M2 via T10.)

## Completion Report

```
Task: T05.1 — Barge-in module & mark registry
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <command → outcome, one line each>
Spec A-numbers verified: <A8/A9/A10/A11/A13(partial)/A14(static) with test names>
Deviations from plan: <none | list>
New interfaces exposed: bargeIn/pushMark/onMarkEcho signatures as implemented
Notes for ledger: <mark-case reconcile choice made in twilio-media.ts; runner style used>
```

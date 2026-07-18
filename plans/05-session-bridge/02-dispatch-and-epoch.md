# T05.2 — Gateway event dispatch loop, response-epoch management & media flow (`src/session.ts`)

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Implement `dispatch(session, ev)` over the complete 23-member normalized server-event union, the four-point `responseStartTimestamp` epoch management (the C2 fix), full-duplex media forwarding, and the `custom`/`error` policies.

**Wave:** D · **Depends on:** T05.1, T03, T04, T06, T08 · **Blocks:** T05.3, T05.4, T10

**References:**
- `docs/specs/05-session-bridge-and-barge-in.md` — R1 (state shape), R2 (dispatch table — normative event names), R3 (media flow both directions), R4 (four epoch reset points), R7 (`custom` matcher), R9 (benign-error whitelist), A2/A3/A7/A13/A14
- `docs/specs/04-gateway-realtime-leg.md` — R5 (`GatewayLeg` interface — `send`, `appendAudio`, `isOpen`), R9 (module-level dispatch table, normative for this task), R10 (`isBenignGatewayError` export)
- `docs/specs/03-twilio-media-ws-leg.md` — R4 (`media` case sets `latestMediaTimestamp`; `onTwilioMedia` hook), R5 (`sendMedia`/`sendMark` helpers), R6 (backpressure guard location)
- `docs/specs/06-audio-dsp-transcoding.md` — R2 (`audioFormatsFor`), R3 (`Transcoder`), R11 (resetOutbound call sites; inbound upsampler NEVER reset)
- `docs/specs/08-logging-and-latency-instrumentation.md` — R6 (TurnRecorder hook names — call sites stubbed here, wired in T05.3), R11 (event vocabulary: `first-audio-delta`, `first-twilio-send`, `custom`, `error`)
- `docs/findings/02-ai-sdk-realtime-event-protocol.md` — §Server events (23-member union), corrections 2, gotchas 6–8
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — D4, G1, G8, G10, V9
- `docs/findings/10-gap-analysis-and-contradictions.md` — C2, C8, C9
- `docs/findings/08-fastify-ws-server-architecture.md` — §backpressure

## Interfaces

**Consumes:**
- `bargeIn`, `pushMark` from `src/bargein.ts` (T05.1).
- `Session` from `src/sessions.ts` (Spec 03 R9; `session.teardown(reason)` is the FR-7 escape used by the non-benign error path).
- `ServerEvent` type and `isBenignGatewayError` from `src/gateway.ts` (Spec 04 R5/R10). If the as-built `gateway.ts` does not export `isBenignGatewayError`, implement the predicate locally per Spec 05 R9 (same regexes) — never two divergent copies; prefer importing.
- `sendMedia` (with its Spec 03 R6 backpressure guard) from `src/twilio-media.ts`.
- `Transcoder` from `src/dsp.ts` (Spec 06 R3).
- Logger `logEvent`/`log` (Spec 01 R12 / Spec 08 R1).

**Produces:**
- `src/session.ts` exporting:
  - `export function dispatch(s: Session, ev: ServerEvent): void` — single `switch (ev.type)` per Spec 05 R2 behavior table.
  - `export function handleTwilioMedia(s: Session, payloadB64: string): void` — Spec 05 R3 inbound steps 2–4 (`latestMediaTimestamp` is already set by Spec 03's route `media` case; do not set it twice).
- Recorder call sites inside `dispatch` written as optional chaining on `s.recorder?.<hook>` using the Spec 08 R6 names (`onSpeechStopped`, `onResponseCreated`, `onAudioDelta`, `onSpeechStarted`, `onResponseDone`) — instantiated/wired in T05.3.
- `src/session-dispatch.test.ts` — includes the **A7 stale-epoch normative regression**. (Interim `src/` location per the `npm test` glob `src/**/*.test.ts`; T10.1 migrates it under `test/`.)
- Additive edits to `src/sessions.ts` `Session` if fields are missing: `transcoder`, `gateway`, `turnPhase`, `currentTurn`, `turns`, `tStreamStartPerf`, `recorder?`, `toolLoop?` (Spec 05 R1; keep names exact, do not declare a competing interface).

## Steps

- [ ] Read the References, then the as-built `src/gateway.ts` (event union import path, `isBenignGatewayError`), `src/twilio-media.ts` (`sendMedia` guard), `src/bargein.ts`, `src/sessions.ts`.
- [ ] Write `src/session-dispatch.test.ts` (same runner style as T05.1) with a fake Session (captured `gateway.send`/`appendAudio`, fake `twilioWs`, spy transcoder, log spy) driving `dispatch` with hand-built normalized events. Required cases:
  - **A7 stale-epoch regression (normative):** sequence `response-created(r1)` → `audio-delta(r1)` ×2 → echo ALL marks (queue drains → epoch disarmed) → `response-created(r2)` → advance `latestMediaTimestamp` → `audio-delta(r2)` → `speech-started` ⇒ truncate sent with `audioEndMs` computed from r2's first-delta epoch, never r1's.
  - Epoch reset point 1: `response-created` sets `responseStartTimestamp = null`, `currentResponseId = ev.responseId`, `responseActive = true`, `firstMarkNameOfResponse = null`, and calls `transcoder.resetOutbound()` exactly once (Spec 05 R4.1).
  - Epoch re-arm point 2 incl. S16 lazy attach: an `audio-delta` with a responseId ≠ `currentResponseId` (no prior `response-created`) re-arms the epoch from `latestMediaTimestamp` and updates `currentResponseId`/`lastAssistantItemId` (Spec 05 R4.2 code block).
  - Epoch reset point 3: mark-queue drain disarms (already covered in T05.1 via `onMarkEcho`; assert here end-to-end through a delta→mark→echo cycle).
  - **A13:** `resetOutbound` called at exactly the two call sites (every `response-created` + every effective `bargeIn`); NO inbound reset ever (assert the transcoder spy has no other reset-like calls across a full simulated exchange).
  - Outbound flow: each `audio-delta` forwards immediately via one `sendMedia` with `transcoder.gatewayToTwilio(ev.delta)` then one `pushMark`; first delta of a response logs `first-audio-delta`/`first-twilio-send`; **subsequent deltas log nothing** (A3 partial — assert via log spy).
  - Backpressure: fake `twilioWs.bufferedAmount = 1_000_001` → warn + `twilioWs.close(1011, ...)` and no send (Spec 05 R3.3 — satisfied via Spec 03's guarded `sendMedia`; assert the observable close).
  - Inbound flow: `handleTwilioMedia` calls `gateway.appendAudio(transcoder.twilioToGateway(payload))` only when `gateway.isOpen`; one append per call, no batching, no logging.
  - Consciously-ignored events (`audio-done`, `content-part-added`, `content-part-done`, `output-item-done`, `conversation-item-added`, `text-delta`, `text-done`, `function-call-arguments-delta`, `audio-committed`): no throw, no log line (log spy stays clean) — Spec 05 R2 / findings/10 C9.
  - `output-item-added` sets `lastAssistantItemId`.
  - `custom` matcher (Spec 05 R7): `rawType 'input_audio_buffer.speech_started'` triggers `bargeIn`; `'conversation.item.truncated'` logs the truncate-ack line; `'rate_limits.updated'` produces no info-level line; any other rawType logs one `custom` line with `safeRaw`.
  - `error` policy (Spec 05 R9): benign (message matching `/truncat/`, `/cancel/`, `/already has an active response/`) → one `warn` with `.raw`, session continues (no teardown); non-benign → `error` log with `.raw` + `s.teardown('gateway-error')` invoked (A14 runtime half).
  - `speech-started` runs `bargeIn` and sets `turnPhase = 'user-speaking'`.
- [ ] Run the suite; expect FAIL.
- [ ] Implement `src/session.ts` per Spec 05 R2 (behavior table row by row — exact normalized names), R3, R4 (all four points; point 4 lives in `bargeIn` from T05.1), R7 (including `safeRaw` = try/catch `JSON.stringify` with `String(err)` fallback), R9. `dispatch` is the body of Spec 04's `callbacks.onEvent` — no second parse/listener layer, no `ws` usage here.
- [ ] Run targeted suite; expect PASS. Run `npm test`; expect all suites green.
- [ ] Run `npm run typecheck && npm run build`; expect exit 0.
- [ ] Re-run `git grep -n "response-cancel" -- src`; expected: no output.
- [ ] Commit with message:
  `feat(session): 23-event dispatch loop, four-point epoch management, duplex media flow` and trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Acceptance

Discharges Spec 05 **A7** (unit, the C2 regression backing live A2), **A13** (both call sites asserted), the runtime half of **A14**, and the no-per-delta-logging portion of **A3**. (Live A2 verified at M2 via T10.)

## Completion Report

```
Task: T05.2 — Dispatch loop, epoch management & media flow
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <command → outcome, one line each>
Spec A-numbers verified: <A7/A13/A14(runtime)/A3(partial) with test names>
Deviations from plan: <none | list>
New interfaces exposed: dispatch(s, ev), handleTwilioMedia(s, payloadB64); Session fields added
Notes for ledger: <isBenignGatewayError imported from gateway.ts? recorder hook names stubbed>
```

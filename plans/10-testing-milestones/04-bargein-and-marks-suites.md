# T10.4 — Barge-in state-machine & mark-registry suites

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Deliver `test/bargein.test.ts` (Spec 10 R5, incl. the normative stale-epoch regression) and `test/marks.test.ts` (R6 post-clear echo tolerance) against the real Session/barge-in modules with injected fakes.

**Wave:** E · **Depends on:** T10.1, T03, T05 · **Blocks:** T10.8

**References:**
- `docs/specs/10-testing-spikes-and-milestones.md` — R5 (items 1–7, incl. the seam-injection authorization in the preamble), R6 (items 1–5), A3, A4
- `docs/specs/05-session-bridge-and-barge-in.md` — R1 (Session state shape: `latestMediaTimestamp`, `responseStartTimestamp`, `markQueue`, `firstMarkNameOfResponse`), the barge-in requirement (`bargeIn(session)`, `pushMark`, `onMarkEcho` in `src/bargein.ts`), the four-point epoch reset, C3 decision (response-cancel omitted), teardown matrix
- `docs/specs/03-twilio-media-ws-leg.md` — mark naming + remove-by-name semantics (C4), outbound `sendMedia`/`sendMark`/`sendClear` shapes
- `docs/findings/02-ai-sdk-realtime-event-protocol.md` — §Server → client events (exact normalized event shapes to feed), gotcha 4 (`contentIndex` required on truncate)
- `docs/findings/03-twilio-media-streams.md` — claim 4 (Twilio message shapes; numeric fields are strings), claim 16.3
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — G1 (stale epoch), G2 (post-clear storm), G4/G5 (guard no-ops), V5/G3 (no response-cancel)
- `docs/findings/06-audio-dsp-transcoding.md` — gotcha 3 (inbound upsampler never reset mid-call)
- `docs/findings/10-gap-analysis-and-contradictions.md` — C2, C3, C4, C9, T3 (mark namespace `r<responseId>:<seq>`), T4 (resetOutbound call sites)

## Interfaces

**Consumes:**
- `src/session.ts` — Session factory + `dispatch(session, ev)` (Spec 05 R2); constructor/factory must accept injected `sendToTwilio(msg)` / `sendToGateway(event)` / `now()`. **If T05 did not expose this seam, Spec 10 R5's preamble authorizes the minimal constructor-injection refactor** — change only how the send functions/clock are provided; zero behavioral change; `npm test` must stay green after.
- `src/bargein.ts` — `bargeIn(session)`, `pushMark`, `onMarkEcho` (Spec 05 deliverable names; confirm in source).
- `src/latency.ts` — `TurnRecord` (for R6.5 `tFirstMarkEcho` stamp assertion).
- `src/dsp.ts` — `createTranscoder('transcode')` for the R5.6 reset-seam spy.

**Produces:**
- `test/bargein.test.ts` — R5.1–R5.7 (absorbs/extends any T05-era bargein test file; one file, under `test/`).
- `test/marks.test.ts` — R6.1–R6.5.
- A shared driver helper inside those files (or `test/helpers/session-driver.ts` if both need it) that builds a Session with captured sends — export name `makeDrivenSession()` if extracted.

## Steps

- [ ] Read the References; open `src/session.ts` + `src/bargein.ts` and confirm the injection seam exists. If not, apply the minimal refactor (see Consumes) and run `npm test` — expect PASS before proceeding.
- [ ] Write R5.1 stale-epoch regression exactly as scripted in Spec 10 R5.1 (streamSid `MZtest1`, media→1000, r1 3 deltas + mark echoes + media→6000 + queue drain disarms epoch, r2 deltas re-arm at 8000, media→8500, `speech-started`). Assert: `clear` sent to Twilio FIRST; then gateway gets `{type:'conversation-item-truncate', itemId:'item_b', contentIndex:0, audioEndMs:500}` — `audioEndMs === 500`, never 7500; `contentIndex` present and `0`.
- [ ] Run `npx vitest run test/bargein.test.ts` — expect PASS. If `audioEndMs` computes 7500, this is the C2 bug live in `src/session.ts` — fix per Spec 05's four-point reset list (that fix is in-scope: the test is normative), then re-run, expect PASS.
- [ ] Add R5.2: assert NO `response-cancel` is ever sent on barge-in (Spec 05 adopted C3 — implement only this branch; delete any whitelist-branch scaffolding).
- [ ] Add R5.3 guard no-ops (empty queue / disarmed epoch → no clear, no truncate; repeated `speech-started` in one response → no-ops until next response's first delta re-arms).
- [ ] Add R5.4 array-frame contract: deliver the two-event JSON array from Spec 10 R5.4 through the same entry point the gateway leg uses for array frames (if array-splitting lives in `src/gateway.ts` per Spec 05 R2, drive `dispatch` twice and instead assert ordering — note which locus was tested in the report).
- [ ] Add R5.5 benign-error whitelist: `code:'response_cancel_not_active'` → logged, session alive; unknown error code → FR-7 teardown path invoked (spy on teardown).
- [ ] Add R5.6 DSP reset seam: with `AUDIO_MODE=transcode`, spy on the transcoder's `resetOutbound()` — invoked at `response-created` and at barge-in; assert the inbound path is never reset mid-call (spy on the upsampler reset if exposed; otherwise assert `resetOutbound` is the only reset entry invoked).
- [ ] Add R5.7 silent-ignore set: `conversation-item-added`, `output-item-done`, `content-part-added/done`, `audio-done`, `text-delta/done`, `function-call-arguments-delta` → no warn, no throw (spy on logger).
- [ ] Run `npx vitest run test/bargein.test.ts` — expect PASS (all R5 items).
- [ ] Write `test/marks.test.ts` per R6: unique names `r<responseId>:<seq>`; echo `m1`, barge-in flushes locally; late echoes of `m2`/`m3` ignored by-name (no crash, no undercount, no epoch re-arm); next response's queue is exactly `[n1]`, its echo drains → epoch disarms; never-sent-name echo ignored; first-mark-per-response stamps `tFirstMarkEcho` on the turn record.
- [ ] Run `npx vitest run test/marks.test.ts` — expect PASS. Then `npm test` — expect PASS repo-wide.
- [ ] Commit: `test(bargein): stale-epoch regression, guard no-ops, and post-clear mark tolerance suites` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 10 **A3** (stale-epoch regression exactly per R5.1, `audioEndMs === 500`) and **A4** (post-clear mark echoes ignored by name-based removal, next-response accounting uncorrupted).

## Completion Report

```
Task: T10.4 — Status: DONE | BLOCKED(<why>)
Files changed: <list>
Seam refactor needed in src/session.ts: <no | yes, what>
Stale-epoch result on first run: <passed | exposed C2 bug, fixed>
Commands run: vitest per-file → <results>; npm test → <n passed>
Spec A-numbers verified: A3, A4
Deviations from plan: <none | list>
New interfaces exposed: <makeDrivenSession() if extracted>
Notes for ledger: <1-2 lines>
```

# T04.5 — 23-event dispatch table, error/custom policy, final sweep

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Replace the pass-through `handleEvent` with the exhaustive 23-member dispatch table (module-level logging per event class), the never-terminal in-band `error` policy with `isBenignGatewayError`, and the rate-limited `custom` handling incl. the S4 synthetic `speech-started` fallback; then run the whole-spec acceptance sweep.

**Wave:** B · **Depends on:** T04.4 · **Blocks:** T05, T10.5, T10.7 (T07's tool loop and T08's anchors consume the forwarding contract at runtime only — per the ledger, no T07/T08 row has a build-order dependency on T04)

**References:**
- `docs/specs/04-gateway-realtime-leg.md` — §R9 (the normative 23-row table — implement the "Disposition/Detail" logging exactly), §R10 (error/custom policy, `BENIGN_ERROR_CODES` starts EMPTY, heuristic snippet), §R13 (complete log-event inventory), §A7, §A8, §A9, §A13
- `docs/findings/02-ai-sdk-realtime-event-protocol.md` — §Server → client events (the exact 23-member union and per-event fields), gotcha 6 (`response-done.status` plain string)
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — V4/G3/G6 (documented-benign error classes behind the heuristic), G8 (`rate_limits.updated` flood → rate limit), V9/G10 (GA wire names for the S4 matcher)
- `docs/specs/05-session-bridge-and-barge-in.md` — the line stating `dispatch(session, ev)` is the body of `callbacks.onEvent` (this task must forward EVERY event; Spec 05 implements the "acts")
- Neighboring plan interfaces: `plans/04-gateway-leg/03-ws-client-leg.md` §Interfaces (`startMockGateway`, `handleEvent` seam)

## Interfaces

**Consumes:** `handleEvent` seam + `startMockGateway` (T04.3); `pendingGreeting` (T04.4); `logEvent` (Spec 01 R12).

**Produces** (appended to `src/gateway.ts`):
- `export function isBenignGatewayError(ev: Extract<ServerEvent, {type:'error'}>): boolean` — verbatim Spec 04 R10 heuristic; `const BENIGN_ERROR_CODES = new Set<string>([])` starts empty on purpose (S11) — do not guess strings
- Guaranteed forwarding contract for Spec 05/07/08: every one of the 23 event types reaches `callbacks.onEvent(ev)` after module-level logging; `custom` with `rawType:'input_audio_buffer.speech_started'` ADDITIONALLY delivers a synthetic `{type:'speech-started', raw: ev.raw}` to `onEvent` (identical path to the normalized event — Spec 04 R10/A8)
- R13 log-event vocabulary: `gateway-session-created`, `session-updated`, `gateway-error-event`, `gateway-custom`, `gateway-unknown-event` (defensive), plus the T04.2/T04.3/T04.4 lines — all with `callSid`, flat fields, never per-frame

## Steps

- [ ] Read the References, especially the Spec 04 R9 table row by row and all of R10.
- [ ] Write failing tests in `src/gateway.dispatch.test.ts` (`node:test`; reuse `startMockGateway` + fixture config; drive events by having the mock send normalized-shape JSON frames; capture log output as in T04.2). Cases:
  - **A7 (silent set):** mock sends one of each `conversation-item-added`, `output-item-done`, `content-part-added`, `content-part-done`, `audio-done`, `text-delta`, `text-done`, `function-call-arguments-delta` (minimal `raw:{}` payloads per findings/02 union) → zero `warn`/`error`-level log lines; each still reaches `onEvent` (count 8, in order)
  - **A7 (act/log set):** `session-created` → `gateway-session-created` line with `.raw` verbatim; `session-updated` → `session-updated` line with `.raw` verbatim; `speech-started`, `speech-stopped`, `response-created`, `response-done`, `output-item-added`, `audio-delta`, `input-transcription-completed`, `audio-transcript-delta`, `audio-transcript-done`, `function-call-arguments-done`, `audio-committed` all reach `onEvent` unchanged
  - **A9:** mock sends `{"type":"error","message":"boom-unknown","code":"weird_code","raw":{}}` then an `audio-delta` → the delta still arrives at `onEvent`, socket not closed, `onClose` not invoked; the error logged at `error` level with `.raw`; a benign-matching error (`message` containing `no active response`) logs at `info`; unit-test `isBenignGatewayError` directly on the four heuristic substring classes + a `BENIGN_ERROR_CODES` member
  - **A8:** mock sends `{"type":"custom","rawType":"input_audio_buffer.speech_started","raw":{}}` → `onEvent` receives a `speech-started`-typed event (assert same observable shape as the normalized case) plus the rate-limited `gateway-custom` line; 100 `custom` events with `rawType:'rate_limits.updated'` inside 1 s → ≤2 `gateway-custom` log lines but all 100 reach `onEvent`; `rawType:'conversation.item.truncated'` → info-level line (S9 evidence)
  - unknown wire type: mock sends `{"type":"totally-new","raw":{}}` → one `gateway-unknown-event` line, no crash
- [ ] Run `npx tsx --test src/gateway.dispatch.test.ts` — expect FAIL.
- [ ] Implement per Spec 04 R9/R10: exhaustive `switch (ev.type)` listing all 23 members (Spec 05 acts are NOT implemented here — this module only logs and forwards); compile-time exhaustiveness via a `default` that first narrows `const _never: never = ev;` behind a runtime `gateway-unknown-event` log (cast the wire value where it enters); fold T04.4's `pendingGreeting` firing into the `session-updated` case; per-leg rate limiter `Map<rawType, lastLoggedMs>` (max 1 line per `rawType` per second per call, findings/04 G8); benign→info / unknown→error split per R10; NOTHING in the error path touches the socket.
- [ ] Run `npx tsx --test src/gateway.dispatch.test.ts` — expect PASS.
- [ ] Whole-spec sweep (Spec 04 acceptance + master-plan T04 verify line):
  - `npm test` → all suites pass; `npm run typecheck` → exit 0; `npm run build` → exit 0, and confirm no `dist/gateway.*.test.js` emitted
  - `npm ls @ai-sdk/gateway ws` → exactly `4.0.23` and `8.21.1` (**A13**)
  - `node -e "const d=require('./package.json');const all={...d.dependencies,...d.devDependencies};const bad=['openai','ai','@ai-sdk/react'].filter(k=>k in all);if(bad.length){console.error(bad);process.exit(1)}console.log('OK: banned deps absent')"` → OK (**A13**)
  - re-run the T04.2 `rt.getToken` grep gate → OK (**A1** regression)
  - confirm `src/gateway.ts` imports nothing from `session.ts`/`twiml.ts`/`dsp.ts`/`tools.ts` (Spec 04 §Deliverables isolation rule): `node -e "const s=require('fs').readFileSync('src/gateway.ts','utf8');const bad=['./session','./twiml','./dsp','./tools'].filter(m=>s.includes(m));if(bad.length){console.error(bad);process.exit(1)}console.log('OK: gateway.ts isolated')"` → OK
- [ ] Commit: `feat(gateway): exhaustive 23-event dispatch, never-terminal error policy, custom-event rate limit` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Discharges Spec 04 **A7**, **A8**, **A9**, **A13**, and closes the whole-spec sweep (A1–A13 all verified across T04.1–T04.5). Implements spike seams S4 (fallback matcher), S5/S31 (verbatim `.raw` logs), S9 (truncate-ack line), S11/S12 (empty whitelist + defensive status logging), S13 (array frames, from T04.3).

## Completion Report

```
Task: T04.5 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome]
Spec 04 A-numbers verified: A7, A8, A9, A13 (+ sweep re-check of A1–A12)
Deviations from plan: [none | list]
New interfaces exposed: isBenignGatewayError; full onEvent forwarding contract (23 events + synthetic speech-started)
Notes for ledger: T04/Spec 04 COMPLETE — GatewayLeg ready for T05 wiring; mint ready for the Wave B/C /twiml delegation
```

# T03.4 — Inbound state machine: media, mark-echo semantics, stop, dtmf, teardown paths

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Complete `src/twilio-media.ts`'s message dispatch — `media` (string→number timestamp + `onTwilioMedia` hook), `mark` (remove-by-name, drain + first-echo hooks), `stop` (teardown), `dtmf` (log-only) — and prove the route-level teardown matrix.

**Wave:** C · **Depends on:** T03.3 · **Blocks:** T03.5, T05

**References:**
- `docs/specs/03-twilio-media-ws-leg.md` — R3 (string numerics, schemas), R4 (`media`/`mark`/`stop`/`dtmf` cases, verbatim mark snippet + normative mark-echo-on-clear semantics), R7 (close-code interpretation, error-vs-close behavior), R10 (which events are NEVER logged)
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — V7, G2, D4 (mark queue discipline, playback clock)
- `docs/findings/10-gap-analysis-and-contradictions.md` — C4 (never bare `shift()`), S17/S22 (cadence spikes this task instruments)
- `docs/findings/09-latency-instrumentation.md` — §rules (no per-frame logging; Railway 500 lines/s)
- `docs/findings/03-twilio-media-streams.md` — claim 4 (only inbound track), claim 8 (cadence not contractual), gotchas 3, 7
- Plan interfaces: `plans/03-twilio-leg/01-sessions-registry.md`, `plans/03-twilio-leg/03-outbound-helpers-backpressure.md` (first-mark tracker)
- Existing code: `src/twilio-media.ts`, `src/sessions.ts`

## Interfaces

**Consumes:** T03.1's `Session` hooks (`onTwilioMedia`, `onPlaybackDrained`, `onFirstMarkEcho`, `onTeardown`) and `teardownSession`; T03.3's internal `isFirstMarkOfResponse`.

**Produces** (behavior, no new exports — this is the contract T05 and T08 attach to):
- `media` case: `session.latestMediaTimestamp = Number(msg.media.timestamp)`; then `session.onTwilioMedia?.(msg.media.payload)`. Zero logging per frame; ONE `media-cadence` info line per call on the first media frame (fields: first `timestamp`, payload byte length — spike S22 evidence, Spec 03 R3 last paragraph).
- `mark` case: exactly the Spec 03 R4 snippet — `indexOf`/`splice` remove-by-name (bare `shift()` forbidden, findings/10 C4); unknown/late names silently ignored; on queue reaching length 0 fire `session.onPlaybackDrained?.()`; if `isFirstMarkOfResponse(session, name)` fire `session.onFirstMarkEcho?.(name)`; non-first echoes never logged (post-`clear` echo storms mean "flushed", not "played").
- `stop` case: set the handler-closure `sawStop` flag (T03.2 wired it into the `stream-stop` summary's `abnormal` computation), log nothing extra here (the summary line is emitted by the `'close'` listener), call `teardownSession(session, 'caller-hangup')`.
- `dtmf` case: one `logEvent` line `{ event: 'dtmf', digit }` via `session.log`; no other action.
- Teardown matrix at route level: `stop`-then-`close` and `close`-alone both run `teardownSession` exactly once; socket `'error'` alone logs but never tears down and never throws.

## Steps

- [ ] Read all References; re-read the T03.2 handler to locate the dispatch stubs and the `sawStop` closure flag.
- [ ] Write failing tests (extend `src/twilio-media.test.ts` or add `src/twilio-media.inbound.test.ts`) driving a real injected WS (`fastify.injectWS`, stub registry from T03.2's helper) through `connected`→`start`(valid token) first, then: (A4) send `media` with `timestamp: "12345"` → `session.latestMediaTimestamp === 12345` and `typeof === 'number'`; an installed `onTwilioMedia` spy receives the exact base64 payload; a compile-level assertion that the vendored types declare `timestamp`/`sequenceNumber`/`chunk` as `string` (e.g. `@ts-expect-error` on assigning a number in a type-only test block); (A5) with `session.markQueue` seeded `['rA:1','rA:2']` (seed via `nextMarkName`+`sendMark` against the live session so the first-mark tracker is real): echo `rA:1` → queue `['rA:2']`, `onPlaybackDrained` NOT yet fired, `onFirstMarkEcho` fired once with `'rA:1'`; echo unknown `zz` → queue unchanged, no throw; echo `rA:2` → queue `[]`, `onPlaybackDrained` fired exactly once; (A9) after `stop` message then client close: `onTeardown` spy called exactly once, `sessions.size === 0`, exactly one `stream-stop` log line whose `reason` is a string (not a Buffer) and `abnormal` is falsy; separately, close without `stop` and code 1006 (if injectWS can't produce 1006, abrupt-destroy the client and assert `abnormal: true` on whatever code surfaces — record actual behavior for the ledger); emitting `'error'` on the server-side socket logs `ws-error`-class output but leaves the session alive until `'close'`; (dtmf) one log line with `digit`, no teardown; (no-per-frame-log) sending 50 media frames produces zero additional stdout lines after the one `media-cadence` line.
- [ ] Run `npm test` — expect FAIL.
- [ ] Implement the four dispatch cases in `src/twilio-media.ts` per Spec 03 R4 (use the verbatim mark snippet; adapt `session.log` calls to the R9 function signature). Every case body stays inside the T03.2 try/catch.
- [ ] Run `npm test` — expect PASS. Run `npm run typecheck` — expect exit 0.
- [ ] Self-check: confirm `markQueue.shift(` appears nowhere in `src/` (Spec 03 A5 grep clause).
- [ ] Commit: `feat(twilio-media): inbound media/mark/stop/dtmf dispatch with C4 mark semantics` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 03 **A4**, **A5**, **A9** (route-level; unit half done in T03.1). Instruments S22 (`media-cadence` line) and preserves S17 revisit room (mark granularity stays mark-per-send; queue is granularity-agnostic).

## Completion Report

```
Task: T03.4 — inbound state machine
Status: <done | blocked (why)>
Files changed: <list>
Commands run: npm test → <counts>; npm run typecheck → <exit>; shift() grep → <result>
Spec A-numbers verified: A4, A5, A9
Deviations from plan: <none | list — incl. observed injectWS close-code behavior for the abnormal-flag test>
New interfaces exposed: none (behavior only)
Notes for ledger: <e.g. exact stream-stop field set; how abnormal test was realized>
```

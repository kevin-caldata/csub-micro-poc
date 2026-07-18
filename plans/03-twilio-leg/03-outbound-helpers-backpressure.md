# T03.3 — Outbound send helpers, mark naming, backpressure guard & hangup

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Add `sendMedia`/`sendMark`/`sendClear`/`hangup` and the `r<responseId>:<seq>` mark-name minting to `src/twilio-media.ts`, with the 1 MB backpressure guard and zero pacing/re-framing, all byte-exact per Spec 03 R5/R6.

**Wave:** C · **Depends on:** T03.2 · **Blocks:** T03.4, T03.5, T05

**References:**
- `docs/specs/03-twilio-media-ws-leg.md` — R5 (outbound contracts + mark naming rule, normative for findings/10 T3), R6 (backpressure guard, verbatim threshold and close code), R7 (`hangup` codes: 1000 deliberate, 1001 shutdown, 1008 auth, 1011 backpressure), R9 (`markQueue`, `markSeq` fields; `log` is the FUNCTION-style signature — the pino-style `session.log.warn(...)` in the R6 snippet is illustrative only, adapt to `session.log('warn', …)`)
- `docs/findings/03-twilio-media-streams.md` — claims 5/7 (any-size payloads, no track field, Twilio is the pacer), gotcha 5 (no WAV/file headers)
- `docs/findings/08-fastify-ws-server-architecture.md` — §Backpressure + V13 (`bufferedAmount` semantics), Impl "WS /twilio-media" (readyState guard)
- `docs/findings/06-audio-dsp-transcoding.md` — C11 (forward-immediately; no re-framing)
- Plan interfaces: `plans/03-twilio-leg/01-sessions-registry.md`, `plans/03-twilio-leg/02-ws-route-auth-gate.md`
- Existing code: `src/twilio-media.ts`, `src/sessions.ts`

## Interfaces

**Consumes:** T03.1's `Session` (`twilioWs`, `streamSid`, `markQueue`, `markSeq`, `log`); T03.2's `src/twilio-media.ts` module.

**Produces** (added exports in `src/twilio-media.ts` — these exact names are what Spec 05 (T05) calls on its outbound audio path and barge-in):
- `export function sendMedia(session: Session, payloadB64: string): void` — backpressure check FIRST (Spec 03 R6 verbatim: `bufferedAmount > 1_000_000` → log warn via `session.log('warn', …, { buffered })`, `socket.close(1011, 'backpressure')`, return without sending), then one `socket.send` of exactly `{"event":"media","streamSid":…,"media":{"payload":…}}`.
- `export function sendMark(session: Session, name: string): void` — sends `{"event":"mark","streamSid":…,"mark":{"name":…}}` and pushes `name` onto `session.markQueue`.
- `export function sendClear(session: Session): void` — sends `{"event":"clear","streamSid":…}`.
- `export function hangup(session: Session, code = 1000, reason = 'bye'): void` — `socket.close(code, reason)` (Spec 03 R7 clean-hangup mechanism).
- `export function nextMarkName(session: Session, responseId: string): string` — mints `r<responseId>:<seq>` using per-session monotonically increasing `markSeq`; on the FIRST mint for a given `responseId`, records that name as the response's first mark (per-session tracking, e.g. a `Map<responseId, name>` stored on the session as an internal field — Spec 03 R5 "isFirstMarkOfResponse is implemented by tracking the first mark name issued per responseId"; no module-level state, R9 isolation rule). Internal (non-exported OK): `isFirstMarkOfResponse(session, name): boolean` consumed by T03.4's mark-echo handler.
- All senders guarded by `socket.readyState === OPEN`; when not OPEN they no-op without throwing (Spec 03 R5 preamble). No `track` field outbound. No timers, no chunking, no batching anywhere on this path (Spec 03 A7 grep target).

## Steps

- [ ] Read all References; note the exact JSON key order/shape in Spec 03 R5 and A6.
- [ ] Extend `src/twilio-media.test.ts` (or add `src/twilio-media.outbound.test.ts` if the file is getting long) with failing tests against a fake socket object (`{ readyState, bufferedAmount, sent: string[], send(s){…}, close: spy }` — no network needed for A6–A8): (A6) each helper's serialized frame is byte-exact per Spec 03 A6 (compare full JSON strings); `sendMark` pushes onto `markQueue`; every helper no-ops without throwing when `readyState !== OPEN`; no `track` key appears in any outbound frame; (A7) a 100 KB `payloadB64` goes out as exactly ONE send call; (A8) with `bufferedAmount` stubbed to `1_000_001`, `sendMedia` calls `close(1011, 'backpressure')` and `sent` stays empty; at exactly `1_000_000` it still sends (threshold is `>`); (naming) `nextMarkName` produces `rA:1`, `rA:2`, then `rB:3` for responseIds A,A,B (markSeq is per-session monotonic, not per-response), and the first-mark tracker flags `rA:1` and `rB:3` only; two distinct sessions mint independent sequences (isolation).
- [ ] Run `npm test` — expect FAIL (helpers missing).
- [ ] Implement the helpers in `src/twilio-media.ts` per Spec 03 R5/R6/R7. Keep them module-level pure functions over `Session` (no closure over route state) so Spec 05 can import them directly.
- [ ] Run `npm test` — expect PASS. Run `npm run typecheck` — expect exit 0.
- [ ] Static self-check for A7: search `src/twilio-media.ts` for `setTimeout`/`setInterval`/`await` on the send path — none may exist between "delta arrives" and `socket.send` (`findstr /n "setTimeout setInterval" src\twilio-media.ts` on Windows or `grep -n` on Linux; the start-timeout from T03.2 is the only legitimate `setTimeout` in the file).
- [ ] Commit: `feat(twilio-media): outbound media/mark/clear helpers, mark naming, backpressure guard` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 03 **A6**, **A7**, **A8**, and the mark-naming half of the T3 decision (findings/10) that **A5**'s echo handling (T03.4) depends on.

## Completion Report

```
Task: T03.3 — outbound helpers & backpressure
Status: <done | blocked (why)>
Files changed: <list>
Commands run: npm test → <counts>; npm run typecheck → <exit>; grep check → <result>
Spec A-numbers verified: A6, A7, A8
Deviations from plan: <none | list>
New interfaces exposed: sendMedia, sendMark, sendClear, hangup, nextMarkName (+ internal isFirstMarkOfResponse)
Notes for ledger: <e.g. where the first-mark tracker lives on Session; test file layout>
```

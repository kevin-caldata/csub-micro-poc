# T09.3 — `src/fallback.ts`: playFallbackAndClose (G4 spoken fallback)

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Implement the FR-7 spoken-fallback helper that plays the apology clip over an open Twilio WS and then closes it, per Spec 09 R6.4–R6.7, with a full unit-test suite — WITHOUT wiring it into `src/session.ts` (that wiring is an orchestrator merge step).

**Wave:** D · **Depends on:** T01, T03, T08, T09.2 · **Blocks:** Wave D merge (T05 `onGatewayFailure` wiring), T10 (M1 kill test / A4)

**References:**
- `docs/specs/09-deployment-and-operations.md` — R6.4 (contract + 6-step behavior), R6.5 (trigger list — document, do not wire), R6.6 (S23 gate), R6.7 (clear-before-clip), A4
- `docs/specs/03-twilio-media-ws-leg.md` — R5 (`sendMedia`/`sendMark`/`sendClear` signatures + byte-exact frames), R4 (mark-echo semantics: remove-by-name, `onPlaybackDrained`), §Session interface (fields `twilioWs`, `streamSid`, `markQueue`, `log`, extension points)
- `docs/specs/05-session-bridge-and-barge-in.md` — §Out of scope last bullet (`onGatewayFailure` hook is where this plugs in; default is clean hangup)
- `docs/specs/08-logging-and-latency-instrumentation.md` — `log(level, message, fields)` / `logEvent` boundary (for the `fallback-played` line)
- `docs/findings/03-twilio-media-streams.md` — claims 1 (WS close ⇒ call ends via `<Connect>` fall-through), 4 (mark echo = played), 5 (any-size media, raw μ-law)
- `docs/specs/00-master-build-plan.md` — Wave D merge point: "playFallbackAndClose plugs into T05's onGatewayFailure hook (defaults no-op) — one-line wiring applied at merge, gated on spike S23"

## Interfaces

**Consumes:**
- `Session` interface from `src/sessions.ts` (T03): `twilioWs: WebSocket`, `streamSid: string`, `callSid: string`, `markQueue: string[]`, `log(level, message, fields?)`.
- `sendMedia(session, payloadB64)`, `sendMark(session, name)`, `sendClear(session)` from `src/twilio-media.ts` (T03).
- `log`/`logEvent` from `src/logger.ts` (T08 final; T01 R12 boundary).
- `assets/fallback-apology.ulaw` (T09.2).

**Produces:**
- `src/fallback.ts` exporting:
  - `export async function playFallbackAndClose(s: Session, reason?: string): Promise<void>` — Spec 09 R6.4 contract; the optional `reason` param is an additive clarification feeding the `fallback-played` log line's `reason` field.
  - (test seam) `export async function playFallbackAndCloseWith(s: Session, opts: { clipB64?: string; timeoutMs?: number; pollMs?: number; reason?: string }): Promise<void>` — same logic with injectable clip/timing; the public function delegates to it with defaults.
- `src/fallback.test.ts`.

## Steps

- [ ] Write the failing test suite `src/fallback.test.ts` (`node:test` + `node:assert/strict`, `.js` import extensions per Spec 01 R1/R7). Build a minimal fake Session per Spec 03's interface: fake `twilioWs` `{ readyState, send: (captures frames), close: (records code) }` (ws `OPEN === 1`), `streamSid: 'MZtest'`, `callSid: 'CAtest'`, `markQueue: []`, `log` capturing lines. Use the real `sendMedia`/`sendMark`/`sendClear` from `src/twilio-media.ts` inside `fallback.ts` so frame shapes stay byte-exact. Test cases (all against `playFallbackAndCloseWith` with `timeoutMs`≈100, `pollMs`≈10, a tiny `clipB64`):
  1. **Pre-start no-op close (R6.4-1):** `streamSid` unset (empty) OR `readyState !== OPEN` → no `media`/`mark`/`clear` frames sent; `close()` called iff socket was OPEN; resolves without throwing.
  2. **Happy path (R6.4-2..6 + R6.7):** `markQueue` prepopulated with one stale name → frames sent in order `clear`, `media` (payload === clip base64), `mark` (name `fallback-apology`, pushed onto `markQueue` by `sendMark`); simulate the echo by removing `fallback-apology` from `markQueue` after ~2 polls → promise resolves, `close()` called AFTER resolution of the wait, one log line with `event: 'fallback-played'` and the given `reason`.
  3. **No clear when nothing buffered (R6.7):** `markQueue` empty at entry → no `clear` frame sent.
  4. **Echo never arrives (R6.4-4 timeout):** mark never removed → resolves after ~`timeoutMs`, `close()` still called (no dead air, no hang).
  5. **Robustness:** fake `send` throws on the media frame → function still reaches `close()` and resolves (never throws to the caller — a failing fallback must not crash teardown).
- [ ] Run `npm test` — expect the new suite to FAIL (module missing).
- [ ] Implement `src/fallback.ts` per Spec 09 R6.4 exactly:
  - Module-scope clip cache: `readFileSync('assets/fallback-apology.ulaw')` → base64 string, path resolved from `process.cwd()` (repo root in dev via tsx and on Railway via `node dist/server.js` — Spec 09 R1 startCommand). Compute default `timeoutMs = clipBytes / 8000 * 1000 + 2000` (clip duration + 2000 ms, R6.4-4).
  - Behavior order: guard (R6.4-1) → `sendClear` if `s.markQueue.length > 0` (R6.7) → `sendMedia` with clip base64 (R6.4-2) → `sendMark(s, 'fallback-apology')` (R6.4-3) → await echo-or-timeout (R6.4-4): poll `s.markQueue` every `pollMs` (default 50) for absence of `'fallback-apology'`, raced with the hard timeout; polling observes Spec 03 R4's remove-by-name handler without touching `onPlaybackDrained` (which T05 owns for the stale-epoch reset) → `s.twilioWs.close()` (R6.4-5) → log `{ event: 'fallback-played', reason, callSid, streamSid, waitedMs, echoed }` via the Session `log` (R6.4-6, Spec 08 line contract — flat scalar fields only).
  - Wrap the whole body so no error escapes; on internal error, log at `error` level and still attempt `close()`.
  - Top-of-file doc comment: reproduce the R6.5 trigger list and the R6.6/S23 gate note verbatim-in-substance, and state that wiring into T05's `onGatewayFailure` is applied at the Wave D merge — **do NOT edit `src/session.ts`, `src/sessions.ts`, or `src/server.ts` in this task.**
- [ ] Run `npm test` — expect PASS (new suite green, all existing suites untouched and green).
- [ ] Run `npm run typecheck` — expect exit 0. Run `npm run build` — expect exit 0 (confirms `dist/` build unaffected; test files excluded per Spec 01 tsconfig).
- [ ] Commit with message:
  `feat(fallback): playFallbackAndClose spoken-fallback helper with mark-echo wait (Spec 09 R6.4-R6.7)`
  including trailer line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Spec 09 **A4** — repo-side half: the helper exists, plays clip → mark → echo-or-timeout → close, logs `fallback-played`, never dead-airs or throws. (The live kill test — caller hears the apology — is spike S23/S19 at M1, executed by T10 per T09.5's RUNBOOK; if S23 fails, acceptance degrades to clean-hangup per R6.6 and the wiring merge is dropped, not this module.)
- Discharges the Wave D merge-point precondition named in `00-master-build-plan.md` §Wave D (T09 row).

## Completion Report

```
Task: T09.3 — playFallbackAndClose helper
Status: <done | blocked: reason>
Files changed: <list — must NOT include src/session.ts, src/sessions.ts, src/server.ts>
Commands run: npm test → <fail-then-pass evidence>; npm run typecheck → <exit>; npm run build → <exit>
Spec acceptance verified: 09-A4 (repo half; S23/S19 live check deferred to M1)
Deviations from plan: <none | ...>
New interfaces exposed: playFallbackAndClose(s: Session, reason?: string): Promise<void> in src/fallback.ts (merge into T05 onGatewayFailure pending, gated on S23)
Ledger notes: <1-2 lines>
```

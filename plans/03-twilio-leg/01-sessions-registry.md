# T03.1 — Session interface, single-instance registry & idempotent teardown (`src/sessions.ts`)

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Ship `src/sessions.ts` — the `Session` interface, a `sessions` registry that IS Spec 02's `src/state.ts` Map (one instance process-wide), `createSession()`, and idempotent `teardownSession()` — with unit tests.

**Wave:** C · **Depends on:** T01, T02 · **Blocks:** T03.2, T03.3, T03.4, T03.5, T05

**References:**
- `docs/specs/03-twilio-media-ws-leg.md` — §Deliverables, R7 (teardown semantics), R9 (Session interface + registry, normative), R10 (event names)
- `docs/specs/02-http-server-and-twiml-webhook.md` — R2 (`src/state.ts` `SessionHandle` + `sessions` map, drain contract), R8 (drain loop calls `s.teardown('server shutdown')`, expects Twilio-leg `close(1001, …)`)
- `docs/specs/01-scaffolding-and-toolchain.md` — R7 (test runner: `node:test` via `tsx --test`, files at `src/<name>.test.ts`), R12 (`logEvent` boundary)
- `docs/specs/00-master-build-plan.md` — §6 risk R-2 (single Map instance), §8 R-1 (interim test runner adjudication)
- `docs/findings/08-fastify-ws-server-architecture.md` — §Graceful shutdown notes (why `sessions.delete` on every path is load-bearing)
- Existing code to read first: `src/state.ts`, `src/config.ts`, `src/logger.ts`, `package.json` (test script glob)

## Interfaces

**Consumes** (from T02):
- `src/state.ts`: `export interface SessionHandle { teardown(reason: string): void }` and `export const sessions: Map<string, SessionHandle>` (keyed by streamSid).

**Produces** (`src/sessions.ts`, exact exports later tasks and T05 rely on):
- `export interface Session` — exactly the field list in Spec 03 R9 (Twilio-leg fields, `log` function-style signature, `teardown(reason: string)`, optional hooks `onTwilioMedia`/`onPlaybackDrained`/`onFirstMarkEcho`/`onTeardown`, plus the Spec 04/05/07/08-owned fields declared there). Additionally one internal optional field `startTimer?: ReturnType<typeof setTimeout>` (holds the R4 5 s start-timeout handle so teardown can clear it — documented as internal, not a cross-spec contract).
- `export type LogLevel = 'debug' | 'info' | 'warn' | 'error'` (only if Spec 01's `src/logger.ts` does not already export an equivalent — reuse the existing type if present).
- `export const sessions: Map<string, Session>` — MUST be the same object as `src/state.ts`'s map: implement as `import { sessions as stateSessions } from './state.js';` then re-export with a type assertion (`stateSessions as unknown as Map<string, Session>` — safe because `Session` structurally implements `SessionHandle`). Do NOT `new Map()` here (master plan R-2: two instances break the SIGTERM drain).
- `export function createSession(init: { twilioWs: WebSocket; streamSid: string; callSid: string; log: Session['log'] }): Session` — initializes `latestMediaTimestamp: 0`, `markQueue: []`, `markSeq: 0`, `tornDown: false`, `responseStartTimestamp: null`, `currentResponseId: null`, `lastAssistantItemId: null`, `responseActive: false`, `pendingToolCalls: new Map()`, `timestamps: {}` (per Spec 03 R9 comment). Does NOT insert into `sessions` (the route's `start` handler does that — Spec 03 R4). The returned object's `teardown(reason)` method delegates to `teardownSession(this, reason, { twilioCloseCode: 1001 })` — 1001 because the only external caller of `Session.teardown` is Spec 02's drain loop, whose contract (Spec 02 R2 doc comment) is "Twilio leg with close(1001, reason)".
- `export function teardownSession(s: Session, reason?: string, opts?: { twilioCloseCode?: number }): void` — Spec 03 R7 semantics: (1) if `s.tornDown` return; set `s.tornDown = true`; (2) `clearTimeout(s.startTimer)` if set; (3) `s.onTeardown?.()` inside try/catch (an onTeardown throw must not skip steps 4–5); (4) `sessions.delete(s.streamSid)` — mandatory on every path; (5) if `s.twilioWs.readyState` is OPEN or CONNECTING, `s.twilioWs.close(opts?.twilioCloseCode ?? 1000, reason ?? 'bye')`. Note: Spec 05 later becomes the one process-wide teardown implementation behind this seam (Spec 05 R "teardown matrix") — keep this function the single exported entry point so that swap is local.

## Steps

- [ ] Read every file in References (specs sections cited + `src/state.ts`, `src/logger.ts`, `package.json`). Confirm the `npm test` script glob (`tsx --test "src/**/*.test.ts"` per Spec 01 R6) will pick up `src/sessions.test.ts`. Test-runner note: Spec 03 names vitest, but master plan §8 R-1 adjudicates the interim runner as `node:test` through Wave D — write `node:test` + `node:assert/strict` suites at `src/*.test.ts`; T10 migrates them later. Record this as a planned deviation in the Completion Report.
- [ ] Write the failing test `src/sessions.test.ts` (`describe`/`it` from `node:test`, ESM imports with `.js` extensions) covering: (1) `sessions` from `./sessions.js` is reference-identical (`===`) to `sessions` from `./state.js`; (2) `createSession` initializes every field per the Produces list (use a minimal fake `twilioWs` object with `readyState`/`close` spies); (3) `teardownSession` called twice runs side effects once (`onTeardown` called exactly once, one `sessions.delete`, `tornDown === true`); (4) teardown clears a set `startTimer` (assert via `clearTimeout` spy or a timer that would otherwise fire); (5) teardown closes an OPEN fake socket with default code 1000, and `session.teardown('server shutdown')` closes with 1001; (6) an `onTeardown` that throws still results in `sessions.delete` having run; (7) `globalThis.window === undefined` (G6 env-guard, one assertion).
- [ ] Run `npm test` — expect FAIL (module `src/sessions.ts` does not exist).
- [ ] Implement `src/sessions.ts` per the Produces section above and Spec 03 R9/R7. No module-level state other than the re-exported map (Spec 03 R9 isolation rule). No imports of `twilio-media.ts` (would be circular later).
- [ ] Run `npm test` — expect PASS (all sessions tests + pre-existing suites green).
- [ ] Run `npm run typecheck` — expect exit 0. Run `npm run build` — expect success.
- [ ] Commit: `feat(sessions): Session interface, shared registry re-export, idempotent teardown` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges the unit-level halves of Spec 03 **A9** (teardown idempotence, `sessions.delete`, `onTeardown` once) and the structural precondition of **A1**/**A10** (single registry, per-call isolation via no shared module state). Route-level A9 assertions complete in T03.4.

## Completion Report

```
Task: T03.1 — sessions registry & teardown
Status: <done | blocked (why)>
Files changed: <list>
Commands run: npm test → <pass/fail counts>; npm run typecheck → <exit>; npm run build → <exit>
Spec A-numbers verified: A9 (unit half), A1/A10 preconditions
Deviations from plan: <none | list — include the R-1 node:test-instead-of-vitest note>
New interfaces exposed: sessions.ts exports (Session, LogLevel?, sessions, createSession, teardownSession)
Notes for ledger: <e.g. exact createSession init signature if it differs; whether logger already exported a level type>
```

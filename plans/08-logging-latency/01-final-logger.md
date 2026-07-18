# T08.1 — Final hand-rolled logger (`src/logger.ts`)

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Replace the Spec 01 stub `src/logger.ts` with the final Railway-parseable hand-rolled logger while preserving the `logEvent`/`LogFields`/`LogLevel` import boundary, and add the guarded `.raw` serializer.

**Wave:** B · **Depends on:** T01 · **Blocks:** T08.2, T08.3, T05, T10

**References:**
- `docs/specs/08-logging-and-latency-instrumentation.md` — R1, R2, R3, R4 (clock helpers), acceptance A2, A12
- `docs/specs/01-scaffolding-and-toolchain.md` — R7 (test runner: `node:test` via `tsx --test`), R12 (the `logEvent` boundary this task MUST keep intact)
- `docs/findings/09-latency-instrumentation.md` — §6 (verified logger code — copy this, adjusted only for lint style), V1, V2, V10, gotchas 2–4
- `docs/findings/07-railway-deployment.md` — §12 (structured log line contract)

## Interfaces

**Consumes:**
- T01's existing `src/logger.ts` stub surface: `logEvent(fields: LogFields): void`, `interface LogFields`, `type LogLevel` (Spec 01 R12 — exact shapes reproduced there). Other Wave B modules already import these; the signatures must not change.

**Produces** (all exported from `src/logger.ts`):
- `log(level: LogLevel, message: string, fields?: Record<string, unknown>): void` — the Spec 08 R1 implementation (verbatim from findings/09 §6)
- `logEvent(fields: LogFields): void` — kept, now a thin wrapper over `log()` per Spec 08 R1 code block
- `type LogLevel = 'debug' | 'info' | 'warn' | 'error'` and `interface LogFields` — unchanged from Spec 01 R12
- `ms(a: number, b: number): number` — 1-decimal rounding delta helper (Spec 08 R2)
- `now(): number` — `performance.now()` wrapper (Spec 08 R4)
- `safeRaw(value: unknown): string` — `JSON.stringify` wrapped in try/catch with `String(err)` fallback; the ONE place `.raw` payloads are serialized (Spec 08 R1 note + A12). Later tasks (T04/T05 `custom`/`error`/`session-updated` lines, T08.2/T08.3 recorder lines) must use it for every `raw` field.

Constraints carried into the file: single-line minified JSON on **stdout** only; never stderr; `LOG_LEVEL` env read at module load with default `info` (R1); no pino, no deps.

## Steps

- [ ] Read the References. Confirm the current `src/logger.ts` stub matches Spec 01 R12 and note every module that imports it (`grep` for `from './logger.js'` / `from '../logger.js'` under `src/`) — none of those import sites may need edits after this task.
- [ ] Write `src/logger.test.ts` using `node:test` + `node:assert/strict` (Spec 01 R7 conventions — this is the Wave B interim runner; do NOT install vitest). Capture output by temporarily monkey-patching `process.stdout.write` (and `process.stderr.write` to assert it is never called) inside the tests. Test cases:
  1. `log('info','hi',{callSid:'CA1',n:5})` emits exactly one line; `JSON.parse` succeeds; line contains no `\n` except the single trailing one; `message` is a string, `level` is the string `'info'`.
  2. Numeric fields survive as JSON numbers (`typeof parsed.n === 'number'`); an `undefined` field is absent from the output (Spec 08 R1 note).
  3. `log('debug', ...)` with default `LOG_LEVEL` emits nothing (rank filter).
  4. `logEvent({level:'info',message:'boot',event:'boot',port:3000})` produces the same flat single-line shape with `event` top-level (Spec 01 R12 compatibility).
  5. `ms(100, 233.456)` → `133.5`; `now()` returns a finite number and is monotonic across two calls.
  6. `safeRaw` on a plain object returns its JSON; on a cyclic object (A12) returns a string without throwing.
  7. Nothing was written to stderr in any of the above.
- [ ] Run `npx tsx --test src/logger.test.ts` — expect FAIL (new exports missing).
- [ ] Implement `src/logger.ts` per Spec 08 R1: paste the verified code block from the spec (which already includes the `logEvent` wrapper), keep the R12 `LogFields`/`LogLevel` declarations, add `safeRaw` per the R1 try/catch note. No other file changes — `src/server.ts` and `src/session.ts` are owned by T02/T05.
- [ ] Run `npx tsx --test src/logger.test.ts` — expect PASS (all cases).
- [ ] Run `npm test` — expect PASS (proves T01's `src/config.test.ts` and any sibling suites still compile against the boundary).
- [ ] Run `npm run typecheck` and `npm run build` — expect exit 0; `dist/logger.js` emitted, no `dist/logger.test.js`.
- [ ] Grep gate: `node -e "const s=require('fs').readFileSync('src/logger.ts','utf8'); if(/console\.(log|error)|process\.stderr/.test(s)){console.log('FAIL stderr/console found');process.exit(1)};console.log('ok')"` — expect `ok`.
- [ ] Commit everything with message:
  `feat(logger): final hand-rolled Railway logger with logEvent boundary and safeRaw guard`
  plus the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 08 **A2** (line shape + stderr rule, unit-tested portion; the "no per-frame lines in a live call" half is verified at M1/M2 by T05/T10), **A12** (cyclic `.raw` guard), and the `ms()`/ISO-`ts` half of **A4**. Preserves master-plan risk R-2's `logEvent` boundary.

## Completion Report

```
Task: T08.1 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec A-numbers verified: [A2 partial, A12, A4 partial]
Deviations from plan: [none | list]
New interfaces exposed: log, logEvent, LogLevel, LogFields, ms, now, safeRaw (src/logger.ts)
Notes for ledger: [anything T05/T08.2 must know]
```
(keep under ~20 lines)

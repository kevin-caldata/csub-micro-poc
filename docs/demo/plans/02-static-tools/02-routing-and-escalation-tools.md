# DA2.2 — `route_call` + `escalate_to_human` (routing and escalation static tools)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Add two more static tools to `buildMcpServer()` in `src/mcp-server.ts` — `route_call` (11-row real-CSUB directory with operator fallback and a `context?` handoff note) and `escalate_to_human` (the LLM-free crisis path speaking real resource numbers verbatim, never transferring) — plus their tests in `test/static-tools.test.ts`. This delivers tools three and four of the six-tool static surface of Demo Spec 02; DA2.3 (`02-static-tools/03-sms-time-and-hello-removal.md`) completes it with `send_sms`, the `get_current_time` reshape, `hello` retirement, and the `rio-demo` server rename.

**All Global Constraints in docs/demo/specs/00-master-demo-plan.md §G bind every step of this plan.** Restated where they bite hardest here: **G3** (crisis path is LLM-free, simulated-only, numbers byte-identical everywhere), **G5** (no module-level mutable state — `ROUTE_DIRECTORY` is a `const`), **G8/G9** (never touch `src/twiml.ts` or any bridge/session file — no TwiML, no `<Connect>` change, `live_transfer: false` always), **G12** (every phone number is copied character-for-character from the Demo Spec 02 R4 table / R3 payload — never retyped from memory), **G2** (no model call, no import from `'ai'`, no fallback anything).

**Wave:** DA (task DA2, chain step 2 of 3) · **Depends on:** `docs/demo/plans/02-static-tools/01-identity-flow-tools.md` landed (same files — strictly sequential, never concurrent) · **Blocks:** DA2.3 (`02-static-tools/03-sms-time-and-hello-removal.md`); merge point M-A; Wave DB (Spec 03 inserts at `// FR-5:`; Spec 01 names these tools)

## References (read BEFORE writing code)

- `docs/demo/specs/00-master-demo-plan.md` — §3 G2/G3/G5/G8/G9/G12, §4 tool-surface + log-event + magic-string tables, §5 D3 (this task lands against the **zero-arg** `buildMcpServer()`), D6 (`context?` confirmed), D9/D10 (crisis preamble + urgency enum frozen), §8 test rules incl. KF-1
- `docs/demo/specs/02-static-tools.md` — **R2** (shared conventions: minified-JSON single text item, `simulated` first key, raw-shape zod, one `logEvent` per handler, recoverable-status rule), **R3** (escalate_to_human: exact description, schema, payload, the three `speak_this` strings, the `crisis-escalation` log call — all verbatim in the spec), **R4** (route_call: exact description, schema, the 11-row directory table with row-order-authoritative first-keyword-substring matching, operator fallback values, payload field order, `handoff_blurb` template, `static-tool` log line), acceptance **A2, A3, A4** (+ A1/A11/A12 slices for these two tools)
- `docs/demo/specs/04-corpus.md` — the R3 crisis allowlist rows and §9 counseling section: the corpus speaks the **same four numbers**; your payload strings must byte-match them (G3): `(661) 654-3366`, `988`, `(661) 654-2111`, `(661) 654-2782`
- `src/mcp-server.ts` — as left by plan 01 (README protocol note N4 read-down): server name still `'hello-world'`, `hello` still registered, plan 01's two tools (`verify_identity`, `reset_password`) landed with the `VERIFICATION_TOKEN_REGEX` export, `// FR-5:` comment still the LAST line of the tool block (pre-plan-01 anchor: `src/mcp-server.ts:37`). The rename, `hello` retirement, and the other two tools belong to DA2.3, not to plan 01.
- `src/logger.ts:63-66` (`logEvent`; `LogFields` requires `level`/`message`/`event`, values scalar per `src/logger.ts:13`)
- `test/static-tools.test.ts` — created by plan 01; reuse its Fastify-port-0 + raw JSON-RPC `fetch` harness (pattern origin: `test/mcp-server.test.ts:8-30`) and its stdout-capture helper (pattern origin: `test/logger.test.ts:6-30` `withCapturedOutput`)

## Files

- **Modify:** `src/mcp-server.ts` — add `RouteEntry` interface + `export const ROUTE_DIRECTORY` at module scope; add two `registerTool` blocks inside `buildMcpServer()`'s tool block, immediately ABOVE the `// FR-5:` comment (which must remain the last line of the block — Spec 03's insertion point).
- **Test (modify):** `test/static-tools.test.ts` — two new `describe` blocks.
- **Nothing else.** No `package.json`, no `src/config.ts`, no env keys, no other test files (plan 01 applied the intermediate containment/`>= 4` migrations; the final R10 forms land with DA2.3).

## Interfaces

**Consumes:**
- Zero-arg `buildMcpServer(): McpServer` and the `/mcp` route body — unchanged (D3: signature change belongs to Spec 03 in Wave DB).
- `logEvent(fields: LogFields)` — `src/logger.ts:63-66`.
- `zod@3.25.76` raw-shape `inputSchema` convention (base Spec 07 R5); `z` is already imported.
- Plan 01's test harness + capture helper in `test/static-tools.test.ts`.

**Produces (exact names — master plan §4 relies on these):**
- Tool registrations `escalate_to_human` (`(reason: string, urgency: 'routine'|'urgent'|'crisis')`) and `route_call` (`(department: string, context?: string)`).
- `export interface RouteEntry { keywords: string[]; department: string; phone: string; extension: string; location: string; estimatedWaitMinutes: number }` and `export const ROUTE_DIRECTORY: RouteEntry[]` from `src/mcp-server.ts` (Spec 02 R4 — 11 rows, spec order).
- Log events: `crisis-escalation` (level `'warn'` iff `urgency === 'crisis'` else `'info'`, message `'escalation requested'`, fields `tool`/`urgency`/`reason` sliced to 200) and `static-tool` for route_call (level `'info'`, message `'static tool served'`, fields `tool`/`department`/`matched`).
- Speakable-script keys `speak_this` (three exact R3 strings) and `handoff_blurb` (R4 template); `live_transfer: false` on both payloads; `simulated: true` as first key on both.

## Preconditions (verify before step 1)

- [ ] Confirm plan 01 landed (README protocol note N4 — these are plan 01's ACTUAL outputs): `npx vitest run test/static-tools.test.ts test/mcp-server.test.ts` is green; `src/mcp-server.ts` exports `VERIFICATION_TOKEN_REGEX` and registers `verify_identity` + `reset_password`; `test/static-tools.test.ts` exists with the shared Fastify-port-0 harness and stdout-capture helper; the `// FR-5:` comment is still the last line of the tool block. `hello` still registered and server name still `'hello-world'` are EXPECTED at this point — the rename/retirement checks defer to DA2.3; do not treat them as a blocker. If any of the plan-01 outputs above is missing, STOP and report BLOCKED — this plan must not run against the pre-01 file.

## Steps

### escalate_to_human (Spec 02 R3)

- [ ] **Failing tests first.** Append a `describe('escalate_to_human', ...)` block to `test/static-tools.test.ts` using the existing harness (`tools/call` via raw JSON-RPC `fetch`; parse `result.content[0].text` as JSON). Tests (assert values per Spec 02 R3/A2 — the payload, the three `speak_this` strings, and the log call are specified there verbatim; copy them from the spec, never paraphrase):
  1. `crisis: payload matches R3 — simulated, status escalation_logged, live_transfer false, exact crisis speak_this, exactly the four resources in order`
  2. `crisis: the strings (661) 654-3366, 988, (661) 654-2111, (661) 654-2782 all appear in the serialized payload`
  3. `crisis: emits exactly one crisis-escalation log line at level warn with urgency and reason` (wrap the awaited `fetch` in the stdout-capture helper; filter captured lines for `"event":"crisis-escalation"`)
  4. `crisis: a 250-char reason is sliced to 200 in the log line` (assert `reason.length === 200` on the parsed line)
  5. `urgent: exact urgent speak_this; log level info`
  6. `routine: exact routine speak_this; log level info`
  7. `payload's first key is "simulated"` (`Object.keys(payload)[0] === 'simulated'` — R2.3)
  8. `invalid urgency value yields the SDK -32602 isError result` (send `urgency: 'panic'`; assert `result.isError === true` — R2.6 boundary)
  9. `tools/list advertises the exact R3 description string` (byte-equal to the spec's Description)
  10. `determinism: two identical crisis calls return byte-identical text` (A11 slice — no random fields in this tool)
- [ ] Run `npx vitest run test/static-tools.test.ts` → expect the new tests to FAIL with unknown-tool errors from `tools/call` (`escalate_to_human` not yet registered) and the description test failing on `tools/list`.
- [ ] **Implement** in `src/mcp-server.ts`: one `registerTool('escalate_to_human', ...)` block inserted above `// FR-5:`, per Demo Spec 02 R3 — description string, two-field raw-shape schema (`reason: z.string()`, `urgency: z.enum(['routine','urgent','crisis'])` with the exact `.describe` texts), deterministic payload with `speak_this` selected by `urgency` (three exact strings), the four-entry `resources` array, and the exact `logEvent` call (level `'warn'` iff crisis; `reason.slice(0, 200)`). Handler is `async` but awaits nothing; no `Date`, no randomness, no network (R2.1). **No transfer occurs — do not touch any TwiML/bridge file (G3/G8/G9).**
- [ ] Run `npx vitest run test/static-tools.test.ts` → expect PASS.

### route_call (Spec 02 R4)

- [ ] **Failing tests first.** Append a `describe('route_call', ...)` block. Tests (values per Spec 02 R4/A3/A4 — directory rows, fallback values, payload field order, and the `handoff_blurb` template are specified there verbatim):
  1. `financial aid + context: department/phone/extension/location/wait per the R4 row, context_note echoed, handoff_blurb equals the rendered template` (args `{department:'financial aid', context:'asking about fall disbursement'}` — A3's exact expected values)
  2. `no keyword match falls back to Campus Operator with context_note 'General inquiry.'` (args `{department:'basket weaving club'}`; assert phone `(661) 654-2782`, extension `2782`, location `9001 Stockdale Highway`, wait 1)
  3. `'student financial services' resolves to Student Financial Services — billing row wins before the aid keyword` (row-order rule, A4)
  4. `'IT help desk' resolves to ITS Service Center` (A4)
  5. `matching lowercases the department arg` (e.g. `'FINANCIAL AID'` → Financial Aid & Scholarships)
  6. `ROUTE_DIRECTORY exports exactly 11 rows in the R4 table order` (import `{ ROUTE_DIRECTORY }` from `../src/mcp-server.js`; assert `length === 11` and `ROUTE_DIRECTORY.map(r => r.department)` deep-equals the spec-order list)
  7. `emits one static-tool log line with tool route_call, the resolved department, and matched:false on fallback` (capture two calls: a hit → `matched: true`, fallback → `matched: false`)
  8. `tools/list advertises the exact R4 description string`
  9. `payload's first key is "simulated"; live_transfer is false`
- [ ] Run `npx vitest run test/static-tools.test.ts` → expect the new tests to FAIL (unknown tool; `ROUTE_DIRECTORY` import error is acceptable as the failure mode for test 6 — vitest reports it as a suite error).
- [ ] **Implement** in `src/mcp-server.ts` per Demo Spec 02 R4:
  - Module-scope `export interface RouteEntry {...}` and `export const ROUTE_DIRECTORY: RouteEntry[]` — the 11 rows **in table order, values copied verbatim from the spec table** (real CSUB numbers — G12; row order is authoritative for matching). `const` only — no mutable module state (G5, A12).
  - `registerTool('route_call', ...)` above `// FR-5:` — exact description, schema (`department: z.string()`, `context: z.string().optional()` with exact `.describe` texts). Matching rule per R4: lowercase the arg, scan rows top-to-bottom, first row where ANY keyword is a substring wins; no match → the fallback entry (NOT a table row). Payload in the R4 field order; `context_note` = the `context` arg or `'General inquiry.'`; `handoff_blurb` built from the exact R4 template. One `logEvent` per R4 (`matched` false only for the fallback).
- [ ] Run `npx vitest run test/static-tools.test.ts` → expect PASS.

### Cross-checks and finish

- [ ] **G3 byte-identity check.** `Select-String -Path src/mcp-server.ts -Pattern '654-3366|654-2111|654-2782|"988"'` — the crisis strings appear with exactly the G3 formatting: `(661) 654-3366`, `988`, `(661) 654-2111`, `(661) 654-2782`. If `assets/csub-corpus.md` already exists (DA1 is a parallel lane — it may not yet), grep the same four strings there and confirm identical formatting; if it doesn't exist, note in the completion report that the M-A/M-B spot check covers it.
- [ ] **A11/A12 slice.** Confirm `src/mcp-server.ts` has no import from `'ai'`, no `generateText`/`generateObject`/`fetch` in any handler, and every new module-scope declaration is `const` (no `let`).
- [ ] **Full suite:** `npx vitest run` → zero non-KF-1 failures, zero skips. Expected count: the 356 pre-demo baseline + plan 01's additions + the 19 tests added here (strictly > 356; record the actual number for the ledger). If ONLY the two `test/harness.test.ts` barge-in tests fail, apply the KF-1 rule (master plan §8.2): `npx vitest run test/harness.test.ts` — green in isolation passes the gate; note it. Any other failure blocks.
- [ ] **Typecheck:** `npx tsc --noEmit` → clean.
- [ ] **Commit** (touching only `src/mcp-server.ts` and `test/static-tools.test.ts`):
  ```
  feat(demo-tools): add route_call and escalate_to_human static tools (Demo Spec 02 R3/R4)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Verify

- `npx vitest run test/static-tools.test.ts` → PASS, includes the 19 tests above.
- `npx vitest run` → zero non-KF-1 failures, zero skips; count > 356 (baseline 356 + plan 01's additions + 19; KF-1 rule per master plan §8.2 if the two harness barge-in tests flake under full-suite load).
- `npx tsc --noEmit` → clean.

## Acceptance discharged

Demo Spec 02 **A2, A3, A4** in full; the `escalate_to_human`/`route_call` slices of **A1** (containment via plan 01's migrated `test/mcp-server.test.ts` assertion), **A11**, **A12**. Leaves for DA2.3: `send_sms`, the `get_current_time` reshape, `hello` retirement, the `rio-demo` rename, and the final R10 migrations — DA2 completes (and merge point M-A becomes reachable) only after DA2.3.

## Completion Report

```
Task: DA2.2 — route_call + escalate_to_human
Status: <complete | blocked: reason>
Files changed: <list — must be exactly src/mcp-server.ts, test/static-tools.test.ts>
Commands run: <cmd → outcome, one line each>
Spec 02 acceptance verified: A2 <p/f>, A3 <p/f>, A4 <p/f>, A11 slice <p/f>, A12 <p/f>
Full-suite count: <n> (KF-1 invoked: <yes+isolation result | no>)
Crisis-number byte check: src/mcp-server.ts <ok>; assets/csub-corpus.md <ok | not yet present>
Deviations from plan: <none | list>
Notes for ledger: <≤3 lines>
```

# DA2.3 — `send_sms`, campus-time `get_current_time`, `hello` retirement, server rename

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Finish the Spec 02 static-tool surface: register `send_sms` (Spec 02 R7), reshape `get_current_time` to the campus-time JSON payload (Spec 02 R8, adjudication D7), DELETE the `hello` tool, rename the server identity to `{ name: 'rio-demo', version: '1.0.0' }` (Spec 02 R1), and migrate every hello-dependent test (Spec 02 R10, adjudication D4). This task ends Wave DA for Spec 02: the full static-tool suite is green.

**Global Constraints:** All Global Constraints in `docs/demo/specs/00-master-demo-plan.md` §G bind every step of this plan. Restated where they bite here: **G5** — no module-level mutable state in `src/mcp-server.ts` (module `const` is fine); **G9** — `src/tools.ts`, `src/session.ts`, `src/twiml.ts` etc. are untouched; **G8** — never weaken the Twilio signature gate (you have no reason to be near it); **G4** — the preamble sentence `Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up').` and its assertions at `test/gateway.session-config.test.ts:100-102` and `:124-128` are untouched (this task never edits `src/gateway.ts` or that test file — A10 requires it to pass unmodified); **G1** — no `package.json` / lockfile changes (Spec 02 introduces zero deps, zero env keys); **G2/A11** — no import from `'ai'`, no model call anywhere in `src/mcp-server.ts`; static handlers are deterministic and LLM-free (Spec 02 R2.1).

**Wave:** DA (task DA2, third and final chain link) · **Depends on:** `docs/demo/plans/02-static-tools/01-*.md` and `docs/demo/plans/02-static-tools/02-routing-and-escalation-tools.md` both `OK` in `docs/demo/plans/LEDGER.md` — they landed `verify_identity` + `reset_password` + `route_call` + `escalate_to_human`, the `VERIFICATION_TOKEN_REGEX` export, and created `test/static-tools.test.ts` with its harness + log-capture pattern · **Blocks:** merge point M-A; Wave DB (Spec 03 inserts at `// FR-5:`; Spec 01 names the frozen tool surface).

**References (read BEFORE writing code):**
- `docs/demo/specs/00-master-demo-plan.md` — §3 (G1–G14), §5 D3/D4/D7, §8 (test rules, KF-1)
- `docs/demo/specs/02-static-tools.md` — R1, R2 (shared conventions), R7 (`send_sms` — description, schema, payload, id format, log line, all verbatim there), R8 (`get_current_time` — description, payload, log line, verbatim), R10 (test migrations, itemized), R11; acceptance A1, A8, A9, A10, A11, A12
- `src/mcp-server.ts` — as left by tasks 01/02. Pre-Wave-DA anchors (locate by quoted content; the sibling tasks inserted blocks above `// FR-5:` so line numbers have shifted): server identity `new McpServer({ name: 'hello-world', version: '1.0.0' })` (was `:9`), old `get_current_time` block (was `:12-23`), `hello` block (was `:27-36`), `// FR-5:` comment (was `:37` — it must remain the LAST line of the tool block, Spec 02 R1)
- `test/mcp-server.test.ts:8-30` (harness pattern), `:33-41` (A1 exact-list assertion), `:43-53` (hello call test), `:55-65` (old time test)
- `test/tools.test.ts:33-39` (exactly-2 count), `:49-54` (get_current_time parameters deep-equal — stays valid, do NOT touch), `:56-63` (hello schema mapping), `:68`, `:80-99` (three time guard tests), `:101-106` (hello valid-args), `:119` (transport failure)
- `test/fakes/fake-gateway.ts:359-381` (`runToolCallScript` + its doc comment)
- `test/harness.test.ts:342-380` (tool-call scenario; `:366` name assertion, `:367-369` exact-text assertion, `:371-374` gated response-create — UNTOUCHED)
- `test/logger.test.ts:6-29` (`withCapturedOutput` pattern) and the log-capture helper already in `test/static-tools.test.ts` from tasks 01/02

## Files

- **Create:** none.
- **Modify:** `src/mcp-server.ts` (add `send_sms` block, replace `get_current_time` block, delete `hello` block, rename server, ensure `randomInt` import).
- **Test:** `test/static-tools.test.ts` (append), `test/mcp-server.test.ts`, `test/tools.test.ts`, `test/harness.test.ts`, `test/fakes/fake-gateway.ts` (migrations per Spec 02 R10). No other file — this is DA2's declared exclusive set (master plan §6, G14). Explicitly forbidden per Spec 02 R10.5: `test/tool-mapping.test.ts`, `test/fixtures/list-tools-response.ts`, `test/tool-loop.test.ts`, `test/session-turns.test.ts`.

## Interfaces

**Consumes:**
- `buildMcpServer(): McpServer` / `mcpRoutes(app)` — zero-arg signatures, unchanged (adjudication D3: Spec 03 owns the signature change in Wave DB, not this task).
- `logEvent(fields)` — `src/logger.ts:63-66` (scalar values; `level`/`message`/`event` required).
- From tasks 01/02: the `verify_identity` registration (retarget target for every migrated hello test), `export const VERIFICATION_TOKEN_REGEX = /^SIM-V-[0-9A-F]{6}$/` from `src/mcp-server.ts`, and `test/static-tools.test.ts`'s shared Fastify-port-0 + raw JSON-RPC `fetch` harness and log-capture helper.
- `randomInt` from `node:crypto` (Spec 02 R2.7 — `randomBytes` was added by task 01; extend that import, don't duplicate it).

**Produces (exact names — master plan §4 interface table):**
- Tool `send_sms (to_summary: string)` — payload keys in order `simulated`(true, FIRST key)/`status`/`message_id`/`to`/`body_summary`/`note`; `message_id` format `SMS-SIM-` + 6 digits, matching `/^SMS-SIM-\d{6}$/`; log event `static-tool`.
- Tool `get_current_time ()` — no `inputSchema` key; payload `{"simulated":false,"utc":...,"campus_time":...,"timezone":"America/Los_Angeles"}` (`simulated` FIRST key, the only `false` in the surface); log event `static-tool`.
- Server identity `new McpServer({ name: 'rio-demo', version: '1.0.0' })`.
- A hello-free six-tool surface with `// FR-5:` still the last line of the tool block, and the D4 containment+exclusion assertion style in `test/mcp-server.test.ts` — so Spec 03 (Wave DB) adds `ask_campus_knowledge` without touching that file again.

## Steps

- [ ] **Read** every file in References. Confirm in `src/mcp-server.ts` that tasks 01/02 landed four new tools and that `hello` + the old plain-string `get_current_time` are still present. Confirm `test/static-tools.test.ts` exists with a working harness — if not, STOP and report BLOCKED (dependency not met).

- [ ] **RED — `send_sms` tests.** Append a `describe('send_sms')` block to `test/static-tools.test.ts`, using the file's existing harness and log-capture helpers. Tests (names + assertions; values are verbatim in Spec 02 R7 and A8):
  1. `'A8: returns sent status with an SMS-SIM message id and echoes body_summary'` — call with `{ to_summary: 'MyID reset link' }`; parse `content[0].text`; assert `status === 'sent'`, `message_id` matches `/^SMS-SIM-\d{6}$/`, `body_summary === 'MyID reset link'`, `to === 'the number the caller is calling from'`, `note === 'Simulated — no real text message was sent. Tell the caller this if they ask.'`, and `Object.keys(payload)[0] === 'simulated'` with `payload.simulated === true` (Spec 02 R2.3).
  2. `'A11: two identical calls are byte-identical except message_id'` — call twice with the same args; assert the two payloads deep-equal after deleting `message_id` from each, and both ids match the regex.
  3. `'R7 log: one static-tool line with tool send_sms and messageId'` — capture stdout around a call; assert exactly one line with `event === 'static-tool'`, `level === 'info'`, `message === 'static tool served'`, `tool === 'send_sms'`, and `messageId` equal to the returned `message_id`.
- [ ] **Run** `npx vitest run test/static-tools.test.ts` → expect FAIL: the three new tests error with the SDK `-32602` `Tool send_sms not found` result (all pre-existing tests in the file still pass).

- [ ] **Implement `send_sms`** per Demo Spec 02 R7 — description string, `to_summary` schema with its `.describe(...)`, payload shape, id template `` `SMS-SIM-${String(randomInt(0, 1000000)).padStart(6, '0')}` ``, and the `logEvent` line are specified there verbatim. One `registerTool` block in `src/mcp-server.ts`, inserted with the other five ABOVE the `// FR-5:` comment (which stays the last line of the tool block). Minified-JSON return shape per R2.2. Extend the `node:crypto` import with `randomInt`. No phone-number argument exists by design (R7 — never collect caller digits).
- [ ] **Run** `npx vitest run test/static-tools.test.ts` → expect PASS (whole file green).

- [ ] **RED — campus-time reshape tests** (adjudication D7: the JSON payload replaces the old plain string; the ripple migrations below are in this task's scope):
  1. Append a `describe('get_current_time')` block to `test/static-tools.test.ts`: `'A8: returns real campus (Pacific) time as JSON'` — parse `content[0].text`; assert `simulated === false`, `Object.keys(payload)[0] === 'simulated'`, `utc` matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`, `timezone === 'America/Los_Angeles'`, `campus_time` is a non-empty string containing a comma (Intl `dateStyle:'full'` output). Plus `'R8 log: one static-tool line with tool get_current_time'` (same capture pattern, fields per Spec 02 R8).
  2. Migrate `test/mcp-server.test.ts:55-65` per Spec 02 R10.1: retitle; parse `content[0].text` as JSON; assert `utc` matches the regex above and `timezone === 'America/Los_Angeles'`.
  3. Migrate the three guard tests at `test/tools.test.ts:80-99` per Spec 02 R10.2: KEEP their `''` / `'   '` / `'{}'` args exactly (they test `runTool`'s empty-args guard, not the tool); replace each `content[0]!.text` regex match with: parse `content[0]!.text` as JSON, assert the R8 shape (`utc` regex + `timezone === 'America/Los_Angeles'`).
- [ ] **Run** `npx vitest run test/static-tools.test.ts test/mcp-server.test.ts test/tools.test.ts` → expect FAIL on exactly those migrated/new time tests (the handler still returns the old `"<iso> (<tz>)"` string, so `JSON.parse` throws or assertions miss).

- [ ] **Implement the `get_current_time` reshape** per Demo Spec 02 R8 — new description string, no `inputSchema` key (handler `(extra) =>` form unchanged), payload built from `new Date().toISOString()` and `Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' })`, hardcoded `timezone: 'America/Los_Angeles'`, minified JSON per R2.2, plus the R8 `logEvent` line. The exact strings and key order are in R8.
- [ ] **Run** the same three-file command → expect PASS. (`test/tools.test.ts:49-54` — parameters deep-equal `{type:'object',properties:{}}` — passes untouched, confirming the no-inputSchema advertisement survives, Spec 02 A1.)

- [ ] **RED — hello-retirement migrations** (Spec 02 R10; retarget everything to `verify_identity`, which task 01 already shipped — so only the *exclusion* assertions go red here):
  1. `test/mcp-server.test.ts:33-41` per R10.1 / adjudication D4 — the exact-list `expect(names).toEqual(['get_current_time', 'hello'])` becomes containment + exclusion (this exact form, so Spec 03 can add its seventh tool without editing this file):
     ```ts
     for (const name of ['escalate_to_human', 'get_current_time', 'reset_password', 'route_call', 'send_sms', 'verify_identity']) {
       expect(names).toContain(name);
     }
     expect(names).not.toContain('hello');
     ```
     Retitle the `it` accordingly (it no longer says "exactly ... and hello").
  2. `test/mcp-server.test.ts:43-53` — replace the hello call test with a `verify_identity` call test: args `{ name: 'Ada' }`; parse `content[0].text`; assert `verified === true` and `student.name === 'Ada'` (R10.1).
  3. `test/tools.test.ts:33-39` — `expect(defs.length).toBe(2)` becomes `expect(defs.length >= 6).toBeTruthy()` (R10.2); retitle.
  4. `test/tools.test.ts:56-63` — migrate the hello schema-mapping test to `verify_identity`: `parameters.properties['name']` equals `{ type: 'string', description: "The caller's full name as spoken." }` and `parameters.required` is `undefined` (both fields optional — R10.2).
  5. `test/tools.test.ts:68` (bad args, keep `'{"name": 42}'`) and `:119` (transport failure) — swap `'hello'` → `'verify_identity'`. `:101-106` (valid args) — `runTool(client, 'verify_identity', '{"name":"Ada"}')`; parse `content[0].text`; assert `verified === true` and `verification_token` matches `VERIFICATION_TOKEN_REGEX` (import it from `'../src/mcp-server.js'`) (R10.2).
  6. `test/fakes/fake-gateway.ts:375` — `name: 'hello'` → `name: 'verify_identity'`; KEEP `arguments: '{"name":"Kevin"}'` at `:376`; update the doc comment at `:359-363` to say `function-call-arguments-done('verify_identity', Kevin)` (R10.3).
  7. `test/harness.test.ts:360-375` per R10.4 — `:366` becomes `expect(itemCreate.item.name).toBe('verify_identity')`; `:367-369` becomes: parse `output.content[0]!.text` as JSON and assert `verified === true`, `student.name === 'Kevin'`, and `verification_token` matching `VERIFICATION_TOKEN_REGEX` (structural match — the token suffix is random, the old exact `'Hello, Kevin!'` is gone). The exactly-one-gated-`response-create` assertion at `:371-374` is UNTOUCHED. Touch nothing else in this file — the two KF-1 barge-in tests (master plan §8 R8.2) must remain byte-identical.
  8. `test/static-tools.test.ts` — extend the file's tool-surface test (or add one if tasks 01/02 asserted only their own names) to assert containment of ALL six R1 names AND `expect(names).not.toContain('hello')` (Spec 02 A1).
- [ ] **Run** `npx vitest run test/static-tools.test.ts test/mcp-server.test.ts test/tools.test.ts test/harness.test.ts` → expect FAIL confined to the `not.toContain('hello')` exclusion assertions (`hello` is still registered); every retargeted `verify_identity` test already passes. Any other failure means a migration typo — fix before proceeding.

- [ ] **Implement the retirement** in `src/mcp-server.ts` per Spec 02 R1: delete the entire `hello` `registerTool` block (the one whose description is `'Say a friendly hello.'`), and rename the server identity to `new McpServer({ name: 'rio-demo', version: '1.0.0' })` (metadata only; nothing asserts the old `'hello-world'` name). `// FR-5:` stays the last line of the tool block.
- [ ] **Run** `npx vitest run test/static-tools.test.ts test/mcp-server.test.ts test/tools.test.ts test/harness.test.ts` → expect PASS. Per-file counts (migrations preserve counts — R8.4, no deletions): `test/mcp-server.test.ts` 8, `test/tools.test.ts` 13, `test/harness.test.ts` 13 (in isolation), `test/static-tools.test.ts` = tasks 01/02's tests + the 6 added here.

- [ ] **Static gates** (Spec 02 A9/A11/A12):
  - `grep -rn "'hello'" test/tools.test.ts test/mcp-server.test.ts test/harness.test.ts test/fakes/fake-gateway.ts src/mcp-server.ts` → zero hits (`test/tool-mapping.test.ts` / `test/fixtures/list-tools-response.ts` are exempt frozen fixtures per R10.5 — do not "fix" them).
  - `grep -n "from 'ai'" src/mcp-server.ts` → zero hits; no `generateText`/`generateObject`/`fetch` inside any static handler (A11).
  - Every module-scope declaration added to `src/mcp-server.ts` across tasks 01–03 is `const`; zero module-level `let`/mutable bindings (A12, G5).
  - `git status` — only the six declared files are modified; `package.json`, `src/tools.ts`, `src/gateway.ts`, `test/gateway.session-config.test.ts` untouched (G1/G4/G9).

- [ ] **Commit:**
  ```
  feat(mcp): send_sms + campus-time get_current_time; retire hello, rename server to rio-demo

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Verify

- [ ] `npx vitest run` — full suite green: zero non-KF-1 failures, zero skips introduced (master plan §8 R8.3). Expected count: the pre-demo baseline **356** plus every test added by Wave DA so far (DA1 corpus ≥ 7, DA3, tasks 02-static-tools/01–02, and this task's ~6) — strictly > 356, count never shrinks (R8.4). Record the exact number for the ledger note. **KF-1 rule (§8 R8.2):** if the run fails ONLY on the two `test/harness.test.ts` barge-in tests ("clear precedes conversation-item-truncate" / "truncate carries a valid audioEndMs"), re-run `npx vitest run test/harness.test.ts` — 13/13 green in isolation passes the gate; note it. Any other failure blocks completion.
- [ ] `npx tsc --noEmit` — clean.
- [ ] Targeted: `npx vitest run test/static-tools.test.ts test/mcp-server.test.ts test/tools.test.ts test/harness.test.ts` — all green at the counts listed above.

## Acceptance

Discharges Demo Spec 02 **A1** (six-name surface, no `hello`, `get_current_time` advertises `{"type":"object","properties":{}}`), **A8** (sms + time payloads), **A9** (migrations + grep), **A10** (full suite; `test/tool-mapping.test.ts`, `test/tool-loop.test.ts`, `test/session-turns.test.ts`, `test/gateway.session-config.test.ts` pass WITHOUT modification), **A11/A12** for the two tools added here. Together with tasks 01/02 this completes Spec 02 → Wave DA merge point M-A becomes reachable. Leaves for Wave DB (NOT this task): the `buildMcpServer(cfg, deps?)` signature change and call-site updates (adjudication D3 — Spec 03 owns them), the exact-seven `tools/list` pin (D4 — lives in `test/knowledge.test.ts`).

## Completion Report

```
Task: DA2.3 — send_sms + campus-time get_current_time + hello retirement + rio-demo rename
Status: <complete | blocked: reason>
Files changed: <list — must be exactly the six declared files>
Commands run: <cmd → outcome, one line each; include full-suite count and KF-1 note if invoked>
Spec 02 acceptance verified: A1 <p/f>, A8 <p/f>, A9 <p/f>, A10 <p/f>, A11 <p/f>, A12 <p/f>
Deviations from plan: <none | list>
New interfaces exposed: send_sms; get_current_time campus-time payload (utc/campus_time/timezone); server name rio-demo; hello-free surface; D4 containment+exclusion assertion in test/mcp-server.test.ts
Notes for ledger: <≤3 lines — include the full-suite test count for §8 R8.4 tracking>
```

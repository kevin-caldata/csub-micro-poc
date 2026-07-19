# DA2.1 — Identity-flow static tools: `verify_identity` + `reset_password` (+ `VERIFICATION_TOKEN_REGEX`)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Register the two identity-flow static tools — `verify_identity` (mints the `SIM-V-` token) and `reset_password` (shape-validates it) — inside `buildMcpServer()` at the FR-5 insertion point in `src/mcp-server.ts`, export `VERIFICATION_TOKEN_REGEX`, and cover them in a new `test/static-tools.test.ts` per Demo Spec 02 acceptance rows A5/A6/A7. The token flow is stateless by construction: the token rides in tool args/results only (Spec 02 R9; master plan D13).

**All Global Constraints in docs/demo/specs/00-master-demo-plan.md §G bind every step of this plan.** Restated where they bite here: G5 statelessness — no module-level mutable state in `src/mcp-server.ts`; new module-scope declarations are `const` only. G14 — touch only the files declared below. Both handlers are LLM-free and deterministic (Spec 02 R2.1) — no import from `'ai'`, no fetch, no timers; the only randomness is opaque-ID minting. This task does NOT delete `hello`, does NOT rename the server (`'hello-world'` stays for now), does NOT add the other four static tools, and does NOT touch `src/gateway.ts` (G4 preamble sentence and its assertions at `test/gateway.session-config.test.ts:100-102`,`:124-128` are out of this task's reach by construction).

**Wave:** DA (task DA2, chain step 1) · **Depends on:** nothing (lands against the current zero-arg `buildMcpServer()` — master plan D3) · **Blocks:** the remaining `02-static-tools` chain steps (crisis/route/sms/time tools, hello retirement + R10 migrations)

**References (read before writing code):**
- `docs/demo/specs/00-master-demo-plan.md` — §3 (G5, G14), §4 interface table (tool signatures, `VERIFICATION_TOKEN_REGEX` export row, magic strings), §5 D3/D13, §8 test rules (baseline 356, KF-1)
- `docs/demo/specs/02-static-tools.md` — R2 (shared conventions), **R5** (`verify_identity` — description string, schema, handler logic, payload, token mint, log line: all exact values live there), **R6** (`reset_password` — description string, schema, regex gate, failure envelope, success payload with MyID narrative, log line), R9 (statelessness rationale), acceptance **A5, A6, A7**, A11/A12 (determinism/statelessness checks, applied to these two tools)
- `src/mcp-server.ts` — current file; the `hello` block ends at `:36`, the `// FR-5:` comment is `:37`, `return server` is `:38`
- `test/mcp-server.test.ts:8-30` — the harness pattern to copy (Fastify port 0, `jsonHeaders` with `accept: application/json, text/event-stream`, `rpcPost` helper); `:33-41` is the exact-list assertion this task must minimally migrate
- `test/tools.test.ts:33-39` — the `defs.length` assertion this task must minimally migrate
- `test/logger.test.ts:6-29` — `withCapturedOutput` pattern (adapt to async, see Step 3 case 12)
- `src/logger.ts:63-66` — `logEvent(fields: LogFields)`; scalar values only

## Files

- **Modify:** `src/mcp-server.ts` — add one import, one exported const, two `registerTool` blocks. Nothing else in the file changes; the `// FR-5:` comment stays the last line of the tool block.
- **Create (test):** `test/static-tools.test.ts` — identity-flow describe block. Later chain steps APPEND their tools' describe blocks to this same file; keep the shared harness setup at top-of-file so siblings reuse it.
- **Modify (test, minimal collateral only):** `test/mcp-server.test.ts` (the `:33-41` exact-list assertion), `test/tools.test.ts` (the `:35` count assertion) — intermediate forms only, detailed in Step 5. The full R10 migrations (hello retirement, `>= 6`, containment+exclusion) belong to a later chain step, NOT this one.

## Interfaces

**Consumes (existing, unchanged):**
- `buildMcpServer(): McpServer` zero-arg + `mcpRoutes(app: FastifyInstance)` — `src/mcp-server.ts:8,41` (D3: signatures unchanged in Wave DA)
- `logEvent(fields)` — `src/logger.ts:63-66`
- zod raw-shape `inputSchema` convention (plain object of zod schemas, never `z.object(...)`) — `zod@3.25.76`, base Spec 07 R5; no `package.json` change (G1)

**Produces (exact names — master plan §4 interface table rows):**
- `export const VERIFICATION_TOKEN_REGEX = /^SIM-V-[0-9A-F]{6}$/;` from `src/mcp-server.ts`
- Tool registrations: `verify_identity (name?: string, dob?: string)`, `reset_password (verification_token: string)`
- Token format `SIM-V-` + 6 uppercase hex, minted as `` `SIM-V-${randomBytes(3).toString('hex').toUpperCase()}` ``
- Log lines: event `static-tool`, level `'info'`, message `'static tool served'`; `verify_identity` adds `verified: <boolean>`, `verifiedWith: <'name'|'dob'|'name+dob'|'none'>`; `reset_password` adds `tokenValid: <boolean>`
- `test/static-tools.test.ts` with the shared harness the sibling chain steps append to

## Steps

- [ ] **1. Read** every file/section in References. Confirm the current anchors: `src/mcp-server.ts:36` (end of `hello` block), `:37` (`// FR-5:` comment), `test/mcp-server.test.ts:40` (`expect(names).toEqual(['get_current_time', 'hello'])`), `test/tools.test.ts:35` (`expect(defs.length).toBe(2)`).

- [ ] **2. Write the failing test file** `test/static-tools.test.ts`. Copy the harness verbatim from `test/mcp-server.test.ts:8-30` (Fastify `{ logger: false }`, `mcpRoutes(app)`, `listen({ port: 0, host: '127.0.0.1' })`, `jsonHeaders`, `rpcPost`). Add a small helper `callTool(name, args)` → `rpcPost({ jsonrpc:'2.0', id:<n>, method:'tools/call', params:{ name, arguments: args } })` and a `parsePayload(body)` that does `JSON.parse(body.result.content[0].text)`. Import `VERIFICATION_TOKEN_REGEX` from `../src/mcp-server.js` (compile fails until Step 4 — that is the red state for the export). One `describe('static tools — identity flow (verify_identity / reset_password)')` with exactly these 12 tests:
  1. `tools/list contains verify_identity and reset_password, each advertising a $schema-bearing inputSchema` — names present in `body.result.tools`; each tool's `inputSchema` JSON contains `$schema` (raw `tools/list`, not `fetchToolDefs`; Spec 02 A1 slice).
  2. `verify_identity {} returns need_detail` — payload `simulated === true`, `verified === false`, `status === 'need_detail'`, `message` per Spec 02 R5.
  3. `verify_identity with whitespace-only name and dob returns need_detail` — args `{ name: '   ', dob: ' ' }` (R5 trim rule).
  4. `verify_identity {name:'Ada Lovelace'} verifies and mints a SIM-V token` — `verified === true`, `status === 'verified'`, `student.name === 'Ada Lovelace'`, `student.netid === 'rrunner900'`, `student.student_id === '900123456'`, `student.record_flag === 'SIMULATED RECORD — not a real student'` (em dash, byte-exact), `verification_token` matches `VERIFICATION_TOKEN_REGEX`, `note === 'Keep the verification_token; reset_password requires it.'` (Spec 02 A5).
  5. `verify_identity {dob:'March 5 2004'} uses the CSUB Student placeholder and never echoes the dob` — `student.name === 'CSUB Student'`; `JSON.stringify(payload)` contains no occurrence of `'March 5 2004'` (Spec 02 A5, PII non-reflection).
  6. `both tools put "simulated" as the first payload key` — `Object.keys(payload)[0] === 'simulated'` for a `verify_identity {name:'Ada'}` payload and a `reset_password {verification_token:'nope'}` payload (Spec 02 R2.3).
  7. `verify→reset token flow works across two fresh server instances` — call `verify_identity {name:'Ada'}`, extract `verification_token`, then call `reset_password` with it (two separate POSTs = two fresh `McpServer`s): `status === 'reset_initiated'`, `system === 'MyID (myid.csub.edu)'`, `narrative` contains ALL of the exact substrings `myid.csub.edu`, `'Forgot Password / Activate Account'`, `authorization code`, `personal email on file`, `11 to 255 characters`; `duo_reminder` contains `(661) 654-4357` (Spec 02 A6).
  8. `reset_password with a malformed token returns recoverable not_verified, not isError` — args `{ verification_token: 'nope' }` → HTTP 200, `body.result.isError` falsy, `status === 'not_verified'`, `message` per Spec 02 R6 (Spec 02 A7).
  9. `reset_password rejects lowercase hex (regex is uppercase-only)` — args `{ verification_token: 'SIM-V-abc123' }` → `status === 'not_verified'` (shape gate per R6/R9.4).
  10. `reset_password {} hits the SDK -32602 validation isError path` — missing required field → `body.result.isError === true` at the JSON-RPC level (Spec 02 A7).
  11. `verify_identity is deterministic apart from the minted token` — call twice with `{ name: 'Ada' }`; the two payloads deep-equal after deleting `verification_token` from each (Spec 02 A11 slice).
  12. `handlers emit exactly one static-tool log line each` — adapt `withCapturedOutput` (`test/logger.test.ts:6-29`) to async: save `process.stdout.write`, install the capturing stub, `await` the tool call, restore in `finally`. For `verify_identity {name:'Ada'}`: exactly one captured line whose parsed JSON has `event === 'static-tool'`, `level === 'info'`, `msg`/message field `'static tool served'` (match the logger's actual serialized field name — check a `test/logger.test.ts` assertion for it), `tool === 'verify_identity'`, `verified === true`, `verifiedWith === 'name'`. For `reset_password {verification_token:'nope'}`: one line with `tool === 'reset_password'`, `tokenValid === false` (Spec 02 R5/R6 log contracts).

- [ ] **3. Run the failing tests:** `npx vitest run test/static-tools.test.ts` → expect FAIL: the `VERIFICATION_TOKEN_REGEX` import has no export to bind (or, if vitest still executes, every `tools/call` returns the SDK's `Tool verify_identity not found` -32602 error). Do not proceed until you have seen the red run.

- [ ] **4. Implement** in `src/mcp-server.ts`:
  - Add `import { randomBytes } from 'node:crypto';` at top. Import `randomBytes` ONLY — `randomInt` belongs to the `send_sms` chain step (Spec 02 R2.7 lists both; an unused import here fails typecheck).
  - Add `export const VERIFICATION_TOKEN_REGEX = /^SIM-V-[0-9A-F]{6}$/;` at module scope (a `const` — G5-compliant).
  - Insert TWO `registerTool` blocks between the end of the `hello` block (`:36`) and the `// FR-5:` comment (`:37`). The FR-5 comment must remain the last line of the tool block, immediately before `return server`.
  - `verify_identity`: implement per **Demo Spec 02 R5** — the description string, the two-optional-field raw shape with its exact `.describe(...)` strings, the need_detail branch (neither arg, or both empty/whitespace after `.trim()`), the always-succeed branch with the exact student record, the token mint `` `SIM-V-${randomBytes(3).toString('hex').toUpperCase()}` ``, the no-dob-echo rule, and the `logEvent` call are all specified there verbatim. Payload first key is `simulated` (R2.3); return shape is one text item of minified JSON (R2.2).
  - `reset_password`: implement per **Demo Spec 02 R6** — the description string, the single required-string raw shape, `VERIFICATION_TOKEN_REGEX.test(arg)` gate, the recoverable `not_verified` envelope (a normal payload, never a throw — R2.6), the `reset_initiated` success payload with the MyID `narrative` and `duo_reminder`, and the `logEvent` call are all specified there verbatim.
  - Handlers: `async` to match the existing pattern, but purely synchronous inside — no awaits, no network, no timers (R2.1). Touch nothing else in the file: `hello`, `get_current_time`, the server name `'hello-world'`, and `mcpRoutes` all stay byte-identical.

- [ ] **5. Run targeted tests:** `npx vitest run test/static-tools.test.ts` → expect PASS, 12/12. Then run `npx vitest run test/mcp-server.test.ts test/tools.test.ts` → expect exactly TWO failures caused by the enlarged surface (the `:40` exact-list `toEqual` and the `:35` `toBe(2)` count). Apply the minimal intermediate migrations, nothing more:
  - `test/mcp-server.test.ts:33-41` — replace the `toEqual(['get_current_time', 'hello'])` with containment: `for (const name of ['get_current_time', 'hello', 'reset_password', 'verify_identity']) { expect(names).toContain(name); }`; retitle the `it` to `A1: tools/list returns 200 application/json and contains the registered tool surface`. (Containment now so sibling chain steps adding tools do not re-break this file; the final R10.1 form — six demo names + `not.toContain('hello')` — lands with the hello-retirement chain step.)
  - `test/tools.test.ts:33-39` — replace `expect(defs.length).toBe(2)` with `expect(defs.length).toBeGreaterThanOrEqual(4)`; retitle to `A4: returns at least 4 defs; every entry has type === "function"`. (R10.2's final `>= 6` lands with the hello-retirement chain step.)
  - Touch NOTHING else in either file — the `hello` call tests, `hello` schema test, and `get_current_time` tests still pass because this task did not touch those tools.
  - Re-run `npx vitest run test/static-tools.test.ts test/mcp-server.test.ts test/tools.test.ts` → all green.

- [ ] **6. Statelessness/determinism review checks** (Spec 02 A11/A12 slices):
  - `grep -n "^let \|module.*let " src/mcp-server.ts` and visually confirm: every new module-scope declaration is `const`.
  - `grep -n "from 'ai'" src/mcp-server.ts` → zero hits; no `generateText`/`generateObject`/`fetch` inside either new handler.
  - `grep -n "FR-5" src/mcp-server.ts` → still exactly one hit, still the last line before `return server`.
  - `git diff --stat` → exactly `src/mcp-server.ts`, `test/static-tools.test.ts`, `test/mcp-server.test.ts`, `test/tools.test.ts` (G14).

- [ ] **7. Verify tail** (all three, in order):
  - `npx vitest run` → **368 passed expected** (356 baseline + 12 new), zero skips introduced. KF-1 rule (master plan §8 R8.2): if the ONLY failures are the two `test/harness.test.ts` barge-in tests ("clear precedes conversation-item-truncate", "truncate carries a valid audioEndMs"), re-run `npx vitest run test/harness.test.ts` once; green in isolation = pass, note it in the completion report. Any other failure blocks.
  - `npx tsc --noEmit` → clean.
  - `npx vitest run test/static-tools.test.ts` → 12/12.

- [ ] **8. Commit** (single commit, exactly the files from Step 6's diff check):
  ```
  feat(demo-tools): add verify_identity + reset_password with stateless SIM-V token flow

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Acceptance

Discharges Demo Spec 02 **A5, A6, A7** and the identity-flow slices of **A11/A12**. Leaves for later chain steps: A1 (full six-tool surface + hello exclusion), A2–A4, A8 (other four tools), A9/A10 (R10 hello-retirement migrations incl. `test/harness.test.ts` and `test/fakes/fake-gateway.ts`), server rename to `rio-demo`.

## Completion Report

```
Task: DA2.1 — verify_identity + reset_password identity flow
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <cmd → outcome, one line each>
Spec 02 acceptance verified: A5 <p/f>, A6 <p/f>, A7 <p/f>, A11/A12 slice <p/f>
Full-suite count: <n> passed (expected 368); KF-1 invoked: <no | yes, isolated re-run green>
Deviations from plan: <none | list — pre-declared: intermediate containment/>=4 assertion forms in
  test/mcp-server.test.ts and test/tools.test.ts pending the R10 chain step>
New interfaces exposed: VERIFICATION_TOKEN_REGEX; verify_identity + reset_password registrations;
  static-tool log lines (verifiedWith / tokenValid)
Notes for ledger: <≤3 lines>
```

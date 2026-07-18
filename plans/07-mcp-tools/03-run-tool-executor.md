# T07.3 — runTool: the never-throws tool executor

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Add `runTool(client, name, argsJson)` to `src/tools.ts` — parses the gateway's JSON-string arguments, calls `callTool` with a 5 s timeout, and ALWAYS resolves to a `function-call-output` string (isError, thrown transport errors, and empty-args all handled), so a tool failure can never kill a call (FR-7).

**Wave:** C · **Depends on:** T07.2 · **Blocks:** T07.4, T05

**References:**
- `docs/specs/07-mcp-server-and-tool-loop.md` — R9 (full contract + verbatim `runTool` snippet + rationale for `{"error": ...}` JSON), A5
- `docs/findings/05-mcp-sdk-streamable-http.md` — §C9 (`callTool` shape + timeout option), §C10 (isError subtlety), §Wire behavior reference (exact `isError` texts: bad args → `MCP error -32602: Input validation error: ...`; unknown tool → `MCP error -32602: Tool nope not found`), gotchas 5–6
- `docs/specs/01-scaffolding-and-toolchain.md` — R7 (test conventions)
- `plans/07-mcp-tools/02-mcp-client-and-tool-defs.md` — Produces (`createMcpClient`, the `src/tools.test.ts` harness this task extends)

## Interfaces

**Consumes:** `createMcpClient(port)` (T07.2); live `mcpRoutes` server from T07.1 as test fixture.

**Produces (in `src/tools.ts`):**
- `export async function runTool(client: Client, name: string, argsJson: string): Promise<string>` — resolves to `JSON.stringify(result)` on success or `JSON.stringify({ error: <message> })` on any failure; never rejects. Uses `callTool({ name, arguments }, undefined, { timeout: 5000 })`.

## Steps

- [ ] Extend `src/tools.test.ts` with a `describe('runTool', ...)` block reusing the live-server + client fixture from T07.2. Test cases (A5 plus the transport layer):
  - `runTool(client, 'hello', '{"name": 42}')` resolves (does not reject); `JSON.parse(result).error` is a string starting `MCP error -32602: Input validation error:` (bad args → isError path)
  - `runTool(client, 'nope', '{}')` resolves; parsed `.error` equals `MCP error -32602: Tool nope not found` (unknown tool)
  - `runTool(client, 'get_current_time', '')` resolves to a success JSON: parsed value has `content[0].text` matching the ISO-8601 pattern and NO `error` key (empty-string args guard → `{}`)
  - same for `argsJson === '   '` (whitespace-only) and `'{}'`
  - `runTool(client, 'hello', '{"name":"Ada"}')` success: parsed `content[0].text === 'Hello, Ada!'`
  - transport failure: create a second Fastify+`mcpRoutes` server on an ephemeral port, connect a second client, `await app2.close()`, then `runTool(client2, 'hello', '{}')` resolves (does not reject) to a string whose parsed `.error` is a non-empty string (fetch/McpError path)
- [ ] Run `npx tsx --test src/tools.test.ts` — expect FAIL (runTool not exported yet).
- [ ] Implement `runTool` in `src/tools.ts` using the Spec 07 R9 verified snippet **verbatim**. Rules re-checked: `JSON.parse` only after the empty/whitespace guard; check `result.isError` and join content text into `JSON.stringify({ error: msg })` (never throw); whole body wrapped in try/catch synthesizing `{ error: message }`; `options.timeout: 5000` as the THIRD `callTool` argument (SDK default 60 s breaks the M3 1.5 s budget).
- [ ] Run `npx tsx --test src/tools.test.ts` — expect PASS. Confirm the process exits cleanly with no unhandled-rejection warning in the output.
- [ ] Run `npm test` and `npm run typecheck` — expect both exit 0.
- [ ] Commit with message:
  `feat(tools): never-throws runTool executor with isError and transport guards`
  including the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 07 **A5** (never-throws unit tests, all three failure classes + empty-args guard). Supplies the mechanism behind **A9** (spoken apology — the `{"error": ...}` output string); A9's live verbal check runs at M3 (T05/T10). The 5 s timeout satisfies R9's budget rule (asserted by code inspection; no slow-tool fixture is required for this PoC).

## Completion Report

```
Task: T07.3 — runTool executor
Status: [complete | blocked: reason]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec A-numbers verified: [A5 + evidence pointer]
Deviations from plan: [none | list]
New interfaces exposed: runTool(client, name, argsJson) in src/tools.ts
Notes for ledger: [anything surprising]
```

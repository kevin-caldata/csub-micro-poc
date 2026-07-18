# T07.2 — Per-call MCP client + fetchToolDefs realtime mapping

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Create `src/tools.ts` with the per-call MCP client lifecycle (`createMcpClient`/`closeMcpClient`) and `fetchToolDefs` — the `listTools()` → realtime `session-update.tools` mapping with `$schema` stripping and explicit field selection.

**Wave:** C · **Depends on:** T07.1 · **Blocks:** T07.3, T07.4, T05

**References:**
- `docs/specs/07-mcp-server-and-tool-loop.md` — R1 (import paths), R7 (per-call client, verbatim `createMcpClient` snippet, `127.0.0.1` not `localhost`), R8 (mapping rules + verbatim `fetchToolDefs` snippet + `RealtimeToolDef`), A4
- `docs/findings/05-mcp-sdk-streamable-http.md` — §C7 (client lifecycle, `ct.sessionId === undefined` is correct), §C8 (`listTools()` shape, draft-07 `inputSchema`), §Client side (verified snippet), gotcha 4 (never spread; `execution` leak)
- `docs/findings/02-ai-sdk-realtime-event-protocol.md` — §Session config (`RealtimeModelV4ToolDefinition` target shape)
- `docs/specs/01-scaffolding-and-toolchain.md` — R7 (test conventions), R1 (`.js` extensions)
- `plans/07-mcp-tools/01-mcp-server-routes.md` — Produces (uses `mcpRoutes` to stand up a real server in tests)

## Interfaces

**Consumes:**
- `mcpRoutes(app: FastifyInstance): Promise<void>` from `src/mcp-server.ts` (T07.1)
- `Client` from `@modelcontextprotocol/sdk/client/index.js`; `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js` (Spec 07 R1 canonical deep imports)

**Produces (in `src/tools.ts`):**
- `export interface RealtimeToolDef { type: 'function'; name: string; description?: string; parameters: Record<string, unknown>; }`
- `export async function createMcpClient(port: number): Promise<Client>` — connects to `http://127.0.0.1:${port}/mcp`
- `export async function closeMcpClient(client: Client): Promise<void>` — thin wrapper over `await client.close()` (Spec 05 teardown calls this once per call)
- `export async function fetchToolDefs(client: Client): Promise<RealtimeToolDef[]>`
- `src/tools.test.ts` (shared by T07.3, which appends to it)

## Steps

- [ ] Write `src/tools.test.ts` (`node:test` + `node:assert/strict` per Spec 01 R7; plain Node environment — assert `globalThis.window === undefined` once at top, the G6 guard). Setup in `before()`: Fastify app with `mcpRoutes`, `await app.listen({ port: 0, host: '127.0.0.1' })`, then `client = await createMcpClient(port)`. Teardown in `after()`: `await closeMcpClient(client); await app.close()`. Test cases for this task (A4, all asserting on `await fetchToolDefs(client)`):
  - returns exactly 2 defs; every entry has `type === 'function'`
  - JSON.stringify of the whole result contains none of: `$schema`, `execution`, `title`, `annotations`, `_meta`
  - the `get_current_time` entry's `parameters` deep-equals `{ type: 'object', properties: {} }`
  - the `hello` entry's `parameters.properties.name` deep-equals `{ type: 'string', description: 'Name to greet' }` and `parameters` has no `required` array
  - `createMcpClient` connects without throwing (the stateless server leaves `transport.sessionId` undefined — do not assert a session id exists)
- [ ] Run `npx tsx --test src/tools.test.ts` — expect FAIL (module does not exist yet).
- [ ] Implement `src/tools.ts` per Spec 07 R7 + R8 using the two verified snippets **verbatim** (add `closeMcpClient` as the one-line wrapper). Rules re-checked: imports only via the R1 canonical deep paths; URL uses `127.0.0.1`; mapping selects exactly `{ type, name, description, parameters }` — **never spread** the tool object; destructure-drop `$schema` from `inputSchema`; pass no-arg `{"type":"object","properties":{}}` through unchanged.
- [ ] Run `npx tsx --test src/tools.test.ts` — expect PASS.
- [ ] Run `npm test` and `npm run typecheck` — expect both exit 0.
- [ ] Commit with message:
  `feat(tools): per-call MCP client and fetchToolDefs realtime mapping`
  including the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 07 **A4** (in-process unit test, node environment). Provides the FR-5 per-call `listTools()` path Spec 05 invokes before `session-update` (Spec 07 R8 last paragraph — the call site itself is T05's).

## Completion Report

```
Task: T07.2 — MCP client + tool-def mapping
Status: [complete | blocked: reason]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec A-numbers verified: [A4 + evidence pointer]
Deviations from plan: [none | list]
New interfaces exposed: RealtimeToolDef, createMcpClient(port), closeMcpClient(client), fetchToolDefs(client) in src/tools.ts
Notes for ledger: [anything surprising]
```

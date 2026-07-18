# T07.1 — Stateless MCP server at POST /mcp + 405 guards + route registration

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Serve a stateless streamable-HTTP MCP server exposing `get_current_time` and `hello` at `POST /mcp` on the one Fastify process, with app-level `GET`/`DELETE` 405 handlers, registered inside `server.ts`'s marked route-registration section.

**Wave:** C · **Depends on:** T01, T02 · **Blocks:** T07.2, T07.3, T07.4, T05

**References:**
- `docs/specs/07-mcp-server-and-tool-loop.md` — R1 (imports/pins), R2 (per-request instances), R3 (handler contract + verbatim implementation), R4 (405 routes), R5 (tool definitions), R6 (no DNS-rebinding hardening), A1–A3, A7
- `docs/findings/05-mcp-sdk-streamable-http.md` — §C4 (stateless enforcement), §C5 (405 app-level), §C6 (Fastify wiring), §Implementation-grade detail / Server side (the verified snippet), §Wire behavior reference (exact status codes/bodies), gotchas 1–3, 7–10
- `docs/specs/02-http-server-and-twiml-webhook.md` — R6 (the `// --- route registration (Specs 03/07) ---` marker in `src/server.ts`)
- `docs/specs/01-scaffolding-and-toolchain.md` — R7 (test runner: `node:test` via `tsx --test`, files `src/<name>.test.ts`), R12 (`logEvent` boundary in `src/logger.ts`)

## Interfaces

**Consumes:**
- `src/server.ts` (T02) — the marked section `// --- route registration (Specs 03/07) ---`; Fastify app is `Fastify({ logger: false, trustProxy: true })`
- `logEvent(fields: LogFields): void` from `src/logger.ts` (T01 stub / T08 final — same signature)
- Pins from T01 `package.json`: `@modelcontextprotocol/sdk@1.29.0` (exact), `zod@3.25.76` (exact)

**Produces:**
- `src/mcp-server.ts` exporting:
  - `buildMcpServer(): McpServer` — the ONLY place tools are registered (FR-5)
  - `mcpRoutes(app: FastifyInstance): Promise<void>` — registers `POST /mcp`, `GET /mcp` 405, `DELETE /mcp` 405
- One line added inside `src/server.ts`'s route-registration marker: `await mcpRoutes(app);` (plus its import with explicit `.js` extension)
- `src/mcp-server.test.ts`

## Steps

- [ ] Verify pins: run `npm ls @modelcontextprotocol/sdk zod` — expect exactly `1.29.0` and `3.25.76`. If wrong, fix `package.json` per Spec 07 Deliverables (Spec 01 R2 owns the pin) and re-run `npm install`. Ignore any `@cfworker/json-schema` peer warning (Spec 07 R1).
- [ ] Write `src/mcp-server.test.ts` (Node's `node:test` + `node:assert/strict` per Spec 01 R7 — vitest is NOT installed until T10; Spec 07 A4's "vitest" is satisfied by either runner per master plan risk R-1). The test file: builds a Fastify instance with `logger: false`, calls `await mcpRoutes(app)`, `await app.listen({ port: 0, host: '127.0.0.1' })`, reads the bound port, and uses Node 22 global `fetch`. Test cases (expected results are all pinned in findings/05 §Wire behavior reference):
  - `tools/list` POST with headers `Content-Type: application/json` and `Accept: application/json, text/event-stream` → 200, `content-type` starts `application/json`, result lists exactly two tools named `get_current_time` and `hello` (A1)
  - `tools/call` of `hello` with `{"arguments":{"name":"Ada"}}` → 200, content text `Hello, Ada!`; `tools/call` of `get_current_time` with `{"arguments":{}}` → text matching `/^\d{4}-\d{2}-\d{2}T.*\(.+\)$/` (ISO-8601 + IANA tz)
  - two sequential POSTs then two concurrent POSTs (`Promise.all`) all 200 — and no response body ever contains `Stateless transport cannot be reused` (A2)
  - `GET /mcp` and `DELETE /mcp` → status 405, body deep-equals `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}` (A3)
  - POST without the `Accept` pair → 406; POST with `Content-Type: text/plain` → 415 (A1 sanity)
  - teardown: `await app.close()` in `after()`
- [ ] Run `npx tsx --test src/mcp-server.test.ts` — expect FAIL (module does not exist yet).
- [ ] Implement `src/mcp-server.ts` using the verified implementation in Spec 07 R3 **verbatim** (same snippet as findings/05 §Implementation-grade detail / Server side), adapting only the logger import to `import { logEvent } from './logger.js'`. Constraints re-checked against R1–R5: deep imports only from `@modelcontextprotocol/sdk/...` paths ending `.js`; `reply.hijack()` first; fresh `McpServer` + fresh `StreamableHTTPServerTransport` per request; `{ sessionIdGenerator: undefined, enableJsonResponse: true }`; `transport.handleRequest(request.raw, reply.raw, request.body)` with the parsedBody third arg; `reply.raw.on('close', ...)` cleanup; 500 error path guarded by `headersSent`; `get_current_time` config has NO `inputSchema` key; `hello` `inputSchema` is a zod RAW SHAPE (never `z.object(...)`); keep the `// FR-5:` comment; do NOT enable `enableDnsRebindingProtection` (R6); never use deprecated `server.tool(...)`.
- [ ] Run `npx tsx --test src/mcp-server.test.ts` — expect PASS (all cases green).
- [ ] Edit `src/server.ts`: add `import { mcpRoutes } from './mcp-server.js';` at top and exactly one line `await mcpRoutes(app);` INSIDE the marked section `// --- route registration (Specs 03/07) ---` (Spec 02 R6). Touch nothing else in the file — T03 edits the same section in parallel; the orchestrator merges.
- [ ] Boot smoke (cross-platform, from repo root): run `npm run build` (expect exit 0, `dist/mcp-server.js` emitted, no `dist/*.test.js`), then start with dummy env (PowerShell: `$env:AI_GATEWAY_API_KEY='x'; $env:TWILIO_AUTH_TOKEN='y'; $env:PUBLIC_HOST='localhost'; npm start` / POSIX: `AI_GATEWAY_API_KEY=x TWILIO_AUTH_TOKEN=y PUBLIC_HOST=localhost npm start`) and in a second shell run the A1 curl from Spec 07 A1 against `http://127.0.0.1:3000/mcp` — expect 200 JSON listing the two tools. Stop the server.
- [ ] Run `npm test` and `npm run typecheck` — expect both exit 0 (no regression in existing suites).
- [ ] Commit all changes with message:
  `feat(mcp): stateless streamable-HTTP MCP server at POST /mcp with 405 guards`
  including the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 07 **A1**, **A2**, **A3** (test + curl evidence). Establishes the **A7** mechanism (single-`registerTool` extension point + `// FR-5:` comment); A7's live add-a-tool/redeploy check is executed at M3 (T10). A6/A9/A10-live are deferred to T05/T10.

## Completion Report

```
Task: T07.1 — MCP server routes
Status: [complete | blocked: reason]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec A-numbers verified: [A1/A2/A3 + evidence pointer]
Deviations from plan: [none | list]
New interfaces exposed: buildMcpServer(), mcpRoutes(app) in src/mcp-server.ts; server.ts marker line added
Notes for ledger: [pin status, marker-merge note for T03, anything surprising]
```

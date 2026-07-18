# Findings 05 — MCP TypeScript SDK 1.29.0: stateless streamable HTTP server + in-process client

**Date:** 2026-07-18
**Author:** research agent (Claude)
**Scope:** BRD §5.1 (package pin, zod peer, v2 trap), §5.7 (MCP server + client wiring, tool loop), §5.8 (`POST /mcp` route). Verified against the **published tarball of `@modelcontextprotocol/sdk@1.29.0`** installed into a scratchpad (`.../scratchpad/mcp-sdk/node_modules/@modelcontextprotocol/sdk`), the **shipped official examples** inside that tarball, the official docs at modelcontextprotocol.io, npm registry metadata, and — most importantly — a **working runtime spike**: Fastify 5.10.0 + stateless `StreamableHTTPServerTransport` + in-process `Client` over `127.0.0.1`, exercising `listTools`, `callTool`, error paths, 405s, and both SSE and JSON response modes. All spike outputs reproduced verbatim below.

---

## Verified claims

### C1. `@modelcontextprotocol/sdk@1.29.0` is the current stable v1 monopackage — **VERIFIED**
- `npm view @modelcontextprotocol/sdk dist-tags` → `{ latest: '1.29.0' }` (checked 2026-07-18). Published 2026-03-30. Engines: `node >= 18`.
- Highest version on the registry for the monopackage. BRD's exact pin is correct and safe.

### C2. zod peer dependency — **VERIFIED with correction**
- Actual peer range is **`zod: '^3.25 || ^4.0'`** (not just `^3.25` as BRD §5.1 implies). zod 4 is equally supported; the SDK has a full dual-version compat layer (`dist/esm/server/zod-compat.js`).
- There is a **second peer**: `@cfworker/json-schema: '^4.1.1'` marked **`peerDependenciesMeta: { optional: true }`** — you do NOT need to install it. The default JSON-Schema validator is `ajv` (a hard dependency). Ignore npm peer warnings about it if any appear.
- Spike ran on `zod@3.25.76` — everything works. Note: zod 3.25+ also ships `zod/v4` as a subpath (the SDK's own shipped examples do `import * as z from 'zod/v4'` while depending on zod 3.x). Pinning `zod@^3.25` per BRD is fine.

### C3. `registerTool` takes a **zod raw shape** for `inputSchema` — **VERIFIED (and slightly broader)**
Exact signature from `dist/esm/server/mcp.d.ts` (lines 150–157):

```ts
registerTool<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
>(name: string, config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;      // raw shape OR full zod schema — see below
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
}, cb: ToolCallback<InputArgs>): RegisteredTool;
```

Where (from `zod-compat.d.ts`):

```ts
type AnySchema = z3.ZodTypeAny | z4.$ZodType;           // a full zod schema, e.g. z.object({...})
type ZodRawShapeCompat = Record<string, AnySchema>;      // a RAW SHAPE: plain object of zod schemas
```

**What "raw shape" means, exactly:** the *argument to* `z.object()`, not the result of calling it.

```ts
// RAW SHAPE — canonical, what the BRD and official docs/examples use:
inputSchema: { name: z.string().optional().describe('Name to greet') }

// NOT this (though 1.29.0 also accepts it — see nuance):
inputSchema: z.object({ name: z.string().optional() })
```

Nuance vs BRD: in 1.29.0 `inputSchema` accepts **either** a raw shape **or** an already-constructed schema (`normalizeObjectSchema()` in `zod-compat.js` handles both; `getZodSchemaObject()` in `mcp.js` throws `'inputSchema must be a Zod schema or raw shape, received an unrecognized object'` for anything else). The raw-shape form is what the official build-server tutorial teaches (`npm install @modelcontextprotocol/sdk zod@3`, `registerTool("get_alerts", { description, inputSchema: { state: z.string().length(2)... } }, async ({ state }) => ...)`) — use it. The handler receives **parsed, validated, typed args** as its first parameter (`ShapeOutput<Shape>`), plus an `extra` second parameter (`RequestHandlerExtra` — carries `sessionId`, `authInfo`, abort signal). Tools with **no** `inputSchema` get a handler called as `(extra) => ...` (no args parameter).

- The deprecated `server.tool(...)` overloads still exist but are marked `@deprecated Use registerTool instead` — don't use them.

### C4. Stateless `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, new transport + server per request, cleanup on `res.close`) — **VERIFIED, and per-request instances are runtime-ENFORCED**
- Constructor: `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` → stateless mode: no `mcp-session-id` header in any response, no session validation at all (`validateSession()` short-circuits to "ok" when `sessionIdGenerator === undefined` — `webStandardStreamableHttp.js` line ~585).
- **Reuse guard (new-ish, important):** `handleRequest` throws `Error('Stateless transport cannot be reused across requests. Create a new transport per request.')` if a stateless transport handles a second request (`webStandardStreamableHttp.js` lines 137–142). So "new transport + new McpServer per request" is not merely a recommendation — the SDK enforces it.
- The **shipped official stateless example** (`dist/esm/examples/server/simpleStatelessStreamableHttp.js`, in the tarball) does exactly the BRD pattern: per-POST `getServer()` + `new StreamableHTTPServerTransport({sessionIdGenerator: undefined})` + `await server.connect(transport)` + `await transport.handleRequest(req, res, req.body)` + `res.on('close', () => { transport.close(); server.close(); })`.
- **Architecture note (changed since older 1.x):** in 1.29.0 `StreamableHTTPServerTransport` is a thin Node wrapper around `WebStandardStreamableHTTPServerTransport`, converting via `@hono/node-server`'s `getRequestListener` (`overrideGlobalObjects: false`). Consequences: the SDK now hard-depends on `hono`, `@hono/node-server`, and `express` (for an optional `createMcpExpressApp` helper) — harmless extra node_modules alongside Fastify; and `handleRequest(req, res, parsedBody)` accepts Node `IncomingMessage`/`ServerResponse` directly, which is exactly what Fastify's `request.raw`/`reply.raw` are.

### C5. "405 for GET/DELETE" is **app-level code you must write**, not transport behavior — **VERIFIED (BRD clarification)**
The transport itself, even stateless, would *serve* a GET (opens a standalone SSE notification stream, requires `Accept: text/event-stream`, else 406) and a DELETE (calls `close()` and returns 200 — no session check in stateless mode). The **official stateless example explicitly registers its own GET and DELETE handlers returning 405** with body `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}` — because in stateless mode a GET SSE stream is useless (the transport dies at end of request) and DELETE session-termination is meaningless. Do the same in Fastify (snippet below). Runtime spike confirmed: GET → 405, DELETE → 405. (The transport does return 405 itself for PUT/PATCH/etc. via `handleUnsupportedRequest`.)

### C6. Fastify 5 wiring via `request.raw` / `reply.raw` + parsed body — **VERIFIED BY RUNTIME SPIKE**
- Fastify 5.10.0 parses `application/json` bodies by default; **pass `request.body` as the third argument** to `handleRequest`. This is essential: `handlePostRequest` only skips `await req.json()` when `parsedBody !== undefined`; without it, the hono-converted web `Request` would try to re-read a body stream Fastify already consumed (hang/parse-error). **No custom content-type parser is needed** — the "content-type parser issue" the BRD asks about does not exist as long as `request.body` is forwarded.
- `transport.handleRequest(request.raw, reply.raw, request.body)` writes the entire response (status, headers, SSE or JSON body) directly to `reply.raw`. Spike ran this both **with and without `reply.hijack()`** — both work with **zero warnings/errors** on fastify@5.10.0 (verified with a warn-level logger capture). Recommendation: call **`reply.hijack()`** before touching `reply.raw` anyway — it is Fastify's documented contract for "I'm taking over the raw response," prevents any future Fastify lifecycle interference (onSend hooks, double-send detection). Note hijacked requests skip Fastify's response logging.
- POST requirements enforced by the transport (spike-confirmed): request must have `Content-Type: application/json` (else 415) and `Accept` containing **both** `application/json` **and** `text/event-stream` (else 406, `-32000 Not Acceptable`). `StreamableHTTPClientTransport` sends the right headers automatically — this only bites hand-rolled curl tests.
- Response mode: by default a POST containing a JSON-RPC *request* is answered as **SSE** (`Content-Type: text/event-stream`, one `event: message` frame with the JSON-RPC response, then stream close). With `enableJsonResponse: true` in the transport options you get plain `application/json` responses instead — spike verified both modes work identically through the client. For this PoC either is fine; JSON mode makes curl debugging nicer and shaves the SSE framing.

### C7. In-process `Client` + `StreamableHTTPClientTransport` against localhost — **VERIFIED BY RUNTIME SPIKE**
- `new Client({ name, version })` → `await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+PORT+'/mcp')))`. `connect()` performs the `initialize` POST + `notifications/initialized` POST (202) automatically. Against the stateless server this "session-spanning" handshake works fine because every POST hits a fresh transport and stateless mode skips session validation. Measured: **cold connect 28 ms; warm connect+listTools 5 ms; callTool 1 ms** on localhost — consistent with the BRD's "single-digit ms localhost hop" latency budget (§5.7).
- `ct.sessionId` is `undefined` in stateless mode (server never issues one).
- Client transport options (`StreamableHTTPClientTransportOptions`): `authProvider?`, `requestInit?`, `fetch?`, `reconnectionOptions?`, `sessionId?` — none needed for localhost.

### C8. `listTools()` return shape — **VERIFIED BY RUNTIME SPIKE**; `inputSchema` is JSON Schema draft-07, directly mappable to realtime `parameters`
Actual spike output (zod 3 path — SDK converts via vendored `zod-to-json-schema`, target draft-7, `strictUnions: true`, `pipeStrategy: 'input'`; zod 4 schemas would go through `z4mini.toJSONSchema`):

```json
{
  "tools": [
    {
      "name": "get_current_time",
      "description": "Returns the current time in ISO format with timezone.",
      "inputSchema": { "type": "object", "properties": {} },
      "execution": { "taskSupport": "forbidden" }
    },
    {
      "name": "hello",
      "description": "Say hello to someone.",
      "inputSchema": {
        "type": "object",
        "properties": { "name": { "type": "string", "description": "Name to greet" } },
        "additionalProperties": false,
        "$schema": "http://json-schema.org/draft-07/schema#"
      },
      "execution": { "taskSupport": "forbidden" }
    }
  ]
}
```

Mapping notes for `session-update.tools` (BRD §5.3 `parameters: JSONSchema7`):
- **Yes, directly mappable** — it *is* JSON Schema draft-07. Map explicitly: `{ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }`.
- **Do not spread the whole tool object** — 1.29.0 adds an `execution: { taskSupport: 'forbidden' }` field (and possibly `title`, `annotations`, `_meta`) that the gateway/OpenAI does not expect.
- Tools with **no** `inputSchema` come back as `{ "type": "object", "properties": {} }` (the SDK's `EMPTY_OBJECT_JSON_SCHEMA`) — valid as-is for realtime `parameters`.
- Tools **with** a zod shape additionally carry `"$schema": "http://json-schema.org/draft-07/schema#"` and `"additionalProperties": false`. `$schema` is legal JSONSchema7 and typically tolerated by OpenAI, but it's noise — safest is to `delete` the `$schema` key when mapping (one line): `const { $schema, ...parameters } = t.inputSchema;`
- Optional zod fields (`z.string().optional()`) simply appear in `properties` without being listed in `required` (no `required` array is emitted when nothing is required). `.describe()` becomes `"description"`.

### C9. `callTool({name, arguments})` call + result shape — **VERIFIED BY RUNTIME SPIKE**
- Signature (`client/index.d.ts` line 431): `callTool(params: CallToolRequest['params'], resultSchema?, options?: RequestOptions)`. Params: `{ name: string, arguments?: Record<string, unknown> }` — note the key is **`arguments`** (an object, NOT a JSON string — `JSON.parse` the gateway's `function-call-arguments-done.arguments` string first, exactly as BRD §5.7 says).
- Success result: `{ content: [{ type: 'text', text: '...' }] }` — spike-confirmed verbatim (`{"content":[{"type":"text","text":"Hello, Kevin!"}]}`). `content` entries can also be `image`/`audio`/`resource` types; `structuredContent` appears only if the tool declares `outputSchema`. For the gateway's `function-call-output.output` field, `JSON.stringify(result)` (whole result) or `result.content.map(c=>c.text).join('\n')` both work; BRD's `JSON.stringify(result)` is fine.
- `options.timeout` (ms, default 60000) is available on every request via `RequestOptions` if you want a tighter tool-call ceiling.

### C10. Error handling / `isError` — **VERIFIED BY RUNTIME SPIKE**, with an important subtlety
All three failure classes below return **normally** from `callTool()` with `isError: true` — **`callTool` does NOT throw** for them (server converts in its `CallToolRequestSchema` handler, `mcp.js` ~line 135: any thrown error → `createToolError(message)`):

1. Handler throws: `{"content":[{"type":"text","text":"boom: deliberate failure"}],"isError":true}`
2. Bad arguments (zod validation): `{"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool hello: [...zod issues...]"}],"isError":true}`
3. Unknown tool name: `{"content":[{"type":"text","text":"MCP error -32602: Tool nope not found"}],"isError":true}`

So the bridge's tool loop must **check `result.isError`** and still send a `function-call-output` describing the failure (BRD §5.7's requirement — the shape above makes that trivial: the text content IS the error message). `callTool` *can* still throw `McpError`/network errors for transport-level failures (server down, malformed response, output-schema mismatch) — wrap in try/catch and synthesize an error output there too.

### C11. The v2.0.0-beta split-package trap — **VERIFIED, worse than BRD states**
- `@modelcontextprotocol/server` and `@modelcontextprotocol/client` exist on npm at **2.0.0-beta.4**, and their **`latest` dist-tag points at the beta** (`npm view @modelcontextprotocol/server dist-tags` → `{ latest: '2.0.0-beta.4', beta: '2.0.0-beta.4' }`). A naive `npm install @modelcontextprotocol/server` silently gets a beta.
- The v2 server package **requires `zod: ^4.2.0`** (hard dependency) — incompatible with this project's `zod@^3.25` pin, and its API differs. Depends on `@modelcontextprotocol/core@2.0.0-beta.4`.
- Rule for the build agent: **only ever `@modelcontextprotocol/sdk@1.29.0`** (save-exact); if any import path starts with `@modelcontextprotocol/server` or `@modelcontextprotocol/client` (no `/sdk`), it's the wrong package. The official build-server tutorial (fetched 2026-07-18) still teaches the v1 monopackage: `npm install @modelcontextprotocol/sdk zod@3`.

### C12. Import paths / module format — **VERIFIED**
Package exports: `.`, `./client`, `./server`, `./validation`, `./validation/ajv`, `./validation/cfworker`, `./experimental`, `./experimental/tasks`, and a catch-all `./*` mapping into `dist/esm` (with `dist/cjs` for require). The canonical deep imports (all spike-tested):

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
```

Works under Node 22 ESM and TS `moduleResolution: node16/nodenext/bundler`. (A `WebStandardStreamableHTTPServerTransport` also exists at `server/webStandardStreamableHttp.js` for non-Node runtimes — not needed here.)

---

## Implementation-grade detail

### Server side — `src/mcp-server.ts` (Fastify 5 plugin, verified working end-to-end)

```ts
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** Fresh McpServer per request (stateless mode requires it — SDK throws on reuse). */
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'hello-world', version: '1.0.0' });

  // Tool 1: no args → config has no inputSchema; handler signature is (extra) => ...
  server.registerTool(
    'get_current_time',
    { description: 'Returns the current server time as ISO-8601 plus IANA timezone.' },
    async () => ({
      content: [{
        type: 'text' as const,
        text: `${new Date().toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
      }],
    }),
  );

  // Tool 2: zod RAW SHAPE (plain object of zod schemas — NOT z.object(...)).
  // Handler's first arg is the parsed+typed args object.
  server.registerTool(
    'hello',
    {
      description: 'Say a friendly hello.',
      inputSchema: { name: z.string().optional().describe('Name to greet') },
    },
    async ({ name }) => ({
      content: [{ type: 'text' as const, text: `Hello, ${name ?? 'world'}!` }],
    }),
  );
  // FR-5: adding a tool = one more registerTool call here. Nothing else changes.
  return server;
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', async (request, reply) => {
    // Take over the raw response; the transport writes status/headers/body itself.
    reply.hijack();
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,     // stateless
      enableJsonResponse: true,          // optional: plain JSON instead of SSE framing
    });
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      // Fastify already parsed the JSON body — MUST forward it as parsedBody.
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null,
        }));
      }
    }
  });

  // Stateless server: no GET SSE stream, no DELETE session termination (official example pattern).
  const notAllowed = async (_req: unknown, reply: any) =>
    reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
```

Transport options actually available (`WebStandardStreamableHTTPServerTransportOptions`): `sessionIdGenerator?: () => string` · `enableJsonResponse?: boolean` (default false = SSE) · `eventStore?` (resumability; irrelevant stateless) · `allowedHosts?: string[]` · `allowedOrigins?: string[]` · `enableDnsRebindingProtection?: boolean` (default **false**) · `retryInterval?: number` · `onsessioninitialized`/`onsessionclosed` (stateful only).

### Client side — `src/tools.ts` (per-call, verified working)

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface RealtimeToolDef {
  type: 'function'; name: string; description?: string; parameters: Record<string, unknown>;
}

export async function createMcpClient(port: number): Promise<Client> {
  const client = new Client({ name: 'voice-bridge', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );
  return client; // measured: ~5 ms warm (init POST + initialized POST), well off the audio path
}

/** listTools → gateway session-update.tools. Explicit field mapping; never spread. */
export async function fetchToolDefs(client: Client): Promise<RealtimeToolDef[]> {
  const { tools } = await client.listTools();
  return tools.map(t => {
    const { $schema: _drop, ...parameters } = t.inputSchema as Record<string, unknown>;
    return { type: 'function' as const, name: t.name, description: t.description, parameters };
  });
}

/** function-call-arguments-done → tool output string for conversation-item-create. */
export async function runTool(client: Client, name: string, argsJson: string): Promise<string> {
  try {
    const args = argsJson ? JSON.parse(argsJson) : {};
    const result = await client.callTool({ name, arguments: args }); // arguments is an OBJECT
    if (result.isError) {
      // Server-side tool failure (throw / bad args / unknown tool) — surfaced here, NOT thrown.
      const msg = (result.content as Array<{ type: string; text?: string }>)
        .map(c => c.text ?? '').join('\n');
      return JSON.stringify({ error: msg || 'tool failed' });
    }
    return JSON.stringify(result); // {content:[{type:'text',text:...}]}
  } catch (err) {
    // Transport/protocol-level failure (McpError, fetch error) — also never kill the call.
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
```

Lifecycle: create the `Client` at call start (BRD §5.7), `await client.close()` on call teardown (`stop` event / hangup). One client per call is cheap (5 ms) and keeps FR-3 isolation trivial; a process-wide singleton would also work but gains nothing.

### Wire behavior reference (spike-observed, exact)

| Interaction | Result |
|---|---|
| `client.connect()` vs stateless server | `initialize` POST → 200; `notifications/initialized` POST → 202; `ct.sessionId === undefined` |
| POST tools/list, default mode | 200, `Content-Type: text/event-stream`, body `event: message\ndata: {"result":{...},"jsonrpc":"2.0","id":N}\n\n`, stream closes |
| POST tools/list, `enableJsonResponse: true` | 200, `Content-Type: application/json`, bare JSON-RPC response |
| POST missing `Accept` pair | 406 `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}` |
| POST wrong content-type | 415 (`-32000`) |
| POST body only notifications/responses | 202, empty body |
| GET/DELETE (our Fastify handlers) | 405 `-32000 Method not allowed.` |
| PUT/PATCH (transport itself) | 405 via `handleUnsupportedRequest` |
| callTool success | `{ content: [{ type:'text', text:'...' }] }` |
| handler throws `Error('boom')` | `{ content:[{type:'text',text:'boom: deliberate failure'}], isError:true }` — returned, not thrown |
| bad args | `isError:true`, text `MCP error -32602: Input validation error: Invalid arguments for tool hello: [...zod issue JSON...]` |
| unknown tool | `isError:true`, text `MCP error -32602: Tool nope not found` |

---

## Gotchas & pitfalls

1. **Stateless transport reuse throws.** `'Stateless transport cannot be reused across requests. Create a new transport per request.'` Never hoist the transport (or the connected `McpServer`) out of the request handler. A `McpServer` binds to exactly one transport via `connect()` — fresh pairs per POST, always.
2. **Forgetting `parsedBody` with Fastify hangs/400s the request.** Fastify consumes the body stream; the transport's fallback `req.json()` (through the hono conversion) cannot re-read it. Always `transport.handleRequest(request.raw, reply.raw, request.body)`.
3. **`reply.hijack()`** — empirically optional on fastify@5.10.0 (spike ran clean without it, warn-level logging enabled), but it is the documented Fastify contract for raw-response takeover. Use it; be aware hijacked requests skip Fastify's own response logging (§5.9 logging should log MCP requests inside the handler if wanted).
4. **Don't spread `listTools()` tool objects into gateway tool definitions.** 1.29.0 adds `execution: {taskSupport:'forbidden'}`; `title`/`annotations`/`_meta` may also appear. Pick `name`/`description`/`inputSchema` explicitly and strip `$schema`.
5. **`callTool` does not throw on tool failure** — check `result.isError`. Treating only exceptions as failures will feed the model "successful" outputs containing error text with no framing. Both layers (isError + try/catch) must produce a `function-call-output`, per BRD FR-7/§5.7.
6. **`arguments` is an object, not a string.** The gateway's `function-call-arguments-done.arguments` is a JSON *string*; `JSON.parse` before `callTool`. Guard the empty-string case (no-arg calls sometimes deliver `""` or `"{}"`).
7. **v2 split packages have `latest` = 2.0.0-beta.4** (`@modelcontextprotocol/server` / `client` / `core`, zod ^4.2.0 required). Any such import is a build error waiting to happen with zod 3 pinned. Only `@modelcontextprotocol/sdk@1.29.0`.
8. **Optional peer `@cfworker/json-schema`** may produce an npm peer warning — ignore; ajv is the default validator and is a hard dep.
9. **`/mcp` is publicly reachable on the Railway domain** (the bridge's client uses 127.0.0.1, but the route itself is exposed). For hello-world tools the risk is negligible (BRD scopes auth out), but a one-line hardening exists if wanted: `enableDnsRebindingProtection: true, allowedHosts: ['127.0.0.1:'+PORT, 'localhost:'+PORT]` → external requests arriving with `Host: <railway-domain>` get 403 (`Invalid Host header`), in-process localhost calls pass. (Host check is exact string match including port — `webStandardStreamableHttp.js` lines 109–128.) Decide at build time; not required by BRD.
10. **SSE default response mode** means curl testing of `POST /mcp` needs `-H 'Accept: application/json, text/event-stream'` and returns `event:`/`data:` framing. Set `enableJsonResponse: true` for saner manual debugging (client behavior identical either way — verified).
11. **Zod error text leaks into `isError` content** (full zod issue JSON). Fine for a PoC (the model just apologizes), but it's what the model will hear about — another reason tool schemas should stay tiny.
12. Node engines `>=18`; Node 22 per BRD is fine (spike ran on v22.14.0).

## Open questions (need runtime spike)

- **None for the MCP leg itself** — server, client, listTools mapping, callTool, error paths, 405s, Fastify wiring, and both response modes were all executed successfully in-process on 2026-07-18 (fastify@5.10.0, zod@3.25.76, Node 22.14.0, Windows; Linux/Railway behavior should be identical for this stack but M1 confirms in situ).
- Whether the **gateway/OpenAI accepts `$schema` inside `tools[].parameters`** — belongs to the gateway leg (findings doc for §5.2/§5.3); stripping `$schema` as specified above makes the question moot.
- GC/alloc churn of per-request `McpServer` instances under sustained load — irrelevant at ≤5 concurrent calls × ~1 tool call/turn, noted only for completeness.
- The `allowedHosts` hardening (gotcha 9) was reasoned from source, not spike-tested behind Railway's proxy — verify at M4 if adopted.

## Sources

- `@modelcontextprotocol/sdk@1.29.0` published tarball (primary evidence), installed at `C:\Users\kevin\AppData\Local\Temp\claude\D--projects-linean-CSUB-RIO-POC\2b673856-d2e2-4653-a80a-85f159b53749\scratchpad\mcp-sdk\node_modules\@modelcontextprotocol\sdk` — key files: `dist/esm/server/mcp.d.ts` + `mcp.js` (registerTool, tools/list JSON-Schema emission, createToolError), `dist/esm/server/zod-compat.d.ts` (AnySchema/ZodRawShapeCompat), `dist/esm/server/zod-json-schema-compat.js` (draft-07 conversion), `dist/esm/server/streamableHttp.{d.ts,js}` (Node wrapper), `dist/esm/server/webStandardStreamableHttp.js` (stateless guard, 406/415/405, session/host validation), `dist/esm/client/index.{d.ts,js}` (listTools/callTool), `dist/esm/client/streamableHttp.d.ts` (client transport options), `dist/esm/examples/server/simpleStatelessStreamableHttp.js` (official stateless pattern incl. app-level 405s and `res.on('close')` cleanup).
- Runtime spikes (executed 2026-07-18): `scratchpad\mcp-sdk\spike.mjs` (Fastify 5 + stateless server + client end-to-end, SSE mode, error paths, raw HTTP probes, timings) and `spike2.mjs` (`reply.hijack()` + `enableJsonResponse: true` + 406 probe + Fastify log capture); fastify@5.10.0, zod@3.25.76, Node v22.14.0.
- npm registry (2026-07-18): `npm view @modelcontextprotocol/sdk` (latest=1.29.0, peers `zod ^3.25 || ^4.0` + optional `@cfworker/json-schema ^4.1.1`, engines node>=18, deps incl. hono/@hono/node-server/express/ajv/zod-to-json-schema); `npm view @modelcontextprotocol/server` and `.../client` (latest=2.0.0-beta.4, zod ^4.2.0).
- Official docs: https://modelcontextprotocol.io/docs/develop/build-server (TypeScript tab: `npm install @modelcontextprotocol/sdk zod@3`, `registerTool` with raw-shape `inputSchema`, fetched 2026-07-18).

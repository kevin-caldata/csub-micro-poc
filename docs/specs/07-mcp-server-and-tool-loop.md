# Spec 07 — Hello-World MCP Server + Bridge-Side MCP Client and the Tool-Call Loop

Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Draft for review
Depends on: 01 (scaffold/toolchain/config — `"type":"module"`, `moduleResolution: nodenext`, pinned `package.json`), 02 (Fastify server boot — plugin registration, `PORT`) · Enables: 05 (session orchestration — consumes `tools.ts` API and the tool-loop state machine), 08 (logging — consumes the `tool-call` event line)
Findings referenced: findings/05 (entire doc — C1–C12, server/client snippets, wire-behavior table, gotchas 1–12), findings/04 (G7 tool-flow race, V5 VAD defaults, D3/D4 session state, D1 mapping table), findings/02 (vendored protocol: client/server event unions, `RealtimeModelV4FunctionCallOutput`, gotcha 5), findings/09 (§2 `ToolTiming`, §4 tool round-trip decomposition, §5 log-line design), findings/10 (C11, C12, C13, T6, T7, G7 stack-table note; spikes S11, S12, S16, S29)

---

## Objective

When this spec is done, the one Fastify process serves a stateless streamable-HTTP MCP server at `POST /mcp` exposing two hello-world tools (`get_current_time`, `hello`), and the bridge owns a per-call MCP client plus a complete, race-safe tool-call loop: `function-call-arguments-done` → localhost `callTool` → `conversation-item-create {function-call-output}` → double-gated single `response-create`. Adding a tool is exactly one `registerTool` call with zero bridge changes (FR-5). Every tool round trip emits one instrumented `tool-call` log line with `mcpMs` / `gateWaitMs` / `secondTtfbMs` / `toolTotalMs` (FR-6, M3).

## Deliverables

- `src/mcp-server.ts` — Fastify plugin: `POST /mcp` (stateless MCP), app-level `GET /mcp` + `DELETE /mcp` 405 handlers, `buildMcpServer()` with the two `registerTool` calls.
- `src/tools.ts` — per-call MCP client (`createMcpClient`, `closeMcpClient` via `client.close()`), `fetchToolDefs()` (listTools → realtime tool mapping), `runTool()` (never-throws tool executor), and `ToolLoop` (the per-call tool-call state machine with the double gate, consumed by `session.ts`).
- Modify `package.json` — ensure `@modelcontextprotocol/sdk` is pinned **exactly `1.29.0`** (`save-exact`) and `zod` pinned **exactly `3.25.76`** (the version findings/05's runtime spike executed against; satisfies the SDK peer `^3.25 || ^4.0` — Spec 01 R2 owns the pin) [findings/05 C1, C2; findings/10 C13].
- (Consumed by Spec 05, not created here: `session.ts` wires `ToolLoop` into its gateway event switch and calls `fetchToolDefs` for `session-update.tools`.)

## Requirements

### Packages and imports

**R1.** Use only the v1 monopackage `@modelcontextprotocol/sdk@1.29.0` (exact pin). Any import path beginning `@modelcontextprotocol/server` or `@modelcontextprotocol/client` (no `/sdk`) is a build error — those are the v2.0.0-beta.4 split packages whose `latest` dist-tag points at the beta and which hard-require `zod ^4.2.0`, incompatible with this repo's `zod@3.25.76` pin [findings/05 C11, gotcha 7]. Ignore any npm peer warning about the optional peer `@cfworker/json-schema` — `ajv` is the default validator and a hard dep [findings/05 C2, gotcha 8]. Canonical deep imports (all spike-tested; explicit `.js` extensions, valid under Node 22 ESM + `moduleResolution: nodenext`) [findings/05 C12]:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
```

### Server side — `src/mcp-server.ts`

**R2.** `POST /mcp` must create a **fresh `McpServer` + fresh `StreamableHTTPServerTransport` per request**. This is runtime-**enforced**, not stylistic: a stateless transport handling a second request throws `Error('Stateless transport cannot be reused across requests. Create a new transport per request.')` [findings/05 C4]. Transport options: `{ sessionIdGenerator: undefined, enableJsonResponse: true }`. `sessionIdGenerator: undefined` selects stateless mode (no `mcp-session-id` header, no session validation). `enableJsonResponse: true` returns plain `application/json` instead of SSE framing — client behavior is identical in both modes (spike-verified); JSON mode is chosen for curl debuggability [findings/05 C6, gotcha 10].

**R3.** Handler contract (all spike-verified) [findings/05 C6, gotchas 2–3; findings/10 T6]:
1. Call `reply.hijack()` at handler entry, **before** `server.connect(transport)` and before anything touches `reply.raw` (T6: hijack-before-connect and hijack-after-connect both work; this spec fixes hijack-first as the single chosen order). Hijacked requests skip Fastify's own response logging — log MCP requests inside the handler if wanted.
2. `await server.connect(transport)`.
3. `await transport.handleRequest(request.raw, reply.raw, request.body)` — the third `parsedBody` argument is **mandatory**: Fastify has already consumed the body stream; omitting it makes the hono-converted web `Request` try to re-read it (hang/parse error). No custom content-type parser is needed [findings/05 gotcha 2].
4. Cleanup: `reply.raw.on('close', () => { void transport.close(); void server.close(); })`.
5. Error path: wrap steps 2–3 in try/catch; on error, log and, only `if (!reply.raw.headersSent)`, write `500` with body `{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal server error"},"id":null}`.

Use this verified implementation verbatim (adapt only the logger import) [findings/05 §Implementation-grade detail, server side]:

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
      enableJsonResponse: true,          // plain JSON instead of SSE framing
    });
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      // Fastify already parsed the JSON body — MUST forward it as parsedBody.
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      logEvent({ level: 'error', message: 'mcp request failed', event: 'mcp-error', err: String(err) }); // shared logger — Fastify runs logger:false (Spec 08 R3)
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

**R4.** The `GET /mcp` and `DELETE /mcp` 405 routes above are **app-level code this spec must write** — not transport behavior. Without them the stateless transport would serve GET as a useless SSE stream (dies at end of request) and DELETE as close+200. Response body exactly `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}`, status 405 (official stateless example pattern; spike-confirmed) [findings/05 C5; findings/10 C12]. PUT/PATCH etc. get 405 from the transport itself (`handleUnsupportedRequest`) — no extra routes needed.

**R5.** Tool definitions per BRD §5.7 / FR-4:
- `get_current_time`: **no `inputSchema` key at all** in the config (SDK then advertises `{"type":"object","properties":{}}`, its `EMPTY_OBJECT_JSON_SCHEMA`); handler signature is `(extra) => ...` — no args parameter [findings/05 C3, C8]. Returns `{content:[{type:'text', text: '<ISO-8601> (<IANA timezone>)'}]}`.
- `hello`: `inputSchema` is a **zod raw shape** — the argument *to* `z.object()`, i.e. `{ name: z.string().optional().describe('Name to greet') }`, never `z.object({...})` (1.29.0 tolerates a full schema, but raw shape is the canonical/tutorial pattern this repo standardizes on) [findings/05 C3]. Handler receives parsed, validated, typed args as its first parameter. Returns a friendly greeting.
- Do **not** use the deprecated `server.tool(...)` overloads [findings/05 C3].
- FR-5 mechanism: the `buildMcpServer()` body is the **only** place a new tool touches. Keep the `// FR-5:` comment in the file. No tool names, schemas, or dispatch tables may appear anywhere in `tools.ts`, `session.ts`, or config.

**R6.** DNS-rebinding/`allowedHosts` hardening (`enableDnsRebindingProtection: true, allowedHosts: [...]`) is **not enabled** for the PoC — `/mcp` stays publicly reachable on the Railway domain with hello-world tools only (risk accepted; BRD scopes auth out) [findings/05 gotcha 9]. Behavior behind Railway's proxy is untested (S29); revisit only if tools ever do more than hello-world.

### Client side — `src/tools.ts`

**R7.** Per-call client lifecycle [findings/05 C7; findings/10 T7]: create a fresh `Client` at call start (Twilio `start` message handling in Spec 05), close it at call teardown (`stop`/hangup) via `await client.close()`. Measured cost: cold connect 28 ms, warm connect+listTools 5 ms, callTool 1 ms on localhost — well off the audio path. `connect()` performs the `initialize` POST (200) + `notifications/initialized` POST (202) automatically; against the stateless server `ct.sessionId` stays `undefined` — this is correct, not a bug. Use `127.0.0.1` (not `localhost`) in the URL, matching the verified spike:

```ts
export async function createMcpClient(port: number): Promise<Client> {
  const client = new Client({ name: 'voice-bridge', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );
  return client;
}
```

**R8.** `fetchToolDefs(client)` — `listTools()` → `session-update.tools` mapping with the **mandatory adjustments** [findings/05 C8, gotcha 4; findings/10 C11]:
- **Never spread** the tool object: 1.29.0 tools carry `execution: { taskSupport: 'forbidden' }` (and possibly `title`, `annotations`, `_meta`) which the gateway/OpenAI does not expect. Select exactly `{ type: 'function', name: t.name, description: t.description, parameters }`.
- **Strip the `$schema` key** from `inputSchema` (zod-shaped tools carry `"$schema":"http://json-schema.org/draft-07/schema#"`): `const { $schema: _drop, ...parameters } = t.inputSchema as Record<string, unknown>;` — stripping makes the "does the gateway tolerate `$schema`" question moot [findings/05 open questions].
- No-arg tools arrive as `{"type":"object","properties":{}}` — valid as-is for realtime `parameters`; pass through unchanged.
- Target type matches the vendored protocol `RealtimeModelV4ToolDefinition` (`{type:'function'; name; description?; parameters: JSONSchema7}`) [findings/02 §Session config].

```ts
export interface RealtimeToolDef {
  type: 'function'; name: string; description?: string; parameters: Record<string, unknown>;
}

/** listTools → gateway session-update.tools. Explicit field mapping; never spread. */
export async function fetchToolDefs(client: Client): Promise<RealtimeToolDef[]> {
  const { tools } = await client.listTools();
  return tools.map(t => {
    const { $schema: _drop, ...parameters } = t.inputSchema as Record<string, unknown>;
    return { type: 'function' as const, name: t.name, description: t.description, parameters };
  });
}
```

Spec 05 calls `fetchToolDefs` once per call, before sending `session-update` (per-call `listTools()` is the FR-5 extension mechanism — BRD §5.7).

**R9.** `runTool(client, name, argsJson)` — the never-throws executor [findings/05 C9, C10, gotchas 5–6]:
- The gateway delivers `function-call-arguments-done.arguments` as a **JSON string**; `callTool` takes `{ name, arguments: <object> }` — `JSON.parse` first. Guard the empty case: no-arg calls sometimes deliver `""` or `"{}"` → treat empty/whitespace string as `{}`.
- `callTool` does **NOT throw for tool failures**. All three failure classes return normally with `isError: true` (handler throws → error text; bad args → `MCP error -32602: Input validation error: ...`; unknown tool → `MCP error -32602: Tool <x> not found`). Check `result.isError` and convert to `JSON.stringify({ error: <joined content text> })`.
- `callTool` **can** still throw `McpError`/fetch errors for transport-level failures (server down, malformed response) — wrap the whole body in try/catch and synthesize `JSON.stringify({ error: message })` there too. Both layers must yield a `function-call-output` string; a tool failure must never kill the call (FR-7).
- Pass `options.timeout: 5000` (third `callTool` argument, `RequestOptions`; SDK default 60000 ms is far beyond the M3 1.5 s budget — a hung tool becomes a spoken apology within 5 s, not a 60 s stall) [findings/05 C9].

```ts
/** function-call-arguments-done → tool output string for conversation-item-create. */
export async function runTool(client: Client, name: string, argsJson: string): Promise<string> {
  try {
    const args = argsJson && argsJson.trim() ? JSON.parse(argsJson) : {};
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
    if (result.isError) {
      // Server-side tool failure (throw / bad args / unknown tool) — surfaced here, NOT thrown.
      const msg = (result.content as Array<{ type: string; text?: string }>)
        .map(c => c.text ?? '').join('\n');
      return JSON.stringify({ error: msg || 'tool failed' });
    }
    return JSON.stringify(result); // {content:[{type:'text',text:...}]}
  } catch (err) {
    // Transport/protocol-level failure (McpError, fetch error, timeout) — never kill the call.
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
```

The error-describing JSON is deliberate: the model reads `{"error": ...}` in the function-call output and apologizes verbally (BRD §5.7 "call never dies silently"; supported by the `INSTRUCTIONS` prompt owned by Spec 04 R8).

### The tool-call loop (per-call state machine, exported from `tools.ts`, wired by Spec 05)

**R10.** Export a `ToolLoop` class (or equivalent factory) instantiated per `Session` with injected dependencies `{ client: Client, gwSend: (ev: ClientEvent) => Promise<void>, log }`. It owns this state (extends BRD §5.8 / findings/04 D3):

```ts
interface PendingToolCall {
  callId: string; name: string;
  outputSent: boolean;
  timing: ToolTiming;              // R13
}
interface ToolLoopState {
  pendingToolCalls: Map<string, PendingToolCall>;  // keyed by callId
  toolResponseIds: Set<string>;    // responseIds that contained ≥1 function call
  toolResponseDone: boolean;       // response-done seen for every toolResponseId
  followupCreateSent: boolean;     // the single gated response-create fired
  awaitingFollowup: boolean;       // next response-created/first audio-delta belongs to the tool follow-up
}
```

**R11.** Event handling (normalized event names from the vendored protocol [findings/02 §Server → client events]):

1. **`function-call-arguments-done` `{responseId, itemId, callId, name, arguments}`** (`arguments` is a complete JSON string): record `pendingToolCalls.set(callId, {...})`, stamp `tArgsDone = performance.now()`, add `responseId` to `toolResponseIds`, then asynchronously: `output = await runTool(client, name, arguments)` → stamp `tToolResolved` → send

   ```ts
   await gwSend({ type: 'conversation-item-create', item: {
     type: 'function-call-output', callId, name, output } });
   ```

   → stamp `tOutputSent`, set `outputSent = true`, then call `tryReleaseGate()`. **Include `name`** in the item even though optional — harmless for OpenAI, required by some providers, keeps the bridge provider-neutral [findings/02 gotcha 5]. Multiple function calls in one response are supported: each gets its own pending entry and output; the gate still fires exactly once.
2. **`function-call-arguments-delta`**: ignore (no accumulation needed — the `-done` event carries the complete JSON string) [findings/02 §Server events; findings/10 C9].
3. **`response-done` `{responseId, status}`**: if `responseId ∈ toolResponseIds`, set `toolResponseDone = true` (log `status` — `'cancelled'` here means barge-in/VAD interrupted the tool-bearing response; still proceed). In all cases call `tryReleaseGate()` — this is also the deferred-retry path when the gate previously blocked on an active response.
4. **`response-created` / `audio-delta`**: Spec 05 maintains `responseActive` (`response-created` seen, `response-done` not yet — findings/04 D3/D4) and exposes it to `ToolLoop`. When `awaitingFollowup` is set, the first `audio-delta` of the next new `responseId` stamps `tFollowupFirstDelta` and triggers the `tool-call` log line + clears the loop state for the turn (lazy attach by responseId change — do not assume `response-created` arrives first through the gateway; S16).

**R12.** `tryReleaseGate()` — **the double gate** (BRD §5.7 gate is necessary but NOT sufficient [findings/04 G7]). Send **exactly one** `response-create` iff ALL of:
- (a) `toolResponseDone === true` — `response-done` received for every tool-bearing response;
- (b) every entry in `pendingToolCalls` has `outputSent === true`;
- (c) `session.responseActive === false` at send time — because server-VAD's `create_response` default is `true` (and not overridable through the normalized config [findings/04 V5, V12]), the caller speaking right after the tool call auto-spawns a response; firing our `response-create` while it is active produces a `conversation_already_has_active_response`-class error;
- (d) `followupCreateSent === false` (idempotence guard).

On send: set `followupCreateSent = true`, `awaitingFollowup = true`, stamp `tResponseCreateSent` on every pending timing. If (c) fails, do nothing — the next `response-done` re-invokes `tryReleaseGate()` (deferral, never a timer). The model does **not** speak after tool results without this `response-create` (BRD §5.3), and it must never be sent more than once per tool-bearing response. If the auto-created response intervened (a VAD response ran between `tOutputSent` and gate release), still send the single gated `response-create` and log `autoResponseIntervened: true` on the `tool-call` line — whether this ever double-speaks is observed at runtime (S11/S12 log data) rather than pre-optimized. If a `conversation_already_has_active_response`-class `error` event arrives anyway (lost race), log it with `.raw` (exact gateway `code` string pinned at S11), treat as benign, reset `followupCreateSent = false`, and let the next `response-done` retry.

**R13.** Latency instrumentation (FR-6/M3) [findings/09 §2 `ToolTiming`, §4]:

```ts
interface ToolTiming {
  callId: string; name: string;
  tArgsDone: number;               // 'function-call-arguments-done' arrival
  tToolResolved?: number;          // runTool promise resolved
  tOutputSent?: number;            // conversation-item-create sent
  tResponseCreateSent?: number;    // the gated response-create sent
  tFollowupFirstDelta?: number;    // first audio-delta of the follow-up responseId
}
```

All stamps via `performance.now()` (monotonic — never `Date.now()` deltas [findings/09 §1]). On `tFollowupFirstDelta`, emit ONE single-line `tool-call` log per tool call with flat top-level numeric fields (Railway `@attr` filters need flat fields [findings/09 §5]):
- `mcpMs = tToolResolved − tArgsDone` (localhost MCP hop; expect single-digit ms)
- `gateWaitMs = tResponseCreateSent − tOutputSent` (time spent waiting on the double gate)
- `secondTtfbMs = tFollowupFirstDelta − tResponseCreateSent` (second model inference — the dominant term)
- `toolTotalMs = tFollowupFirstDelta − tArgsDone` (M3 acceptance number, target < 1500)

Example line shape [findings/09 §5]: `{"message":"tool get_current_time round trip","level":"info","ts":"...","callSid":"CAxxxx","event":"tool-call","turn":5,"tool":"get_current_time","callId":"call_1","mcpMs":4.2,"gateWaitMs":112.0,"secondTtfbMs":540.8,"toolTotalMs":688.3}`. Round deltas to 1 decimal. Never log per `function-call-arguments-delta`.

**R14.** Teardown: on Twilio `stop`/hangup, Spec 05 calls `toolLoop.dispose()` → abandon unresolved `runTool` promises (their `gwSend` must no-op if the gateway WS is closed) and `await client.close()`. No state leaks between calls (`Map<streamSid, Session>` isolation — FR-3 falls out structurally).

## Acceptance criteria

- **A1** (server basics): `curl -X POST http://127.0.0.1:$PORT/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'` returns 200 `Content-Type: application/json` with exactly two tools, `get_current_time` and `hello`. A missing `Accept` pair returns 406 (`-32000 Not Acceptable`); wrong content-type returns 415 (transport behavior, sanity only) [findings/05 wire table].
- **A2** (stateless correctness): two sequential POSTs and two concurrent POSTs to `/mcp` all succeed — no `'Stateless transport cannot be reused'` error ever appears (fresh instances per request).
- **A3** (405 routes): `GET /mcp` and `DELETE /mcp` both return status 405 with body exactly `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}`.
- **A4** (mapping): `fetchToolDefs()` output contains no `$schema`, no `execution`, no `title`/`annotations`/`_meta` keys anywhere; `get_current_time.parameters` deep-equals `{"type":"object","properties":{}}`; `hello.parameters.properties.name` is `{type:'string', description:'Name to greet'}` with no `required` array; every entry has `type:'function'`. Verifiable with an in-process unit test (vitest, node environment — never jsdom [findings/10 G6]).
- **A5** (never-throws): unit tests — `runTool(client, 'hello', '{"name": 42}')` resolves (does not reject) to a JSON string parsing to `{error: "MCP error -32602: Input validation error: ..."}`; `runTool(client, 'nope', '{}')` resolves to `{error: "MCP error -32602: Tool nope not found"}`; `runTool(client, 'get_current_time', '')` resolves to a success JSON (empty-string args guard).
- **A6** (FR-4 / M3): live call — ask "what time is it"; the model verbally acknowledges ("one moment…"), the log shows one `event:"tool-call"` line for `get_current_time`, and the model speaks the current time. `toolTotalMs < 1500` in that line (M3 acceptance); `mcpMs < 50`.
- **A7** (FR-5): add a third tool (e.g. `echo`) as exactly one `registerTool` call in `buildMcpServer()`, change nothing else, redeploy — the tool is callable on the next call. `git diff` touches only `src/mcp-server.ts`.
- **A8** (double gate): at most one `response-create` is sent per tool-bearing response, verified by log inspection, including the race test: barge in / speak immediately while the tool executes — no unhandled `error` event, no double `response-create`; any `create-while-active` error is logged as benign with its `.raw` and the gateway `code` recorded (feeds S11).
- **A9** (spoken apology, FR-7): temporarily make a tool handler throw — the model apologizes verbally on the call; the call continues and the next turn works; the `function-call-output` sent contains `{"error": ...}`.
- **A10** (instrumentation): the `tool-call` line carries flat numeric `mcpMs`, `gateWaitMs`, `secondTtfbMs`, `toolTotalMs` fields; `@event:tool-call AND @toolTotalMs:>1500` is a working Railway Log Explorer query (subject to S33).
- **A11** (teardown): after hangup mid-tool-execution, no unhandled promise rejection and no send on a closed WS is logged; `client.close()` runs once per call.

## Out of scope

- `session.ts` itself: gateway WS lifecycle, `session-update` assembly/ordering, greeting, barge-in, `responseActive` bookkeeping (Specs 04/05), and the instructions text (the "briefly say you're checking" masking prompt lives in Spec 04 R8's `INSTRUCTIONS` per BRD §5.7) — this spec only defines the `ToolLoop` contract Spec 05 wires in.
- Twilio leg, DSP/audio formats, logger implementation (`logger.ts` — Spec 08; this spec only emits through it).
- `/mcp` auth, `allowedHosts` hardening (decision recorded in R6), stateful/session-ful MCP, SSE response mode, resumability/`eventStore`.
- Hosted/OpenAI-side MCP through the gateway — definitively not expressible (`tools` accepts only `{type:'function'}` definitions); bridge-executed function tools are the design [findings/10 G7-note; findings/02 §ToolDefinition].
- Turn-level (non-tool) latency instrumentation (`ttfbMs`, `bridgeMs`, `turn` lines) — Spec 05/08.

## Open items deferred to runtime spikes (findings/10 Part 4)

- **S11** — exact gateway `error.code` strings for create-while-active (and cancel/truncate errors): needed to turn the R12 benign-error handling from message-class matching into an exact-code whitelist. Log `.raw` on every `error` event at M1/M2 and pin.
- **S12** — actual `response-done.status` values through the gateway (is the tool-bearing response's status `'completed'` vs `'cancelled'` after barge-in?): informs whether the R12 "still send after cancelled" decision ever double-speaks.
- **S16** — whether `response-created` reliably precedes that response's first `audio-delta` through the gateway: the R11.4 lazy responseId-attach for `tFollowupFirstDelta` is the specified fallback either way.
- **S29** — `allowedHosts`/DNS-rebinding behavior behind Railway's proxy: only if the R6 no-hardening decision is ever reversed.
- **S33** — Railway Log Explorer numeric/attribute filtering on the first deployed build (gates A10's query check).
- MCP leg itself has **no** open spikes — server, client, listTools mapping, callTool, error paths, 405s, and Fastify wiring were all executed successfully on 2026-07-18 [findings/05 §Open questions].

# Findings 08 — Fastify 5 + ws Server Architecture for the Bridge Process

**Date:** 2026-07-18
**Scope:** How one Fastify 5 + Node 22 process serves `POST /twiml`, `POST /mcp`, `GET /health`, and the `WS /twilio-media` upgrade; `@fastify/websocket` vs raw `ws` upgrade handling; Twilio signature validation body/URL requirements; running MCP `StreamableHTTPServerTransport` under Fastify; graceful shutdown/drain wiring; `ws@8` client options for the gateway leg; error/close-code handling for both WS legs.

**Method:** Exact-version packages installed into a scratchpad (`fastify@5.10.0`, `@fastify/websocket@11.3.0`, `@fastify/formbody@8.0.2`, `ws@8.21.1`, `twilio@6.0.2`, `@modelcontextprotocol/sdk@1.29.0`), source read directly, plus a **runtime smoke test** (`smoke.js`) that exercised every claim end-to-end in one process: health route, signature-validated `/twiml` with a real computed `X-Twilio-Signature`, WS echo on `/twilio-media`, WS upgrade to a non-WS route, full MCP client→server round trip (`listTools` + `callTool`) over localhost streamable HTTP under Fastify, and `fastify.close()` with an open WS connection. All passed.

---

## Verified claims

### V1. Fastify `^5` is current; latest is 5.10.0 — VERIFIED
`npm view fastify` → `latest: 5.10.0` (dist-tags: three 3.29.5, four 4.29.1). BRD §5.1 pin `fastify ^5` is correct.

### V2. `@fastify/websocket` current major for Fastify 5 is **v11** (latest 11.3.0) — VERIFIED
- `npm view @fastify/websocket dist-tags` → `latest: 11.3.0`, `five: 5.0.1` (the `five` tag is a *legacy* tag for old Fastify — do NOT use it), `next: 11.0.0`.
- `node_modules/@fastify/websocket/index.js` ends with `fp(fastifyWebsocket, { fastify: '5.x', name: '@fastify/websocket' })` — v11 registers **only** against Fastify 5.x.
- Dependencies: `ws: ^8.16.0`, `duplexify: ^4.1.3`, `fastify-plugin: ^6.0.0`. Installed resolution in the probe: `ws@8.21.1`.

### V3. v11 handler API is `(socket, req)` where `socket` is a plain `ws` WebSocket — VERIFIED
Source (index.js line ~195): `result = wsHandler.call(this, socket, request)` where `socket` comes from `wss.handleUpgrade(...)` — i.e., a `ws.WebSocket` instance (runtime test printed `socket ctor= WebSocket`). The old `(connection, req)` API where `connection` was a Duplex stream with `.socket` is **gone** (≤ v10). Any tutorial showing `connection.socket.on('message', ...)` is stale.

### V4. `@fastify/websocket` runs `ws` in `noServer` mode and dispatches upgrades through the Fastify router — VERIFIED
Source: the plugin forces `{ noServer: true, ...opts.options }`, explicitly **errors** if you pass `noServer` yourself, warns if you pass `path`, listens on `fastify.server`'s `'upgrade'` event, wraps the raw request in a synthetic `ServerResponse`, and calls `fastify.routing(rawRequest, rawResponse)`. The route handler then calls `reply.hijack()` and `wss.handleUpgrade(...)`. Consequences:
- **All Fastify hooks (onRequest etc.) run for WS upgrade requests** before the handshake completes — usable for auth/drain gating.
- WS routes must be **GET** (`throw new Error('websocket handler can only be declared in GET method')`).
- The plugin decorates `fastify.websocketServer` (the `ws.Server`) and `request.ws` (boolean: is this an upgrade request).
- `fastify.injectWS(path, upgradeContext)` exists for in-process WS testing without a network socket.

### V5. ws server `perMessageDeflate` default is **false**; ws client default is **true** — VERIFIED
- `ws/lib/websocket-server.js`: defaults `{ ..., perMessageDeflate: false, clientTracking: true, maxPayload: 100 * 1024 * 1024, autoPong: true, closeTimeout: 30000 (CLOSE_TIMEOUT), ... }`.
- `ws/lib/websocket.js` (client `initAsClient`): defaults `{ ..., perMessageDeflate: true, followRedirects: false, maxPayload: 100MB, ... }`, and if truthy it sends a `Sec-WebSocket-Extensions: permessage-deflate` **offer** in the handshake.
- ⇒ BRD §5.1 "Disable perMessageDeflate on both" is right in spirit but the critical leg is the **gateway client leg** (defaults ON — must pass `perMessageDeflate: false`). The Twilio server leg is OFF by default; passing it explicitly in the plugin options is free documentation. The ws README explicitly warns permessage-deflate can cause "catastrophic memory fragmentation and slow performance" under concurrency on Linux.

### V6. `twilio.validateRequest(authToken, signatureHeader, url, params)` needs the **parsed form params object**, not the raw body — VERIFIED
`twilio@6.0.2` (`lib/webhooks/webhooks.js`):
```
validateRequest(authToken, twilioHeader, url, params)  // → boolean
getExpectedTwilioSignature(authToken, url, params)     // → base64 HMAC-SHA1
validateRequestWithBody(authToken, twilioHeader, url, body) // only for JSON webhooks w/ bodySHA256 query param
webhook(opts, authToken)                               // Express middleware — not usable with Fastify
```
Algorithm (source-confirmed, matches Twilio docs): sort `params` keys alphabetically, concatenate `key + value` onto the full URL string, HMAC-SHA1 with the auth token, base64, constant-time compare (`scmp`). Array values are de-duplicated, sorted, and each appended. `validateRequest` internally retries **four URL variants**: with/without explicit port × with/without legacy querystring re-encoding — so port-stripping proxies are already tolerated.
**Raw-body access is NOT needed** for Twilio's form-encoded voice webhooks. It would only matter for JSON webhooks (`bodySHA256` flow), which `/twiml` is not. Runtime test: computed a signature with `getExpectedTwilioSignature`, POSTed `application/x-www-form-urlencoded` through `@fastify/formbody`, and `validateRequest(AUTH_TOKEN, sig, url, req.body)` returned `true`.

### V7. `@fastify/formbody@8.0.2` is the right (and tiny) urlencoded parser for Fastify 5 — VERIFIED
Entire plugin is ~30 lines: `fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, ...)` using `fast-querystring.parse`. Registers via `fastify-plugin` with `fastify: '5.x'`. Latest is 8.0.2. Duplicate form keys parse to arrays, which `validateRequest` handles (V6).

### V8. MCP `StreamableHTTPServerTransport` runs under Fastify with `handleRequest(req.raw, reply.raw, req.body)` — no content-parser surgery needed — VERIFIED (runtime)
`@modelcontextprotocol/sdk@1.29.0` `dist/cjs/server/streamableHttp.d.ts`:
```ts
handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void>
```
The optional third `parsedBody` argument means **Fastify's default JSON body parsing is fine as-is** — pass `request.body` straight through; the transport only reads the raw stream when `parsedBody` is undefined. Do **not** remove Fastify's JSON content-type parser for this route. You DO need `reply.hijack()` because the transport writes directly to the `ServerResponse`. Runtime test: stateless mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), new `McpServer` + transport per request, `reply.raw.on('close', ...)` cleanup — a real `StreamableHTTPClientTransport` client completed `initialize` → `listTools` → `callTool` against it over localhost. `registerTool` with a zod raw shape (`{ name: z.string().optional() }`) produced draft-07 JSON Schema in `listTools` output, confirming BRD §5.7's tool-definition mapping.
Note: in 1.29.0 this class is a **wrapper** over `WebStandardStreamableHTTPServerTransport` converting Node req/res via `@hono/node-server`. Options type: `sessionIdGenerator?`, `enableJsonResponse?` (default false = SSE), `onsessioninitialized?`, `onsessionclosed?`, `eventStore?`, deprecated DNS-rebinding options.

### V9. `fastify.close()` immediately closes ALL active WS connections (via the plugin's `preClose` hook) — VERIFIED (runtime)
Source `defaultPreClose`: iterates `websocketServer.clients` calling `client.close()` (no code ⇒ empty close frame ⇒ **peer observes code 1005**), removes the `'upgrade'` listener, calls `wss.close(done)` *and* `done()` synchronously (a quirk — it does not actually wait for close handshakes). Runtime: with one WS open, `await app.close()` resolved in **2 ms** and the client got `{"code":1005,"reason":""}`. ⇒ **Never call `fastify.close()` while calls are live if you want them to drain** — drain first, then close (see implementation section). Overridable via the plugin's `preClose` option.

### V10. Fastify 5 `forceCloseConnections` defaults to `'idle'` on Node ≥18 — VERIFIED
`fastify/lib/server.js`: if not a boolean, `forceCloseConnections = serverHasCloseIdleConnections ? 'idle' : false`. During `close()`, after `preClose` hooks, it calls `server.closeIdleConnections()` (keep-alive HTTP sockets) — upgraded WS sockets were already closed by the plugin's preClose before this point.

### V11. Upgrade requests to routes without a WS handler complete the handshake and are then immediately closed — VERIFIED (runtime)
The plugin overrides **every** route handler; a WS upgrade to a non-WS route reaches `noHandle` → logs → `socket.close()`. Runtime: client to `/health` saw `open` then `close 1005`. Upgrades to **unregistered paths** get Fastify's 404 through the synthetic ServerResponse, and the plugin's `onResponse` hook destroys the raw socket (client sees `Unexpected server response: 404`). This is the mechanism that also makes **hook-based rejection** work: any hook that replies (401/503) to a `request.ws === true` request results in a non-101 HTTP response then socket destroy — clean refusal, usable for drain gating.

### V12. ws@8 client: protocols array → `Sec-WebSocket-Protocol`, custom headers supported, subprotocol charset fits the gateway's auth-in-protocol scheme — VERIFIED
- Constructor: `new WebSocket(address, protocols?, options?)`. Protocols are validated against `/^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/` (no duplicates) and joined into one `Sec-WebSocket-Protocol` header. The BRD's gateway protocols `['ai-gateway-realtime.v1', 'ai-gateway-auth.<vcst_token>']` pass this regex as long as the token is base64url-ish (`-` `_` `.` `+` allowed; `/` and `=` are NOT — base64url tokens don't contain them).
- Client options (source JSDoc + code): `perMessageDeflate` (default **true** — set `false`), `headers` (merged into the handshake request), `origin`, `handshakeTimeout` (ms; maps to request timeout — **no default**, set one, e.g. 5000), `followRedirects` (default false), `maxRedirects` 10, `maxPayload` 100 MB, `closeTimeout` 30000 (forcibly destroys socket if close handshake stalls), `autoPong` true, `finishRequest` (last-chance request mutation), `protocolVersion` 13, plus all `http(s).request`/TLS options. After connect, ws verifies the server-selected subprotocol is one it offered, else aborts the handshake.
- On abnormal handshake responses the client emits `'error'` with `Unexpected server response: <status>` and never `'open'`.

### V13. `bufferedAmount` and send callback semantics — VERIFIED
`ws/lib/websocket.js`: `get bufferedAmount() { return this._socket._writableState.length + this._sender._bufferedBytes }` — bytes queued but not yet handed to the OS. `ws.send(data, [options], [callback])` — callback fires when data is flushed to the socket or errors. Valid close codes you may *send*: 1000–1014 excluding 1004/1005/1006, plus 3000–4999 (`validation.js isValidStatusCode`); `close()` with no code sends an empty close frame (peer sees 1005). `'close'` listener signature: `(code: number, reason: Buffer)` — **reason is a Buffer**, call `.toString()`.

### V14. ws server has no automatic keepalive; heartbeat is DIY — VERIFIED
README documents the canonical `isAlive`/`ws.ping()` interval pattern. `autoPong: true` (default, both sides) answers incoming pings automatically. For this PoC, both legs carry ~20 ms media frames continuously (Twilio sends silence frames even when the caller is quiet), so application traffic keeps NAT/proxies warm; a heartbeat is belt-and-braces for the gateway leg only (see snippets).

### V15. BRD claims in this domain — all consistent
BRD §5.1 (`fastify ^5`, `ws ^8`, disable perMessageDeflate), §5.7 (stateless transport per request, close both on `res.close`, 405 for GET/DELETE), §5.8 (route table, Session map), §7.6 (SIGTERM drain) all check out against source + runtime. Refinements, not corrections: (a) perMessageDeflate is only default-ON on the client leg (V5); (b) raw-body access is a non-issue for Twilio validation (V6); (c) `fastify.close()` is call-severing unless you drain first (V9); (d) `twilio` latest is **6.0.2** and `validateRequest`'s signature is unchanged from v4/v5.

---

## Recommendation: use `@fastify/websocket@11`, not a raw `upgrade` listener

| | `@fastify/websocket` v11 | raw `wss = new ws.Server({noServer:true})` + `fastify.server.on('upgrade')` |
|---|---|---|
| Routing | Fastify router; hooks run pre-handshake (auth, drain-gate, logging) | Manual `req.url` parsing; must `socket.destroy()` unknown paths yourself |
| Cleanup | `preClose` auto-closes clients + removes listener on `fastify.close()`; overridable | Entirely manual; easy to leak the upgrade listener or half-open sockets |
| Error surface | `errorHandler(error, socket, req, reply)` option catches sync throws + rejected handler promises (default: `socket.terminate()`) | DIY |
| Testing | `fastify.injectWS()` | DIY |
| Overhead | One synthetic `ServerResponse` + router dispatch per upgrade (once per call — irrelevant vs a 5-min call) | Minimal |
| Risk | Maintained by the Fastify org, pinned to Fastify 5.x | None extra, but you re-implement the above |

**Verdict:** `@fastify/websocket@11.3.0`. The bridge accepts ~1 upgrade per call — the plugin's per-upgrade overhead is nothing, and pre-handshake hook gating is exactly what the SIGTERM drain needs. The only reason to go raw is if you needed `handleProtocols`/`verifyClient`-style handshake control on the *server* leg, which Twilio's leg does not (Twilio offers no subprotocols; auth is the `<Parameter>` token in the `start` message per BRD §5.4).

---

## Implementation-grade detail

### Server boot (src/server.ts shape)

```ts
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyWebsocket from '@fastify/websocket';

const app = Fastify({
  logger: true,          // pino; swap transport for the structured logger
  trustProxy: true,      // Railway edge terminates TLS; req.protocol/req.host honor X-Forwarded-*
});

await app.register(formbody); // application/x-www-form-urlencoded → req.body object

await app.register(fastifyWebsocket, {
  options: {
    perMessageDeflate: false,   // ws-server default is false anyway; explicit
    maxPayload: 1 * 1024 * 1024 // Twilio frames are ~200-byte JSON; 1 MB is generous
  },
  errorHandler: (err, socket, req, _reply) => {
    req.log.error({ err }, 'ws handler error');
    socket.terminate();
  },
  // preClose: custom drain (see shutdown section) — optional; default closes all clients
});

app.get('/health', async () => ({ ok: true }));
// ... routes below ...
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }); // 0.0.0.0 required on Railway
```

Registration order note: plugins are independent (formbody = content-type parser, websocket = upgrade listener); order between them doesn't matter, but **both must be registered (awaited) before the routes that use them** in the same encapsulation scope.

### POST /twiml with signature validation

```ts
import twilio from 'twilio';

app.post('/twiml', async (req, reply) => {
  // The URL Twilio signed = exactly what's configured in the console.
  // Build it deterministically from config, NOT from headers (headers work with
  // trustProxy, but config can't be spoofed and can't drift):
  const host = process.env.RAILWAY_PUBLIC_DOMAIN ?? process.env.PUBLIC_HOST!;
  const url = `https://${host}/twiml`;

  const signature = req.headers['x-twilio-signature'] as string | undefined;
  const params = req.body as Record<string, string>; // parsed by @fastify/formbody

  if (!twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN!, signature ?? '', url, params)) {
    return reply.code(403).send('invalid signature');
  }

  const token = crypto.randomUUID();              // per-call token (BRD §5.4)
  // ... stash token, kick off gateway getToken() promise keyed by CallSid ...

  reply.type('text/xml');
  return `<Response><Connect><Stream url="wss://${host}/twilio-media"><Parameter name="token" value="${token}"/></Stream></Connect></Response>`;
});
```
Facts that make this safe: `validateRequest` internally tolerates port-present/absent variants; params must be the **complete** POST form body (Fastify/formbody gives exactly that — do not add/remove keys); values are strings (Twilio sends strings). If Twilio is ever configured with a querystring on the webhook URL, the query must be included in `url` exactly as configured.

### WS /twilio-media

```ts
app.get('/twilio-media', { websocket: true }, (socket /* ws.WebSocket */, req /* FastifyRequest */) => {
  // Handshake is complete at this point (101 already sent).
  let session: Session | undefined;

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;                       // Twilio sends text JSON frames
    const msg = JSON.parse(data.toString());
    switch (msg.event) {
      case 'connected': break;                  // protocol/version info only
      case 'start':
        // Verify customParameters.token BEFORE bridging (BRD §5.4); on failure:
        //   socket.close(1008, 'bad token');  // 1008 = policy violation
        session = createSession(socket, msg.start); // streamSid, callSid, customParameters, mediaFormat
        sessions.set(msg.start.streamSid, session);
        break;
      case 'media':  session?.onTwilioMedia(msg.media); break;  // {timestamp, payload}
      case 'mark':   session?.onMark(msg.mark.name); break;
      case 'stop':   session?.endFromTwilio(); break;
    }
  });

  socket.on('close', (code: number, reason: Buffer) => {
    req.log.info({ code, reason: reason.toString() }, 'twilio ws closed');
    session?.teardown();                        // closes gateway leg, logs summary, sessions.delete
  });
  socket.on('error', (err) => { req.log.error({ err }, 'twilio ws error'); });
  // NOTE: 'close' always fires after 'error' — teardown only in 'close'.
});
```
Sending to Twilio: `socket.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }))` then the `mark` message. `socket.send` on a CLOSING/CLOSED socket does not throw — it invokes the callback with an error (or emits `'error'` if no callback); guard with `socket.readyState === WebSocket.OPEN` anyway.

### POST /mcp under Fastify (stateless, per BRD §5.7)

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

app.post('/mcp', async (req, reply) => {
  const server = buildHelloWorldMcpServer();       // new McpServer + registerTool × 2, per request
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,                 // stateless mode
    enableJsonResponse: true,                      // plain JSON responses; skips SSE framing — ideal for localhost tool calls
  });
  reply.raw.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  reply.hijack();                                  // MUST precede raw writes; Fastify stops managing the response
  await transport.handleRequest(req.raw, reply.raw, req.body);  // req.body = Fastify-parsed JSON
});

// Streamable HTTP spec: GET opens a server-notification SSE stream, DELETE ends sessions.
// Stateless server → refuse both:
const notAllowed = async (_req: any, reply: any) =>
  reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);
```
Verified behaviors: Fastify's default JSON content-type parser handles the MCP POST body; `handleRequest`'s third arg consumes it (the transport does not re-read the stream). `reply.hijack()` prevents `FST_ERR_REPLY_ALREADY_SENT`/double-send; after hijack, no onSend/onResponse hooks run for this request — the transport fully owns the response. The in-process client (`new Client(...)` + `StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+PORT+'/mcp'))`) completed `listTools`/`callTool` against exactly this setup in the smoke test; tool `inputSchema` arrives as draft-07 JSON Schema ready for `session-update.tools` mapping.

### Graceful shutdown / SIGTERM drain (Railway `drainingSeconds: 60`)

Requirements: stop new calls immediately, let active calls finish (≤ ~55 s), then close. Because the plugin's default `preClose` kills every socket the instant `fastify.close()` runs (V9), **drain before close**:

```ts
let draining = false;
const sessions = new Map<string, Session>();

// Gate BOTH new webhooks and new upgrades. Hooks run for upgrade requests (V4),
// and a non-hijacked error reply to an upgrade request destroys the socket cleanly (V11).
app.addHook('onRequest', async (req, reply) => {
  if (!draining) return;
  if (req.url.startsWith('/health')) return reply.code(503).send('draining'); // fail healthcheck
  if (req.ws || req.url.startsWith('/twiml')) return reply.code(503).send('draining');
});

process.on('SIGTERM', () => { void shutdown(); });
async function shutdown() {
  draining = true;
  const deadline = Date.now() + 55_000;                    // < Railway's 60 s SIGKILL
  while (sessions.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  for (const s of sessions.values()) s.teardown();         // any stragglers: close gateway leg,
                                                           // twilioWs.close(1001, 'shutting down')
  await app.close();  // preClose closes remaining WS (peers would see 1005), then HTTP server closes
  process.exit(0);
}
```
Notes: `Session.teardown()` must `sessions.delete(...)` (also on natural call end — the `stop` event / `close` handler path) or drain never completes. `1001` ("going away") is the semantically correct shutdown code; the plugin's default bare `close()` yields 1005 at the peer — cosmetic for Twilio, but send 1001 yourself when you control it. There is no need for a custom `preClose` if you drain first; if you'd rather encode drain inside the plugin, pass `preClose(done)` that closes clients with `client.close(1001, 'server shutdown')` and then calls `this.websocketServer.close(done)`.

### Gateway-leg ws client (per call)

```ts
import WebSocket from 'ws';

const gw = new WebSocket(cfg.url, cfg.protocols, {   // protocols: ['ai-gateway-realtime.v1', 'ai-gateway-auth.<vcst_...>']
  perMessageDeflate: false,   // client default is TRUE — must disable (V5)
  handshakeTimeout: 5000,     // no default in ws — unset means it can hang for the TCP timeout
  maxPayload: 16 * 1024 * 1024, // >> gateway 256 KB cap; default 100 MB also fine
  // headers: { ... }         // supported if ever needed; auth rides in protocols here
});

gw.on('open', () => { /* send session-update FIRST (30 s rule), then response-create */ });

gw.on('unexpected-response', (_req, res) => {        // non-101 handshake answer
  log.error({ status: res.statusCode }, 'gateway refused upgrade');
  // fall through: 'error' fires next with "Unexpected server response: <code>"
});

gw.on('error', (err) => log.error({ err }, 'gateway ws error')); // 'close' always follows

gw.on('close', (code: number, reasonBuf: Buffer) => {
  const reason = reasonBuf.toString();
  // 1000 normal · 1001 going away · 1005 empty close frame · 1006 abnormal (local synth, never on wire)
  // 1008 policy · 1011 server error · 1013 try again later · 4xxx app-specific (log raw — gateway may
  // use these for session-limit / idle-timeout / 25-min-cap signals; record empirically at M4)
  session.onGatewayClosed(code, reason);  // → spoken fallback or clean hangup (FR-7)
});

// Keepalive (belt-and-braces; media flows every ~20 ms during a call):
let alive = true;
gw.on('pong', () => { alive = true; });
const hb = setInterval(() => {
  if (gw.readyState !== WebSocket.OPEN) return;
  if (!alive) { gw.terminate(); return; }   // 'close' will fire with 1006 locally
  alive = false;
  gw.ping();                                 // gateway auto-pongs (RFC 6455 requirement)
}, 25_000);
gw.on('close', () => clearInterval(hb));
```

### Backpressure on fast producers

- **Twilio → gateway**: paced at real time (~50 frames/s, ~1.3 KB each as PCM16@24k) — cannot outrun a healthy socket. No handling needed beyond an OPEN-state guard.
- **Gateway → Twilio**: `audio-delta`s arrive *faster than real time* (model generates ahead). Twilio's WS consumes and buffers server-side (BRD §5.4: "Twilio buffers and plays in order"), so normally fine — but if the Twilio socket stalls, `ws.send()` queues unboundedly in process memory. Cheap guard, checked before each forward:

```ts
const MAX_BUFFERED = 1_000_000; // ~1 MB ≈ 25 s of μ-law audio queued locally — call is unrecoverable
if (twilioWs.bufferedAmount > MAX_BUFFERED) {
  log.warn({ buffered: twilioWs.bufferedAmount }, 'twilio leg backpressure — dropping call');
  twilioWs.close(1011, 'backpressure');
} else {
  twilioWs.send(frameJson);
}
```
`bufferedAmount` = kernel-unflushed writable bytes + sender-queued bytes (V13). Log it in the per-call summary to catch creep. Do NOT pace/queue audio-deltas yourself — forward immediately (BRD §5.3); Twilio is the pacer.

### Error/close-code handling matrix

| Leg | Event | Meaning | Action |
|---|---|---|---|
| Twilio WS | `close` 1000/1005 after `stop` | normal hangup | teardown session, close gateway leg 1000, log summary |
| Twilio WS | `close` 1006 (no `stop`) | network drop / Twilio abort | same teardown; flag abnormal in summary |
| Twilio WS | `error` | socket-level fault | log only; `'close'` always follows — teardown there (single path) |
| Twilio WS | bad `<Parameter>` token in `start` | unauthenticated stream | `socket.close(1008, 'bad token')`; never bridge |
| Gateway WS | `unexpected-response` (e.g. 401/429) | handshake refused (bad/expired vcst token, concurrency limit) | Twilio leg still up: play/speak fallback via a canned μ-law clip or just `twilioWs.close(1000)` → Twilio ends call (FR-7: never dead air) |
| Gateway WS | `error` "Unexpected server response: N" | same as above (error path) | as above; `'close'` follows |
| Gateway WS | `close` 1000/1001 mid-call | gateway ended session (25-min cap, idle) | teardown; close Twilio leg 1000 |
| Gateway WS | `close` 1006/1011/4xxx | abnormal / server fault / app-specific | log code+reason verbatim (M4 evidence), teardown both legs |
| Either | `session.error` event (in-band, BRD §5.3) | protocol-level error | log `.raw`; decide continue vs teardown per code |

One rule keeps it leak-free: **all teardown lives in each socket's `'close'` handler**, is idempotent, and each leg's teardown closes the other leg. `'error'` handlers only log (ws always emits `'close'` after `'error'`). Attach `'error'` handlers to BOTH sockets immediately — an unhandled `'error'` event crashes the process and severs every concurrent call.

---

## Gotchas & pitfalls

1. **Stale handler signature in most tutorials.** Anything showing `(connection, req)` + `connection.socket` targets `@fastify/websocket` ≤10 / Fastify 4. v11 passes the `ws` socket directly (V3). Mixing the styles produces `connection.socket is undefined` at the first message.
2. **`fastify.close()` is a call killer.** Default `preClose` closes every tracked client instantly and resolves without waiting for close handshakes (2 ms observed). Drain first (see shutdown section) — calling `app.close()` on SIGTERM directly violates the BRD's drain requirement.
3. **Client-leg perMessageDeflate is ON by default** (V5). Forgetting `perMessageDeflate: false` on the gateway `WebSocket` adds zlib contexts per call and the README-documented memory-fragmentation risk — and the negotiation happens silently if the gateway accepts the offer.
4. **`reply.hijack()` before `transport.handleRequest`**, not after. After-the-fact hijack races Fastify's "promise resolved with no reply" handling → `FST_ERR_REPLY_ALREADY_SENT` or a double-write. Also: after hijack, your `onRequest`-hook logging still ran, but onResponse/onSend will not — don't put MCP metrics there.
5. **Don't disable Fastify's JSON parser for `/mcp`.** The transport's `parsedBody` arg exists precisely for framework-parsed bodies (V8). Removing the parser and letting the transport stream-read also works, but then any *other* JSON route loses parsing in that scope — pointless risk.
6. **`validateRequest` needs the exact configured URL.** Signature = HMAC over URL + sorted params. Deriving the URL from `req.hostname` behaves differently across Fastify majors (Fastify 5 split `host`/`hostname`/`port`) and proxies; build it from `RAILWAY_PUBLIC_DOMAIN`/`PUBLIC_HOST` config instead. If you ever add a querystring to the webhook, include it character-exact (encoded form).
7. **WS routes are GET-only** and the plugin 404s non-upgrade GETs to a `{websocket:true}` route (it swaps in a `reply.code(404).send()` HTTP handler). Health checks probing `/twilio-media` over plain HTTP will see 404 — point Railway's healthcheck at `/health` only.
8. **Upgrade-to-wrong-path still completes the WS handshake** before closing (V11) — don't treat "connection opened" as authentication on the Twilio leg; the `<Parameter>` token check in `start` is the auth gate (BRD §5.4), and close with 1008 on failure.
9. **`'close'` reason is a Buffer** in ws@8 — `reason.toString()` before logging, or every close logs `{}`.
10. **Unhandled `'error'` on either socket = process crash** taking down all concurrent calls (FR-3 hazard). Attach error handlers synchronously at socket acquisition.
11. **`handshakeTimeout` has no default** on the ws client — a black-holed gateway connect otherwise waits for OS TCP timeout (~75–130 s) while the caller hears silence. Set ~5 s and treat expiry as gateway-refused (FR-7 path).
12. **Plugin `preClose` double-`done` quirk**: `defaultPreClose` calls both `server.close(done)` and `done()`. Harmless in practice (avvio tolerates it) but if you write a custom `preClose`, call `done` exactly once (or use the async form and call none).
13. **Per-request MCP server construction is mandatory in stateless mode** — reusing one `StreamableHTTPServerTransport` across concurrent POSTs in stateless mode causes request-ID collisions on the shared transport. The per-request cost (two object graphs + `connect`) is microseconds; the BRD's per-request pattern is correct — keep it.
14. **`maxPayload` on the server leg**: default is 100 MB; a hostile client can force large allocations pre-auth. 1 MB bound is far above any Twilio frame (~200 B JSON) and closes the hole. Exceeding it terminates the connection with close code 1009.

## Open questions (need runtime spike)

1. **Gateway close-code vocabulary**: which codes/reasons `ai-gateway.vercel.sh` actually sends for session-cap, 25-min cap, 5-min idle, and first-message-30s violations (1008 vs 1011 vs 4xxx). The matrix above logs them verbatim; M1/M4 calls will populate it. (Unpublishable from source — gateway is closed.)
2. **Whether protocol-level pings keep the gateway's 5-min idle timer at bay** (vs requiring application messages). Irrelevant during calls (continuous media), only matters if a session is ever held open without audio.
3. **Twilio's tolerance for slow WS accept during drain**: when `/twiml` 503s, Twilio's retry/fallback-URL behavior decides caller experience during a deploy window. PoC accepts "deploy between calls" (BRD §7.6), so untested.
4. **Railway edge idle behavior for the `wss://` upgrade during high `bufferedAmount` stalls** — the 60 s proxy idle timeout should be moot (continuous frames), but a stalled Twilio consumer + proxy buffer interaction is only observable live.
5. **`enableJsonResponse: true` vs SSE-mode responses through the in-process client**: JSON mode verified working here; if a future tool wants streaming progress notifications, the SSE default would be needed — retest hook cleanup (`reply.raw.on('close')`) under SSE then.

## Sources

- Local source (exact versions, installed 2026-07-18): `scratchpad/pkgprobe/node_modules/` — `fastify@5.10.0` (`lib/server.js`, `fastify.js`), `@fastify/websocket@11.3.0` (`index.js`), `@fastify/formbody@8.0.2` (`formbody.js`), `ws@8.21.1` (`lib/websocket.js`, `lib/websocket-server.js`, `lib/validation.js`), `twilio@6.0.2` (`lib/webhooks/webhooks.js`), `@modelcontextprotocol/sdk@1.29.0` (`dist/cjs/server/streamableHttp.d.ts`, `dist/cjs/server/webStandardStreamableHttp.d.ts`, `package.json`).
- Runtime evidence: `C:\Users\kevin\AppData\Local\Temp\claude\D--projects-linean-CSUB-RIO-POC\2b673856-d2e2-4653-a80a-85f159b53749\scratchpad\pkgprobe\smoke.js` (all assertions passed; output reproduced in Scope/Verified sections).
- https://github.com/fastify/fastify-websocket — README: handler `(socket, req)`, plugin options (`maxPayload`, `perMessageDeflate`), `errorHandler`, `preClose`, "all ws connections are closed when the server closes".
- https://github.com/websockets/ws/blob/master/README.md — client `perMessageDeflate` default true + disable example, heartbeat/ping-pong pattern, permessage-deflate memory-fragmentation warning.
- https://www.twilio.com/docs/usage/webhooks/webhooks-security — HMAC-SHA1 over exact URL + alphabetically sorted params; "always use the exact URL Twilio used to make the request".
- npm registry dist-tags (2026-07-18): `fastify` latest 5.10.0 · `@fastify/websocket` latest 11.3.0 (`five: 5.0.1` legacy tag) · `@fastify/formbody` latest 8.0.2 · `ws` latest 8.21.1 · `twilio` latest 6.0.2.
- BRD: `D:\projects-linean\CSUB-RIO-POC\BRD_Micro_Voice_PoC.md` (§5.1, §5.4, §5.7, §5.8, §7).

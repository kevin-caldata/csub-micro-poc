# Spec 02 — HTTP Server Boot, POST /twiml Webhook, Status Callback, Health & Graceful Shutdown

Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Draft for review
Depends on: 01 (repo scaffold: package.json pins, tsconfig/ESM decision G1, `src/config.ts`, `src/logger.ts`, railway.json) · Enables: 03 (Twilio media WS leg), 05 (session bridge & barge-in), 07 (MCP server route), 09 (deployment/drain contract)
Findings referenced: findings/08 (V1–V15, Implementation §Server boot, §POST /twiml, §Graceful shutdown, gotchas 2, 4, 6, 9, 10), findings/03 (claims 1, 2, 9, 10, 11, 14, 15, Impl A/B/E, correction 5), findings/07 (claims 5, 7, 8, 9, 11, 12, Impl §Server boot + SIGTERM, §Structured log line contract, gotchas 5, 6), findings/01 (claim 3, gotcha 1/5, Impl §1–2, error taxonomy §9), findings/10 (C1, C14, C15, C18, G4, G7, S15, S19, S21, S24, S25, S28)

---

## Objective

When this spec is done, one Fastify 5.10.0 process boots on `0.0.0.0:$PORT`, serves a signature-validated `POST /twiml` that mints a per-call auth token, kicks off the gateway `getToken` mint early (off the audio path), and returns `<Connect><Stream>` TwiML pointing at `wss://HOST/twilio-media` with a `statusCallback`; it also serves a log-only `POST /stream-status`, a `GET /health` for Railway's deploy gate, and a SIGTERM handler that drains active sessions BEFORE `fastify.close()` (which would otherwise sever every live WS in ~2 ms). The `/twilio-media` and `/mcp` route bodies are NOT built here — this spec provides the server they plug into plus the shared state seams (`sessions` map, `pendingCalls` map) they consume.

## Deliverables

Create:
- `D:\projects-linean\CSUB-RIO-POC\src\server.ts` — Fastify boot, plugin registration, `/health`, drain hook, SIGTERM/SIGINT shutdown, route wiring
- `D:\projects-linean\CSUB-RIO-POC\src\twiml.ts` — `POST /twiml` + `POST /stream-status` handlers, per-call token mint, `pendingCalls` store + `claimPendingCall()`
- `D:\projects-linean\CSUB-RIO-POC\src\state.ts` — shared `sessions: Map<string, SessionHandle>` (the drain target; Spec 03's `Session` implements `SessionHandle`)

Modify (if Spec 01 created stubs): none expected; this spec owns the three files above in full.

Later specs will MODIFY `src/server.ts` only inside the marked `// --- route registration (Specs 03/07) ---` section (R6).

## Requirements

### R1 — Package pins used by this spec

From findings/08 §Sources and findings/10 C14/G7 (do not re-resolve `latest`):
- `fastify@5.10.0` (exact)
- `@fastify/websocket@11.3.0` (exact — NEVER the `five` dist-tag, which is a legacy 5.0.1 for old Fastify [findings/08 V2])
- `@fastify/formbody@8.0.2` (exact) — required or `req.body` on `/twiml` is `undefined` and validation always fails [findings/03 gotcha 9]
- `twilio@6.0.2` (exact) [findings/03 claim 15, findings/10 C14]
- `@ai-sdk/gateway@4.0.23` (exact) — already pinned by Spec 01; used here only for `getToken`

### R2 — `src/state.ts`: shared session map (drain seam)

```ts
export interface SessionHandle {
  /** Idempotent. Closes both WS legs (Twilio leg with close(1001, reason)),
   *  logs the call summary, and MUST delete itself from `sessions`. */
  teardown(reason: string): void;
}
export const sessions = new Map<string, SessionHandle>(); // keyed by streamSid
```

Contract for Spec 03 (stated here because drain depends on it): every `Session` registers itself in `sessions` on the Twilio `start` message and removes itself in `teardown()` on EVERY exit path (natural `stop`, WS `close`, error) — otherwise the drain loop in R8 never completes [findings/08 §Graceful shutdown notes].

### R3 — `src/server.ts` boot sequence

Exact shape (verified runtime pattern, findings/08 §Server boot):

```ts
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyWebsocket from '@fastify/websocket';
import { loadConfig, type AppConfig } from './config.js';
import { logEvent } from './logger.js';
import { sessions } from './state.js';
import { registerTwimlRoutes } from './twiml.js';

let config: AppConfig;
try {
  config = loadConfig();          // fail-fast first (Spec 01 R5/R11 invariant)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const app = Fastify({
  trustProxy: true,               // Railway edge terminates TLS [findings/08 §boot]
  logger: false,                  // hand-rolled logEvent()/log() ONLY (Spec 01 R12 / Spec 08 R1/R3);
                                  // pino defaults break Railway parsing [findings/09 V10]
});

await app.register(formbody);     // application/x-www-form-urlencoded → req.body object

await app.register(fastifyWebsocket, {
  options: {
    perMessageDeflate: false,     // server default is already false; explicit = documentation [findings/08 V5, findings/10 C15]
    maxPayload: 1 * 1024 * 1024,  // Twilio frames ~400 B JSON; 1 MB closes the pre-auth allocation hole [findings/08 gotcha 14]
  },
  errorHandler: (err, socket, _req, _reply) => {
    logEvent({ level: 'error', message: 'ws handler error', event: 'ws-error', err: String(err) });
    socket.terminate();
  },
});
// NOTE: do NOT pass a custom preClose — drain-before-close (R8) makes the default fine.
```

Ordering rules (all load-bearing):
1. Both plugins are `await`ed BEFORE any route registration in the same scope [findings/08 §boot note].
2. `GET /health` is registered before any async warmup so a slow boot cannot fail Railway's 120 s healthcheck window [findings/07 gotcha 5].
3. Listen call is exactly `await app.listen({ port: config.port, host: '0.0.0.0' })` — `0.0.0.0` is mandatory on Railway; never define a `PORT` service variable manually [findings/07 claims 7–8, gotcha 6].
4. At boot, log one event via `logEvent`: `{level:'info', message:'boot', event:'boot', region: process.env.RAILWAY_REPLICA_REGION, commit: process.env.RAILWAY_GIT_COMMIT_SHA}` to prove region pinning [findings/07 claim 15].

### R4 — `GET /health`

`app.get('/health', async () => ({ ok: true }))` → 200. Constraints: no signature validation, no Host filtering (Railway probes with hostname `healthcheck.railway.app` on `$PORT`) [findings/07 claim 11, gotcha 5]. Returns 503 during drain via the R8 hook — acceptable because Railway healthchecks are deploy-time only and never probe the draining (old) replica [findings/07 claim 11]. Maps to BRD §5.8 route table and railway.json `healthcheckPath: "/health"`.

### R5 — `POST /twiml` (in `src/twiml.ts`, registered via `registerTwimlRoutes(app)`)

#### R5.1 Signature validation — exact contract

Use `twilio@6.0.2` `validateRequest(authToken, twilioHeader, url, params): boolean` [findings/03 claim 15]:

```ts
import twilio from 'twilio';                     // default-import + destructure: safe under both
const { validateRequest } = twilio;              // ESM and CJS emit (twilio is a CJS package)
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';

app.post('/twiml', async (req, reply) => {
  const host = config.publicHost;                // PUBLIC_HOST ?? RAILWAY_PUBLIC_DOMAIN, resolved in config.ts (Spec 01 R5)
  const url = `https://${host}/twiml`;           // EXACTLY the URL configured in the Twilio console
  const signature = req.headers['x-twilio-signature'] as string | undefined; // Node lowercases headers
  const params = req.body as Record<string, string>; // complete formbody-parsed POST body — never add/remove keys

  if (!signature || !validateRequest(config.twilioAuthToken, signature, url, params)) {
    logEvent({ level: 'warn', message: 'invalid signature', event: 'twiml-bad-signature', callSid: params?.CallSid });
    return reply.code(403).send('invalid signature');
  }
  // ... R5.2 + R5.3 + R5.4 ...
});
```

Rules baked into the SDK — do NOT re-implement or "help" [findings/08 V6, findings/03 Impl B]:
- `params` must be the parsed form object, NOT the raw body (`validateRequestWithBody` is for JSON webhooks only — `/twiml` is form-encoded).
- Build `url` from config (`RAILWAY_PUBLIC_DOMAIN`/`PUBLIC_HOST`), NEVER from `req.hostname`/`req.protocol` — Railway's proxy view can differ from what Twilio signed [findings/08 gotcha 6, findings/03 gotcha 8].
- Do not normalize the URL (the SDK already retries 4 port/encoding variants).
- On 403: no token mint, no `getToken` call, log one warn event.

#### R5.2 Per-call token mint + `pendingCalls` store

```ts
export interface PendingCall {
  callSid: string;
  createdAt: number;                          // Date.now()
  gatewayAuth: Promise<{ token: string; url: string; expiresAt?: number }>;
}
export const pendingCalls = new Map<string, PendingCall>();  // key = per-call token
const PENDING_TTL_MS = 60_000;                // BRD §5.4 / findings/03 claim 11: single-use, ~60 s TTL
```

- Mint: `const callToken = randomUUID();` (36 chars — far under the 500-char `<Parameter>` name+value limit [findings/03 claim 3]).
- On every `/twiml` hit, sweep `pendingCalls` entries with `createdAt < Date.now() - PENDING_TTL_MS` (no timers needed at PoC call rates).
- Export a claim function for Spec 03 (single-use + constant-time; direct `Map.get` would be a timing oracle [findings/03 claim 11]):

```ts
const sha256 = (s: string) => createHash('sha256').update(s).digest();
export function claimPendingCall(candidate: string): PendingCall | undefined {
  for (const [tok, pc] of pendingCalls) {
    if (Date.now() - pc.createdAt > PENDING_TTL_MS) { pendingCalls.delete(tok); continue; }
    if (timingSafeEqual(sha256(tok), sha256(candidate))) {   // hash-then-compare: length-independent constant time
      pendingCalls.delete(tok);                              // single-use
      return pc;
    }
  }
  return undefined;
}
```

#### R5.3 Early gateway `getToken` kick-off (corrected API — BRD §5.2 is WRONG here)

`getToken` lives on the FACTORY object, not the model instance; `rt.getToken(...)` throws [findings/10 C1, findings/01 gotcha 1]:

```ts
import { gateway } from '@ai-sdk/gateway';

const t0 = Date.now();
const gatewayAuth = gateway.experimental_realtime.getToken({
  model: config.modelId,                      // 'openai/gpt-realtime-2.1'
  expiresAfterSeconds: 600,                   // official example value; realtime TTL undocumented → S15
});
gatewayAuth
  .then(({ expiresAt }) => logEvent({ level: 'info', message: 'getToken resolved', event: 'getToken-resolved', callSid: params.CallSid, getTokenMs: Date.now() - t0, expiresAt }))
  .catch((err) => logEvent({ level: 'error', message: 'getToken failed', event: 'getToken-failed', callSid: params.CallSid, err: String(err), statusCode: (err as any)?.statusCode }));
pendingCalls.set(callToken, { callSid: params.CallSid, createdAt: Date.now(), gatewayAuth });
```

- (Merge note: once Spec 04 lands, this kick-off SHOULD delegate to `mintRealtimeToken()` from `src/gateway.ts` — the identical factory call with `getTokenMs`/`GatewayMintError` handling built in; one mint implementation process-wide, merged at the wave boundary.)
- Do NOT `await` `gatewayAuth` in the handler — reply with TwiML immediately; Spec 05 awaits it (via the `onSessionStart` hook) when the `start` message arrives (the ~100 ms mint runs concurrently with Twilio's WS dial-in, off the audio path — this is FR-1's greeting budget).
- The `.catch` above is mandatory: without it a mint failure (e.g. missing key → `GatewayAuthenticationError` with an OIDC-flavored message [findings/01 gotcha 5], or a concurrency rejection at mint time [findings/01 §9, S24]) becomes an `unhandledRejection` that can kill the process and all concurrent calls. The stored promise still rejects when Spec 05 awaits it — that await is the FR-7 trigger.
- Do NOT pass `sessionConfig` to `getToken` — the gateway provider intentionally ignores it; session config goes over the WS as the first `session-update` (Spec 04) [findings/01 claim 5].
- `vcst_` tokens are single-use; never cache/reuse across sessions [findings/01 gotcha 10].

#### R5.4 TwiML response

Generate with the SDK (execution-verified output [findings/03 Impl A]) and add the `statusCallback` (findings/03 correction 5 — the ONLY channel that surfaces `StreamError` detail):

```ts
const vr = new twilio.twiml.VoiceResponse();
const connect = vr.connect();
const stream = connect.stream({
  url: `wss://${host}/twilio-media`,          // NO query string — it can hard-fail the handshake, error 31920 [findings/03 claim 2, gotcha 1]
  statusCallback: `https://${host}/stream-status`,   // must be absolute [findings/03 Impl E]
  statusCallbackMethod: 'POST',
});
stream.parameter({ name: 'token', value: callToken });
reply.type('text/xml');
return vr.toString();
```

Design lock (G4, the `/twiml` half of FR-7): there are NO TwiML verbs after `</Connect>` and NO `action` attribute — so the bridge closing the Twilio WS ends the call cleanly (the clean-hangup arm of FR-7) [findings/03 claim 1]. An `action`-URL `<Say>` branch is explicitly rejected: it would speak on every NORMAL hangup too [findings/10 G4]. The spoken-fallback arm (canned μ-law apology before close) is Spec 09's (`src/fallback.ts`, wired via Spec 05's `onGatewayFailure` hook), gated on spike S23.

### R6 — Route wiring section in `server.ts`

```ts
registerTwimlRoutes(app);                     // this spec: POST /twiml, POST /stream-status
// --- route registration (Specs 03/07) ---
// Spec 03 adds: registerTwilioMediaRoute(app)   — GET /twilio-media { websocket: true }
// Spec 07 adds: mcpRoutes(app)                  — POST /mcp (+ 405 GET/DELETE)
// -----------------------------------------
```

WS routes must be GET (`@fastify/websocket` throws otherwise) and plain-HTTP GETs to a `{websocket:true}` route 404 — one more reason `/health` is the only healthcheck target [findings/08 V4, gotcha 7].

### R7 — `POST /stream-status` (log-only)

Twilio POSTs form-encoded status events for the `<Stream>` when `statusCallback` is set: `StreamEvent` ∈ {`stream-started`, `stream-stopped`, `stream-error`} plus `StreamError` (detailed message), `AccountSid`, `CallSid`, `StreamSid`, `StreamName`, `Timestamp` (ISO 8601) [findings/03 claim 14, Impl E].

```ts
app.post('/stream-status', async (req, reply) => {
  const b = req.body as Record<string, string>;
  logEvent({
    level: b.StreamEvent === 'stream-error' ? 'error' : 'info',
    message: 'twilio stream status', event: 'stream-status',
    callSid: b.CallSid, streamSid: b.StreamSid,
    streamEvent: b.StreamEvent, streamError: b.StreamError, timestamp: b.Timestamp,
  });
  return reply.code(204).send();
});
```

- Log-only; no state changes, no signature validation (nothing is actioned on it; it exists purely as M1/FR-7 kill-test evidence — S19). Always 204, even on `stream-error`.
- Keep `callSid` top-level in the log line so `@callSid:CA...` filtering works in Railway Log Explorer [findings/07 claim 12].
- This route is exempt from the R8 drain gate (Twilio may report `stream-stopped` for draining calls; we want those lines).

### R8 — SIGTERM graceful shutdown: drain FIRST, then close (ordering is load-bearing)

`@fastify/websocket`'s default `preClose` closes EVERY tracked WS client the instant `fastify.close()` runs — measured 2 ms, peers see close code 1005. Calling `app.close()` directly on SIGTERM severs all live calls and violates BRD §7.6 [findings/08 V9, gotcha 2; findings/10 C18]. Railway's default grace is 0 s; the 60 s window only exists because railway.json sets `drainingSeconds: 60` (Spec 01) [findings/07 claim 9].

```ts
let draining = false;

// Gate new work. Hooks run for WS upgrade requests too (V4); a non-hijacked 503 reply
// to an upgrade request yields a non-101 response + socket destroy = clean refusal (V11).
app.addHook('onRequest', async (req, reply) => {
  if (!draining) return;
  if (req.url.startsWith('/stream-status')) return;                      // keep evidence flowing (R7)
  if (req.url.startsWith('/health')) return reply.code(503).send('draining');
  if (req.ws || req.url.startsWith('/twiml')) return reply.code(503).send('draining');
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;                    // idempotent — Railway sends exactly one SIGTERM, but be safe
  shuttingDown = true;
  draining = true;
  logEvent({ level: 'info', message: 'draining', event: 'shutdown-start', signal, activeSessions: sessions.size });
  const deadline = Date.now() + 55_000;        // < Railway's 60 s SIGKILL [findings/08 §shutdown]
  while (sessions.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const s of sessions.values()) s.teardown('server shutdown');  // stragglers: Twilio leg gets close(1001)
  await app.close();                           // preClose now finds no (or only just-torn-down) clients
  logEvent({ level: 'info', message: 'bye', event: 'shutdown-complete' });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));   // local-dev convenience, same path
```

Behavior contract:
1. Drain loop polls `sessions` (R2); active calls run to natural completion (≤ 55 s of the 60 s window).
2. Straggler teardown uses `close(1001, ...)` on the Twilio leg — "going away", not the plugin's bare-close 1005 [findings/08 §shutdown notes].
3. `await app.close()` runs strictly AFTER the loop + straggler sweep.
4. 503-during-drain caller experience (what Twilio does when `/twiml` 503s) is an ACCEPTED RISK — the operating rule is "deploy between test calls" (BRD §7.6); Twilio's retry/fallback-URL behavior is untested by design [S28, findings/08 open Q3]. Document this in a comment at the hook.
5. Whether the Railway edge keeps routing the established Twilio WS to the SIGTERM'd replica during the drain window is unverified (S25) — the drain is best-effort courtesy, not a durability guarantee.

### R9 — Logging discipline (this spec's routes)

One minified JSON line per EVENT, never per request/frame, all via `logEvent` (Spec 01 R12 boundary; Fastify runs `logger: false` per Spec 08 R3); `message` + string `level` top-level; `callSid` top-level whenever known. Events emitted by this spec: `boot`, `twiml-request` (include `edgeMs: Date.now() - Number(req.headers['x-request-start'])` — free edge→app latency probe [findings/07 §edge headers]), `twiml-bad-signature`, `getToken-resolved`, `getToken-failed`, `stream-status`, `shutdown-start`, `shutdown-complete` [findings/07 claim 12, §log contract; BRD §5.9].

### R10 — Config inputs (consumed from Spec 01's `config.ts`)

Via Spec 01's `loadConfig()` → `AppConfig` (camelCase fields): `port` (number, default 3000), `publicHost` (= `PUBLIC_HOST ?? RAILWAY_PUBLIC_DOMAIN`, bare hostname, no scheme [findings/07 claim 7; Spec 01 R5]), `twilioAuthToken` (required — boot fails fast if absent), `aiGatewayApiKey` (required — validated at boot; the SDK otherwise fails late with an obscure OIDC error [findings/01 gotcha 5]), `modelId` (default `openai/gpt-realtime-2.1`).

## Acceptance criteria

- A1. `npm run build && node dist/server.js` with a populated `.env` boots without error, listens on `0.0.0.0:$PORT`, and `GET /health` → 200 `{"ok":true}`. Boot log line has top-level `message`, string `level`, `event:"boot"`. (BRD §5.8; railway.json healthcheck gate, FR-8 support.)
- A2. `POST /twiml` with a signature computed via `getExpectedTwilioSignature(TWILIO_AUTH_TOKEN, 'https://HOST/twiml', params)` (findings/08 V6 test pattern) and the same form params → 200 `text/xml`; body contains `<Connect><Stream url="wss://HOST/twilio-media"`, a `statusCallback="https://HOST/stream-status"` with `statusCallbackMethod="POST"`, exactly one `<Parameter name="token" value="...">`, NO `?` anywhere in the `url` attribute, and NO verbs after `</Connect>`.
- A3. `POST /twiml` with a missing or wrong `X-Twilio-Signature` → 403; `pendingCalls` unchanged; no `getToken` HTTP call issued; one `twiml-bad-signature` warn line.
- A4. After a valid `/twiml`, `pendingCalls` holds one entry keyed by the minted token with a live `gatewayAuth` promise. A `getToken` rejection (e.g. bogus `AI_GATEWAY_API_KEY`) logs `getToken-failed` and does NOT crash the process (no unhandledRejection). On success, `getToken-resolved` logs `getTokenMs` and `expiresAt` (S15 evidence; FR-1 budget).
- A5. `claimPendingCall(minted)` returns the entry exactly once; a second call returns `undefined`; a token older than 60 s is unclaimable and swept. Compare path uses `timingSafeEqual` (code inspection).
- A6. `POST /stream-status` with form fields `StreamEvent=stream-error&StreamError=x&CallSid=CA1&StreamSid=MZ1` → 204 and one `stream-status` log line at level error with those fields top-level-queryable (`callSid` top-level). (FR-7 evidence channel, S19.)
- A7. Drain ordering: with one fake `SessionHandle` in `sessions` and one open WS on any route, sending SIGTERM causes — immediately: `/twiml` → 503, `/health` → 503, `/stream-status` still 2xx, new WS upgrades refused with a non-101 response; the ALREADY-OPEN WS is NOT closed at that instant (proves drain-before-close, C18). When the fake handle is removed from `sessions`, the process exits 0 well before the 55 s deadline. With `sessions` never emptied, straggler `teardown('server shutdown')` is invoked and the process exits by ~55 s.
- A8. Second SIGTERM/SIGINT during shutdown is a no-op (idempotence); SIGINT triggers the same path locally.
- A9. Static checks: no route derives the validation URL from `req.hostname`/`req.protocol`; `fastify@5.10.0`, `@fastify/websocket@11.3.0`, `@fastify/formbody@8.0.2`, `twilio@6.0.2` pinned exactly in package.json.

## Out of scope

- `GET /twilio-media` websocket handler, `Session` implementation, token verification against the `start` message, gateway WS client, barge-in (Specs 03/04/05). This spec only exports `sessions`/`claimPendingCall` seams.
- `POST /mcp` route and MCP server/client (Spec 07).
- Spoken-fallback canned μ-law clip (G4's other arm) — Spec 09, gated on S23.
- Optional defense-in-depth WS-upgrade signature validation (`wss://` scheme rewrite, findings/03 claim 10/Impl C) — belongs with the upgrade handler in Spec 03; the `<Parameter>` token remains the primary gate.
- `config.ts`, `logger.ts`, tsconfig/ESM toolchain, railway.json, package.json scaffolding (Spec 01).
- Twilio console configuration and Railway project setup (BRD §6–7, operational runbook).

## Open items deferred to runtime spikes (findings/10 Part 4)

- S15 — realtime `getToken` TTL default/max and latency distribution: R5.3 logs `getTokenMs` + `expiresAt` per call; evaluate at M1.
- S19 — caller-experience timing on handshake failure / mid-call drop: the R7 `/stream-status` route plus R5.4 `statusCallback` attribute exist precisely to capture this in the M1 kill test (FR-7 evidence).
- S21 — whether `x-twilio-signature` is present on every media WS upgrade: Spec 03 logs the header at upgrade; prerequisite for ever promoting the optional upgrade validation.
- S24 — where the gateway concurrency rejection manifests (mint vs WS-open): R5.3's `.catch` logs `statusCode`/error class at mint; the WS-open arm is Spec 04's. Both must map to FR-7 at M4.
- S25 — Railway edge routing of established WS connections during overlap/drain: R8 is written as best-effort; verify by deploying mid-call at M4.
- S28 — Twilio retry/fallback behavior when `/twiml` 503s during drain: accepted risk, "deploy between calls"; only spike if that operating rule is relaxed.

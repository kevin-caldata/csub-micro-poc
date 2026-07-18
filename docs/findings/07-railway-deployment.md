# Findings 07 — Railway Deployment for the WebSocket Voice Bridge

**Date:** 2026-07-18
**Researcher:** Claude (research agent), independent verification pass over BRD §3 (Railway constraints), §7 (Railway setup), §5.9 (logging)

## Scope

Railway platform behavior for a single-service Node/TypeScript WebSocket voice bridge: `railway.json` config-as-code schema, Railpack Node 22 build behavior, GitHub auto-deploy, public networking (generated domain, `wss://`, PORT, proxy timeouts), deploy lifecycle (SIGTERM / draining / overlap semantics), healthchecks, logging limits and Log Explorer filtering, sealed variables, Hobby plan pricing/fit, and region latency (us-east4-eqdc4a vs Twilio US1 / Vercel).

Evidence hierarchy used: (1) the live JSON schema at `https://railway.com/railway.schema.json` (downloaded 2026-07-18), (2) raw markdown of docs.railway.com pages (the docs serve raw `.md` at `https://docs.railway.com/<path>.md` — useful for future agents), (3) railpack.com official docs, (4) web search only for corroboration.

---

## Verified claims

### 1. `railway.json` schema — every field the BRD uses exists — **VERIFIED**

Downloaded `https://railway.com/railway.schema.json` (2026-07-18). Relevant fields and their exact schema definitions:

| Field | Schema definition | BRD usage | Status |
|---|---|---|---|
| `build.builder` | enum `["NIXPACKS","DOCKERFILE","RAILPACK","HEROKU","PAKETO"]` (docs list only `RAILPACK` (default) and `DOCKERFILE` as current choices) | `"RAILPACK"` | VERIFIED |
| `deploy.startCommand` | `string \| null` | `"node dist/server.js"` | VERIFIED |
| `deploy.healthcheckPath` | `string \| null` | `"/health"` | VERIFIED |
| `deploy.healthcheckTimeout` | `number \| null` (seconds; default 300 per healthcheck docs) | `120` | VERIFIED |
| `deploy.restartPolicyType` | enum `["ON_FAILURE","ALWAYS","NEVER"]` | `"ON_FAILURE"` | VERIFIED |
| `deploy.restartPolicyMaxRetries` | `number`, **minimum 1** | `3` | VERIFIED |
| `deploy.drainingSeconds` | `number`, minimum 0 — "The time in seconds between when the previous deploy is sent a SIGTERM to the time it is sent a SIGKILL" | `60` | VERIFIED |
| `deploy.overlapSeconds` | `number`, minimum 0 — "Time in seconds that the previous deploy will overlap with the newest one being deployed" | not used by BRD (worth adding, see §Implementation) | VERIFIED (exists) |
| `deploy.multiRegionConfig` | object keyed by region id → `{ numReplicas (int 1–200), stackerAssignment }` | `{"us-east4-eqdc4a": {"numReplicas": 1}}` | VERIFIED |
| `deploy.region` | `string \| null` (single-region alternative to multiRegionConfig) | — | VERIFIED (exists) |
| `deploy.preDeployCommand` | string or array (max 1 item) | — | VERIFIED (exists) |
| `$schema` | `string` | `"https://railway.com/railway.schema.json"` | VERIFIED |

**No BRD field is missing from the current schema.** The BRD's proposed `railway.json` (§7.5) validates as-is.

Minor doc/schema discrepancy: the config-as-code docs page shows `"overlapSeconds": "60"` and `"drainingSeconds": "10"` as **strings** in its examples, while the JSON schema types both as **number**. Use numbers (the BRD already does) — the schema is authoritative.

Also confirmed from the config-as-code reference: `us-east4-eqdc4a` appears **verbatim** in the official `multiRegionConfig` example.

### 2. Config-as-code precedence — **VERIFIED**

"Configuration defined in code will always override values from the dashboard." Config applies **only to the deployment it ships with**; dashboard settings are not rewritten. Resolution order: environment-specific code config → base code config → dashboard service settings. Consequence: setting Region in the dashboard (BRD §7.2) is redundant-but-harmless given `multiRegionConfig` in `railway.json`; the file wins on every deploy.

### 3. Region `us-east4-eqdc4a` = US East Metal (Virginia) — **VERIFIED**

Current region table (docs.railway.com/deployments/regions): `us-west2` US West Metal (California), **`us-east4-eqdc4a` US East Metal (Virginia)**, `europe-west4-drams3a` EU West Metal (Amsterdam), `asia-southeast1-eqsg3a` Southeast Asia Metal (Singapore). All four are Railway Metal infrastructure. Default region is the account's "preferred region" (Account Settings) — so pinning in `railway.json` is the right call, not optional. No plan restriction on region choice is documented.

### 4. Region latency argument (Virginia vs Twilio US1) — **LIKELY (sound)**

Twilio's default **US1 region is Ashburn, VA** (twilio.com/docs/global-infrastructure: "the default Ashburn, VA, United States (US1) Region"); all voice/Media Streams workloads default to US1. Railway's US East Metal is in Virginia (the `eqdc` in the ID is an Equinix DC-campus designator, Ashburn corridor). Same-metro placement of bridge and Twilio media gateway is the correct cheapest latency win. The one unverifiable leg: **where Vercel AI Gateway (`ai-gateway.vercel.sh`) terminates the realtime WS is unpublished** — Vercel's primary region is historically IAD/us-east, so the claim is plausible but only the BRD's own instrumentation can confirm the gateway-leg RTT. Marked LIKELY, not VERIFIED.

### 5. Railpack Node build behavior — **VERIFIED** (railpack.com/languages/node)

- **Detection:** `package.json` at repo root → Node provider.
- **Node version priority:** `RAILPACK_NODE_VERSION` env var → **`engines.node` in package.json** → `.nvmrc` → `.node-version` → `mise.toml`/`.tool-versions` → **defaults to 22**. BRD's `"engines": {"node": "22.x"}` is honored (priority 2) and matches the default anyway. VERIFIED.
- **Build script:** "Executes the build script if defined in `package.json`" — `"build": "tsc"` runs automatically; no `buildCommand` needed in railway.json. VERIFIED.
- **Dev dependencies ARE installed during build**: Railpack sets `NPM_CONFIG_PRODUCTION=false` and `YARN_PRODUCTION=false` (listed under "Runtime Variables" along with `NODE_ENV=production`, `CI=true`). So `typescript` can live in `devDependencies` and `tsc` will work at build time. Dev deps remain in the final image unless you opt in to pruning with `RAILPACK_PRUNE_DEPS=true` (prune command overridable via `RAILPACK_NODE_PRUNE_CMD`, e.g. `npm prune --omit=dev --ignore-scripts`). VERIFIED.
- **Start command priority:** `start` script in package.json → `main` field → root `index.js`/`index.ts`. The BRD sets both `deploy.startCommand: "node dist/server.js"` (railway.json — wins) and `"start": "node dist/server.js"` (package.json) — consistent; keep them in sync.
- **`NODE_ENV=production` at runtime** — code that branches on NODE_ENV will take the production path on Railway. VERIFIED.
- **Package manager:** `packageManager` field → lockfile detection (`pnpm-lock.yaml`, `bun.lockb`, `.yarnrc.yml`, `yarn.lock`) → `engines` → **defaults to npm**. A committed `package-lock.json` ⇒ npm.
- **Install caching caveat:** Railpack copies only `package.json` + lockfiles into the install layer for cache efficiency — **this optimization is disabled if a `preinstall` or `postinstall` script exists**. Avoid those scripts.
- **SPA autodetection is irrelevant here** (no vite/next config, and a custom start command disables it), but note `RAILPACK_NO_SPA=1` exists if it ever misfires.
- Builder pin available via `build.railpackVersion` in railway.json (valid version from github.com/railwayapp/railpack/releases) — not needed for the PoC.
- Note: "Railway will always build with a Dockerfile if it finds one" — don't add a Dockerfile to the repo, or `builder: RAILPACK` intent is overridden.

### 6. GitHub auto-deploy on push to main — **VERIFIED**

"Services linked to a GitHub repository automatically deploy when new commits are pushed to the connected branch." (docs.railway.com/deployments/github-autodeploys). Branch selectable in Service Settings; Enable/Disable toggle; manual fallback = Command Palette (Cmd+K) → "Deploy Latest Commit". Requirements: ≥1 project member with a connected GitHub account having **contributor access** to the repo, and the Railway GitHub App installed with repo access. "Wait for CI" (deployment goes `WAITING` until GitHub Actions pass; failure ⇒ `SKIPPED`) exists but requires a workflow with `on: push: branches: [main]` — BRD says leave it off; correct for this PoC. Gotcha: with **watch paths** configured, empty commits and out-of-path changes are silently `SKIPPED` — the BRD doesn't use watchPatterns, so full-repo pushes always deploy. FR-8 is satisfied by the platform default.

### 7. `RAILWAY_PUBLIC_DOMAIN` + generated domain + wss — **VERIFIED**

- `RAILWAY_PUBLIC_DOMAIN`: "The public service or customer domain, of the form `example.up.railway.app`" — **hostname only, no scheme** (docs.railway.com/variables/reference). Injected automatically once a domain is generated (Settings → Networking → Generate Domain). Build TwiML as `wss://${process.env.RAILWAY_PUBLIC_DOMAIN}/twilio-media` and webhook URL as `https://${...}/twiml`.
- WebSockets: "Support for websockets over HTTP/1.1" at the edge (Specs & Limits). All inbound traffic must be TLS ⇒ **`wss://` is required and works out of the box on the generated domain**; plain `ws://` is impossible (HTTP GET on port 80 → 301 to HTTPS). No special config; the WS server just shares the HTTP server on `PORT`. VERIFIED.
- Free LetsEncrypt cert auto-provisioned/renewed (RSA 2048; 90-day validity, renewed at ~60 days).

### 8. PORT injection — **VERIFIED**

"As long as you have not defined a PORT variable, Railway will provide and expose one for you. To have your application use the Railway-provided port, you should ensure it is listening on `0.0.0.0:$PORT`." (docs.railway.com/networking troubleshooting + variables docs). The same PORT "is also used when performing health checks on your deployments." So: `fastify.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })`. Do **not** define a PORT service variable manually.

### 9. SIGTERM / draining semantics — **VERIFIED (0 s default grace confirmed)**

From docs.railway.com/deployments (reference) and /deployments/deployment-teardown:

- Lifecycle: new deployment builds → (healthcheck if configured, until HTTP 200) → new deployment becomes **Active** → "Once the new deployment is active, the previous deployment is sent a SIGTERM signal and given time to gracefully shutdown before being forcefully stopped with a SIGKILL."
- **Default grace: "By default, it is given 0 seconds to gracefully shutdown before being forcefully stopped with a SIGKILL."** And the variables reference states `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` "default value is 0". BRD's "0 s default grace" claim is exactly right.
- Three equivalent ways to set draining: `deploy.drainingSeconds` in railway.json, service Settings pane, or the `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` service variable. Same triple for overlap (`overlapSeconds` / Settings / `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`).
- **Overlap** = time the previous deployment *remains active* after the new one activates (both running, before SIGTERM is sent). **Draining** = SIGTERM→SIGKILL window after that. Timeline on redeploy with `overlapSeconds: O, drainingSeconds: D`: new deploy healthy → both live for `O` s → old gets SIGTERM → old has `D` s to exit → SIGKILL.
- **What the docs do NOT say (open question):** whether established WS connections continue to route to the old container during overlap/draining, and whether new connections are atomically switched to the new deployment at "Active". Nothing in the official docs addresses in-flight connection routing. The BRD's operating rule — **"deploys sever live calls; deploy between test calls"** — is therefore the correct conservative posture and should stay. `drainingSeconds: 60` gives the SIGTERM handler up to 60 s to close gateway sessions cleanly and log call summaries, but a 5–10 min call in progress will still die (60 s < call length), and whether Twilio's WS even stays routed to the old replica during that minute is unverified. Status of BRD claim: **VERIFIED** (mechanics), connection-routing detail **UNVERIFIED — runtime spike**.

### 10. 60 s proxy idle timeout — BRD claim **WRONG in detail, moot in practice**

Exact text from Specs & Limits (docs.railway.com/networking/public-networking/specs-and-limits):

> "Idle HTTP/1.1 connections are closed after 60 seconds between requests. **This does not apply to HTTP/2 or websocket connections.**"
> "HTTP requests can run for up to 15 minutes if data keeps transferring… and are otherwise closed after 5 minutes with no data transferred."
> "**Websocket connections are exempt from these duration and inactivity limits, and can stay open indefinitely, even while idle.**"

The BRD (§3) says "60 s proxy keep-alive idle timeout (moot — media frames every ~20 ms)". Correction: the 60 s timeout applies to idle **HTTP/1.1 keep-alive connections between requests**, and WebSockets are **explicitly exempt** — they can idle forever. So the conclusion (no risk to the media WS) is even stronger than the BRD states, but the stated mechanism is wrong: no idle timeout applies to the WS legs at all, with or without 20 ms frames. This also means a silent/paused call cannot be dropped by the Railway edge.

Other edge specs relevant to the bridge: max 32 KB combined request headers; 10,000 concurrent connections per service; ~11,000 RPS per domain; 10,000 requests per connection; TLS 1.2/1.3; HTTP/1.1 + HTTP/2 (WS rides HTTP/1.1). All orders of magnitude above 5 concurrent calls.

### 11. Healthchecks — **VERIFIED**

- "When a new deployment is triggered… Railway will query the endpoint until it receives an HTTP 200 response" — **deploy-time only**: "Railway does not monitor the healthcheck endpoint after the deployment has gone live."
- Default `healthcheckTimeout` is **300 s**; BRD's 120 is a valid tightening. If no 200 within the window, "the deploy will be marked as failed" — the old deployment stays live (failed deploys never receive traffic), which protects live calls from a broken push. This is the main practical value of `healthcheckPath` here: a boot-crash in a new build cannot take down the running service.
- Healthchecks hit the container on **`PORT`** with hostname **`healthcheck.railway.app`** — two build implications: (a) `GET /health` must be registered before/independent of anything that blocks boot (gateway warmup etc.); (b) nothing in the stack may filter by Host header or require Twilio signatures on `/health`.
- There is also a `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` config variable (variables reference) equivalent to the JSON field.

### 12. Log rate limit & Log Explorer — **VERIFIED (500 lines/s/replica confirmed)**

- "Railway rate limit of **500 logs/sec reached for replica**, update your application to reduce the logging rate." — the limit is 500 log lines/s per replica on **all plans**; excess lines are **dropped** (not queued), with that warning emitted into the stream. BRD §5.9's number is correct, and its per-event (never per-frame) rule is essential: 5 concurrent calls × 50 frames/s × 2 directions = 500 lines/s — per-frame logging would sit exactly at the drop threshold.
- Structured logs: emit one **minified** JSON object per line to stdout: `{"message": "...", "level": "info", "callSid": "CA...", ...}`. `message` is required; `level` ∈ debug|info|warn|error; **arbitrary additional attributes are queryable**.
- Log Explorer filter syntax (docs.railway.com logs guide): substring `keyword` / `"key phrase"`; attribute `@attribute:value` (so **`@callSid:CAxxxxxxxx` works exactly as the BRD plans**, provided `callSid` is a top-level JSON key); array elements `@arrayAttribute[i]:value`; `replica:<replica_id>`; boolean `AND`, `OR`, `-` negation, parentheses; built-in HTTP attributes `@httpStatus`, `@responseTime`, `@path`, `@srcIp`; `@level:error` for severity. Nested-object attribute paths are not documented — **keep `callSid` top-level**.
- Retention: Hobby/Trial **7 days**, Pro 30 days. Fine for a PoC; export findings promptly.

### 13. Hobby plan pricing & fit — **VERIFIED numbers, LIKELY fit**

(docs.railway.com/reference/pricing/plans, fetched 2026-07-18)

- Hobby: **$5/month, includes $5 of usage credit** — you pay above $5 only if usage exceeds the credit. Per-service caps on Hobby: 6 replicas, 48 GB RAM, 48 vCPU, 100 GB ephemeral storage.
- Usage rates: CPU **$20/vCPU/month** ($0.000463/vCPU/min), RAM **$10/GB/month** ($0.000231/GB/min), egress **$0.05/GB**, volumes $0.15/GB/month (unused here).
- Fit arithmetic for this bridge (always-on, 1 replica): a Node process at ~0.2–0.3 GB RSS ⇒ $2–3/mo RAM; near-idle CPU between test calls (~0.02–0.05 vCPU avg; DSP is ~0.16% core/call per BRD benchmark) ⇒ well under $1/mo; egress = outbound WS media to Twilio + gateway upstream — μ-law at 8 kB/s/direction ≈ 29 MB/hr of talk time per leg, pennies at $0.05/GB. Total comfortably inside the $5 credit for a PoC test cadence ⇒ **BRD's "fits inside Hobby" claim is LIKELY** (confirm in the dashboard's usage page during M4; sustained 24/7 memory bloat is the only realistic way to exceed it).
- Do **not** enable `sleepApplication` (serverless/app sleeping): a slept service would add cold-start latency to the first Twilio webhook and defeat FR-1's ~2 s greet target. Default is off; leave it off.
- A Free tier ($0, $1 credit, 0.5 GB RAM / 1 vCPU / 1 replica) exists — technically enough for a demo, but the 0.5 GB ceiling is tight for Node + 5 concurrent sessions; Hobby is the right call.

### 14. Sealed variables — **VERIFIED**

- Seal via the 3-dot menu on a variable → "Seal". "Its value is provided to builds and deployments but is never visible in the UI nor can it be retrieved via the API."
- **Irreversible**: cannot be unsealed; you can only overwrite with a new value. Keep the canonical copies of `AI_GATEWAY_API_KEY` / `TWILIO_AUTH_TOKEN` in a password manager before sealing.
- **Sealed values are NOT provided to `railway variables` or `railway run` CLI** — local dev must use the `.env` file (which the BRD already prescribes), not `railway run`.
- Not copied to PR environments, duplicated environments/services; excluded from environment-sync diffs and integrations. No impact on this single-environment PoC.

### 15. Railway-provided variables inventory (for config.ts) — **VERIFIED**

Available at runtime: `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_PRIVATE_DOMAIN`, `RAILWAY_PROJECT_NAME/ID`, `RAILWAY_ENVIRONMENT_NAME/ID`, `RAILWAY_SERVICE_NAME/ID`, `RAILWAY_DEPLOYMENT_ID`, `RAILWAY_REPLICA_ID`, `RAILWAY_REPLICA_REGION` (e.g. `us-east4-eqdc4a` — log it at boot to prove region pinning worked), git metadata (`RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_BRANCH`, …). Config-style user-settable: `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`, `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`, `RAILPACK_VERSION`.

---

## Implementation-grade detail

### Final recommended `railway.json`

The BRD's file is valid as-is. Recommended addition: `overlapSeconds` so new deploys take over new-connection routing while old calls get their drain window (harmless if connection routing turns out to be atomic):

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "RAILPACK" },
  "deploy": {
    "startCommand": "node dist/server.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3,
    "overlapSeconds": 10,
    "drainingSeconds": 60,
    "multiRegionConfig": { "us-east4-eqdc4a": { "numReplicas": 1 } }
  }
}
```

Notes: numbers, not strings, for `overlapSeconds`/`drainingSeconds` (schema type is `number`; docs examples showing strings are sloppy). `restartPolicyMaxRetries` minimum is 1. `numReplicas` range 1–200. Do not add a Dockerfile (it would override the RAILPACK builder choice).

### `package.json` requirements for Railpack

```json
{
  "engines": { "node": "22.x" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts"
  }
}
```

- Railpack: installs with npm (assuming `package-lock.json` committed; commit it), **including devDependencies** (`NPM_CONFIG_PRODUCTION=false`), runs `npm run build` automatically, then the container starts with railway.json's `startCommand`. `typescript` and `tsx` belong in `devDependencies`; they will be present at build time and (absent `RAILPACK_PRUNE_DEPS=true`) also in the runtime image — acceptable for the PoC.
- Avoid `preinstall`/`postinstall` scripts (they disable Railpack's install-layer cache optimization).
- Runtime env from Railpack: `NODE_ENV=production`, `CI=true`.

### Server boot + SIGTERM drain pattern

```ts
const port = Number(process.env.PORT ?? 3000);
await fastify.listen({ port, host: '0.0.0.0' });   // 0.0.0.0 is mandatory on Railway

let draining = false;
process.on('SIGTERM', () => {
  draining = true;                  // /twiml starts returning 503 (or <Reject/>) for NEW calls
  stopAcceptingUpgrades();          // refuse new /twilio-media upgrades
  for (const s of sessions.values()) s.beginGracefulEnd();  // let active calls finish, ≤60 s
  const t = setTimeout(() => process.exit(0), 55_000);      // exit before the 60 s SIGKILL
  t.unref();
  whenAllSessionsClosed().then(() => process.exit(0));
});
```

With `drainingSeconds: 60` the process has 60 s between SIGTERM and SIGKILL. Without the handler, default Node SIGTERM behavior is immediate exit — the config buys nothing on its own.

### URLs constructed from injected env

- `RAILWAY_PUBLIC_DOMAIN` = bare hostname (e.g. `csub-rio-poc-production.up.railway.app`).
- Twilio webhook: `https://${RAILWAY_PUBLIC_DOMAIN}/twiml`
- TwiML stream URL: `wss://${RAILWAY_PUBLIC_DOMAIN}/twilio-media`
- Local override per BRD: `PUBLIC_HOST` env var wins when set (ngrok host).

### Latency instrumentation freebie: edge request headers

Every proxied request carries (Specs & Limits): `X-Real-IP` (client IP), `X-Forwarded-Proto` (always `https`), `X-Forwarded-Host`, `X-Railway-Edge` (which POP handled it), **`X-Request-Start` (Unix ms when the edge received the request)** — log `Date.now() - Number(X-Request-Start)` on `POST /twiml` and on the WS upgrade for a free edge→app latency probe — and `X-Railway-Request-Id` (correlate with Railway's network logs). Clients may send `X-Railway-Debug: 1` to get `X-Railway-Upstream-Zone` back.

### Structured log line contract (Log Explorer-compatible)

```json
{"message":"first-audio-delta","level":"info","callSid":"CA123...","streamSid":"MZ...","event":"first-audio-delta","deltaMs":612}
```

- One minified JSON object per stdout line; `message` required; `level` in debug|info|warn|error; every other key becomes a queryable attribute.
- Query examples: `@callSid:CA123abc` · `@level:error` · `@event:first-audio-delta AND @callSid:CA123abc` · `-@event:media` · `replica:<id>`.
- Keep `callSid` top-level (nested-path querying is undocumented). Hard cap 500 lines/s/replica; overflow is silently dropped after one warning line.

### Deploy pipeline (once-only setup, verified sequence)

1. Push repo to GitHub → Railway: New Project → Deploy from GitHub repo → pick repo; connected-branch pushes auto-deploy from then on (toggleable Enable/Disable in Service Settings; requires contributor access + Railway GitHub App).
2. Service → Settings → Networking → **Generate Domain** ⇒ `RAILWAY_PUBLIC_DOMAIN` starts being injected.
3. Variables tab: add `AI_GATEWAY_API_KEY`, `TWILIO_AUTH_TOKEN`, `MODEL_ID`, `AUDIO_MODE`, `VOICE`; seal the two secrets (3-dot → Seal; irreversible; keep copies elsewhere). Changing variables triggers a redeploy (which severs calls — set all variables before the demo window).
4. `railway.json` at repo root governs build/deploy per-deployment; dashboard Region setting is then irrelevant (code wins).
5. Healthcheck gate means a broken push never replaces the live deployment (fails after 120 s of non-200 and the old deploy stays).

---

## Gotchas & pitfalls

1. **BRD §3 mis-states the 60 s timeout** — it's for idle HTTP/1.1 connections between requests; WebSockets are explicitly exempt from all duration/inactivity limits ("can stay open indefinitely, even while idle"). Risk was already assessed as none; the mechanism text should be corrected so nobody "fixes" a non-problem with WS-level keepalives.
2. **Default SIGTERM grace really is 0 s** — `drainingSeconds: 60` in railway.json is what creates the drain window; the SIGTERM handler is useless without it and vice versa. Also: every **variable change** and every **push to main** triggers a redeploy → severed calls. Deploy/change-vars between test calls only.
3. **Draining ≠ safe deploys for calls in progress**: 60 s < a 5–10 min call, and whether the edge keeps routing the established Twilio WS to the SIGTERM'd replica is undocumented. Treat every deploy as call-fatal (BRD already does).
4. **Sealed = write-only forever**: cannot unseal, invisible in UI/API, and **not available via `railway run`/`railway variables`** — local dev must use `.env`, never `railway run` (BRD's local-dev section already avoids it, keep it that way).
5. **Healthcheck comes from `healthcheck.railway.app` host on `$PORT`** — don't enable Fastify host allow-listing, don't put Twilio signature validation on `/health`, and register `/health` before any async boot work so a slow gateway warmup can't fail the 120 s window.
6. **Don't set a `PORT` variable manually** — Railway provides one; defining your own can break domain→port targeting and healthchecks. Listen on `0.0.0.0:$PORT`, never `localhost`/`127.0.0.1` (the MCP client's `http://localhost:PORT/mcp` loopback call is fine — that's in-process egress, not inbound routing).
7. **Per-frame logging would hit the cap exactly**: 5 calls × 50 fps × 2 directions = 500 lines/s ⇒ dropped lines during the M4 concurrency test would corrupt the latency dataset. Per-event logging only (BRD §5.9 already mandates this); also log minified JSON (a documented mitigation).
8. **Log retention on Hobby is 7 days** — export M1–M5 measurement logs into the repo/README as they're produced.
9. **A stray `Dockerfile` in the repo silently overrides `builder: RAILPACK`** ("Railway will always build with a Dockerfile if it finds one").
10. **devDependencies ship in the runtime image** by default (`NPM_CONFIG_PRODUCTION=false`, no pruning) — fine here; if image slimming is ever wanted, `RAILPACK_PRUNE_DEPS=true` prunes *after* the build script runs, so `tsc` output is unaffected.
11. **`NODE_ENV=production` is set by Railpack at runtime** — any library that changes behavior on NODE_ENV (Fastify logging, error verbosity) behaves as production on Railway vs local dev.
12. **Watch paths**: not used in this repo — don't add `watchPatterns` casually; commits touching only excluded paths are silently SKIPPED (a confusing FR-8 "failure").
13. **Account "preferred region" is the default, not us-east4** — without the `multiRegionConfig` (or dashboard region) pin, the service could land in `us-west2` and add ~60–70 ms RTT to every Twilio and gateway exchange.
14. Docs examples show `drainingSeconds`/`overlapSeconds` as strings; the schema says number — use numbers to keep editor validation green.

## Open questions (need runtime spike)

1. **Connection routing during overlap/draining**: do established WS connections keep flowing to the old (SIGTERM'd) replica for the full draining window, and are new connections routed to the new deployment the moment it's Active? Undocumented. Spike: deploy mid-call with `overlapSeconds: 10, drainingSeconds: 60` and watch whether the in-flight call survives to its natural end.
2. **Maximum allowed `drainingSeconds`/`overlapSeconds`**: schema has `minimum: 0`, no maximum; docs give none. 60 is safely within observed community usage; anything much larger should be spike-tested.
3. **Vercel AI Gateway WS termination locale** (us-east assumption): only measurable via the BRD §5.9 instrumentation (gateway-open handshake RTT + TTFB deltas from a Virginia replica).
4. **Actual Hobby usage burn**: verify in Railway dashboard usage page after M4 (RSS of the Node process under 5 concurrent calls is the main variable; predicted ~$3/mo, inside the $5 credit).
5. **Whether `RAILWAY_PUBLIC_DOMAIN` is present at build time** (irrelevant to this design — it's read at runtime only — but don't bake it into the build).
6. **Log Explorer custom-attribute indexing lag** under burst logging (e.g., are `@callSid` queries complete seconds after a call ends?) — cosmetic, affects demo ergonomics only.

## BRD corrections (summary)

- §3 "60 s proxy keep-alive idle timeout (moot…)": mechanism wrong — 60 s applies to idle HTTP/1.1 connections between requests; **WebSocket connections are wholly exempt and may idle indefinitely**. Conclusion unchanged (no risk), text should be fixed.
- §7.2 dashboard Region setting is redundant given railway.json `multiRegionConfig` (code always overrides dashboard). Harmless; can be dropped from the setup steps or kept as belt-and-braces.
- Everything else in the BRD's Railway domain checked out: schema fields, 0 s default grace, `drainingSeconds` semantics, Railpack Node 22 + `engines.node` + auto-run `build` script, auto-deploy on push, `RAILWAY_PUBLIC_DOMAIN` injection + wss, 500 logs/s/replica, `@callSid:` filtering, sealed variables, Hobby-fit (likely), us-east4-eqdc4a region id.

## Sources

- https://railway.com/railway.schema.json — live JSON schema (downloaded 2026-07-18; local copy read in full)
- https://docs.railway.com/config-as-code/reference (raw: https://docs.railway.com/config-as-code/reference.md) — all config fields, precedence, us-east4-eqdc4a example, overlap/draining definitions
- https://docs.railway.com/deployments/deployment-teardown (raw .md) — overlap time, draining time, SIGTERM→SIGKILL
- https://docs.railway.com/reference/deployments — "By default, it is given 0 seconds to gracefully shutdown before being forcefully stopped with a SIGKILL"
- https://docs.railway.com/networking/public-networking/specs-and-limits (raw .md) — WS exemption, 60 s HTTP/1.1 idle, header/connection limits, edge request headers
- https://docs.railway.com/deployments/regions — region table (US East Metal Virginia = us-east4-eqdc4a)
- https://docs.railway.com/deployments/github-autodeploys (raw .md) — auto-deploy, Wait for CI, troubleshooting
- https://docs.railway.com/deployments/healthchecks — deploy-time-only checks, 300 s default, healthcheck.railway.app hostname, PORT usage
- https://docs.railway.com/variables/reference (raw .md) — RAILWAY_PUBLIC_DOMAIN format, RAILWAY_DEPLOYMENT_DRAINING_SECONDS default 0, full variable inventory
- https://docs.railway.com/guides/variables — sealed variables behavior and CLI limitation
- https://docs.railway.com/guides/logs — 500 logs/sec/replica, structured log format, Log Explorer syntax, retention
- https://docs.railway.com/reference/pricing/plans — Hobby $5 + $5 credit, $20/vCPU/mo, $10/GB/mo, $0.05/GB egress, per-plan limits
- https://railpack.com/languages/node — Node version resolution (default 22), build-script auto-run, NPM_CONFIG_PRODUCTION=false, RAILPACK_PRUNE_DEPS, start-command priority, install caching
- https://www.twilio.com/docs/global-infrastructure — US1 = Ashburn, VA default region
- https://station.railway.com (community, corroboration only) — wss:// requirement, PORT binding guidance

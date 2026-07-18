# T01.3 — Logger stub, placeholder server, build + boot smoke

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Ship the `src/logger.ts` import-boundary stub (Spec 01 R12) and the minimal `src/server.ts` placeholder (Spec 01 R11), then prove the pipeline: build, typecheck, boot, `/health` 200, fail-fast on missing env.

**Wave:** A · **Depends on:** T01.2 · **Blocks:** T01.4

**References:**
- `docs/specs/01-scaffolding-and-toolchain.md` — R11 (exact `server.ts` content + invariants a–d), R12 (exact `logger.ts` stub + boundary rules), Acceptance A2, A3, A4
- `docs/specs/08-logging-and-latency-instrumentation.md` — the "Spec 01 R12 boundary" note only (Spec 08 later replaces the stub internals but MUST keep `logEvent`/`LogFields`/`LogLevel` exported — write the stub so that holds)
- `docs/findings/07-railway-deployment.md` — claims 8, 11, 12 (0.0.0.0 listen, healthcheck contract, structured-log line contract)
- `docs/findings/01-vercel-ai-gateway-realtime.md` — gotcha 5 (why fail-fast before listen matters)

## Interfaces

**Consumes:** T01.2's `loadConfig` / `AppConfig` from `./config.js`; T01.1's scripts and tsconfig.

**Produces** (later tasks rely on these exact names):
- `src/logger.ts` exporting `type LogLevel`, `interface LogFields` (with required `level`, `message`, `event`; optional top-level `callSid`, `streamSid`; `[key: string]: unknown` flat scalars), and `function logEvent(fields: LogFields): void` — the ONLY logging surface any spec may import until Spec 08 (T08) lands; T08 extends this file but keeps `logEvent` signature-identical.
- `src/server.ts` — placeholder OWNED BY T02 after Wave A: T02 replaces this file wholesale but must preserve the R11 invariants (fail-fast `loadConfig()` first; `/health` registered before async boot work, no auth; listen on `0.0.0.0`; SIGTERM drain deferred to T02).

## Steps

- [ ] Write `src/logger.ts` with the exact content from Spec 01 R12 (types + `logEvent` only; no `log`/`ms`/`now` — those are Spec 08's).
- [ ] Write `src/server.ts` with the exact content from Spec 01 R11 (Fastify `{ logger: false, trustProxy: true }`, `GET /health`, top-level `await app.listen`, one `logEvent` boot line). No other routes, no plugins, no signal handlers.
- [ ] Run `npm run build` — expect exit 0; verify emitted files with `node -e "const fs=require('fs');const need=['dist/server.js','dist/config.js','dist/logger.js'];const bad=fs.readdirSync('dist').filter(f=>f.endsWith('.test.js'));const miss=need.filter(f=>fs.existsSync(f)===false);if(miss.length===0&&bad.length===0){console.log('dist ok')}else{console.error({miss,bad});process.exit(1)}"` — expect `dist ok` (A2: no `dist/*.test.js`).
- [ ] Run `npm run typecheck` — expect exit 0.
- [ ] Boot smoke (A3): start the server in the background with dummy env, then curl it.
  - PowerShell: `$env:AI_GATEWAY_API_KEY='x'; $env:TWILIO_AUTH_TOKEN='y'; $env:PUBLIC_HOST='localhost'; npm start`
  - POSIX: `AI_GATEWAY_API_KEY=x TWILIO_AUTH_TOKEN=y PUBLIC_HOST=localhost npm start`
  Then run `curl http://localhost:3000/health` — expect HTTP 200 body `{"ok":true}`. Capture stdout: expect exactly ONE minified single-line JSON object containing `"message":"boot"` and `"event":"boot"`. Stop the server afterwards.
- [ ] Fail-fast smoke (A4, case 1): in a fresh shell with `AI_GATEWAY_API_KEY` unset (set only `TWILIO_AUTH_TOKEN` and `PUBLIC_HOST`), run `npm start` — expect non-zero exit BEFORE listening; stderr names `AI_GATEWAY_API_KEY` and mentions the OIDC fallback trap.
- [ ] Fail-fast smoke (A4, case 2): with `AI_GATEWAY_API_KEY` and `TWILIO_AUTH_TOKEN` set but BOTH `PUBLIC_HOST` and `RAILWAY_PUBLIC_DOMAIN` unset, run `npm start` — expect non-zero exit; stderr names `PUBLIC_HOST` and `RAILWAY_PUBLIC_DOMAIN`.
- [ ] Run `npm test` — expect PASS (config suite still green; no test files were added or broken).
- [ ] Commit `src/logger.ts` and `src/server.ts` with message:
  `feat(scaffold): logger boundary stub and placeholder health server`
  followed by a blank line and `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 01 **A2** (build emits the three modules, no test JS; typecheck clean), **A3** (boot + `/health` 200 + single boot log line), **A4** (both fail-fast cases exit non-zero before listen with named variables).

## Completion Report

```
Task: T01.3 — Logger stub & placeholder server
Status: <complete | blocked (why)>
Files changed: src/logger.ts, src/server.ts
Commands run: <command → outcome, one line each; include curl body and boot log line>
Spec A-numbers verified: A2, A3, A4
Deviations from plan: <none | list>
New interfaces exposed: logEvent(fields: LogFields): void; LogFields; LogLevel; server R11 invariants documented for T02
Notes for ledger: <anything unusual>
```

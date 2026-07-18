# T02.1 — Shared state seam + Fastify server skeleton (/health, plugins, route marker)

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Replace Spec 01's placeholder `src/server.ts` with the full boot skeleton (plugins, `/health`, boot log, route-registration marker, testable `buildApp` seam) and create `src/state.ts` (the process-wide `sessions` map that SIGTERM drain and Spec 03 depend on).

**Wave:** B · **Depends on:** T01 · **Blocks:** T02.3, T02.4, T03, T07

**References:**
- `docs/specs/02-http-server-and-twiml-webhook.md` — R1, R2, R3, R4, R6, R9, R10; acceptance A1 (and the A9 pin list)
- `docs/specs/01-scaffolding-and-toolchain.md` — R1 (ESM `.js` extensions), R5 (`AppConfig`/`loadConfig`), R7 (test conventions: `node:test` via `tsx --test`, files `src/<name>.test.ts`), R11 (placeholder being replaced), R12 (`logEvent` boundary)
- `docs/findings/08-fastify-ws-server-architecture.md` — §Server boot (src/server.ts shape), V4, V5, gotcha 14
- `docs/findings/07-railway-deployment.md` — claims 7, 8, 11, 15, gotchas 5, 6
- `docs/specs/03-twilio-media-ws-leg.md` — R9 only (to see how `sessions`/`SessionHandle` get consumed; do not implement anything from it)

## Interfaces

**Consumes** (from T01, all already in the repo):
- `loadConfig(env?): AppConfig` and `interface AppConfig` from `src/config.ts` (fields used here: `port`, `publicHost`, `twilioAuthToken`, `aiGatewayApiKey`, `modelId`)
- `logEvent(fields: LogFields): void` from `src/logger.ts` (Spec 01 R12 boundary — import nothing else from it)
- package pins from T01's `package.json` (`fastify@5.10.0`, `@fastify/websocket@11.3.0`, `@fastify/formbody@8.0.2`)

**Produces:**
- `src/state.ts` exporting exactly (per Spec 02 R2, verbatim shape):
  - `interface SessionHandle { teardown(reason: string): void }`
  - `const sessions: Map<string, SessionHandle>` — keyed by streamSid. Include the R2 doc comment stating: idempotent, closes both WS legs (Twilio leg `close(1001, reason)`), MUST self-delete from `sessions` on every exit path. Add a file-level comment: this is the ONE process-wide map; Spec 03's `src/sessions.ts` must re-export or BE this instance (master plan risk R-2).
- `src/server.ts` exporting:
  - `buildApp(config: AppConfig, shutdownOpts?: ShutdownOpts): Promise<{ app: FastifyInstance; shutdown: (signal: string) => Promise<void> }>` — in THIS task `shutdown` may be a stub `async () => {}`; T02.4 implements it. `ShutdownOpts` is declared here as `{ deadlineMs?: number; pollMs?: number; exit?: (code: number) => void }` (T02.4 gives it meaning).
  - a guarded main entry (see Steps) so that importing `src/server.ts` from a test has NO side effects (no `loadConfig()`, no listen).
- Inside `buildApp`, immediately after the (future) twiml registration point, the marker section verbatim from Spec 02 R6:
  ```
  // --- route registration (Specs 03/07) ---
  // Spec 03 adds: registerTwilioMediaRoute(app)   — GET /twilio-media { websocket: true }
  // Spec 07 adds: mcpRoutes(app)                  — POST /mcp (+ 405 GET/DELETE)
  // -----------------------------------------
  ```

## Steps

- [ ] Read every file in References. Confirm `src/server.ts` currently holds only the Spec 01 R11 placeholder and that `src/config.ts` + `src/logger.ts` exist with the R5/R12 shapes.
- [ ] Write `src/state.ts` per Spec 02 R2 (interface + Map + contract comments). No test file needed — it is types + one Map literal; it gets exercised by T02.4's drain tests.
- [ ] Write failing test `src/server.test.ts` (`node:test` + `node:assert/strict`, Spec 01 R7 conventions) with cases:
  1. `buildApp(fixtureConfig)` resolves; `app.inject({method:'GET', url:'/health'})` → status 200, JSON body `{ok:true}` (Spec 02 R4).
  2. Importing `./server.js` does not throw and does not require env vars (import side-effect freedom; use a fixture `AppConfig` object, never `process.env`).
  3. `app.inject({method:'GET', url:'/twilio-media'})` → 404 (route not registered yet — guards the marker section stays empty until Specs 03/07).
  Run: `npx tsx --test src/server.test.ts` → expect FAIL (buildApp does not exist yet).
- [ ] Rewrite `src/server.ts` per Spec 02 R3 (use the verified boot snippet in Spec 02 R3 / findings/08 §Server boot as the authority — `trustProxy: true`, `logger: false`, `await register(formbody)` then `await register(fastifyWebsocket, {...})` with `perMessageDeflate: false`, `maxPayload: 1*1024*1024`, the `errorHandler` that logs `ws-error` and terminates, and NO custom `preClose`), restructured only as follows for testability:
  - All of the above lives inside `export async function buildApp(config, shutdownOpts?)`. Ordering rules R3.1–R3.2 hold INSIDE buildApp: plugins awaited before any route; `GET /health` registered before anything async beyond the two plugin awaits.
  - After `/health`, place a one-line comment `// registerTwimlRoutes(app, config)  — added by T02.3` followed by the R6 marker block (verbatim, see Produces).
  - Guarded main entry at the bottom of the file (this snippet exists nowhere in specs — inline it):
    ```ts
    import { pathToFileURL } from 'node:url';
    const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
    if (isMain) { /* main() */ }
    ```
    Inside `main()`: Spec 02 R3 fail-fast `loadConfig()` try/catch → stderr + `process.exit(1)`; `const { app, shutdown } = await buildApp(config);`; `await app.listen({ port: config.port, host: '0.0.0.0' })` (R3.3 — never any other host); then the R3.4 boot `logEvent` (`event:'boot'`, `region: process.env.RAILWAY_REPLICA_REGION`, `commit: process.env.RAILWAY_GIT_COMMIT_SHA`, plus `port`, `audioMode`, `modelId` carried over from Spec 01 R11). Signal wiring is T02.4's — leave a `// SIGTERM/SIGINT wiring — added by T02.4` comment.
- [ ] Run `npx tsx --test src/server.test.ts` → expect PASS (3/3).
- [ ] Run `npm run typecheck` → expect clean. Run `npm test` → expect all suites (including T01's `config.test.ts`) PASS.
- [ ] Boot smoke (Spec 02 A1, manual): `npm run build`, then start with dummy env and probe health:
  - POSIX: `AI_GATEWAY_API_KEY=x TWILIO_AUTH_TOKEN=y PUBLIC_HOST=localhost npm start`
  - PowerShell: `$env:AI_GATEWAY_API_KEY='x'; $env:TWILIO_AUTH_TOKEN='y'; $env:PUBLIC_HOST='localhost'; npm start`
  - Other terminal: `curl http://localhost:3000/health` → `{"ok":true}`; confirm exactly one boot log line with top-level `message`, string `level`, `event:"boot"`. Stop the server (Ctrl+C).
- [ ] Commit:
  ```
  feat(server): boot Fastify app with health route, state seam, and route-registration marker

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Acceptance

Discharges Spec 02 **A1** (boot + `/health` 200 + boot log contract) and the structural half of **R2/R6** (state seam + marker section). A9's pin check is performed in T02.3; drain behavior (A7/A8) is T02.4.

## Completion Report

```
Task: T02.1 — state seam + server skeleton
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <cmd → outcome, one line each>
Spec 02 acceptance verified: A1 <pass/fail + evidence line>
Deviations from plan: <none | list — expected: buildApp/main-guard restructuring of Spec 02 R3 (planned, for cross-platform testability)>
New interfaces exposed: buildApp(config, shutdownOpts?) → {app, shutdown}; ShutdownOpts; state.ts sessions/SessionHandle
Notes for ledger: <≤3 lines>
```

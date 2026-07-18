# T02.4 — SIGTERM graceful shutdown: drain sessions FIRST, then close

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Implement the drain-before-close shutdown contract in `src/server.ts` — onRequest drain gate, sessions-drain loop with 55 s deadline, straggler teardown, `app.close()` strictly last, idempotent signal handling — with in-process tests that never rely on real OS signals (Windows cannot deliver SIGTERM).

**Wave:** B · **Depends on:** T02.3 · **Blocks:** T05, T09, T10

**References:**
- `docs/specs/02-http-server-and-twiml-webhook.md` — R8 (the authority; verified snippet including the onRequest hook and shutdown loop), R2 (drain target contract), R9; acceptance A7, A8
- `docs/findings/08-fastify-ws-server-architecture.md` — V4, V9, V11, gotcha 2; §Graceful shutdown / SIGTERM drain
- `docs/findings/07-railway-deployment.md` — claim 9 (`drainingSeconds: 60`; default grace 0 s)
- `docs/findings/10-gap-analysis-and-contradictions.md` — C18, S25, S28
- `plans/02-http-twiml/01-state-and-server-skeleton.md` — §Interfaces (the `buildApp`/`ShutdownOpts` seam this task fills in)

## Interfaces

**Consumes:**
- From T02.1: `src/state.ts` `sessions` map + `SessionHandle.teardown(reason)`; `buildApp(config, shutdownOpts?)` and the stub `shutdown` + `ShutdownOpts` declaration in `src/server.ts`
- From T02.3: registered `/twiml`, `/stream-status`, `/health` routes (the drain gate discriminates by these URLs)

**Produces** (in `src/server.ts`):
- Real `ShutdownOpts` semantics: `{ deadlineMs = 55_000, pollMs = 500, exit = process.exit }` — defaults are Spec 02 R8's values; tests pass small ones. `deadlineMs` must stay under Railway's 60 s SIGKILL (comment it).
- `shutdown(signal: string): Promise<void>` returned from `buildApp` — sets `draining = true`, logs `shutdown-start` (with `signal`, `activeSessions`), polls `sessions.size` until empty or deadline, calls `teardown('server shutdown')` on stragglers, THEN `await app.close()`, logs `shutdown-complete`, calls `opts.exit(0)`. Idempotent via a `shuttingDown` flag (second call returns immediately).
- The onRequest drain gate inside `buildApp` per the Spec 02 R8 snippet: when draining — `/stream-status` passes through untouched; `/health` → 503; `req.ws` or `/twiml` → 503 (non-hijacked 503 on an upgrade request = clean non-101 refusal, findings/08 V11). Include the S28 accepted-risk comment at the hook ("deploy between test calls"; Twilio 503 retry behavior untested by design).
- Main-guard wiring (replacing T02.1's placeholder comment): `process.on('SIGTERM', () => void shutdown('SIGTERM'))` and same for `SIGINT` (Spec 02 R8 — SIGINT is the local-dev path and the ONLY one exercisable on Windows).

## Steps

- [ ] Read every file in References. The load-bearing ordering (findings/10 C18): drain loop and straggler sweep complete BEFORE `app.close()` — the plugin's default preClose severs every live WS in ~2 ms otherwise. Do NOT add a custom `preClose`.
- [ ] Write failing test `src/shutdown.test.ts` (`node:test` conventions; import `buildApp` from `./server.js`, `sessions` from `./state.js`; clear `sessions` in `beforeEach`). All cases in-process, no OS signals. Cases:
  1. **A7 gate + drain-before-close:** `const { app, shutdown } = await buildApp(cfg, { deadlineMs: 3000, pollMs: 25, exit: exitSpy })`. Before `app.ready()`, register a test-only WS route `app.get('/test-ws', { websocket: true }, () => {})`; open it via `app.injectWS('/test-ws')` and attach a close-listener spy. Put a fake `SessionHandle` (teardown spy that also `sessions.delete`s itself, per the R2 contract) into `sessions`. Start `const done = shutdown('SIGTERM')` WITHOUT awaiting. Then assert, while draining: `POST /twiml` → 503; `GET /health` → 503; `POST /stream-status` (A6-style form payload) → 204; a NEW `app.injectWS('/test-ws')` attempt fails (non-101 / rejected promise); the ALREADY-OPEN test WS has NOT received a close event. Then `sessions.delete(<key>)` to simulate natural call end → `await done` resolves quickly (well under `deadlineMs`); `exitSpy` called once with `0`; straggler `teardown` was NOT called.
  2. **A7 straggler sweep:** fresh `buildApp` with `{ deadlineMs: 300, pollMs: 25, exit: exitSpy }`; fake handle whose teardown spy self-deletes from `sessions` but is never removed otherwise; `await shutdown('SIGTERM')` → teardown called exactly once with `'server shutdown'`; `exitSpy(0)` called; total time ≈ deadline (assert < 2000 ms).
  3. **A8 idempotence:** call `shutdown('SIGTERM')` then immediately `shutdown('SIGINT')`; await both → `exitSpy` called exactly once; exactly one `shutdown-start` log line (capture via wrapped `process.stdout.write`, restore in `finally`).
  Run: `npx tsx --test src/shutdown.test.ts` → expect FAIL (stub shutdown does nothing).
- [ ] Implement per Spec 02 R8 — transcribe the spec's verified snippet into `buildApp`'s closure (the `draining` flag is shared by the hook and `shutdown`), parameterized only by `ShutdownOpts` as named in Produces. Wire `process.on('SIGTERM'/'SIGINT')` in the main guard only (never at import time). Keep behavior-contract comments 4–5 from R8 (S28 accepted risk; S25 best-effort caveat) in the code.
- [ ] Run `npx tsx --test src/shutdown.test.ts` → expect PASS (3/3).
- [ ] Run `npm test` → all suites PASS; `npm run typecheck` → clean; `npm run build` → clean.
- [ ] Optional (POSIX only — skip on Windows, note skip in report): boot `node dist/server.js` with dummy env (`AI_GATEWAY_API_KEY=x TWILIO_AUTH_TOKEN=y PUBLIC_HOST=localhost`), `kill -TERM <pid>` with empty `sessions` → process exits 0 promptly, logs `shutdown-start` then `shutdown-complete`.
- [ ] Commit:
  ```
  feat(server): SIGTERM drain-before-close graceful shutdown

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Acceptance

Discharges Spec 02 **A7** and **A8** (via injected-exit equivalents of "process exits 0"; the real-signal path is exercised on Railway at M1/M4 — S25). Completes Spec 02: A1–A9 all discharged across T02.1–T02.4.

## Completion Report

```
Task: T02.4 — SIGTERM drain shutdown
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <cmd → outcome, one line each>
Spec 02 acceptance verified: A7 <p/f>, A8 <p/f>; POSIX signal smoke: <done | skipped (Windows)>
Deviations from plan: <none | list — expected: exit/deadline injected via ShutdownOpts (planned, Windows-safe testing)>
New interfaces exposed: shutdown(signal) via buildApp result; ShutdownOpts defaults (55000/500/process.exit)
Notes for ledger: <≤3 lines — include that T09/T05 may rely on drain gate + 1001 straggler contract>
```

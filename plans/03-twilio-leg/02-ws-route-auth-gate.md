# T03.2 — `/twilio-media` WS route: registration, token auth gate, timeouts, close/error wiring

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Ship `src/twilio-media.ts` with `registerTwilioMediaRoute(app, deps)` — v11 `(socket, req)` handler, `connected`/`start` handling, `claimPendingCall` token gate (1008 on failure), 5 s start-timeout, synchronous close/error listeners with `stream-stop` summary — and wire the one registration line into `server.ts`'s marked section.

**Wave:** C · **Depends on:** T03.1, T02 · **Blocks:** T03.3, T03.4, T03.5, T05

**References:**
- `docs/specs/03-twilio-media-ws-leg.md` — R1 (plugin registration options), R2 (v11 handler API, synchronous listeners), R3 (inbound parsing rules + vendored TS types), R4 (`connected`/`start` state machine, auth gate), R7 (close/error handling, close-code interpretation), R10 (logging discipline)
- `docs/specs/02-http-server-and-twiml-webhook.md` — R2 (state map), R3 (boot sequence: `fastifyWebsocket` is ALREADY registered by Spec 02 — verify, don't duplicate), R5 (`claimPendingCall(candidate): PendingCall | undefined` signature + `PendingCall` shape), R6 (the `// --- route registration (Specs 03/07) ---` marker in `server.ts`)
- `docs/findings/08-fastify-ws-server-architecture.md` — V3/V4 (handler API, `injectWS`), V5/gotcha 14 (plugin options), gotchas 1, 7, 8, 9, 10 (crash/close pitfalls), error/close matrix
- `docs/findings/03-twilio-media-streams.md` — claim 4 (inbound schemas), claim 11 + Impl D (token gate, timeout guards), claim 1 (Connect fall-through hangup)
- Plan interfaces: `plans/03-twilio-leg/01-sessions-registry.md` §Interfaces (exact `createSession`/`teardownSession` signatures)
- Existing code to read first: `src/server.ts`, `src/twiml.ts` (for `claimPendingCall` export), `src/state.ts`, `src/sessions.ts`, `src/logger.ts`

## Interfaces

**Consumes:**
- T02: `claimPendingCall(candidate: string): PendingCall | undefined` from `src/twiml.ts`; the `// --- route registration (Specs 03/07) ---` section in `src/server.ts`; the already-registered `@fastify/websocket` plugin.
- T03.1: `Session`, `sessions`, `createSession`, `teardownSession` from `src/sessions.ts`.
- T01: `logEvent` from `src/logger.ts`; `AppConfig` from `src/config.ts`.

**Produces** (`src/twilio-media.ts` exports — stable for T03.3–T03.5 and T05):
- `export interface TwilioMediaDeps { config: Pick<AppConfig, 'publicHost' | 'twilioAuthToken' | 'twilioValidateUpgrade'>; claimPendingCall: (candidate: string) => { callSid: string } | undefined; onSessionStart: (session: Session) => void; }`
  (Type `twilioValidateUpgrade` as `boolean` now even though the config key lands in T03.5 — until then declare the pick as `Pick<AppConfig,'publicHost'|'twilioAuthToken'> & { twilioValidateUpgrade?: boolean }` so typecheck passes; T03.5 tightens it.)
- `export function registerTwilioMediaRoute(app: FastifyInstance, deps: TwilioMediaDeps): void` — declares `app.get('/twilio-media', { websocket: true }, (socket, req) => …)` per Spec 03 R2.
- Vendored TS types for the six inbound messages (Spec 03 R3 — string-typed `sequenceNumber`/`chunk`/`timestamp`), exported for test reuse (e.g. `TwilioInboundMessage` union).
- `src/server.ts` gains exactly one call inside the marked section: `registerTwilioMediaRoute(app, { config, claimPendingCall, onSessionStart: () => {} });` (the no-op `onSessionStart` is Spec 05's attach point — leave a `// Spec 05 replaces onSessionStart` comment).

**Behavior contract implemented here** (per Spec 03 R2/R4/R7): listeners attached synchronously before any await; 5 s start-timeout armed at handler entry (`socket.close(1008, 'no start')`), handle stored on the eventual session's `startTimer` field / handler closure and cleared on `start` and on `'close'`; `start` → extract fields, `claimPendingCall(token)` gate → on failure log `auth-fail` + `close(1008, 'bad token')`, never create a Session; on success `createSession(...)`, `sessions.set(streamSid, session)`, log `stream-start` (with `callSid`, `streamSid`, `mediaFormat`), call `deps.onSessionStart(session)`. `'error'` listener logs only; `'close'` listener `(code, reason: Buffer)` logs one `stream-stop` line (`code`, `reason: reason.toString()`, `abnormal` = code 1006 && no `stop` seen — track a `sawStop` flag in the handler closure for T03.4 to set — plus final `bufferedAmount`) then calls `teardownSession(session)` if a session exists. Binary frames ignored; JSON parse failure logs once and returns; unknown event names log once at debug. `media`/`mark`/`stop`/`dtmf` cases are stubs (`// T03.4`) this task leaves empty except `stop` setting nothing yet.

## Steps

- [ ] Read all References. In `src/server.ts`, verify the existing `fastifyWebsocket` registration matches Spec 03 R1 (`perMessageDeflate: false`, `maxPayload: 1 MB`, `errorHandler` logging `ws-error` then `socket.terminate()`); if the `errorHandler` is missing, add it exactly per Spec 03 R1 (additive edit — do not touch anything else outside the marked section). Do NOT register the plugin a second time.
- [ ] Write the failing tests `src/twilio-media.test.ts` using `fastify.injectWS('/twilio-media')` (pattern: findings/08 V4; runner: `node:test` per master plan §8 R-1). Build a small helper that constructs a real Fastify app, registers `@fastify/websocket` with the R1 options, and calls `registerTwilioMediaRoute` with a **stub** `claimPendingCall` (Map-backed, single-use) and a spy `onSessionStart`. Cases: (A1) `connected` then valid `start` → session in `sessions` keyed by the start message's `streamSid`, `onSessionStart` called once, one `stream-start` log line (capture via a `process.stdout.write` spy); (A2) `start` with missing / unknown / already-claimed token → close code 1008, `sessions` empty, `onSessionStart` never called; (A3) connect, send only `connected` → closed 1008 within ~5 s (use `node:test` mock timers, `mock.timers.enable({ apis: ['setTimeout'] })`, tick 5000; fall back to a deps-injected timeout override ONLY if mock timers prove incompatible with injectWS — record as deviation); (A12 partial) a binary frame and an unparseable text frame are ignored without close/teardown; plain HTTP `GET /twilio-media` via `app.inject` → 404. Clean up `sessions` between tests (`sessions.clear()`).
- [ ] Run `npm test` — expect FAIL (`src/twilio-media.ts` missing).
- [ ] Implement `src/twilio-media.ts` per the Behavior contract above and Spec 03 R2/R3/R4 (`connected`/`start` cases only) and R7. Wrap the `'message'` handler body in try/catch (findings/03 gotcha 7): exceptions log via `logEvent` and never throw out. Build the session's bound `log` wrapper here (closes over `logEvent` with `{ callSid, streamSid }` merged into fields — Spec 03 R9 comment; never `req.log`).
- [ ] Add the registration line + comment in `src/server.ts` inside `// --- route registration (Specs 03/07) ---` (Spec 02 R6). Touch nothing else in that file.
- [ ] Run `npm test` — expect PASS. Run `npm run typecheck` — expect exit 0. Boot smoke: `npm run build` then verify the server still boots (`AI_GATEWAY_API_KEY=x TWILIO_AUTH_TOKEN=y PUBLIC_HOST=localhost npm start`, check `/health` 200, Ctrl-C; on Windows PowerShell set the env vars with `$env:NAME='x'` first).
- [ ] Commit: `feat(twilio-media): WS route with token auth gate, start timeout, close wiring` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 03 **A1**, **A2** (gate behavior; the `timingSafeEqual` clause is Spec 02's compare helper — assert only that the route calls `claimPendingCall` and never compares tokens itself), **A3**, and the binary-frame/garbage/404 clauses of **A12**. (A12's repo-wide `connection.socket` grep re-runs in T03.5.)

## Completion Report

```
Task: T03.2 — /twilio-media route & auth gate
Status: <done | blocked (why)>
Files changed: <list, incl. exact server.ts lines added>
Commands run: npm test → <counts>; npm run typecheck → <exit>; boot smoke → <result>
Spec A-numbers verified: A1, A2, A3, A12 (partial)
Deviations from plan: <none | list — e.g. mock-timer fallback, errorHandler already present?>
New interfaces exposed: registerTwilioMediaRoute(app, deps), TwilioMediaDeps, inbound message types
Notes for ledger: <e.g. how stream-stop/sawStop closure is structured for T03.4>
```

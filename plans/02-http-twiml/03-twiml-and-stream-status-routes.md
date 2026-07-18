# T02.3 — POST /twiml (signature gate, mint kick-off, TwiML) + POST /stream-status

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Add `registerTwimlRoutes(app, config, deps?)` to `src/twiml.ts` — the signature-validated `POST /twiml` that mints the per-call token, kicks off the gateway `getToken` mint without awaiting it, and returns `<Connect><Stream>` TwiML — plus the log-only `POST /stream-status`; wire both into `src/server.ts`.

**Wave:** B · **Depends on:** T02.1, T02.2 · **Blocks:** T02.4, T03, T05

**References:**
- `docs/specs/02-http-server-and-twiml-webhook.md` — R5.1, R5.3, R5.4 (verified code snippets are the authority), R6, R7, R9, R10; acceptance A2, A3, A4, A6, A9
- `docs/findings/03-twilio-media-streams.md` — claims 1, 2, 9, 14, 15; Impl A (TwiML generation, execution-verified), Impl B (Fastify webhook validation), Impl E (`<Stream>` attributes / statusCallback fields); correction 5; gotchas 1, 8
- `docs/findings/08-fastify-ws-server-architecture.md` — V6 (validateRequest contract + `getExpectedTwilioSignature` test pattern), V7, gotcha 6
- `docs/findings/01-vercel-ai-gateway-realtime.md` — claim 5 (no `sessionConfig` in getToken), gotchas 1, 5, 10; §9 error taxonomy
- `docs/specs/04-gateway-realtime-leg.md` — R3 heading only: `mintRealtimeToken(modelId?)` — the function the mint kick-off will delegate to at the Wave B/C merge (implement NOTHING from Spec 04)

## Interfaces

**Consumes:**
- From T02.2 (`src/twiml.ts`, same file — extend it): `pendingCalls`, `PendingCall`, `PENDING_TTL_MS`, `claimPendingCall`, `sweepPendingCalls`
- From T02.1: `buildApp(config)` in `src/server.ts` (add the registration call above its marker); `logEvent` from `src/logger.ts`; `AppConfig` from `src/config.ts` (`publicHost`, `twilioAuthToken`, `modelId`)
- From T01 pins: `twilio@6.0.2` (default-import + destructure `validateRequest`; `twilio.twiml.VoiceResponse`; `twilio.getExpectedTwilioSignature` in tests), `@ai-sdk/gateway@4.0.23` (`gateway.experimental_realtime.getToken` — factory form ONLY, findings/10 C1)

**Produces** (exact names; T03/T05 and the Wave B/C merge rely on these):
- In `src/twiml.ts`:
  - `export type MintFn = (modelId: string) => Promise<{ token: string; url: string; expiresAt?: number }>` — return shape matches Spec 04 R3's `MintResult` (minus `getTokenMs`, an extra field callers may ignore); T04.2's as-planned `mintRealtimeToken(cfg, callSid, modelId?)` takes explicit config/callSid (ledger pre-declared deviation), so the Wave B/C merge delegation is the one-line adapter `mint: (modelId) => mintRealtimeToken(config, callSid, modelId)` — config and callSid are already in scope in the `/twiml` handler
  - `export interface TwimlDeps { mint?: MintFn }` (tests inject; default is the real getToken wrapper)
  - `export function registerTwimlRoutes(app: FastifyInstance, config: AppConfig, deps?: TwimlDeps): void` — registers `POST /twiml` (R5.1→R5.4) and `POST /stream-status` (R7). NOTE: two-arg-plus-deps form supersedes Spec 02 R6's one-arg illustration — config is injected, never re-loaded (planned deviation, record it).
  - internal `defaultMint` wrapping `gateway.experimental_realtime.getToken({ model, expiresAfterSeconds: 600 })` per Spec 02 R5.3, preceded by the merge marker comment, verbatim:
    ```
    // --- gateway mint (Wave B/C merge point: delegate to mintRealtimeToken from ./gateway.js once Spec 04 lands) ---
    ```
- In `src/server.ts`: the line `registerTwimlRoutes(app, config);` placed immediately ABOVE the `// --- route registration (Specs 03/07) ---` marker (replacing T02.1's placeholder comment). Touch nothing inside the marker section.

## Steps

- [ ] Read every file in References. Note the R5.1 rules that must NOT be "improved": params = parsed form object (never raw body); URL built from `config.publicHost` (never `req.hostname`/`req.protocol`); no URL normalization; on 403 → no mint, no map write, one warn line.
- [ ] Write failing tests appended to `src/twiml.test.ts` (or a new `src/twiml.routes.test.ts`; `node:test` conventions per Spec 01 R7). Shared setup: `buildApp(fixtureConfig)` with `fixtureConfig.publicHost = 'test.example.com'`, `twilioAuthToken = 'tok123'`; call `registerTwimlRoutes(app, fixtureConfig, { mint: <controllable fake> })` — note buildApp will NOT auto-register twiml routes until the implement step edits server.ts, so register manually in tests to start red. Helper: valid signature via `twilio.getExpectedTwilioSignature('tok123', 'https://test.example.com/twiml', params)` (findings/08 V6 pattern); send with `app.inject({ method:'POST', url:'/twiml', headers:{ 'content-type':'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, payload: new URLSearchParams(params).toString() })`. Capture log lines by temporarily wrapping `process.stdout.write` (restore in `finally`). Cases:
  1. **A2 happy path:** params `{ CallSid:'CA1', From:'+15550001111' }` + valid signature → 200, `content-type` `text/xml`; body contains `<Connect>`, `<Stream url="wss://test.example.com/twilio-media"` with NO `?` in the url attribute, `statusCallback="https://test.example.com/stream-status"`, `statusCallbackMethod="POST"`, exactly one `<Parameter name="token"` (regex-count), and nothing between `</Connect>` and `</Response>`.
  2. **A4 store + mint:** after case 1, `pendingCalls.size === 1`; the entry's `callSid === 'CA1'`; the fake mint was called once with `fixtureConfig.modelId`; the stored `gatewayAuth` resolves to the fake's value; a `getToken-resolved` log line carries `getTokenMs` and `expiresAt`.
  3. **A4 rejection safety:** fake mint returns `Promise.reject(new Error('boom'))` → `/twiml` still 200 with TwiML; one `getToken-failed` error line; NO unhandledRejection (assert via a `process.on('unhandledRejection')` listener installed for the test, plus `await new Promise(r => setImmediate(r))` to flush).
  4. **A3 bad signature:** wrong/missing `x-twilio-signature` → 403, `pendingCalls` unchanged, fake mint never called, one `twiml-bad-signature` warn line.
  5. **Sweep on hit:** pre-insert an entry aged past `PENDING_TTL_MS`; one valid `/twiml` hit leaves only the newly minted entry.
  6. **A6 stream-status:** `POST /stream-status` form payload `StreamEvent=stream-error&StreamError=x&CallSid=CA1&StreamSid=MZ1` (no signature header) → 204; one `stream-status` log line with `level:'error'` and top-level `callSid`, `streamSid`, `streamEvent`, `streamError`.
  Run: `npx tsx --test src/twiml.routes.test.ts` → expect FAIL (registerTwimlRoutes missing).
- [ ] Implement in `src/twiml.ts` per Spec 02 R5.1 (validateRequest exactly as the spec snippet), R5.3 (mint kick-off: NOT awaited; `.then`/`.catch` logging both mandatory — the `.catch` prevents process-killing unhandledRejection; no `sessionConfig`; store `{ callSid, createdAt, gatewayAuth }` under the `randomUUID()` token), R5.4 (VoiceResponse snippet verbatim; the G4 design lock: no verbs after `</Connect>`, no `action`), R7 (stream-status: log-only, always 204, no signature validation, `callSid` top-level), R9 (also emit `twiml-request` with `edgeMs` from `x-request-start` when present). `sweepPendingCalls()` runs at the top of every `/twiml` hit.
- [ ] Edit `src/server.ts`: replace the `// registerTwimlRoutes(app, config)  — added by T02.3` placeholder with the real call, directly above the untouched `// --- route registration (Specs 03/07) ---` marker. Update the server test's expectation if it asserted twiml absence.
- [ ] Run `npx tsx --test src/twiml.routes.test.ts` → expect PASS (6/6). Run `npm test` → all suites PASS. Run `npm run typecheck` → clean.
- [ ] Static checks (Spec 02 A9): search `src/` for `req.hostname` and `req.protocol` → zero hits; search for `rt.getToken` → zero hits (findings/10 C1); run `npm ls fastify @fastify/websocket @fastify/formbody twilio` → exactly `5.10.0` / `11.3.0` / `8.0.2` / `6.0.2`.
- [ ] Commit:
  ```
  feat(twiml): signature-validated /twiml with TwiML response, mint kick-off, and /stream-status

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Acceptance

Discharges Spec 02 **A2, A3, A4, A6, A9**. Leaves for later: mint delegation to Spec 04's `mintRealtimeToken` (orchestrator merge at the Wave B/C boundary, via the marker comment above); S15/S19 evidence review happens at M1, not here.

## Completion Report

```
Task: T02.3 — /twiml + /stream-status routes
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <cmd → outcome, one line each>
Spec 02 acceptance verified: A2 <p/f>, A3 <p/f>, A4 <p/f>, A6 <p/f>, A9 <p/f>
Deviations from plan: <none | list — expected: registerTwimlRoutes(app, config, deps?) supersedes R6 one-arg form (planned)>
New interfaces exposed: registerTwimlRoutes, MintFn, TwimlDeps; mint merge-marker comment in twiml.ts
Notes for ledger: <≤3 lines>
```

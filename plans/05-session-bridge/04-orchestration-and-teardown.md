# T05.4 — Call-start orchestration, teardown matrix & server wiring

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Implement the per-call bridge bootstrap (`onSessionStart`: mint → MCP client/tools → transcoder → `openGatewayLeg` → hook installation), the ONE idempotent teardown implementation (R11 matrix), the `onGatewayFailure` seam for T09, and the `server.ts` wiring.

**Wave:** D · **Depends on:** T05.1, T05.2, T05.3, T02, T03, T04, T06, T07, T08 · **Blocks:** T10, T09-merge (`onGatewayFailure` wiring)

**References:**
- `docs/specs/05-session-bridge-and-barge-in.md` — R1 (Session fields incl. `mcpClient`, `heartbeat`, `tornDown`), R11 (teardown function + trigger matrix + invariants), R12 (heartbeat clearing only), Deliverables note (`server.ts` modified only insofar as the route constructs a Session), A4/A5/A6/A12
- `docs/specs/02-http-server-and-twiml-webhook.md` — R2 (`SessionHandle`/`sessions` in `src/state.ts` — drain polls `sessions.size`), R5.2 (`PendingCall { callSid, createdAt, gatewayAuth }`), R5.3 (mint kicked off at webhook; Spec 05 awaits `gatewayAuth`; rejection = FR-7 trigger), R8 (drain calls `s.teardown(...)`; stragglers close 1001)
- `docs/specs/03-twilio-media-ws-leg.md` — R4 start case (`deps.onSessionStart(session)` invoked after `claimPendingCall` success), R7 (teardownSession semantics, close-code table: 1000/1001/1008/1011), R9 (`createSession`, `teardownSession`, hooks `onTwilioMedia`/`onTeardown`)
- `docs/specs/04-gateway-realtime-leg.md` — R3 (`MintResult`), R5 (`openGatewayLeg(opts)`, `GatewayLegCallbacks`: `onOpen`/`onOpenFailed`/`onEvent`/`onClose`; `formats` injected — never hand-built), R8 (gateway.ts owns session-update + greeting), R11 (close decode), R12 (heartbeat ownership)
- `docs/specs/06-audio-dsp-transcoding.md` — R2 (`audioFormatsFor(config.audioMode)` — Spec 05 MUST inject it), R3 (`createTranscoder`)
- `docs/specs/07-mcp-server-and-tool-loop.md` — R7 (`createMcpClient(port)` per call), R8 (`fetchToolDefs` before session-update), R14 (`toolLoop.dispose()` + `client.close()` at teardown)
- `docs/specs/08-logging-and-latency-instrumentation.md` — R7 (greeting record stamps collected during bootstrap), R12 (`stream-stop` summary shape)
- `docs/findings/08-fastify-ws-server-architecture.md` — §shutdown, §error/close matrix, gotchas 2, 9–11
- `docs/findings/10-gap-analysis-and-contradictions.md` — C18, T7, G4
- `docs/specs/00-master-build-plan.md` — §3 Wave D merge points (`onGatewayFailure` ← T09's `playFallbackAndClose`; mint delegation note), §6 G4

## Interfaces

**Consumes:**
- `PendingCall` from `src/twiml.ts` (Spec 02 R5.2) — `pendingCall.gatewayAuth: Promise<{token; url; expiresAt?}>` (post-merge this is Spec 04's `MintResult` from `mintRealtimeToken` — consume whichever shape the as-built code stores; T05.4 only awaits it).
- `registerTwilioMediaRoute(app, deps)` from `src/twilio-media.ts` and `createSession`/`teardownSession`/`sessions` from `src/sessions.ts` (Spec 03). The `sessions` map is the SINGLE process-wide instance re-exporting Spec 02's `src/state.ts` map — this task must NOT create any second map.
- `openGatewayLeg`, `GatewayLegCallbacks`, `GatewayLeg` from `src/gateway.ts` (Spec 04 R5).
- `createTranscoder`, `audioFormatsFor` from `src/dsp.ts` (Spec 06 R2/R3).
- `createMcpClient`, `closeMcpClient`, `fetchToolDefs`, `ToolLoop` from `src/tools.ts` (Spec 07 R7/R8/R10/R14).
- `TurnRecorder` from `src/latency.ts` (Spec 08).
- `dispatch`, `handleTwilioMedia` from `src/session.ts` (T05.2), `onMarkEcho` wiring state (T05.1), turn/tool wiring (T05.3).

**Produces:**
- In `src/session.ts`:
  - `export async function startSessionBridge(session: Session, pendingCall: PendingCall): Promise<void>` — the implementation Spec 03's `deps.onSessionStart` points at.
  - `export function setOnGatewayFailure(fn: (s: Session) => void | Promise<void>): void` — module-level seam, default no-op; invoked before the Twilio close on the gateway-close teardown row. **This is the T09 merge point** (Spec 09's `playFallbackAndClose` plugs in here at the Wave D merge, gated on S23 — do NOT wire any fallback in this task).
- ONE teardown implementation per Spec 05 R11, reconciled into Spec 03's `teardownSession`/`Session.teardown(reason)` seam (see Steps — no second parallel teardown path).
- Modified `src/server.ts`: inside the marked `// --- route registration (Specs 03/07) ---` section ONLY, the `registerTwilioMediaRoute(app, deps)` call gains `onSessionStart: startSessionBridge`. No other `server.ts` changes.
- `src/teardown.test.ts`. (Interim `src/` location per the `npm test` glob `src/**/*.test.ts`; T10.1 migrates it under `test/`.)

## Steps

- [ ] Read the References, then the as-built `src/twilio-media.ts` (does `deps.onSessionStart` receive the claimed `PendingCall`?), `src/sessions.ts` (`teardownSession` body, `onTeardown` hook), `src/state.ts`, `src/server.ts` (route-registration marker), `src/twiml.ts` (`PendingCall` shape), `src/gateway.ts`, `src/tools.ts`, `src/latency.ts`.
- [ ] If the as-built `deps.onSessionStart` signature is `(session)` only, extend it ADDITIVELY to `(session, pendingCall)` in `src/twilio-media.ts` (the route's `start` case already holds the claimed `PendingCall` — Spec 03 R4 step 4); keep Spec 03's tests green (update their stub deps if needed).
- [ ] Write `src/teardown.test.ts` (same runner style; fake gateway leg with recorded `close`, fake `twilioWs`, fake MCP client with `close()` spy, real `sessions` map). Required cases:
  - **A12 idempotency:** call teardown twice → each socket closed at most once, `mcpClient.close()` once, `clearInterval(heartbeat)` effective, `sessions.delete` exactly once, exactly one `stream-stop` summary line.
  - **A12 same-tick cross-trigger:** fire the Twilio `'close'`-path teardown and the gateway `onClose`-path teardown in the same tick → same single-execution result.
  - **A5 unit analog (gateway dies):** invoke the wired `GatewayLegCallbacks.onClose({code, reason})` → verbatim `gateway-close` log, `onGatewayFailure` seam invoked BEFORE `twilioWs.close(1000)`, `sessions.size` returns to 0 — no dead-air path.
  - `onOpenFailed` → teardown with the Twilio leg closed (FR-7 at handshake).
  - **A6 unit analog (drain cooperation):** teardown invoked via the Spec 02 drain path (reason indicating shutdown) closes the Twilio WS with code **1001**; a normal `stop` closes with 1000 (Spec 05 R11 `opts.twilioCloseCode` / Spec 03 R7 code table).
  - **A4 unit analog (isolation):** two sessions in the map; teardown of one leaves the other untouched (sockets open, map entry intact).
  - Mint rejection: `startSessionBridge` with a rejecting `gatewayAuth` → logged error + teardown (clean hangup), no gateway leg opened, no unhandled rejection.
  - `fetchToolDefs` failure: call proceeds with `tools: []` + one error log (FR-7 — a tool failure never kills the call).
  - Bootstrap wiring: after `startSessionBridge` with fakes, `session.onTwilioMedia` forwards to `handleTwilioMedia`, `openGatewayLeg` received `formats` deep-equal to `audioFormatsFor(config.audioMode)` and the fetched `tools` array, and `callbacks.onEvent` is `dispatch`-backed.
- [ ] Run the suite; expect FAIL.
- [ ] Implement `startSessionBridge` per Spec 05 R1 + the References: (1) await `pendingCall.gatewayAuth` (catch → log + `session.teardown('mint-failed')`, return); (2) `session.transcoder = createTranscoder(config.audioMode)`; (3) `session.mcpClient = await createMcpClient(config.port)` + `fetchToolDefs` (per-call, before session-update — Spec 07 R8; failures → `[]`); (4) construct `TurnRecorder` + `ToolLoop` (T05.3 wiring); (5) `session.gateway = openGatewayLeg({ mint, callSid, tools, formats: audioFormatsFor(config.audioMode), callbacks })` with callbacks: `onOpen` → log (Spec 04 owns session-update/greeting sends), `onOpenFailed` → teardown, `onEvent: (ev) => dispatch(session, ev)`, `onClose: (info)` → verbatim log → `onGatewayFailure(session)` → teardown `'gateway-close'`; (6) install `session.onTwilioMedia`, `session.onTeardown` hooks.
- [ ] Reconcile teardown into ONE implementation (Spec 05 R11 note "this function is the implementation behind Spec 03's teardownSession — ONE teardown implementation process-wide"): keep Spec 03's `teardownSession(s)`/`s.teardown(reason)` as the single funnel (tornDown latch + `sessions.delete` + start-timeout clear), and have this task's additions run via the funnel (either extend `teardownSession`'s body or install them in `session.onTeardown`): `clearInterval(heartbeat)`, `toolLoop.dispose()`, `void closeMcpClient(mcpClient)` when set (T07.2's wrapper — Spec 07 R14), `gateway.close(1000, 'call ended')`, `twilioWs.close(twilioCloseCode ?? 1000)`, `stream-stop` summary emission (Spec 08 R12 shape via the recorder). Shutdown reason → 1001 close code. Spec 03's tests must stay green; do NOT write a second standalone teardown function that bypasses the funnel.
- [ ] Wire `src/server.ts`: add `onSessionStart: startSessionBridge` (adapting to the deps shape) to the existing `registerTwilioMediaRoute` call inside the `// --- route registration (Specs 03/07) ---` marked section. Touch nothing else in `server.ts` (T03/T07 own their registration lines).
- [ ] Run targeted suite; expect PASS. Run `npm test`; expect ALL suites green (Specs 02/03/04/06/07/08 suites must not regress).
- [ ] Run `npm run typecheck && npm run build`; expect exit 0.
- [ ] Boot smoke (build-verify): set dummy env (`AI_GATEWAY_API_KEY=x`, `TWILIO_AUTH_TOKEN=y`, `PUBLIC_HOST=localhost` — per Spec 01's boot contract) and run `npm start` in the background, then `curl http://localhost:3000/health`; expected: `{"ok":true}` and no boot crash. Stop the process.
- [ ] Final A14 sweep: `git grep -n "response-cancel" -- src` → no output.
- [ ] Commit with message:
  `feat(session): call-start orchestration, idempotent teardown matrix, onGatewayFailure seam` and trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Acceptance

Discharges Spec 05 **A12** (unit) and the unit analogs of **A4/A5/A6**; completes the structural requirements behind FR-3/FR-7. Live A1/A2/A4/A5/A6 are executed on the deployed service at M2/M4 via T10; the T09 `playFallbackAndClose` → `setOnGatewayFailure` wiring happens at the Wave D merge (orchestrator), not here.

## Completion Report

```
Task: T05.4 — Orchestration, teardown & server wiring
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <command → outcome, one line each>
Spec A-numbers verified: <A12 + A4/A5/A6 unit analogs with test names>
Deviations from plan: <none | list>
New interfaces exposed: startSessionBridge(session, pendingCall); setOnGatewayFailure(fn); deps.onSessionStart signature as-built
Notes for ledger: <where teardown additions landed (teardownSession body vs onTeardown hook); PendingCall/MintResult shape consumed; server.ts marker line touched>
```

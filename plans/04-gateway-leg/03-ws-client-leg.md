# T04.3 — WS client construction + `GatewayLeg` lifecycle

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Implement `openGatewayLeg` — ws client construction with the mandatory options, synchronous listeners, typed send/receive plumbing (single + array frames), terminal `onOpenFailed`/`onClose` contract, and the optional ping timer — tested against a local mock ws server.

**Wave:** B · **Depends on:** T04.1, T04.2 · **Blocks:** T04.4, T04.5, T05

**References:**
- `docs/specs/04-gateway-realtime-leg.md` — §R4 (construction), §R5 (public interface + lifecycle contract), §R6 (send/receive helpers, array frames, never-batch rule), §R11 (close handling), §R12 (keepalive), §A2, §A6, §A10, §A12
- `docs/findings/08-fastify-ws-server-architecture.md` — §Gateway-leg ws client (per call) (the verified client snippet: options, listener order), §Error/close-code handling matrix, gotchas 9–11 (Buffer reason, unhandled-'error' crash, missing handshakeTimeout default)
- `docs/findings/02-ai-sdk-realtime-event-protocol.md` — §The model interface and factory (`getWebSocketConfig` protocols), claims 3–5 (serialize/parse ceremony, array return)
- `docs/findings/01-vercel-ai-gateway-realtime.md` — claim 7 (auth rides in subprotocols), gotcha 8 (256 KB message cap), Impl 10 (`unexpected-response`)
- `docs/specs/01-scaffolding-and-toolchain.md` — §R7 (test harness), §R12 (`logEvent` boundary)
- Neighboring plan interfaces: `plans/04-gateway-leg/02-token-mint.md` §Interfaces (`MintResult`, config-parameter convention)

## Interfaces

**Consumes:** `MintResult` (T04.2, same file); `AppConfig` fields `gatewayHandshakeTimeoutMs`, `gatewayPingSeconds` (T04.1); `logEvent` (Spec 01 R12); `WebSocket` + `WebSocketServer` from `ws@8.21.1`; `gateway.experimental_realtime(modelId)` codec instance (`getWebSocketConfig`, `serializeClientEvent`, `parseServerEvent`).

**Produces** (appended to `src/gateway.ts`):
- `export interface GatewayLegCallbacks` — verbatim Spec 04 R5 (`onOpen`, `onOpenFailed(info)`, `onEvent(ev: ServerEvent)`, `onClose(info)`)
- `export interface OpenGatewayLegOptions` — Spec 04 R5 **plus one amendment**: add field `config: AppConfig` (same no-singleton rationale as T04.2; record as deviation-by-design). Fields: `mint`, `callSid`, `tools: ToolDefinition[]`, `formats`, `config`, `callbacks`.
- `export function openGatewayLeg(opts: OpenGatewayLegOptions): GatewayLeg` and `export interface GatewayLeg { send; appendAudio; isOpen; close }` — verbatim Spec 04 R5
- `export function gatewayWsOptions(cfg: AppConfig): { perMessageDeflate: false; handshakeTimeout: number; maxPayload: number }` — small pure helper so A2 is testable "against a recorded options object"; `openGatewayLeg` MUST construct its `WebSocket` with exactly this helper's output
- NEW test-helper file `src/gateway.mock.test.ts` — exports `startMockGateway(): Promise<{ url, port, frames: unknown[], nextConnection(), send(json), sendRaw(text), close(code, reason), ping capture, stop() }>` (exact member names at implementer's discretion; document them in the completion report — T04.4/T04.5 tests import this). Contains ZERO test registrations. Named `*.test.ts` deliberately: excluded from `dist` by the build, harmless under `tsx --test` (0 tests = pass); T10 later relocates it to `test/fakes/`.

## Steps

- [ ] Read the References, especially Spec 04 R4–R6/R11–R12 in full and the findings/08 client snippet.
- [ ] Write `src/gateway.mock.test.ts`: `new WebSocketServer({ port: 0, host: '127.0.0.1' })`. **Trap:** the client sends subprotocols (`ai-gateway-realtime.v1`, `ai-gateway-auth.<token>`); ws@8 clients error out if the server selects none — the mock MUST set `handleProtocols: (protocols) => protocols.values().next().value`. Also register a `'ping'` listener on each connection for A12.
- [ ] Write failing tests in `src/gateway.leg.test.ts` (`node:test`, plain Node env; build fixture config via `loadConfig({AI_GATEWAY_API_KEY:'x', TWILIO_AUTH_TOKEN:'y', PUBLIC_HOST:'localhost', ...overrides})`; fake mint `{token:'vcst_test', url: mock.url, getTokenMs: 0}` — `openGatewayLeg` connects to `mint.url`, so no URL-override seam is needed). Cases:
  - **A2:** `gatewayWsOptions(cfg)` deep-equals `{ perMessageDeflate: false, handshakeTimeout: 5000, maxPayload: 16777216 }` with default config
  - open path: `onOpen` fires; `leg.isOpen === true`; a `gateway-open` log line with Δ-from-mint is emitted (Spec 04 R13)
  - `send`/`appendAudio`: after open, `leg.appendAudio('AAAA')` → mock receives one frame `{type:'input-audio-append', audio:'AAAA'}`; one frame per call (never batched, Spec 04 R6)
  - **A6:** mock sends one frame `[{"type":"response-created","raw":{}},{"type":"audio-delta","raw":{},"responseId":"r1","itemId":"i1","delta":"AA=="}]` → `onEvent` fires twice in that order and a `gateway-array-frame` log line (count 2) is emitted (the identity `parseServerEvent` passes normalized-shape JSON through — mock frames use normalized event shapes)
  - parse error: mock sends `not-json{{` → one `gateway-parse-error` log line with a ≤200-char snippet; `onEvent` NOT called; socket stays open
  - **A10 close:** mock closes with `(4001, 'test-reason')` → `onClose({code: 4001, reason: 'test-reason'})` — reason is a STRING (Buffer decoded, findings/08 gotcha 9) — and a `gateway-close` log line with both verbatim
  - **A10 non-101:** plain `node:http` server replying 403 to the upgrade → `onOpenFailed` fires with `statusCode: 403`, `onClose` does NOT fire, and a `gateway-upgrade-refused` line is logged (mutually exclusive terminal signals, Spec 04 R5)
  - post-terminal guard: after close, `await leg.send(...)`/`appendAudio(...)` resolve as silent no-ops (mock receives nothing; at most one debug line)
  - **A12:** with `gatewayPingSeconds: 1` the mock receives ≥1 ws ping within ~1.5 s and no further pings after `leg.close()` (timer cleared); with the default `0` no ping arrives within the same window (A12's "25" is the config unit — 1 s keeps the test fast; note this in the report)
- [ ] Run `npx tsx --test src/gateway.leg.test.ts` — expect FAIL.
- [ ] Implement in `src/gateway.ts` per Spec 04 R4/R5/R6/R11/R12 and the findings/08 §Gateway-leg client snippet: `rt = gateway.experimental_realtime(modelId)`; `cfg = rt.getWebSocketConfig({token, url})`; `new WebSocket(cfg.url, cfg.protocols, gatewayWsOptions(config))`; attach `open`/`message`/`error`/`close`/`unexpected-response` listeners synchronously at construction (an unhandled `'error'` kills every concurrent call — findings/08 gotcha 10); `send` awaits `rt.serializeClientEvent` with the OPEN-state guard; `message` handler = try/parse → array-normalize → `handleEvent(ev)` for each, where `handleEvent` in THIS task only forwards to `callbacks.onEvent` (T04.5 builds the full table); `'error'` after open → `gateway-ws-error` log only, teardown deferred to `'close'`; handshake-timeout/`unexpected-response`+`'error'`-before-open → `onOpenFailed` exactly once; ping timer per R12 started on `'open'`, `clearInterval` in `'close'`.
- [ ] Run `npx tsx --test src/gateway.leg.test.ts` — expect PASS. Then `npm test` and `npm run typecheck` — exit 0.
- [ ] Commit: `feat(gateway): openGatewayLeg ws client with lifecycle contract and mock-server tests` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Discharges Spec 04 **A2**, **A6**, **A10**, **A12**. Establishes the R5 lifecycle contract Spec 05 consumes (`onOpenFailed`/`onClose` mutual exclusivity, post-terminal no-op sends).

## Completion Report

```
Task: T04.3 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome]
Spec 04 A-numbers verified: A2, A6, A10, A12
Deviations from plan: OpenGatewayLegOptions.config added (no-singleton rule) [plus any others]
New interfaces exposed: GatewayLeg, GatewayLegCallbacks, OpenGatewayLegOptions (+config), openGatewayLeg, gatewayWsOptions; startMockGateway members: [list exact names]
Notes for ledger: [anything T04.4/T04.5 must know about the mock helper]
```

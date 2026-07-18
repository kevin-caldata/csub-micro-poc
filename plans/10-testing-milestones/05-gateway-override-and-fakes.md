# T10.5 — `GATEWAY_WS_URL` override seam + fake-gateway & fake-twilio

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Add the test-only `GATEWAY_WS_URL` override to `config.ts`/`gateway.ts` (the ONLY production-code change Spec 10 makes) and build the two offline fakes: a protocol-faithful fake gateway WS server and a fake Twilio WS client.

**Wave:** E · **Depends on:** T10.1, T02, T03, T04 · **Blocks:** T10.6

**References:**
- `docs/specs/10-testing-spikes-and-milestones.md` — R9 (fake-gateway behavior contract incl. the S5-assumption `session-updated.raw` fixture), R10 (override semantics), R11 (fake-twilio items 1–5)
- `docs/specs/04-gateway-realtime-leg.md` — R3 (`MintResult`), R4 (connect sequence: `getWebSocketConfig`, ws client options), R5 (`openGatewayLeg` / `GatewayLeg` / `GatewayLegCallbacks`) — the override bypasses R3/R4's mint+config, nothing else
- `docs/specs/02-http-server-and-twiml-webhook.md` — `/twiml` handler + token mint + `<Parameter name="token">` (what fake-twilio drives)
- `docs/findings/02-ai-sdk-realtime-event-protocol.md` — §Client → server events + §Server → client events (the complete unions the fake speaks verbatim), §Session config
- `docs/findings/03-twilio-media-streams.md` — claims 4–5 (message shapes, string numerics, mark/clear semantics), claim 15 (`getExpectedTwilioSignature`), gotcha 3
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — D2 (response event order), V9 (truncate ack arrives as `custom`), G7 (single gated `response-create`)
- `docs/findings/01-vercel-ai-gateway-realtime.md` — claim 8 (30 s first-message rule the fake mirrors at 5 s)
- `docs/findings/09-latency-instrumentation.md` — §2 (server-vad flow the scripted VAD turn follows)
- Master plan §6 R-2: `config.ts` edits are ADDITIVE — do not restructure existing keys.

## Interfaces

**Consumes:**
- `src/config.ts` (additive edit), `src/gateway.ts` (`openGatewayLeg` internals), `.env.example` (one commented line).
- `twilio@6.0.2` — `getExpectedTwilioSignature` (import path per findings/03 claim 15).
- `ws@8.21.1` — `WebSocketServer` (fake-gateway), `WebSocket` client (fake-twilio).

**Produces:**
- `src/config.ts` — optional `config.gatewayWsUrl?: string` from env `GATEWAY_WS_URL` (no validation beyond string; absent = undefined).
- `.env.example` — `# GATEWAY_WS_URL= (test harness only)` comment line, nothing more (R10).
- `src/gateway.ts` — when `config.gatewayWsUrl` is set: skip `mintRealtimeToken`/`getWebSocketConfig`, open `new WebSocket(GATEWAY_WS_URL, [], { perMessageDeflate: false })` directly; all listener wiring, parse, dispatch, callbacks unchanged; behavior bit-identical when unset.
- `test/fakes/fake-gateway.ts` — exports `startFakeGateway(opts: { port?: number; scenario?: FakeGatewayScenario }): Promise<{ port: number; received: unknown[]; close(): Promise<void> }>` (name it exactly `startFakeGateway`); `FakeGatewayScenario` flags per R9 (`benignError`, `arrayFrame`, `unmappedCustom`, `bargeIn`, `toolCall`); CLI entry via `node --import tsx test/fakes/fake-gateway.ts`.
- `test/fakes/fake-twilio.ts` — exports `runFakeCall(opts: { baseUrl: string; authToken: string; publicHost: string; script?: CallScript }): Promise<CallCapture>` (name it exactly `runFakeCall`); `CallCapture` exposes collected outbound `media`/`mark`/`clear` traffic + timings (R11.5); CLI entry likewise.

## Steps

- [ ] Read the References; open `src/config.ts` and `src/gateway.ts` to locate the mint/connect code path (Spec 04 R3/R4).
- [ ] Additive `config.ts` edit + `.env.example` comment per Produces. Run `npm test` — expect PASS (no existing test touched).
- [ ] Edit `src/gateway.ts` per R10: branch only at socket construction; when the override is set there is no token, so the `protocols` array is `[]`. Guard: production path must be reachable and unchanged — verify by running the existing gateway unit tests (`npx vitest run` on the gateway test file) — expect PASS.
- [ ] Write `test/fakes/fake-gateway.ts` implementing the full R9 behavior contract in order: 5 s first-message timer requiring `session-update`; reply `session-created` then `session-updated` with the R9 raw fixture **verbatim, carrying the required comment that its shape is the S5 assumption** (update-after-M1 note per Spec 10 §Open items); `response-create` → the D2 event order with ~50 ms delta cadence (160-byte 0xFF μ-law silence, base64); scripted VAD turn after ≥25 `input-audio-append` frames; scripted barge-in with truncate validation + `custom` ack + `response-done {status:'cancelled'}`; scripted tool call asserting `conversation-item-create` then exactly ONE `response-create`; scenario-flagged anomalies (benign error, JSON-array frame, unmapped `custom {rawType:'rate_limits.updated'}`). Every emitted event must be a valid member of findings/02's server union with `raw` present.
- [ ] Verify standalone: `node --import tsx test/fakes/fake-gateway.ts` boots and logs its port; connect with a throwaway ws client script or `npx tsx -e` one-liner sending `{"type":"session-update",...}` and confirm the two session replies. Kill it.
- [ ] Write `test/fakes/fake-twilio.ts` per R11 items 1–5: POST `/twiml` form-encoded with the R11.1 params and `X-Twilio-Signature` from `getExpectedTwilioSignature(authToken, 'https://' + publicHost + '/twiml', params)`; parse `<Parameter name="token" value="..."/>`; open `ws://localhost:<port>/twilio-media`; send `connected` then `start` (R11.2 exact shape, `customParameters:{token}`, string `sequenceNumber`); stream 20 ms silence `media` frames with string `timestamp` advancing by 20; playback simulation with byte-count accounting at 8 bytes/ms, delayed `mark` echo, and on `clear` immediately echo ALL pending marks + zero the buffer (R11.4 — this drives R6's tolerance live); `stop` + close; return `CallCapture`.
- [ ] Verify standalone: `node --import tsx test/fakes/fake-twilio.ts` prints usage or runs against a URL given via argv (implement a minimal argv CLI: `--base-url`, `--auth-token`, `--public-host`).
- [ ] Run `npm test` and `npm run typecheck` — expect PASS (fakes compile; no production regression).
- [ ] Commit 1: `feat(gateway): test-only GATEWAY_WS_URL override seam (Spec 10 R10)`; Commit 2: `test(fakes): protocol-faithful fake gateway server and fake Twilio client`; both with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Delivers the R9/R10/R11 deliverables that **A6** depends on (T10.6 discharges A6). R10's "production behavior bit-identical when unset" is verified by the untouched gateway suite staying green.

## Completion Report

```
Task: T10.5 — Status: DONE | BLOCKED(<why>)
Files changed: <list>
Commands run: npm test → <n passed>; standalone fake boots → <ok/notes>
Spec A-numbers verified: (enables A6)
Deviations from plan: <none | list>
New interfaces exposed: startFakeGateway(opts), runFakeCall(opts), config.gatewayWsUrl
Notes for ledger: <1-2 lines>
```

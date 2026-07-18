# T10.6 — Offline integration harness (`test/harness.test.ts`)

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Boot the real Fastify app in-process against the fake gateway and fake Twilio client and assert the full scripted-call contract (Spec 10 R12 items a–h) with zero network access.

**Wave:** E · **Depends on:** T10.5, T05, T07 · **Blocks:** T10.8

**References:**
- `docs/specs/10-testing-spikes-and-milestones.md` — R12 (assertions a–h), R1 (15 s testTimeout exists for this file), A6
- `plans/10-testing-milestones/05-gateway-override-and-fakes.md` — §Interfaces (exact `startFakeGateway`/`runFakeCall` signatures + scenario flags)
- `docs/specs/02-http-server-and-twiml-webhook.md` — server boot/close exports (how to start the app in-process on an ephemeral port; use the exported build/boot function, not `npm start`)
- `docs/specs/05-session-bridge-and-barge-in.md` — dispatch/turn lifecycle (what produces the `stream-stop` summary)
- `docs/specs/07-mcp-server-and-tool-loop.md` — `/mcp` route + `fetchToolDefs` (assertion (a) checks tools came from the LIVE route)
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — D5 (greeting order), G7 (single gated `response-create`)
- `docs/findings/09-latency-instrumentation.md` — §5 (`stream-stop` summary fields `ttfbP50`/`turns`)

## Interfaces

**Consumes:**
- `startFakeGateway`, `runFakeCall` from T10.5 (exact signatures in that plan's Interfaces).
- The app's exported boot function from `src/server.ts` (Spec 02 — confirm the exported name in source; if `server.ts` only boots at import time with no export, add a minimal `export function buildApp()`-style seam consistent with Spec 02's structure and note it as a deviation).
- Env for the run (set via `process.env` before importing the app, or vitest `env` option): `GATEWAY_WS_URL=ws://localhost:<fakeGwPort>`, `AUDIO_MODE=pcmu`, `AI_GATEWAY_API_KEY=test`, `TWILIO_AUTH_TOKEN=test-token`, `PUBLIC_HOST=localhost:<appPort>`, `PORT=0`.

**Produces:**
- `test/harness.test.ts` — one describe block per scenario: baseline call, barge-in scenario, tool scenario, anomaly scenario (array frame + benign error + unmapped custom).

## Steps

- [ ] Read the References; confirm the fake interfaces and the app boot export.
- [ ] Write the harness skeleton: `beforeAll` starts fake gateway on an ephemeral port, sets env, boots the real app on port 0 and reads the bound port; `afterAll` closes app then fake; hook `process.on('unhandledRejection')` and a stderr-write spy for assertion (h).
- [ ] Baseline-call test — run `runFakeCall` with the default script and assert R12 (a) `session-update` is the fake's first received message and its `config.tools` came from the live `/mcp` route with `$schema` stripped; (b) greeting `response-create` follows `session-update`; (c) each inbound media frame arrived as one `input-audio-append` with byte-identical base64 (Path A identity); (d) every `audio-delta` reached fake-Twilio as `media` followed by a `mark`; (g) `stop` tears down both legs and the `stream-stop` summary line carries `ttfbP50`/`turns` (capture log lines via a stdout-write spy and JSON-parse them).
- [ ] Run `npx vitest run test/harness.test.ts` — iterate until the baseline scenario PASSES. Integration failures here are real wiring bugs (T05/T07 scope): diagnose against the specs; fix only what a spec unambiguously mandates, otherwise report as BLOCKED with the exact assertion and captured traffic.
- [ ] Barge-in test — scenario flag `bargeIn`: assert R12 (e) `clear` precedes `conversation-item-truncate` and `audioEndMs` equals the fake's playback-position math (byte-count accounting from the fake-twilio capture).
- [ ] Tool test — scenario flag `toolCall`: assert R12 (f) the real MCP server round-trip produced a `conversation-item-create` function-call-output followed by exactly ONE `response-create`, and a follow-up audio response played.
- [ ] Anomaly test — flags `arrayFrame` + `benignError` + `unmappedCustom` on one call: assert both array-frame events processed in order, benign error survived (call continues), unmapped custom ignored silently, and the call still ends cleanly.
- [ ] Assert (h) globally in `afterEach`: zero unhandled rejections, zero stray stderr writes during scenarios.
- [ ] Run `npm test` — expect PASS repo-wide, offline (disable Wi-Fi or trust the fakes: no assertion may reach a non-localhost host).
- [ ] Commit: `test(harness): offline end-to-end scripted call through the real bridge (Spec 10 R12)` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 10 **A6** (full offline scripted call: greeting order, per-frame append passthrough, barge-in clear→truncate, single gated tool `response-create`, array-frame handling, benign-error survival, clean teardown with `stream-stop` summary).

## Completion Report

```
Task: T10.6 — Status: DONE | BLOCKED(<why + assertion + captured traffic>)
Files changed: <list>
Commands run: npx vitest run test/harness.test.ts → <result>; npm test → <n passed>
Spec A-numbers verified: A6
Integration bugs found/fixed (with spec citation): <none | list>
Deviations from plan (e.g. buildApp seam added): <none | list>
New interfaces exposed: <none expected>
Notes for ledger: <1-2 lines>
```

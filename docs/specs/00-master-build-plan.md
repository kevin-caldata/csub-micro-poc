# 00 — Master Build Plan (READ THIS FIRST)

Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Entry point for the build orchestrator
Sources: `BRD_Micro_Voice_PoC.md` (requirements), `docs/specs/01–10` (normative detail), `docs/findings/01–10` (verified platform facts). This document is **navigational only** — it never restates requirement text; every task hands the build agent the spec(s) that do.

---

## 1. Project one-pager

Smallest possible voice demo: a caller dials a Twilio number and holds a natural, low-latency, barge-in-capable conversation with `openai/gpt-realtime-2.1`, reached **exclusively through Vercel AI Gateway** (existing credits, no OpenAI account). The model calls tools on a hello-world MCP server (`get_current_time`, `hello`) mid-conversation. One Node 22 / TypeScript ESM process (Fastify + ws) on one Railway service bridges Twilio Media Streams (base64 μ-law 8 kHz) to the gateway's normalized AI SDK realtime protocol, with two audio paths behind `AUDIO_MODE` (pcmu passthrough vs μ-law⇄PCM16@24k transcode). 3–5 fully isolated concurrent calls; push-to-`main` auto-deploys. **The measured latency findings are the primary deliverable** (FR-6/M5): per-turn TTFB decomposition, tool round-trip < 1.5 s, barge-in < 500 ms, pcmu-vs-transcode verdict, concurrency ceiling, $/call-minute.

Non-goals: no OpenAI-direct fallback, no persistence, no auth beyond webhook validation, no recording, no outbound calls, no reconnect/resume, no scaling beyond ~5 concurrent.

---

## 2. Spec index

| # | Title | Key deliverables | Depends on | Enables |
|---|---|---|---|---|
| 01 | Scaffolding & toolchain | `package.json`+lockfile, `.npmrc`, `tsconfig.json`, `railway.json`, `.env.example`, `.gitignore`, `src/config.ts`(+test), `src/logger.ts` stub, placeholder `src/server.ts` | — | everything |
| 02 | HTTP server & /twiml webhook | `src/server.ts` (full boot, drain, SIGTERM), `src/twiml.ts` (`/twiml`, `/stream-status`, `pendingCalls`+`claimPendingCall`), `src/state.ts` (`sessions` map seam) | 01 | 03, 05, 07, 09 |
| 03 | Twilio Media WS leg | `src/twilio-media.ts`, `src/sessions.ts` (Session interface + registry + teardown), tests; modifies `server.ts` (route section), `config.ts` (`TWILIO_VALIDATE_UPGRADE`) | 01, 02 | 04-wiring, 05, 08 |
| 04 | Gateway realtime WS leg | `src/gateway.ts` (mint, GatewayLeg, session-update/greeting, 23-event dispatch table, error/close policy); modifies `config.ts`, `.env.example` | 01 | 05, 07, 08 |
| 05 | Session bridge & barge-in | `src/session.ts`, `src/bargein.ts`, barge-in tests (C2/C3/C4 corrections, teardown matrix, tool gate wiring) | 01, 02, 03, 04 (+ consumes 06, 07, 08 contracts) | 07-loop live, 08 hooks, 09 fallback seam |
| 06 | Audio DSP & transcoding | `src/dsp.ts` (vendored μ-law tables, Up/Downsampler3x, `createTranscoder`, `audioFormatsFor`), DSP test suite, README M1 checklist stub | 01 | 05, 09/M1 |
| 07 | MCP server & tool loop | `src/mcp-server.ts` (`POST /mcp` stateless + 405s), `src/tools.ts` (per-call client, `fetchToolDefs`, `runTool`, `ToolLoop` double gate) | 01, 02 | 05 integration, M3 |
| 08 | Logging & latency instrumentation | `src/logger.ts` (final hand-rolled), `src/latency.ts` (`TurnRecorder`), `scripts/aggregate-latency.mjs`, `docs/measurements/` extraction procedure | 01 (stub boundary) | 05 hooks, M4/M5 |
| 09 | Deployment & operations | final `railway.json`, `assets/fallback-apology.ulaw`+script, `src/fallback.ts` (G4 spoken fallback), `scripts/check-credits.ts`, `docs/RUNBOOK.md` | 01, 02, 08 | M1 deploy, M4, M5 |
| 10 | Testing, spikes & milestones | `vitest.config.ts`, full `test/` suite + fakes (fake-twilio, fake-gateway), `scripts/concurrency-probe.ts`, M1–M5 procedures, S1–S35 answer table, README report skeleton (aggregation reuses Spec 08's `aggregate-latency.mjs`) | 01–09 | M1–M5 sign-off |

---

## 3. Build plan — tasks for sub-agent execution

Each task = one sub-agent hand-off. **Attach the named spec file(s) plus the listed findings docs** (findings paths: `docs/findings/NN-*.md`). "Verify" = the command/procedure the orchestrator runs before accepting the task; the spec's full acceptance-criteria list is authoritative.

### Wave A — foundation (sequential, blocks everything)

**T01 — Scaffold & toolchain**
- Spec: `01-scaffolding-and-toolchain.md`. Findings: 10, 07, 05, 06, 08, 01.
- Produces: `package.json`, `package-lock.json`, `.npmrc`, `tsconfig.json`, `railway.json`, `.env.example`, `.gitignore`, `src/config.ts`, `src/config.test.ts`, `src/logger.ts` (stub), `src/server.ts` (placeholder).
- Verify: `npm install && npm run build && npm run typecheck && npm test`; pin check `npm ls @modelcontextprotocol/sdk @ai-sdk/gateway fastify @fastify/websocket @fastify/formbody ws twilio zod`; boot smoke `AI_GATEWAY_API_KEY=x TWILIO_AUTH_TOKEN=y PUBLIC_HOST=localhost npm start` + `curl :3000/health`; grep gates (no `require(`, no extension-less relative imports, no `dotenv`/`alawmulaw`/`openai`); no `Dockerfile`/`.nvmrc`/`preinstall`.
- Sequencing: FIRST, alone.

### Wave B — independent modules (all four in PARALLEL; each depends only on T01)

**T02 — HTTP server, /twiml, drain**
- Spec: `02-http-server-and-twiml-webhook.md`. Findings: 08, 03, 07, 01, 10.
- Produces: `src/server.ts` (replaces placeholder — owns the file), `src/twiml.ts`, `src/state.ts`.
- Verify: Spec 02 A1–A9 — boot + `/health` 200; signed `/twiml` (use `getExpectedTwilioSignature`) returns correct TwiML (statusCallback, one `<Parameter token>`, no query string, nothing after `</Connect>`); bad signature → 403 with no mint; `claimPendingCall` single-use/TTL/timingSafeEqual; SIGTERM drain-before-close behavior (A7/A8).

**T04 — Gateway realtime leg**
- Spec: `04-gateway-realtime-leg.md`. Findings: 01, 02, 04, 08, 06, 09, 10.
- Produces: `src/gateway.ts`; additive edits to `src/config.ts` + `.env.example` (R2 keys).
- Verify: Spec 04 A1–A13 — unit tests vs local mock ws server: factory-form `getToken` only (grep `rt.getToken` → zero hits), first frame is full `session-update` then greeting `response-create`, pcmu format has structurally no `rate` key, array-frame parse, 23-event exhaustive switch, in-band `error` never terminal, close/onOpenFailed contract, custom-event rate limit.

**T06 — DSP / audio formats**
- Spec: `06-audio-dsp-transcoding.md`. Findings: 06, 02, 10.
- Produces: `src/dsp.ts`, DSP test suite, README M1-spike checklist stub. (`AUDIO_MODE` parsing already in T01's config.)
- Verify: Spec 06 R12 suite — μ-law table round-trip (255/256 + `0x7F→0xFF` exception), chunked-vs-oneshot bit-identity incl. ragged chunks, boundary-click detector, THD+N ≥ 60 dB projection test, < 500 µs/frame perf guard, Path A reference-equality (zero-copy) identity.

**T08 — Logger & latency recorder**
- Spec: `08-logging-and-latency-instrumentation.md`. Findings: 09, 07, 02, 10.
- Produces: final `src/logger.ts` (hand-rolled ~25-line `log()`; MUST keep Spec 01 R12's `logEvent` boundary compatible so earlier imports don't break), `src/latency.ts`, `scripts/aggregate-latency.mjs`, `docs/measurements/README.md` + `.gitkeep`.
- Note: the `src/session.ts`/`src/server.ts` hook CALL SITES defined here are implemented by T05/T02 — this task ships the modules + contract only (plus the `monitorEventLoopDelay` boot snippet as an ready-to-paste block if `server.ts` is contended).
- Verify: logger unit tests (single-line minified JSON, `message`+string `level`, flat fields, numbers stay numbers); `TurnRecorder` unit tests (responseId keying, lazy attach, nearest-rank p50/p95, barge-in tagging policy); aggregation script runs on fixture JSONL.

### Wave C — routes on the running server (both in PARALLEL; depend on T01+T02)

⚠ Merge point: T03 and T07 both add one registration line inside `server.ts`'s marked `// --- route registration (Specs 03/07) ---` section — orchestrator merges trivially.

**T03 — Twilio media WS leg**
- Spec: `03-twilio-media-ws-leg.md`. Findings: 03, 08, 04, 06, 09, 10.
- Produces: `src/twilio-media.ts`, `src/sessions.ts`, WS-leg tests; edits `server.ts` (route registration), `config.ts` (`TWILIO_VALIDATE_UPGRADE`).
- Integration note: `src/sessions.ts`'s registry must BE (or re-export) Spec 02's `src/state.ts` `sessions` map — one Map instance process-wide; `Session` implements `SessionHandle.teardown(reason)` and self-deregisters on every exit path (drain depends on it).
- Verify: Spec 03 A1–A13 via `fastify.injectWS` — token gate (1008 on missing/expired/reused), 5 s start-timeout, string-numeric coercion, remove-by-name mark semantics + `onPlaybackDrained`, byte-exact outbound `media`/`mark`/`clear`, no pacing/re-framing, 1 MB backpressure → 1011, idempotent teardown, two-session isolation.

**T07 — MCP server & tool loop**
- Spec: `07-mcp-server-and-tool-loop.md`. Findings: 05, 04, 02, 09, 10.
- Produces: `src/mcp-server.ts`, `src/tools.ts`; edits `server.ts` (route registration).
- Verify: boot server, `curl -X POST /mcp` JSON-RPC `tools/list` + `tools/call` round trips (enableJsonResponse makes this curl-able); GET/DELETE `/mcp` → 405; unit tests: `$schema` strip + explicit-field mapping (no `execution` leak), `runTool` never throws (isError + thrown + 5 s timeout → error-JSON), `ToolLoop` double gate (response-done AND outputs sent AND `responseActive===false` AND idempotence flag; deferred retry on next response-done).

### Wave D — integration (T05 sequential after Waves B+C; T09 may run in PARALLEL with T05)

**T05 — Session bridge & barge-in (the integration task)**
- Spec: `05-session-bridge-and-barge-in.md`. Findings: 04, 02, 03, 06, 08, 09, 10.
- Produces: `src/session.ts`, `src/bargein.ts`, barge-in test suite. Wires together: T03's Session/hooks, T04's `GatewayLeg`/dispatch table, T06's `createTranscoder`/`audioFormatsFor` (spread — never hand-built format objects) + `resetOutbound()` at response-created and bargeIn (T4 seam), T07's `ToolLoop`, T08's `TurnRecorder` hook call sites.
- Verify: Spec 05 A1–A14, especially the **A2 stale-epoch regression** (truncate `audioEndMs` = current-epoch delta, never stale), no `response-cancel` sent (C3), post-clear mark-echo tolerance (C4), four-point `responseStartTimestamp` reset, teardown matrix idempotence (`sessions.delete` on every path), tool gate re-check on every response-done. Then full offline conversation against T10's fakes once available.

**T09 — Deployment & operations** (parallel with T05; one merge point)
- Spec: `09-deployment-and-operations.md`. Findings: 07, 03, 01, 10.
- Produces: final `railway.json` (should already match T01's), `assets/fallback-apology.ulaw` + `assets/README.md` + `scripts/make-fallback-clip.sh`, `src/fallback.ts`, `scripts/check-credits.ts`, `docs/RUNBOOK.md`; documents human console steps (Railway project, sealed vars, GitHub auto-deploy, Twilio number/webhook).
- Merge point: `playFallbackAndClose` plugs into T05's `onGatewayFailure` hook (defaults no-op) — one-line wiring applied at merge, gated on spike S23.
- Verify: `railway.json` parses, numeric fields are numbers, `overlapSeconds:10` present; clip is headerless raw μ-law/8000 (`ffprobe`/size math); `scripts/check-credits.ts` runs against `/v1/credits`; RUNBOOK contains deploy-between-calls checklist, C16/S20 qualifier, Log Explorer cheat-sheet, 7-day extraction rule.

### Wave E — test layer & milestone execution (sequential, last)

**T10 — Testing, spikes & milestones**
- Spec: `10-testing-spikes-and-milestones.md`. Findings: ALL (10 primarily; 01–09 as referenced).
- Produces: `vitest.config.ts` (+ exact-pinned vitest resolved at install), `test/` suites (env-guard, dsp, tool-mapping, bargein, marks, config, logger), `test/fakes/fake-gateway.ts`, `test/fakes/fake-twilio.ts`, `test/harness.test.ts`, `scripts/concurrency-probe.ts` (aggregation reuses T08's `scripts/aggregate-latency.mjs` — no second aggregator); `config.ts`+`gateway.ts` test-only `GATEWAY_WS_URL` override seam; README Spike Results + M5 report skeleton; package.json script updates.
- Also performs the **test-runner consolidation** (see Risk register item R-1): migrates/absorbs the interim `node:test` suites into the vitest layer, keeping the env-guard (`globalThis.window === undefined`) regression.
- Verify: `npm test` (vitest run) green including the stale-epoch normative test; harness drives the real Fastify app through a scripted call with zero network; then execute the M1–M5 milestone procedures (below) on the deployed service.

---

## 4. Build order & parallelism summary

```
Wave A: T01
Wave B: T02 ∥ T04 ∥ T06 ∥ T08     (config.ts/.env.example edits are additive — merge at wave end)
Wave C: T03 ∥ T07                  (merge: server.ts route-registration section)
Wave D: T05 ∥ T09                  (merge: fallback.ts → onGatewayFailure wiring)
Wave E: T10                        (terminal; then milestone execution)
```

Strictly sequential chain: T01 → T02 → T03 → T05 → T10. Everything else hangs off it in parallel.

---

## 5. Milestone mapping (BRD §10)

| Milestone | Needs tasks | Procedure owner | Gate |
|---|---|---|---|
| **M1** — audio spike + first call | T01–T06, T08, T09 deployed (T07 not required) | Spec 10 R15 12-item checklist; Spec 06 R13 decision procedure | Live greeted call; Path A (pcmu) tested first, `session-updated.raw` recorded; spikes S1–S23 answered; S33 Log Explorer checklist passes |
| **M2** — conversation quality | + T05 complete | Spec 10 M2 procedure | FR-2 two-layer evidence (server-side < 50 ms + speakerphone-measured < 500 ms), transcripts in logs, S9 truncate-ack probe |
| **M3** — tools end-to-end | + T07 wired via T05 | Spec 10 M3 procedure | FR-4/FR-5 pass; `toolTotalMs` < 1500 in logs; add-a-tool diff test |
| **M4** — concurrency + pipeline | + T09, T10 scripts | Spec 10 M4 (FR-3 parallel calls, S24 probe, S25 deploy-mid-call, FR-7 kill tests, FR-8 timed push) | 3–5 parallel calls no cross-talk; concurrency limit recorded; rejection → FR-7 behavior |
| **M5** — findings report | all + extracted logs | Spec 10 R26 template; Spec 08 extraction procedure | README report: per-leg p50/p95, pcmu-vs-transcode verdict, ceiling, $/call-minute, full S1–S35 answer table, honest-accounting phrasing |

---

## 6. Design-decision register

Every gap resolution and BRD override, with the spec that OWNS it (agents must not re-litigate; the owning spec is normative).

### Gap resolutions (findings/10 Part 2)

| ID | Resolution | Owner |
|---|---|---|
| G1 | ESM `"type":"module"` + NodeNext + mandatory `.js` extensions; `alawmulaw` banned (vendored tables kill the only ESM hazard) | 01 (tables: 06) |
| G2 | Node 22 native `--env-file` via `tsx watch`; `dotenv` never installed; Railway injects env in prod; zod fail-fast config naming the OIDC trap | 01 |
| G3 | `VOICE=marin` default, boot-config fallback `alloy` (no runtime auto-retry); verified via `session-updated.raw` at M1 (S8) | 04 (config: 01) |
| G4 | FR-7 spoken fallback = pre-rendered headerless μ-law apology clip via media+mark before WS close, gated on S23; clean hangup is fallback-of-fallback; action-URL `<Say>` rejected (fires on normal hangups) | 09 (TwiML half: 02; clean-hangup half: 03) |
| G5 | Mandatory 10-min ngrok WS smoke test at first local run; on failure all testing moves to Railway; latency numbers valid only from Railway | 09 |
| G6 | Node-environment testing, jsdom structurally forbidden (getToken throws under `window`); env-guard regression test | 01 (interim node:test) / 10 (final vitest — see risk R-1) |
| G7 | BRD stack-table omissions fixed: `@fastify/websocket@11.3.0`, `@fastify/formbody@8.0.2` pinned exact | 01 |

### BRD contradictions/overrides (findings/10 Part 3A — findings win)

| ID | Override (vs BRD) | Owner |
|---|---|---|
| C1 | `getToken` on the FACTORY (`gateway.experimental_realtime.getToken`), never the model instance; zero `rt.getToken` call sites | 04 (kick-off: 02) |
| C2 | Stale-epoch fix: `responseStartTimestamp` has exactly four reset/re-arm points, not just the barge-in reset | 05 |
| C3 | `response-cancel` OMITTED from barge-in (server-vad `interrupt_response` already cancels); whitelist still matches cancel-class errors | 05 |
| C4 | Mark queue is unique-name + remove-by-name, tolerant of post-clear echo storms; never bare `shift()` | 03 (consumed by 05) |
| C5 | WS upgrade signature validation IS feasible (wss-scheme rewrite) — implemented log-only behind `TWILIO_VALIDATE_UPGRADE` | 03 |
| C6 | Railway 60 s idle timeout doesn't apply to WS at all (exempt) — no keepalive workaround exists in the code | 09 (documented) |
| C7 | pcmu support through the gateway is a SPIKE (S1), not verified; `AUDIO_MODE` typo-guard at boot | 06 |
| C8 | No outbound re-framing/pacing (Twilio buffers any size); `audio/pcmu` carries NO `rate` key (structurally absent); `audio/pcm` always `rate:24000` | 06 |
| C9 | Consciously-ignored event set (conversation-item-added etc.) — silent, never warn | 04 (table) / 05 (impl) |
| C10 | `turnDetection` can't express `create_response`/`interrupt_response`; rely on OpenAI defaults; `providerOptions` never used for session params (root-merge clobber) | 04 |
| C11 | Tool mapping: strip `$schema`, explicit field selection (never spread; `execution` must not leak); `callTool` never throws for tool failures — check `isError` | 07 |
| C12 | `/mcp` GET/DELETE 405s are app-level routes you write, not transport behavior | 07 |
| C13 | zod peer is `^3.25 || ^4.0`; pinned `3.25.76`; ignore `@cfworker/json-schema` peer warning | 01 |
| C14 | `twilio` exact-pinned `6.0.2` (BRD said `latest`) | 01 |
| C15 | Only the ws CLIENT needs `perMessageDeflate:false` (server already off; explicit = docs); client `handshakeTimeout` 5000 (no ws default) | 04 (client) / 02 (server) |
| C16 | Twilio "unlimited inbound concurrency" only holds for upgraded accounts w/ approved Business Profile (S20) | 09 (runbook) |
| C17 | Region pinned in `railway.json` only (code overrides dashboard — BRD §7.2 step dropped); `overlapSeconds:10` added over the BRD | 01/09 |
| C18 | SIGTERM: drain `sessions` FIRST, then `fastify.close()` (default preClose severs live WS in ~2 ms) | 02 |

### Inter-findings tensions (findings/10 Part 3B, as adjudicated by the specs)

| ID | Resolution | Owner |
|---|---|---|
| T1 | findings/01 Impl 1 authoritative for the connect sequence (findings/02's ternary snippet is wrong) | 04 |
| T2 | Gateway ping optional (`GATEWAY_PING_SECONDS`, default 0), diagnostics-only, never load-bearing for idle (S23) | 04 |
| T3 | Single mark namespace `r<responseId>:<seq>`; first mark per response doubles as `tFirstMarkEcho`; no separate timing mark | 03 (naming) / 08 (instrumentation) |
| T4 | `transcoder.resetOutbound()` (= `down.reset()`) at exactly response-created + bargeIn; the inbound upsampler never reset mid-call | 06 (contract) / 05 (call sites) |
| T5 | DSP benchmark numbers non-conflicting; perf guard set at < 500 µs/frame | 06 |
| T6 | `reply.hijack()` standardized at handler entry, before `server.connect` | 07 |
| T7 | Per-call MCP client (create at call start, `client.close()` in teardown) | 07 |

---

## 7. Spike register (S1–S35 → owning spec/task)

All 35 rows are mandatory in the M5 answer table (Spec 10 classifies must-answer vs opportunistic vs accepted-risk).

| Spikes | Topic | Owner (instrumented by) | Answered at |
|---|---|---|---|
| S1–S3 | pcmu honored / default output rate / rate-alongside-pcmu misconfig probe | 06 (formats), 04 (`session-updated.raw` log) | M1 |
| S4–S6 | speech-started normalized-vs-custom / `.raw` shapes / session-update ordering (`WAIT_FOR_SESSION_UPDATED` fallback) | 04 | M1 |
| S7, S8 | `gpt-realtime-2.1` connect; `VOICE=marin` validity | 04/01 (env fallbacks) | M1 |
| S9 | truncate forwarded + `conversation.item.truncated` ack | 04/05 | M2 |
| S10 | `providerOptions` passthrough (not built; probe only if needed) | 04 | conditional |
| S11, S12 | benign error `code` strings; `response-done.status` values | 04/05/07 (whitelists start empty/heuristic) | M1/M2 |
| S13, S14 | array frames; WS close-code vocabulary | 04 | M1+ |
| S15 | token TTL semantics + `getTokenMs` distribution | 02/04 | M1 |
| S16, S17 | response-created-before-delta ordering; delta cadence (mark granularity) | 08 (lazy attach) / 03 | M1 |
| S18 | VAD behavior 8 k μ-law vs 24 k PCM | 06 | opportunistic |
| S19 | caller experience on handshake failure / mid-call drop (statusCallback evidence) | 02/03 | M1 kill test |
| S20 | Twilio account upgraded + Business Profile (human console check) | 09 | pre-M1 |
| S21, S22 | upgrade-signature header presence; Twilio frame cadence/timeout | 03 | M1 |
| S23 | canned-clip playback before close (gates G4); ping-vs-idle-timer | 09/03 (clip), 04 (ping) | M1 probe |
| S24 | gateway concurrency limit number + rejection locus (mint vs WS-open) | 10 (`concurrency-probe.ts`), 02/04 (both paths logged) | M4 |
| S25 | Railway WS routing during overlap/drain (deploy-mid-call) | 09/02 | M4 |
| S26, S27 | shared-vCPU DSP multiplier + loop p99; Hobby usage burn | 06/08; 09 | M4 |
| S28 | Twilio behavior on `/twiml` 503 during drain — ACCEPTED RISK ("deploy between calls") | 02 | only if rule relaxed |
| S29 | `/mcp` DNS-rebinding hardening — not adopted for PoC | 07 | conditional |
| S30–S32 | audio-token pricing; generation IDs; `gateway.tags` attribution | 09 (`check-credits.ts`), 04 (raw logs) | M1/M5 |
| S33 | Log Explorer flat-field filtering verification checklist | 08 | first deployed build |
| S34, S35 | `audio_end_ms` semantics; gateway-hop overhead (the instrumentation IS the measurement) | 08 | M1/M5 |

---

## 8. Risk register

| # | Risk | Mitigation / decision |
|---|---|---|
| R-1 | **Test-runner contradiction between specs**: Spec 01 mandates `node:test` via `tsx --test` (no vitest); Specs 03/05/06/10 write vitest suites. | Adjudicated here: Spec 01's harness is the interim runner through Waves A–D (agents may write suites in either style as long as they run); **T10 owns the final test layer** — installs exact-pinned vitest (`environment:'node'`), consolidates all suites under `test/`, updates `"test": "vitest run"`, and keeps the env-guard jsdom regression. Both runners satisfy G6 (plain Node env). |
| R-2 | **File contention across parallel agents**: `config.ts`/`.env.example` (T04, T06, T03 additive edits), `server.ts` route section (T03, T07), `logger.ts` (T01 stub → T08 final). | Edits are declared additive/sectioned in the specs; orchestrator merges at wave boundaries. T08 must preserve the Spec 01 R12 `logEvent` boundary. `sessions` map must remain ONE instance (`state.ts`/`sessions.ts` — see T03 integration note). |
| R-3 | Gateway may not honor `audio/pcmu` (S1) — Path A dead. | Path B transcode is the default baseline and ships regardless (T06); flip is a Railway variable, zero code. |
| R-4 | `gpt-realtime-2.1` connect refusal (S7) / `marin` voice rejection (S8). | Manual env fallbacks (`openai/gpt-realtime-2`, `alloy`); no auto-fallback so M1 latency data stays clean. |
| R-5 | Unpublished gateway concurrency limit < 5 breaks FR-3. | S24 phone-free ramp probe before burning real calls; rejection locus instrumented at both mint and WS-open; FR-7 behavior covers the limit-hit path. |
| R-6 | Deploys sever live calls (Railway SIGTERM); drain is best-effort (S25). | Operating rule "deploy between test calls" is absolute; C18 drain-before-close implemented; `overlapSeconds:10` adopted with S25 caveat; 503-during-drain accepted risk (S28). |
| R-7 | In-band gateway error mistakenly treated as fatal → dead calls on benign errors. | Design lock: in-band `error` events are NEVER call-terminating; only WS close/handshake failure triggers FR-7. Whitelist starts empty + heuristic until S11 pins codes. |
| R-8 | Railway 7-day Hobby log retention destroys the M5 dataset. | Mandatory same-day (hard 72 h) extraction procedure → JSONL committed under `docs/measurements/`; offline aggregation only (never percentile-of-percentiles); S33 checklist must pass before any measurement session counts. |
| R-9 | Per-frame logging trips Railway's 500 lines/s cap and drops the evidence. | One-line-per-event discipline repo-wide; custom-event rate limiter; `logger:false` on Fastify; hand-rolled logger (pino defaults break Railway parsing). |
| R-10 | ESM/dep traps: `alawmulaw` named-import crash, MCP v2 beta split packages, `@canary` gateway dist-tag, `five` dist-tag, Dockerfile overriding RAILPACK. | All structurally banned by T01's pins/grep gates; acceptance A1/A7/A8 re-checked at every wave merge. |
| R-11 | Tool-loop race: VAD auto-response during tool execution → double-speak or stuck gate. | Double gate + idempotence flag + event-driven deferral (T07); `autoResponseIntervened` logged; observed at runtime (S11/S12) rather than pre-optimized. |
| R-12 | Spoken-fallback clip may not play before close (S23). | Clip playback gated on the 10-min M1 probe; clean hangup is the always-working fallback-of-the-fallback. |

---

*Detail lives in the numbered specs. When a build agent finds a conflict between this plan and a numbered spec, the numbered spec wins for its owned scope; conflicts between specs escalate to the orchestrator with reference to §6/§8 above.*

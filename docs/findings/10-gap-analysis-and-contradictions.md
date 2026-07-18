# Findings 10 — Gap Analysis, Contradictions & Consolidated Spike List

**Date:** 2026-07-18
**Role:** Completeness critic over the research phase. Inputs: `BRD_Micro_Voice_PoC.md` plus findings docs 01–09 (all read in full). This document does three things: (1) identifies BRD claims and build-critical topics **no findings doc covers**, (2) reconciles **contradictions** — findings-vs-BRD and findings-vs-findings, (3) consolidates every **runtime-spike-only unknown** into one deduplicated, milestone-mapped list. Where a resolution is stated, the authoritative source doc is cited.

---

## Part 1 — Coverage matrix (BRD section → findings doc)

| BRD section | Owner doc(s) | Coverage |
|---|---|---|
| §2 FR-1..FR-8 | 01/03/04/05/07/08/09 (distributed) | Covered, except FR-7 spoken-fallback design (Gap G4) |
| §3 NFRs (latency, cost, gateway limits, Railway) | 09, 07, 01 | Covered (with corrections C6, C7) |
| §5.1 stack pins | 01, 02, 03, 05, 08 | Covered (refinements C13–C15; Gap G1 on TS/ESM toolchain) |
| §5.2 gateway connection | 01, 02 | Covered (correction C1; inter-doc tension T1) |
| §5.3 normalized protocol | 01, 02, 04 | Covered (corrections C9, C10) |
| §5.4 Twilio Media Streams | 03 | Covered (corrections C4, C5) |
| §5.5 audio two-path | 06 | Covered (corrections C7, C8) |
| §5.6 barge-in | 04 | Covered (corrections C2, C3, C4) |
| §5.7 MCP tool loop | 05 | Covered (corrections C11, C12) |
| §5.8 HTTP surface / Session | 08 | Covered |
| §5.9 logging/instrumentation | 09, 07 | Covered |
| §6 Twilio setup | 03 | Covered (correction C16) |
| §7 Railway | 07 | Covered (corrections C6, C17) |
| §8 Local development | — (fragments in 03) | **Gaps G2, G5** |
| §12 env vars | — (partial) | **Gap G3** (`VOICE=marin` unverified) |

---

## Part 2 — Gaps: build-critical topics no findings doc covers

### G1. TypeScript/ESM build toolchain (tsconfig, module system, import extensions) — UNCOVERED
No doc verifies the project's own build configuration, yet three findings make it load-bearing:
- MCP SDK deep imports use explicit `.js` extensions (`@modelcontextprotocol/sdk/server/mcp.js`) and doc 05 confirms they work "under Node 22 ESM and TS `moduleResolution: node16/nodenext/bundler`" — but nobody chose/verified a tsconfig for this repo.
- `alawmulaw` **crashes under Node ESM named imports** (doc 06 gotcha 1) — whether the project is `"type": "module"` or CJS changes whether that gotcha bites and how every import in the repo is written.
- BRD §9 assumes `tsc` → `dist/server.js` and `tsx watch` for dev; Railpack behavior verified (doc 07) but the tsconfig (`module`, `target`, `outDir`, ESM vs CJS emit) is unwritten. **Action:** decide before scaffolding: recommend `"type": "module"` + `moduleResolution: nodenext` + vendored μ-law tables (doc 06 already recommends vendoring, which removes the alawmulaw hazard entirely). This is a decision the build agent must make on day one with no findings backing.

### G2. Local-dev environment loading (`.env`) — UNCOVERED
BRD §8 prescribes a `.env` file, but Node does not auto-load `.env`. No doc says whether to use `dotenv`, `node --env-file=.env`, or `tsx`'s behavior (tsx does **not** load `.env` by itself). Doc 01 gotcha 5 makes this sharp: a missing `AI_GATEWAY_API_KEY` fails **late and obscurely** (OIDC fallback error), so env loading + boot-time validation in `config.ts` is a correctness feature, not a convenience. **Action:** pick `node --env-file` (Node ≥20.6, zero deps, works with `tsx watch --env-file`) or add `dotenv`; validate required vars at boot.

### G3. `VOICE=marin` validity — UNVERIFIED by any doc
BRD §12 sets `VOICE=marin`. Doc 01/02 confirm `voice?: string` is a free-form field; doc 04's mapper table shows it maps to `audio.output.voice`. **No doc verified that `marin` is an accepted voice for `openai/gpt-realtime-2.1` through the gateway**, nor what happens on an invalid voice name (error event? silent fallback to default?). A wrong voice string is exactly the kind of thing that costs an hour at M1. **Action:** add to the M1 spike checklist: confirm voice in `session-updated.raw`; have `alloy` as fallback.

### G4. FR-7 "spoken fallback" mechanism — fragments only, no design
FR-7 acceptance is "spoken fallback **or** clean hangup, never dead air". The clean-hangup path is fully verified (doc 03 claim 1: closing the Twilio WS ends the call). The **spoken** fallback is only touched in passing:
- Doc 08's error matrix says "play/speak fallback via a canned μ-law clip or just close" — no doc verifies producing/playing a canned clip.
- Doc 03 §Impl D notes TwiML verbs after `</Connect>` (or an `action` URL) execute on stream close — a `<Say>` there would speak on **every** call end, including normal hangups, unless an `action` handler branches on why the stream ended.
No doc resolves this design choice (pre-rendered μ-law apology buffer sent before `close()` vs `action`-URL TwiML branch vs accept clean-hangup-only). **Action:** decide at build time; simplest verified-compatible option is a small pre-encoded μ-law apology buffer (Path-A format, so it works in both audio modes) sent on gateway failure before closing — needs a 10-minute M1 check that Twilio plays it.

### G5. ngrok local-dev WS path — asserted, not verified
BRD §8's ngrok flow (webhook + `wss://<ngrok>/twilio-media`) is only glanced at (doc 03 gotcha 13: upgrade-signature caveat). Nobody verified ngrok forwards WS upgrades with the free tier's current limits/interstitial behavior (ngrok's browser interstitial does not affect API/WS clients, but that's unstated anywhere). Low risk, but M-zero dev-loop breakage would be annoying. **Action:** treat first local call as its own smoke test; latency caveat in BRD already correct.

### G6. Test-runner choice and the jsdom trap — UNCOVERED
Doc 06 ships a full DSP test strategy "to port into the repo's tests" and doc 01 gotcha 6 warns `getToken` **throws in any environment where `globalThis.window` is defined** (jsdom). No doc picks a test runner/config. **Action:** vitest/node environment (never jsdom), one line in the scaffold.

### G7. Minor un-adjudicated BRD claims (accepted-by-implication; listing for completeness)
- §5.7 header: "hosted/OpenAI-side MCP is definitively NOT expressible through the gateway [VERIFIED]" — no doc re-verified explicitly, but doc 02's vendored protocol shows `tools` accepts only `{type:'function'}` definitions, which entails it. Treat as confirmed by implication.
- §6 steps 1–2, 5 (account upgrade, number purchase, auth token) — console procedure; doc 03 covers the trial caveats; account state itself is Open (S20).
- BRD's `@fastify/formbody` and `@fastify/websocket` are **absent from the §5.1 stack table** but are hard requirements established by docs 03/08 (`@fastify/formbody@8.0.2`, `@fastify/websocket@11.3.0`). Not a research gap — a BRD stack-table omission to fix when pinning `package.json`.

---

## Part 3 — Contradictions

### 3A. Findings vs BRD (BRD is wrong or materially incomplete; findings authoritative)

| # | BRD claim | Correction | Source |
|---|---|---|---|
| C1 | §5.2 sample: `const rt = gateway.experimental_realtime(MODEL); await rt.getToken({...})` | **Throws** — `getToken` exists only on the factory object: `await gateway.experimental_realtime.getToken({ model, expiresAfterSeconds })`. Model instance has only `doCreateClientSecret/getWebSocketConfig/parseServerEvent/serializeClientEvent/buildSessionConfig`. | 01 (claim 2, Impl 1) |
| C2 | §5.6: reset `responseStartTimestamp` only at step 4 (barge-in) | Implemented literally, this reproduces the reference implementation's **stale-epoch truncate bug** (truncate errors on every barge-in after the first non-interrupted turn). Must also reset on every `response-created`, re-arm per `responseId` at first `audio-delta`, and reset when the mark queue drains. | 04 (G1, D4) |
| C3 | §5.6 step 3: send `response-cancel` ("belt-and-braces") | Redundant: server-vad's `interrupt_response` defaults to `true` and is **not overridable** via the normalized config; the server already cancelled. A client cancel typically returns an `error` event. Omit, or whitelist that error as benign. | 04 (V4, V5, G3) |
| C4 | §5.4 "mark (echoed when played)… powers the barge-in `audioEndMs` math" | Marks are **also echoed on `clear`** (post-clear echoes ≠ playback), so the queue needs unique per-response names + remove-by-name, never bare `shift()`. And marks only *gate whether* barge-in runs; `audioEndMs` comes from Twilio `media.timestamp` deltas. | 03 (claim 16.3), 04 (G2, correction 3) |
| C5 | §5.4 "Do NOT try to validate the WS upgrade" | Overstated: validation works if computed over the `wss://` URL with empty params (lowercase `x-twilio-signature`). Token pattern stays primary; upgrade validation is optional defense-in-depth. | 03 (claim 10) |
| C6 | §3 "60 s proxy keep-alive idle timeout (moot — media frames every ~20 ms)" | Mechanism wrong: 60 s applies only to idle **HTTP/1.1** connections between requests. Railway docs: WebSockets are **exempt from all duration/inactivity limits** and can idle indefinitely. No WS keepalive workaround is needed under any traffic pattern. | 07 (claim 10) |
| C7 | §5.5 "The normalized protocol types this [VERIFIED]" (pcmu) | Overstated: `inputAudioFormat.type` is a plain `string`; pcm/pcmu/pcma appear only in JSDoc. No compile-time or client-side guarantee — the [SPIKE] framing is the correct one; the [VERIFIED] tag applies only to the docstring. | 02 (claim 11), 06 (C3) |
| C8 | §5.5 Path B outbound "…→ μ-law encode → **re-frame for Twilio**" | No re-framing (or pacing) is needed: Twilio accepts outbound `media` payloads of any size, buffers, and plays in order. Also: omit `rate` entirely with `audio/pcmu` (GA schema defines no rate on that format object); reset the outbound downsampler at each new response and on barge-in, never the inbound upsampler mid-call. | 06 (C11, gotcha 3), 03 (claim 5/7) |
| C9 | §5.3 server-event list | Incomplete: union also contains `conversation-item-added`, `output-item-done`, `content-part-added/done`, `audio-done`, `text-delta/done`, `function-call-arguments-delta` — bridge must consciously ignore/log, not warn. `input-transcription-completed` = `{itemId (required), transcript}`. `turnDetection` also allows `semantic-vad`/`disabled`/`null`; config also has `outputModalities`, `outputAudioTranscription`, `providerOptions`; `audio-message` item type exists; `response-create.options = {modalities?, instructions?, metadata?}`. | 02 (corrections 1–11), 01 (claim 16) |
| C10 | §5.3 turnDetection expressiveness (implicit) | The normalized `turnDetection` **cannot express** `create_response` / `interrupt_response` / `idle_timeout_ms` / semantic-vad `eagerness`. The design silently relies on OpenAI defaults (both `true`); the `providerOptions` escape hatch merges at session **root** in the public codec (clobbers the whole `audio` subtree) and is unverified through the gateway. | 04 (V12, correction 4) |
| C11 | §5.7 "map `{name, description, inputSchema}` **directly**" to tools | Two required adjustments: strip the `$schema` key from `inputSchema`, and select fields explicitly (never spread) because 1.29.0 adds an `execution` field per tool. Also `callTool` **never throws** for tool failures — bad args and unknown tools return `isError:true` results with `MCP error -32602:` text; check `isError`. | 05 (C8, C10, gotchas 4–5) |
| C12 | §5.7 "405 for GET/DELETE" | App-level route code you must write (official example pattern), not transport behavior — the stateless transport would otherwise serve GET as SSE and DELETE as close+200. | 05 (C5) |
| C13 | §5.1 `zod ^3.25` "(v1.29 SDK peer)" | Actual peer is `^3.25 \|\| ^4.0` (plus optional peer `@cfworker/json-schema` — ignore). `registerTool` accepts a raw shape **or** a full zod schema; raw shape remains the recommended pattern. Pinning `zod@^3.25` remains valid. | 05 (C2, C3) |
| C14 | §5.1 `twilio: latest` | Resolves to **6.0.2** (2026-07-16). Exact-pin `twilio@6.0.2` for consistency; `validateRequest` signature unchanged. | 03 (claim 15), 08 (V15) |
| C15 | §5.1 "Disable `perMessageDeflate` on **both**" | Only the ws **client** (gateway leg) defaults to ON — that's the mandatory one. The server leg is OFF by default (explicit `false` = free documentation). Also: ws client `handshakeTimeout` has **no default** — set ~5 s. | 08 (V5, gotcha 11) |
| C16 | §6 step 4 "no Twilio-side concurrency limit" for inbound | Holds for upgraded accounts with an approved profile; trial/unapproved accounts have limited concurrency and trial blocks unverified inbound callers entirely. | 03 (claim 12) |
| C17 | §7.2 set Region in dashboard | Redundant: `railway.json` `multiRegionConfig` overrides dashboard on every deploy ("code always overrides"). Harmless; droppable. Doc 07 also recommends adding `overlapSeconds: 10` (BRD omits it). | 07 (claim 2, Impl) |
| C18 | §7.6/SIGTERM handler (implicit ordering) | The drain must run **before** `fastify.close()`: `@fastify/websocket`'s default `preClose` severs all live WS connections in ~2 ms. Calling `app.close()` directly on SIGTERM violates the BRD's own drain intent. | 08 (V9, gotcha 2) |

### 3B. Between findings docs (tensions and resolutions)

| # | Tension | Resolution |
|---|---|---|
| T1 | **Doc 02's "canonical bridge connect sequence" is labeled "(matches BRD §5.2)" and contains a broken ternary** (`await rt.getToken ? … : never`) — while doc 01 establishes BRD §5.2's receiver is wrong. Doc 02 never explicitly flags the `rt.getToken` bug; a build agent reading only doc 02 could reproduce it or copy non-compiling code. | **Doc 01 §Implementation-grade detail 1 is the authoritative connect sequence.** Doc 02's snippet intends the same thing (its comment says "use the factory getToken") but must not be copied verbatim. |
| T2 | **Keepalive:** docs 01 (gotcha 12) / 02 (gotcha 9) say "no keepalive needed" (no `getHealthCheckResponse`; continuous media); doc 08 ships a 25 s ping heartbeat on the gateway leg as "belt-and-braces". | Not a real conflict: all three agree media traffic suffices during calls. The doc 08 heartbeat is optional insurance whose only open point is whether WS-protocol pings even count against the 5-min idle timer (doc 01 says idle counts "sent **or** received"; ping frames are transport-level — spike S23). Fine to include; must not be *relied on* to hold an audio-silent session open. |
| T3 | **Mark naming/granularity:** doc 04 D4 sends one mark per `audio-delta` named `r<responseId>:<seq>` (barge-in accounting); doc 09 §2 sends one instrumented mark `t<turn>-first` per response and ignores all other echoes for timing. Doc 04's own O7 flags mark-per-delta as potential noise. | Compatible if unified: one namespace, e.g. per-delta `r<responseId>:<seq>` for the barge-in queue **plus** treating the first mark of each response as the `tFirstMarkEcho` instrumentation point (no separate `t<turn>-first` mark needed). Whatever the choice, remove-by-name (C4) and "never log non-first echoes" (doc 09) both still apply. Decide once in `session.ts`; revisit after S17 (delta cadence) if deltas are tiny. |
| T4 | **Barge-in state machine (doc 04 D4) omits the Path-B DSP reset (doc 06 gotcha 3).** Doc 04's `bargeIn()`/`response-created` handlers don't call `down.reset()`; doc 06 requires resetting the outbound downsampler at each new response and on barge-in. | Integration seam, not disagreement — doc 04 scoped DSP out. The merged Session must add `dspState.down.reset()` inside both the `response-created` handler and `bargeIn()` when `AUDIO_MODE=transcode`. Worth stating because both docs present "complete" pseudocode for the same handler. |
| T5 | **DSP benchmark numbers differ:** BRD/§5.5 says ~32 µs round trip; doc 06 measures 21.4 µs. | Explicitly non-conflicting (different hardware; doc 06 says "same order"). Conclusion identical: DSP is not a bottleneck. |
| T6 | **`reply.hijack()` placement:** doc 05's `/mcp` snippet hijacks at handler entry (before `server.connect`); doc 08 hijacks after `connect`, before `handleRequest`. | Both satisfy the only real rule (hijack **before** the transport writes to `reply.raw`, per doc 08 gotcha 4). Either order is fine; pick one. |
| T7 | **MCP client lifecycle:** BRD §5.7/doc 05 create a `Client` per call ("at call start"); doc 05 also notes a process-wide singleton "would also work but gains nothing". | No conflict — per-call is the agreed design (5 ms warm connect, FR-3 isolation trivial). Ensure `client.close()` in Session teardown. |

No irreconcilable contradictions exist between findings docs — every pairwise tension above has a stated resolution.

---

## Part 4 — Consolidated runtime-spike-only unknowns

Everything below is unanswerable from source/docs (gateway server-side is closed-source; several platform behaviors are undocumented). Deduplicated across docs 01–09; grouped by the milestone that should resolve it. Each item lists the observation method.

### M1 — gateway + audio (the core spike, BRD §5.5/§10)

| # | Unknown | Observe via | Docs |
|---|---|---|---|
| S1 | Does the gateway honor `audio/pcmu` for OpenAI realtime models end-to-end (Path A)? | `session-updated.raw` + audible output | 01, 02, 04, 06, BRD §11 |
| S2 | Is the gateway's default/applied output really PCM16@24 kHz (Path B constants)? | `session-updated.raw` before first delta | 06 |
| S3 | Gateway behavior if a `rate` field is sent alongside `audio/pcmu` (reject vs ignore)? Omit it regardless. | deliberate misconfig once, log result | 06 |
| S4 | `speech-started` normalized vs `custom {rawType:'input_audio_buffer.speech_started'}` through the gateway? (Public mapper says normalized — LIKELY.) | first live call logs; D4 handler covers both | 01, 02, 04, BRD §11 |
| S5 | Does the gateway pass raw OpenAI events through in `.raw` (esp. `speech_stopped.audio_end_ms` for the `vadGapMs` cross-check), and what exactly is `session-updated.raw`'s shape? | log `.raw` verbatim on first call | 09, 02 |
| S6 | Are `session-update` → `response-create` applied in order through the gateway (greeting arrives in configured format/voice)? Fallback: wait for `session-updated` (~1 RTT). | greeting audio format on first call | 04 (O3) |
| S7 | Does `gpt-realtime-2.1` accept realtime WS connects despite the missing `websocket-realtime` tag? Fallback `openai/gpt-realtime-2` (one line). | one connect attempt | 01, BRD §11 |
| S8 | `VOICE=marin` accepted for this model through the gateway? (Gap G3.) | `session-updated.raw` + audible voice | this doc |
| S9 | Does the gateway forward `conversation-item-truncate` faithfully and return the `conversation.item.truncated` ack (as `custom`)? Acceptance probe: after barge-in, ask "what did you just say?" | M2 barge-in test + `custom` logs | 04 (O2) |
| S10 | Does `sessionConfig.providerOptions` pass through to OpenAI session params (`idle_timeout_ms`, `interrupt_response`, semantic-vad `eagerness`), and with what merge shape (root-level assign clobbers `audio` in the public codec)? | send providerOptions, diff `session-updated.raw` | 04 (O4), 02 (O7) |
| S11 | Exact error `code` strings through the gateway for: cancel-with-no-active-response, truncate-out-of-range, create-while-active — needed for the benign-error whitelists. | log `.raw` on every `error` event M1/M2 | 04 (O5) |
| S12 | Actual `response-done.status` values (and is `turn_detected` reachable in `.raw.response.status_details`)? | M1/M2 logs | 02, 04 (O6) |
| S13 | Does the gateway server ever send a JSON **array** of events in one frame? (Handle both regardless — contract allows it.) | log if `Array.isArray(parsed)` | 02 |
| S14 | WS close-code vocabulary from `ai-gateway.vercel.sh`: 25-min cap, 5-min idle, 30-s no-first-message, concurrency rejection, expired/reused `vcst_` token (also: is the token strictly single-use?). | log `code`/`reason` on every close + `unexpected-response` on upgrade | 01, 02, 08 |
| S15 | Realtime token TTL: default/max for `expiresAfterSeconds`; check returned `expiresAt`. Also `getToken` latency distribution (budgeted ~100 ms; gates FR-1). | log `expiresAt` + `getTokenMs` per call | 01, 09 |
| S16 | Event-ordering guarantee `response-created` before that response's first `audio-delta` through the gateway (instrumentation state machine assumes it). | M1 logs; fallback lazy responseId attach | 09 |
| S17 | Gateway `audio-delta` chunk size/cadence for pcmu vs pcm output (affects mark granularity T3; correctness already handled). | M1 logs | 04 (O7), 06 |
| S18 | Whether OpenAI's input noise-reduction/VAD behaves differently on 8 kHz μ-law vs 24 kHz PCM input (could shift perceived VAD latency between Path A and Path B). | compare `speech-stopped` timing across paths | 06 |

### M1 — Twilio leg (kill tests + observations)

| # | Unknown | Observe via | Docs |
|---|---|---|---|
| S19 | Caller-experience timing on (a) WS handshake failure, (b) mid-call bridge WS drop: seconds to fall-through/hangup, any dead air? (FR-7 evidence.) | kill test with `<Stream statusCallback>` → log-only `/stream-status` route attached | 03 |
| S20 | Is the target Twilio account upgraded (non-trial) with approved profile? Gates FR-3's parallel-call test and claim C16. | console check (human, pre-M1) | 03 |
| S21 | Is `X-Twilio-Signature` present on every Media Streams upgrade request (prerequisite for optional defense-in-depth validation)? | log the header on upgrades at M1 | 03 |
| S22 | Twilio handshake timeout, max accepted inbound `media` size, and actual inbound frame cadence on this account/region (expect 20 ms/160 B). | one log line from M1 media timestamps | 03 |
| S23 | Does a canned μ-law clip sent right before `twilioWs.close()` reliably play (Gap G4 fallback design)? Related: do WS-protocol pings count against the gateway 5-min idle timer (T2)? | 10-min M1 probe / only matters off-audio | this doc, 08 |

### M4 — concurrency + platform

| # | Unknown | Observe via | Docs |
|---|---|---|---|
| S24 | Team concurrent-session limit **number** (unpublished; design assumes ≥10), and **where** rejection manifests: `getToken` mint (HTTP error class) vs WS-open (close/HTTP code). Both paths must map to FR-7. | M4 ramp test + ask Vercel support | 01, BRD §11 |
| S25 | Railway connection routing during overlap/draining: do established WS connections keep flowing to the SIGTERM'd replica; are new connections atomically switched? (Max `drainingSeconds`/`overlapSeconds` also undocumented.) | deploy mid-call with `overlapSeconds:10, drainingSeconds:60` | 07 |
| S26 | Railway shared-vCPU multiplier on the 21 µs/frame DSP benchmark (expected ≤5×, still negligible) + event-loop `loopP99Ms` at 5 concurrent calls. | M4 summaries | 06, 09 |
| S27 | Actual Hobby usage burn (predicted ~$3/mo inside the $5 credit). | Railway usage dashboard after M4 | 07 |
| S28 | Twilio caller experience when `/twiml` 503s during drain (retry/fallback-URL behavior). Accepted risk: "deploy between calls". | only if the operating rule is ever relaxed | 08 |
| S29 | `allowedHosts`/DNS-rebinding hardening for `/mcp` behind Railway's proxy (reasoned from source, untested behind the proxy). | only if adopted | 05 |

### M1/M5 — billing & observability

| # | Unknown | Observe via | Docs |
|---|---|---|---|
| S30 | Audio-token pricing: models API lists $4/$24/M with **no audio-token field**; whether the gateway bills listed rates or OpenAI's higher audio rates is unobservable pre-billing. | dashboard Requests log + `/v1/credits` delta after first billed call | 01, BRD §11 |
| S31 | Do realtime sessions surface generation IDs (`GET /v1/generation`) and how do they appear in the dashboard (per-session? per-response?)? Note `/v1/report` is 403 on Hobby. | `session-created.raw` + dashboard after M1 | 01 |
| S32 | Is `providerOptions.gateway` (`tags: ['voice-poc']`, `user`) honored for realtime spend attribution? | dashboard after a tagged call | 01 |
| S33 | Railway Log Explorer: nested-attribute filtering undocumented (flat fields sidestep it) — verify `@event:turn` / numeric filters work on the first deployed build before M5 relies on them; also indexing lag under burst. | first deployed build | 09 |
| S34 | Semantics of OpenAI `audio_end_ms` on `speech_stopped` (includes silence window?) — needed only if S5 shows `.raw` passthrough. | compare observed values M1 | 09 |
| S35 | Gateway-hop latency overhead itself (no published numbers; Vercel WS termination locale unknown). The §5.9 instrumentation IS the measurement — gateway-only by design. | M2–M5 ttfb dataset | 07, 09, BRD §11 |

**Spike-list observations:** (1) The BRD §11 risk table (7 items) is a strict subset of the above — all seven survive as S1, S4, S7, S24, S30, S35 + the pin/vendoring mitigation (no spike needed for API drift). (2) Everything in S1–S18 is observable from **one instrumented M1 call** plus deliberate misconfigs — the single most valuable build artifact for the research phase is the M1 logging of `.raw`, close codes, and `session-updated` verbatim, exactly as docs 01/09 specify. (3) Only S8, S23a (canned-clip playback), and G1–G4 decisions are **new** relative to the union of docs 01–09.

---

## Sources

- `D:\projects-linean\CSUB-RIO-POC\BRD_Micro_Voice_PoC.md` (read in full)
- `D:\projects-linean\CSUB-RIO-POC\docs\findings\01-vercel-ai-gateway-realtime.md`
- `D:\projects-linean\CSUB-RIO-POC\docs\findings\02-ai-sdk-realtime-event-protocol.md`
- `D:\projects-linean\CSUB-RIO-POC\docs\findings\03-twilio-media-streams.md`
- `D:\projects-linean\CSUB-RIO-POC\docs\findings\04-barge-in-and-realtime-voice-patterns.md`
- `D:\projects-linean\CSUB-RIO-POC\docs\findings\05-mcp-sdk-streamable-http.md`
- `D:\projects-linean\CSUB-RIO-POC\docs\findings\06-audio-dsp-transcoding.md`
- `D:\projects-linean\CSUB-RIO-POC\docs\findings\07-railway-deployment.md`
- `D:\projects-linean\CSUB-RIO-POC\docs\findings\08-fastify-ws-server-architecture.md`
- `D:\projects-linean\CSUB-RIO-POC\docs\findings\09-latency-instrumentation.md`

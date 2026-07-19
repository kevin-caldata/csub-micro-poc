# Findings 11 — Demo-impact capability audit of the PoC codebase

**Date:** 2026-07-19
**Author:** research agent (Claude)
**Scope:** Thought-exercise audit (no code changes) of `D:\projects-linean\CSUB-RIO-POC` for levers that raise demo impact for the CSUB "RIO" stakeholder demo: persona, fake-data tools, transcript/KPI story, language, fake warm transfer, voice options, SMS. Everything below is verified against the working tree as of 2026-07-19; citations are `file:line`. Companion to findings/01–10 (same numbered-claims style).

---

## 1. Persona / system instructions

### C1. The persona is a hardcoded exported constant — one string edit away from "RIO" — **VERIFIED**
- The entire system prompt lives in `src/gateway.ts:241-244` as the exported `const INSTRUCTIONS`:
  > "You are a friendly, concise voice assistant on a phone call. Keep answers short and conversational — one to three sentences. Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."
- It is consumed exactly once, in `buildCallSessionConfig()` at `src/gateway.ts:265` (`instructions: INSTRUCTIONS`), which builds the `session-update` payload sent as the mandatory first client frame on gateway WS open (`src/gateway.ts:590-592`, `sendFirstFrames()`).
- The doc comment at `src/gateway.ts:237-240` explicitly anticipates this lever: *"Exported so it is overridable later without touching `buildCallSessionConfig`."*
- **There is NO `INSTRUCTIONS` env var.** `src/config.ts:3-37` (the full `EnvSchema`) has no instructions/persona key. Making the persona configurable would be a two-line additive edit (one Zod key in `EnvSchema`, one field in `AppConfig`) — exactly the additive-config pattern the master plan blesses (`docs/specs/00-master-build-plan.md:221`, risk R-2: "config.ts/.env.example ... edits are declared additive").
- **Demo effort for "RIO, the Roadrunner Intelligent Operator for CSUB":** trivial. Either edit the one string constant (single-file diff, auto-deploys from GitHub main), or add an `INSTRUCTIONS` env var so the persona can be swapped per Railway environment without a redeploy of code. One caveat: Spec 07 (`docs/specs/07-mcp-server-and-tool-loop.md:189, 271`) requires the tool-preamble sentence ("briefly say you're checking...") to survive — a test asserts on that exact substring (`src/gateway.ts:238-239`), so a rich RIO persona should *append around* that sentence, not delete it.

### C2. The greeting has its own separate instruction string — a second, independent persona lever — **VERIFIED**
- `GREETING_INSTRUCTIONS` (`src/gateway.ts:248`): *"Greet the caller warmly in one short sentence and ask how you can help."* It is sent as a per-response instruction override on the greeting `response-create` (`src/gateway.ts:604-607`), no synthetic conversation items (findings/04 D5 variant 1).
- Changing this one string makes the *very first thing the caller hears* be, e.g., "Thanks for calling CSUB — this is RIO, the Roadrunner Intelligent Operator. How can I help?" — the highest-leverage 10 seconds of the demo, and it is one string literal.

---

## 2. MCP tools and the add-a-tool pattern

### C3. Exactly two hello-world tools exist today — **VERIFIED**
- `src/mcp-server.ts:12-23`: `get_current_time` (no args; returns ISO-8601 + IANA timezone).
- `src/mcp-server.ts:27-36`: `hello` (optional `name: z.string()`; returns "Hello, {name}!").
- Both registered inside `buildMcpServer()`, a fresh `McpServer` per request (stateless StreamableHTTP, `src/mcp-server.ts:41-70`).

### C4. Adding a fake-data tool = ONE `registerTool` call, nothing else changes — **VERIFIED, spec-mandated**
- The in-file contract at `src/mcp-server.ts:37`: `// FR-5: adding a tool = one more registerTool call here. Nothing else changes.`
- Spec 07 makes this normative: *"the `buildMcpServer()` body is the **only** place a new tool touches ... No tool names, schemas, or dispatch tables may appear anywhere in `tools.ts`, `session.ts`, or config"* (`docs/specs/07-mcp-server-and-tool-loop.md:122`), and acceptance test A7: add a third tool as exactly one `registerTool` call, redeploy, callable on the next call; *"`git diff` touches only `src/mcp-server.ts`"* (`docs/specs/07-mcp-server-and-tool-loop.md:263`).
- Why it works with zero wiring: tool defs are fetched **per call** — `startSessionBridge` runs `fetchToolDefs(mcpClient)` before every `session-update` (`src/session.ts:438-446`; `src/tools.ts:30-36` maps `listTools()` → gateway tool defs, dropping `$schema`), and the defs are passed verbatim into the session config (`src/gateway.ts:275`, `tools` passthrough). New tool → next phone call already has it. Spec 07 confirms: *"per-call `listTools()` is the FR-5 extension mechanism"* (`docs/specs/07-mcp-server-and-tool-loop.md:161`).
- **Concrete effort for the demo tool set** (`lookup_office_hours`, `route_call`, `verify_identity`, `reset_password`, `log_crisis_escalation`): five `registerTool` blocks of ~10 lines each, all in `src/mcp-server.ts`, each returning canned fake-data text (e.g. a hardcoded office-hours table, a fake ticket number). Pattern to copy is the `hello` tool (`src/mcp-server.ts:27-36`): zod **raw shape** for `inputSchema` (findings/05 C3), handler returns `{ content: [{ type: 'text', text: ... }] }`. Tool descriptions are the model's routing signal, so rich `description` strings double as demo-script control.

### C5. The ToolLoop already handles multi-tool turns and error tools gracefully — **VERIFIED**
- `ToolLoop` (`src/tools.ts:96-250`) is a per-call state machine: each `function-call-arguments-done` records a `PendingToolCall` in a `Map` and fires `runTool` async (`src/tools.ts:121-128`); the "double gate" (`src/tools.ts:161-181`) sends **exactly one** follow-up `response-create` only when (a) every tool-bearing response is done, (b) **every** pending call's output has been sent, (c) no response is active, (d) not already sent — so *multiple tool calls in one turn* are natively supported (all outputs land before the single follow-up), and any number of **sequential** tool round trips per call are supported (`resetCycle`, `src/tools.ts:238-243`).
- Tool failures never kill the call: `runTool` catches everything and returns `{"error": ...}` as the tool output (`src/tools.ts:39-55`, 5 s timeout at `:42`); the model reads it and apologizes verbally (Spec 07: `docs/specs/07-mcp-server-and-tool-loop.md:189`). Demo-relevant: a deliberately-failing fake tool is a safe "resilience" beat.
- Each round trip emits a one-line `tool-call` log with `mcpMs` / `gateWaitMs` / `secondTtfbMs` / `toolTotalMs` (`src/tools.ts:209-235`) — measured MCP latency is ~5 ms warm (`src/tools.ts:22`), so multiple demo tools cost essentially nothing in latency.

---

## 3. Per-call state, transcripts, and the KPI story

### C6. Both sides of the conversation are ALREADY transcribed into structured logs — **VERIFIED**
- Input transcription is enabled in the session config (`inputAudioTranscription: {}`, `src/gateway.ts:268`), and dispatch logs both directions as flat JSON lines keyed by `callSid`/`streamSid`:
  - assistant side: `output-transcript` with full `transcript` + `responseId` on `audio-transcript-done` (`src/session.ts:158-159`);
  - caller side: `input-transcript` with full `transcript` + `itemId` on `input-transcription-completed` (`src/session.ts:162-163`).
- The logger is single-line minified JSON to stdout, Railway-queryable by `@callSid:` (`src/logger.ts:7-14, 39-44`). **A per-call transcript therefore already exists** — filtering one call's `input-transcript`/`output-transcript` lines reconstructs the dialogue. Repurposing this as a fake "call transcription / QA record" demo screen requires zero bridge changes, only a log-reading view.

### C7. The latency instrumentation is a ready-made per-call KPI record — **VERIFIED**
- `TurnRecorder` (`src/latency.ts:106-644`) maintains rich per-call state: a `GreetingRecord` (webhook → pickup → gateway → first greeting audio chain, `src/latency.ts:45-57`), per-turn `TurnRecord`s with `ttfbMs`/`bridgeMs`/`turnMs`/`playbackConfirmMs`/`bargedIn`/`tools[]` (`src/latency.ts:12-30`), and a `stream-stop` call summary with call duration, turn count, barge-in count, p50/p95/max percentiles and tool-call totals (`src/latency.ts:587-643`).
- Emitted lines per call: `greeting` (`src/latency.ts:241-251`), one `turn` line per exchange (`src/latency.ts:511-523`), `tool-call` per round trip, `barge-in` (`src/latency.ts:423-432`), `dtmf` digits (`src/twilio-media.ts:343-345`), and the final `stream-stop` summary. **Demo framing:** these ARE contact-center KPIs (answer speed, response latency, interruption rate, handle time, tool/"backend" latency) — an Amazon Connect real-time-metrics analog, generated per call today. The only missing piece for a "KPI dashboard" beat is a presentation layer over Railway logs; no capture code is needed.
- Limitation to note honestly: nothing persists — state is in-memory per call (`src/sessions.ts:17-95`) and the record's only durable form is the stdout log stream; there is no DB, file sink, or recording of audio.

---

## 4. Language support

### C8. Nothing in the code constrains the call to English — multilingual is a prompt-only lever — **VERIFIED**
- Turn detection is `server-vad` with silence/threshold/padding numbers only (`src/gateway.ts:269-274`; defaults `src/config.ts:19-21`) — VAD is energy-based, language-agnostic; no language field exists.
- `inputAudioTranscription: {}` sets no language hint (`src/gateway.ts:268`; "{} valid, all fields optional" — findings/02 correction 6), so transcription auto-detects.
- The only English anywhere is the `INSTRUCTIONS`/`GREETING_INSTRUCTIONS` prose itself (`src/gateway.ts:241-248`) — an implicit bias, not a constraint. Adding "If the caller speaks Spanish, respond in Spanish" to the RIO persona (see C1) is the entire change. The voice (`marin`) is a model-side property; no code asserts an English-only voice. A live English→Spanish mid-call switch is a high-impact, zero-risk demo beat.

---

## 5. Faking a "warm transfer" within one call

### C9. Real transfer is designed OUT; the TwiML is `<Connect><Stream>` only — **VERIFIED**
- The webhook returns exactly `<Connect><Stream>` + a token `<Parameter>` (`src/twiml.ts:141-150`) with a design lock: *"NO verbs after `</Connect>`, NO action attribute — the bridge closing the Twilio WS ends the call cleanly"* (`src/twiml.ts:151-153`). There is no `<Dial>`, no conference, no Twilio REST client (the `twilio` import is used only for `validateRequest` and `VoiceResponse`, `src/twiml.ts:3-4`). A *real* transfer would require new TwiML/REST plumbing — out of PoC scope.

### C10. All the primitives for a convincing FAKE warm transfer already exist — **VERIFIED**
Within one live call the bridge can already:
1. **Play an arbitrary pre-rendered mu-law clip** (ring tone / hold music / "connecting you now" chime) over the open Twilio WS and wait for playback confirmation: `src/fallback.ts:94-150` (`playFallbackAndCloseWith`) demonstrates the full pattern — `sendClear(s)` to flush stale audio (`src/fallback.ts:114`; helper `src/twilio-media.ts:431`), `sendMedia(s, clip)` (`src/fallback.ts:116`; helper `src/twilio-media.ts:400`), `sendMark` + poll-for-echo to know the clip finished (`src/fallback.ts:67-87, 117`). The clip is just base64 raw mu-law at 8000 bytes/s (`src/fallback.ts:102`) loaded from `assets/` (`src/fallback.ts:40-44`).
2. **Change the persona mid-call**: `GatewayLeg.send` accepts any client event (`src/gateway.ts:578-581`), including a second `session-update` with new `instructions`, or a `response-create` with per-response `instructions` override (the greeting already uses exactly this, `src/gateway.ts:604-607`). Nothing sends a mid-call `session-update` today, but the plumbing is generic.
3. **Trigger on a tool**: a fake `route_call` / `transfer_to_agent` MCP tool (C4) gives the model itself the ability to "initiate" the transfer, with the tool result ("Transferring you to Financial Aid...") narrated per the tool-preamble instruction.
4. **End the leg**: closing the Twilio WS ends the call (`src/fallback.ts:129-131`; `hangup` helper `src/twilio-media.ts:444`); the gateway leg closes via `session.gateway.close(1000, ...)` (`src/session.ts:363`). The `onGatewayFailure` seam (`src/session.ts:317-321`) is the declared plug-point where clip-then-close behavior joins the session lifecycle (Wave D merge, gated on spike S23 — `src/fallback.ts:20-23`).

**Demo choreography that needs no new primitives** (concept, not code): caller asks for a human → model calls fake `route_call` tool → tool returns "queued for Financial Aid" → model says "connecting you now" → (optional) short hold/ring clip via the fallback-clip pattern → model resumes in a second persona ("Hi, this is the Financial Aid desk...") via per-response instruction override — all inside the single Media Streams call. Unechoed DTMF is even logged already (`src/twilio-media.ts:343-345`) if a "press 1" beat is wanted, though nothing acts on digits today.

---

## 6. Voice options

### C11. Voice is env-configurable; `marin` default with `alloy` boot-config fallback; S8 still unresolved — **VERIFIED**
- `VOICE` (default `'marin'`) and `VOICE_FALLBACK` (default `'alloy'`) are env keys (`src/config.ts:17-18`); any string is accepted — no allowlist — so trying other OpenAI realtime voices (e.g. `cedar`, `alloy`) is an env-var flip per Railway environment, no code change.
- The voice is applied in the session config (`src/gateway.ts:266`) with the inline caveat: *"'marin' default; S8 unverified — boot-config fallback via VOICE_FALLBACK, no runtime auto-retry."* The fallback is **manual** (operator sets env), by design, to keep M1 latency data clean (`docs/specs/00-master-build-plan.md:223`, risk R-4; guardrail G3 at `:142`).
- Ground truth for what voice actually applied is the `session-updated` event's `.raw`, logged verbatim per call (`src/gateway.ts:457-462`) — spike S8 (`marin` validity) is resolved by reading that log at M1 (`docs/specs/00-master-build-plan.md:193`). **Demo note:** verify `marin` in `session-updated.raw` before the demo; if rejected, one env flip to `alloy` fixes it.

---

## 7. SMS

### C12. The codebase does not touch Twilio SMS at all — **VERIFIED (negative result)**
- Repo-wide grep for SMS/messaging: zero hits outside Media-Streams WS message types (`src/twilio-media.ts:28-93`) and log strings. The `twilio` package is imported once, for webhook signature validation and TwiML generation only (`src/twiml.ts:3-4, 141`). Config has no Twilio Account SID — only `TWILIO_AUTH_TOKEN` (`src/config.ts:11`) — so even the REST client for `messages.create` could not be constructed today.
- **Demo implication:** a real "I'll text you a link" beat is a genuinely new integration (Account SID + REST call). A *fake* one is prompt/tool-only: a `send_sms` MCP tool returning "SMS sent to (661) 555-xxxx" costs one `registerTool` block (C4) and the model will narrate it convincingly — consistent with the everything-is-fake-data PoC charter.

---

## 8. Declared extension points (spec skim)

### C13. The specs pre-authorize exactly the levers above — **VERIFIED**
- **Tools:** FR-5 mechanism confined to `buildMcpServer()` (`docs/specs/07-mcp-server-and-tool-loop.md:122, 161, 263`).
- **Persona:** instructions text is explicitly Spec 04 R8 territory, owned by `gateway.ts`, and Spec 07 defers to it (`docs/specs/07-mcp-server-and-tool-loop.md:271`); the export-for-override comment sits in code (`src/gateway.ts:237-240`).
- **Config:** additive `config.ts`/`.env.example` edits are the sanctioned pattern (`docs/specs/00-master-build-plan.md:110, 221`).
- **Fallback/transfer plumbing:** `playFallbackAndClose` → `onGatewayFailure` is a declared one-line Wave-D merge (`src/fallback.ts:20-23`; `src/session.ts:311-321`).
- **Session extension hooks:** `Session` carries typed optional callbacks (`onTwilioMedia`/`onPlaybackDrained`/`onFirstMarkEcho`/`onTeardown`) as the sanctioned seam for new per-call behavior (`src/sessions.ts:34-38`).

---

## Summary table — demo lever vs. effort

| Lever | Where | Effort (concept) |
|---|---|---|
| RIO persona + branded greeting | `src/gateway.ts:241-248` (2 string constants) | Trivial; keep the tool-preamble sentence; optional env-var-ification |
| 5 fake CSUB tools | `src/mcp-server.ts:37` (one `registerTool` each) | Small; single-file diff, live on next call |
| Transcript / KPI story | Already emitted (`src/session.ts:158-163`; `src/latency.ts`) | Zero capture work; presentation layer only |
| Spanish / multilingual | Prompt line in `INSTRUCTIONS` | Trivial; nothing constrains language |
| Fake warm transfer | `route_call` tool + fallback-clip pattern (`src/fallback.ts:94-150`) + per-response instruction override (`src/gateway.ts:604-607`) | Moderate concept, all primitives exist |
| Voice A/B | `VOICE` env (`src/config.ts:17`) | Env flip; verify via `session-updated.raw` (S8) |
| SMS | Absent | Fake via tool narration only; real SMS = new integration |

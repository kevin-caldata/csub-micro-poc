# Demo Spec 06 — Documentation Deliverables + Launch

Date: 2026-07-19 · Project: CSUB-RIO self-serve demo · Status: Draft for review
Depends on: Demo Spec 05 (performance tuning — this spec CONSUMES its measured E4/E6 results; the ARCHITECTURE.md latency annotations are hard-blocked on them), the demo specs that own the corpus (`assets/csub-corpus.md`), the static tool set, the `ask_campus_knowledge` tool, and the RIO persona (this spec documents and verifies against their shipped output, referenced descriptively below) · Enables: the email send itself — the last step of the build.
Findings referenced: findings/11 (C1, C4–C7, C10–C11), findings/15 (§1–§5, claims 5, 12–15, 17–25), findings/16 (C1–C18), findings/17 (via `docs/demo/RIO-INTELLIGENT-TOOLS-CONCEPT.md` §2, §5, §6), findings/12 (§3.4, §6.5 via findings/16 citations), findings/09 (V4), findings/07 (gotcha 8). Concept docs: `docs/demo/RIO-INTELLIGENT-TOOLS-CONCEPT.md`, `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md`, `docs/demo/RIO-DEMO-CONCEPT.md`.

---

## Objective

When this spec is done, four artifacts exist and are internally consistent with the shipped build: (a) `docs/demo/ARCHITECTURE.md` — a process-flow document with one mermaid flowchart and one mermaid sequence diagram, evolved from the user's original concept flow (Actor → phone → Twilio → WS bridge → GPT-Realtime via AI Gateway → MCP server → tier-1 static tools → fake data; tier-2 `ask_campus_knowledge` → `google/gemini-3.1-flash-lite` via the same gateway → corpus), annotated with **measured** latencies from Demo Spec 05's E4/E6 experiment results — estimated or placeholder numbers are forbidden; (b) `docs/demo/MCP-SERVER-DEEP-DIVE.md` — the written replacement for the technical Q&A a presenter would have fielded, covering transport, registry, the two-tier taxonomy, ToolLoop mechanics, the delegated-intelligence pattern with its cost math, statelessness, a use-case catalog, and operational characteristics; (c) the finalized announcement email (`docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` edited in place) with the "what time is it" item rewritten as a tool-call showcase, every live/simulated/future claim re-verified against the shipped build, and its three send-blocking placeholders declared as execution-time human inputs; (d) `docs/demo/LAUNCH-CHECKLIST.md` — pre-send smoke test script, post-send deploy-freeze rule, 72-hour log-extraction cadence, corpus update procedure reference, and rollback procedure.

## Deliverables

- `docs/demo/ARCHITECTURE.md` — new file (R1–R7).
- `docs/demo/MCP-SERVER-DEEP-DIVE.md` — new file (R8–R16).
- `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` — edited in place (R17–R21). No new file; the artifact keeps its history.
- `docs/demo/LAUNCH-CHECKLIST.md` — new file (R22–R26).

Ordering constraint: R8–R26 can be executed as soon as the build specs land. R5 (latency annotations) is executable **only after** Demo Spec 05's E4/E6 measurement data has been extracted into `docs/measurements/` — ARCHITECTURE.md may be drafted earlier, but it must not be committed with annotation gaps (R6 forbids placeholders; a draft with missing numbers stays uncommitted or on a branch).

## Requirements

### (a) `docs/demo/ARCHITECTURE.md` — process-flow document

**R1. Document skeleton.** The file contains, in order: a one-paragraph purpose statement (audience: technically curious email recipients and future maintainers; states that every number in the diagrams is measured, with measurement date and source path); §1 the flowchart (R2–R3); §2 the sequence diagram (R4); §3 a latency table consolidating every annotation with its source (R5); §4 failure paths in prose (R7). All mermaid content in fenced ` ```mermaid ` blocks (GitHub renders these natively). Every section cites findings/spec sources in the `[findings/NN §claim]` / `[file:line]` house style.

**R2. Flowchart node inventory (exact).** The flowchart (`flowchart LR` or `flowchart TD`, implementer's layout choice) must contain **exactly** these nodes, with these IDs and labels (labels in double quotes so parentheses/commas parse; wording may be tightened only if every fact below survives):

| ID | Label |
|---|---|
| `caller` | `"Caller (any phone)"` |
| `twilio` | `"Twilio — +1 (661) 490-9364 — Programmable Voice + Media Streams"` |
| `bridge` | `"Bridge — one Node 22 process (Fastify + ws) on Railway us-east4"` |
| `webhook` | `"POST /twiml — signature-validated webhook, TwiML <Connect><Stream>, gateway token pre-mint"` |
| `gw` | `"Vercel AI Gateway — one AI_GATEWAY_API_KEY, two modalities"` |
| `rt` | `"openai/gpt-realtime-2.1 — speech-to-speech (realtime WS modality)"` |
| `mcp` | `"In-process MCP server — POST /mcp, StreamableHTTP stateless, fresh server per request"` |
| `t1` | `"Tier 1 — six static tools: escalate_to_human, route_call, verify_identity, reset_password, send_sms, get_current_time"` |
| `fake` | `"Canned simulated data — constants inside tool handlers, no model, no I/O"` |
| `t2` | `"Tier 2 — ask_campus_knowledge(question, topic?)"` |
| `flash` | `"google/gemini-3.1-flash-lite — generateObject, thinking minimal, max 150 output tokens"` |
| `corpus` | `"assets/csub-corpus.md — ~30–50 KB, 12 sections, SIMULATED-DATA banner, loaded once at module scope"` |
| `apology` | `"assets/fallback-apology.ulaw — pre-rendered apology clip"` |

`webhook` is drawn inside a `subgraph` for `bridge` (it is a route on the same Fastify process — [src/twiml.ts:141-150]); `t1`, `t2` inside a subgraph for `mcp`; `rt` and `flash` are drawn as separate consumers behind the single `gw` node — the "same gateway, same key, both modalities" point is the diagram's central claim [findings/15 §1–3; src/config.ts:4; src/gateway.ts:81].

**R3. Flowchart edge inventory (exact facts per edge).** Required edges and the fact each label must carry:

1. `caller → twilio`: PSTN dial.
2. `twilio → webhook`: HTTP webhook, Twilio-signature validated; response is `<Connect><Stream>` only — no verbs after `</Connect>`, no `<Dial>` (real transfer designed out) [findings/11 §C9; src/twiml.ts:141-153].
3. `twilio ↔ bridge`: WebSocket; μ-law 8 kHz base64 audio, 20 ms frames, both directions.
4. `bridge ↔ gw ↔ rt`: realtime WS session; first frame is `session-update` carrying persona instructions + per-call tool defs [src/gateway.ts:590-592].
5. `bridge → mcp`: per-call `listTools()` at call start; `callTool` over localhost HTTP with the 5000 ms transport cap [src/tools.ts:42; findings/16 §C3].
6. `mcp → t1 → fake`: deterministic, single-digit-ms, no LLM.
7. `mcp → t2`; `t2 → gw → flash`: HTTPS text modality, same `AI_GATEWAY_API_KEY`, in-handler abort `AbortSignal.any([extra.signal, AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS)])` with `MCP_TOOL_TIMEOUT_MS` default 3500 [findings/16 §C12].
8. `corpus → t2`: whole-corpus prompt-stuffing, corpus-first/question-last for implicit caching; no RAG, no pre-filter [findings/15 §21; RIO-INTELLIGENT-TOOLS-CONCEPT §5.18].
9. `t2 → mcp` return edge labeled with the envelope verbatim: `{status: 'ok'|'not_found'|'error', response_text}`.
10. `bridge → apology → caller` (failure edge): gateway-leg death → `playFallbackAndClose` plays the clip over the still-open Twilio WS, then closes it (closing the Twilio WS ends the call) [src/server.ts:142; src/fallback.ts:94-150].

A barge-in annotation must appear on the `twilio ↔ bridge` edge or the `bridge` node: caller speech during playback → clear Twilio buffer + truncate model memory; during the tool gap barge-in is a designed no-op [src/bargein.ts:75; findings/16 §C7].

**R4. Sequence diagram.** One `sequenceDiagram` with participants exactly: `Caller`, `Twilio`, `Bridge` (owns ToolLoop), `Gateway` (one participant serving both models — annotate which model each arrow targets), `MCP` (in-process server), `FlashLite`. It walks the knowledge-question round trip of `RIO-INTELLIGENT-TOOLS-CONCEPT.md` §3, steps 1–8: caller question → VAD end-of-speech → R1 response streams the spoken preamble AND emits `function-call-arguments-done` → ToolLoop `runTool` → MCP handler → `generateObject` on flash-lite over the corpus → envelope → `function-call-output` via `conversation-item-create` → double gate releases exactly one `response-create` → R2 speaks the answer. A `note over` marks the preamble-masking window: tool execution overlaps the preamble audio; time inside it is free of caller-perceived dead air [findings/16 §C6]. Three `alt` blocks cover the failure paths (same content as R7): mint failure, gateway death, tool timeout.

**R5. Measured latency annotations — the Spec 05 dependency.** Every latency annotation in both diagrams and the §3 table comes from Demo Spec 05's measured results — experiments **E4** (delegated knowledge-tool round trip) and **E6** (end-to-end call, static-tool baseline) — as extracted into `docs/measurements/<YYYY-MM-DD>-<label>/` per Spec 08 R14 [docs/specs/08-logging-and-latency-instrumentation.md:225-241]. Minimum required annotation set, each as `p50/p95 <n> ms (measured <YYYY-MM-DD>, docs/measurements/<dir>)`:

1. Turn TTFB (`ttfbMs`) for ordinary speech turns — from E6 `turn` lines.
2. Static-tool `toolTotalMs` (p50/p95) — from E6 `tool-call` lines.
3. Knowledge-tool `toolTotalMs` (p50/p95) — from E4; state explicitly whether it meets the M3 gate `toolTotalMs < 1500` ms [docs/specs/00-master-build-plan.md:126].
4. Knowledge-tool model-call duration (the in-handler `generateObject` await, p50/p95) — from E4.
5. `gateWaitMs` and `secondTtfbMs` (p50) for tool turns — from E4/E6.
6. Barge-in cutoff time if E-series data includes `barge-in` lines; if Spec 05 produced no barge-in measurement, the diagram marks barge-in qualitatively (no number) — that is the only permitted unnumbered path annotation.

The pre-measurement design estimates (0.7–1.2 s p50 etc. [findings/15 §14]) may appear only in the §3 table's "design estimate" column beside the measured value — never as the annotation itself.

**R6. No placeholders.** The strings `TBD`, `TODO`, `XXX`, `~?`, `N ms`, and any square-bracket placeholder are forbidden in ARCHITECTURE.md. If a required number does not exist yet, the file is not ready to commit — the fix is running/extracting Spec 05, not softening the annotation.

**R7. Failure-path prose (§4).** Three subsections, each: trigger → mechanism → what the caller hears → log evidence.

1. **Mint failure**: the gateway token mint (kicked off at webhook time) rejects → `mint-failed` log event → clean teardown, no gateway leg, call ends [src/session.ts:381-384].
2. **Gateway death mid-call**: WS `error`/unexpected `close`/fatal in-band `error` → `onGatewayFailure` seam → `playFallbackAndClose`: clear stale audio, play `assets/fallback-apology.ulaw`, wait for mark echo, close the Twilio WS; `fallback-played` log line with `echoed`/`waitedMs` [src/server.ts:142; src/session.ts:532-539; src/fallback.ts:108-149].
3. **Tool timeout / tool failure**: in-handler abort at `MCP_TOOL_TIMEOUT_MS` (3500 ms default) returns a handler-authored `status:'error'` envelope; the 5000 ms transport cap [src/tools.ts:42] is the ceiling behind it; either way `runTool` never throws — the model reads the error output and apologizes verbally; the call continues [src/tools.ts:39-55; findings/16 §C11–C12].

### (b) `docs/demo/MCP-SERVER-DEEP-DIVE.md`

**R8. Required section list.** The file has exactly these numbered sections (order fixed): 1 Transport architecture · 2 Tool registry and the per-call re-fetch guarantee · 3 The two-tier taxonomy · 4 ToolLoop mechanics · 5 The delegated-intelligence pattern · 6 Statelessness and cross-tool state · 7 Use-case catalog · 8 Operational characteristics. Purpose paragraph up top: this document replaces the technical Q&A a presenter would have fielded in a staged demo; it is written for an engineer who has the repo open.

**R9. §1 Transport architecture.** Must cover: StreamableHTTP in stateless mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) with a **fresh `McpServer` + transport per POST** and *why* — the SDK runtime-enforces it (`'Stateless transport cannot be reused across requests'`) and JSON mode keeps `/mcp` curl-debuggable [docs/specs/07-mcp-server-and-tool-loop.md R2; src/mcp-server.ts:41-70]; the `GET/DELETE /mcp` 405 handlers; server-in-same-process (client connects to `http://127.0.0.1:$PORT/mcp`, warm connect ≈ 5 ms [src/tools.ts:22]).

**R10. §2 Tool registry and per-call re-fetch.** Must cover: `buildMcpServer()` as the single FR-5 extension point (quote the in-file contract comment [src/mcp-server.ts:37]); tool defs fetched fresh **per phone call** via `fetchToolDefs` (`listTools()` → realtime tool mapping, `$schema` stripped, never spread) before every `session-update` [src/tools.ts:30-36; src/session.ts:438-446; src/gateway.ts:275] — consequence: a pushed tool is live on the next call with zero bridge changes.

**R11. §3 Two-tier taxonomy.** Must state the tier-decision rule verbatim from the concept doc: *a tool is static-fake when its return must be deterministic, instant, or safety-critical (canned string, no model in the loop); it is delegated-intelligence when its job is answering an open-ended factual question whose answer lives in the corpus* [RIO-INTELLIGENT-TOOLS-CONCEPT §2; findings/16 §C13]. Then the seven-tool table (six static + `ask_campus_knowledge`) with per-tool tier rationale, and the two corollaries: safety paths never touch the intelligent tier (real numbers spoken verbatim: Counseling Center (661) 654-3366, 988, UPD (661) 654-2111, operator (661) 654-2782 — simulated handoff, nobody dialed); exactly ONE delegated tool (topic-sharded `ask_*` tools recreate the intent-tree misfire class [RIO-INTELLIGENT-TOOLS-CONCEPT §2.8]).

**R12. §4 ToolLoop mechanics.** Must cover, with citations: `function-call-arguments-done` → async `runTool` → `conversation-item-create {function-call-output}` [src/tools.ts:121-144]; the **double gate** — exactly one `response-create` iff (a) every tool-bearing response done, (b) every pending output sent, (c) no response active, (d) not already sent [src/tools.ts:161-181; findings/11 §C5]; the deferred retry — re-checked on every `response-done`, "never a timer" [src/tools.ts:148-155]; barge-in races — tool-gap barge-in is a guarded no-op, a VAD auto-response blocks gate condition (c) and sets `autoResponseIntervened`, the lost-race `conversation_already_has_active_response`-class error is treated benign and retried [src/bargein.ts:75; src/tools.ts:168-172; src/session.ts:209-211; findings/16 §C7]; the never-throws contract of `runTool` and the spoken-apology outcome [src/tools.ts:39-55].

**R13. §5 The delegated-intelligence pattern.** Must present the context-protection argument with the numbers: a ~75 KB/19k-token corpus stuffed into realtime `INSTRUCTIONS` costs ≈ $0.076 on turn 1 + ≈ $0.0076/turn cached ≈ **$0.16 per 12-turn call**, paid on every call; the same call delegating ~2 questions to flash-lite costs ≈ **$0.004** — ~40× cheaper, and only on knowledge turns [findings/16 §C18]; price asymmetry $4/M realtime text-in vs $0.25/M flash-lite ($0.40/M vs $0.03/M cached) [findings/15 §22–23; findings/12 §6.5]; 128k realtime window vs 1M flash-lite; and the non-dollar half — instruction-following/persona-adherence dilution and prefill latency on every turn [findings/16 §C18]. Must state the boundary contract: one-sentence question in, 2–3-sentence envelope out; the corpus never enters the realtime context [RIO-INTELLIGENT-TOOLS-CONCEPT §4.17]. Must name the single-model/no-fallback decision: `MCP_MODEL_ID` default `google/gemini-3.1-flash-lite`, no fallback chain — on failure the envelope carries `status:'error'` and the existing spoken-apology path handles it.

**R14. §6 Statelessness and cross-tool state.** Must explain: the MCP server holds **zero** state between requests (fresh server per POST); therefore any state a multi-step flow needs rides in the **realtime conversation itself** — tool results become conversation items the model carries forward. Concrete walkthrough: the `verify_identity` → `reset_password` flow — verification's returned result (the simulated verified/token payload, exact shape per the static-tools spec) lives only in GPT-Realtime's context; `reset_password` receives what the model passes back as arguments; the MCP server never remembers the caller. Note honestly that this is theater on fake data (verification always succeeds) and that in a production design the token would be server-validated.

**R15. §7 Use-case catalog.** Two lists plus a recipe. **Can handle today**: open-ended campus-fact Q&A from the 12-section corpus (grounded, `not_found`-safe); simulated routing/warm-transfer narration; simulated identity verification + password-reset flow; simulated SMS narration; current time; crisis-path escalation speaking real resource numbers; bilingual (Spanish-switch) operation; barge-in mid-anything. **Cannot handle today** (each with the reason): real transfers (no `<Dial>`, designed out [src/twiml.ts:151-153]); real SMS (no Account SID, no REST client [findings/11 §C12]); facts outside the corpus (returns `not_found`, offers routing — by design); real records/verification; audio recording; anything requiring per-caller persistence (no DB; state is in-memory per call [findings/11 §C7]). **Extension recipe for a new tool**: (1) apply the R11 tier rule; (2) static → one `registerTool` block in `buildMcpServer()` returning canned content, ~10 lines [findings/11 §C4]; knowledge → don't add a tool, add a corpus section and push; (3) keep the instructions' tool mentions in exact sync with the registered list [RIO-INTELLIGENT-TOOLS-CONCEPT §6.23]; (4) push to main → Railway auto-deploy (~2 min) → live on the next call; deploys sever in-flight calls.

**R16. §8 Operational characteristics.** Must tabulate: timeouts (in-handler `MCP_TOOL_TIMEOUT_MS` 3500 ms → transport cap 5000 ms [src/tools.ts:42] → SDK default 60 s, unused); env keys `MCP_MODEL_ID` (default `google/gemini-3.1-flash-lite`), `MCP_MODEL_MAX_TOKENS` (default 150), `MCP_TOOL_TIMEOUT_MS` (default 3500) — additive to `src/config.ts`; error paths (handler throw → `isError` → `{"error":...}`; abort → handler-authored `status:'error'` envelope; transport failure → outer catch — all reach the same spoken apology, none can kill the call [findings/16 §C11]); logging (the one-line `tool-call` event with flat `mcpMs`/`gateWaitMs`/`secondTtfbMs`/`toolTotalMs` [src/tools.ts:209-235], Railway-queryable `@event:tool-call AND @toolTotalMs:>1500`); the M3 gate `toolTotalMs < 1500` ms; corpus load-once-at-module-scope and why (`buildMcpServer` runs per request; `import.meta.url` path resolution per the fallback-clip precedent [src/fallback.ts:40-44; findings/16 §C15]).

### (c) Announcement email finalization (`docs/demo/RIO-ANNOUNCEMENT-EMAIL.md`, edited in place)

**R17. Rewrite "what to try" item 6 as a tool-call showcase.** The current item frames "what time is it?" as a probe of what the model *can't* know, with rationale R5 claiming "no clock tool exists" — contradicted by the shipped build (`get_current_time` stays registered) [RIO-INTELLIGENT-TOOLS-CONCEPT §8.34; findings/11 §C3]. Replace item 6's body with exactly:

> **Ask "what time is it?"** — a deceptively small question. A language model has no clock, so listen for what actually happens: RIO says it's checking, calls a real backend tool (`get_current_time`), and reads back the real current time on the Bakersfield campus (Pacific Time), straight from the server's clock — the one answer on your call computed by ordinary code instead of an AI. It's also the fastest tool round trip in the system, if you want to feel the difference.

And rewrite rationale **R5** in §2 to match (the beat is now "smallest possible demonstration of the tool loop," not "honest-limits probe"; the honest-limits framing moves to the sentence "a language model has no clock"). Delete the stale "no clock tool exists in the PoC" claim.

**R18. Update the "Under the hood" paragraph for the two-tier design.** Replace the sentence `When RIO "looks something up," it's calling tools on an in-process MCP (Model Context Protocol) server that returns the fake demo data.` with exactly:

> When RIO "looks something up," it's calling tools on an in-process MCP (Model Context Protocol) server. Simple actions (routing, verification, the time) return canned demo data instantly. Open-ended campus questions are handed to a second, much faster text model — Google's Gemini Flash-Lite, reached through the same AI gateway — which answers only from our simulated campus reference document and hands RIO back two or three sentences to speak. So even the "smart" answers are fake on purpose.

**R19. Re-verify every row of the live/simulated/future table against the shipped build** and adjust wording where the build moved. Known deltas the implementer must apply (and re-check for others):

1. **Row 2 (24/7 self-service)**: the knowledge base is now a corpus-backed delegated model, not canned per-topic strings — keep status **LIVE (knowledge simulated)** but the mechanism wording must not imply canned lookups.
2. **Row 8 (SMS)**: `send_sms` is now a registered static tool, so RIO's "I've texted you" narration is tool-backed theater — the row must still say plainly that **no text will ever arrive** (status stays **FUTURE**, wording e.g. "RIO will narrate sending a text via a simulated tool; no message is ever sent").
3. Verify the constants: phone number `+1 (661) 490-9364`, ~25-minute session cap, real operator line (661) 654-CSUB / 654-2782, deploy-severs-calls small print, crisis paragraph (unchanged — escalation remains static-fake with real 988/Counseling numbers).
4. The what-to-try item 5 parenthetical (Duo refusal, always-succeeds verification) must match the shipped static-tool behavior.

Each row's verification is recorded: append a short "Finalization log (Spec 06 R19)" subsection to the email doc's §2 listing row → checked-against (file or live call) → changed/unchanged.

**R20. Execution-time human inputs — not spec placeholders.** `[SENDER NAME/TITLE]`, `[FEEDBACK CHANNEL]`, `[PILOT END DATE]` are declared **required inputs the human supplies at execution time**. The implementer must NOT invent values; the launch checklist (R23 gate 6) blocks the send until the human has provided all three and they are substituted into the email text. `[NAME]` is a per-recipient mail-merge field and may remain bracketed in the repo copy. After substitution, the only bracketed tokens remaining in §1 of the email are `[NAME]` and the `[SIMULATED]` honesty tags.

**R21. Honesty invariants (must survive every R17–R19 edit).** The four-bullet "honest part" block, the crisis "don't role-play distress" paragraph with the real 988 pointer, the logging disclosure, and the AI-self-identification claim are load-bearing (the email is the presenter-replacement honesty layer [RIO-ANNOUNCEMENT-EMAIL §R1; RIO-INTELLIGENT-TOOLS-CONCEPT §7.25]) — none may be weakened or deleted.

### (d) `docs/demo/LAUNCH-CHECKLIST.md`

**R22. Structure.** Numbered gates in execution order: §1 pre-send build gates → §2 smoke-test call script → §3 send → §4 deploy freeze → §5 log-extraction cadence → §6 corpus updates → §7 rollback → §8 incident triggers. Each gate has a checkbox line, an owner (`HUMAN` or `AGENT`), and a pass condition. The file records `T0` (send timestamp) as a fill-in-at-execution field — this is the checklist's only permitted blank.

**R23. §1 Pre-send build gates.** (1) full vitest suite green (≥ the pre-demo baseline of 356 tests; new tool/corpus tests included); (2) all demo-spec acceptance criteria signed off, including Demo Spec 05's experiment gates with the revert rule honored (no failed experiment left deployed); (3) knowledge-tool measured p50 `toolTotalMs < 1500` ms confirmed from E4 data (the M3 gate); (4) ARCHITECTURE.md and MCP-SERVER-DEEP-DIVE.md committed with R6's no-placeholder check passing; (5) the configured voice confirmed applied via a `session-updated.raw` log line (S8: `marin`, or `alloy` if E3 failed and Demo Spec 05 R7's fallback flip was taken) [findings/11 §C11]; (6) the three R20 human inputs supplied and substituted; (7) email finalization log (R19) present.

**R24. §2 Smoke-test call script.** Run against the production number `+1 (661) 490-9364` within 24 h before send, **after** the final deploy (the freeze starts at send). Scripted items, each with expected behavior and post-call log check:

1. Say nothing at pickup — greeting self-identifies as an AI in its first sentence, in the RIO persona.
2. "When does fall financial aid actually come through?" — audible preamble ("one moment…"), then a `[SIMULATED]`-corpus answer; log shows `tool-call` for `ask_campus_knowledge` with `toolTotalMs < 1500`.
3. Interrupt mid-answer — playback stops ≤ ~1 s, model pivots; `barge-in` log line present.
4. "¿Podemos hablar en español?" — full mid-call switch, persona intact.
5. "What time is it?" — `get_current_time` tool call; correct campus (Pacific) time spoken (master plan D5).
6. "I forgot my password" — verify → reset theater; RIO refuses a proffered Duo code.
7. "Can I just talk to a human?" — warm-handoff narration with real numbers; **no** transfer occurs; call continues.
8. Not-in-corpus probe (e.g. "what's the quidditch team's schedule?") — RIO says it doesn't have that and offers routing; never invents; log shows the knowledge tool returned `status:'not_found'`.
9. Hang up — post-call: one `stream-stop` summary line; zero `@level:error` lines for the call; every tool exercised has exactly one `tool-call` line.

Pass rule: all nine on a single call (two calls permitted if the first exceeds ~5 min). Any failure blocks the send; fix → redeploy → rerun the full script.

**R25. §4–§6 Operate rules.**

- **Deploy freeze (§4):** from `T0` to `T0 + 24 h`: no push to `main`, no Railway variable change (either triggers a redeploy, and every redeploy severs in-flight calls [docs/specs/09-deployment-and-operations.md R3.3]). Sole exception: a safety-critical defect (crisis-path misbehavior, call-killing bug, credential exposure) — fix immediately and note it in the checklist. After 24 h: deploys allowed, batched (≤ 1/day), preferring low-traffic hours, after confirming no call is in flight (Railway logs: no `stream-start` in the last 30 min without a matching `stream-stop`).
- **Log extraction (§5):** while the pilot line is up, extract logs at least **every 72 h** — Railway Hobby retains only 7 days; the 72 h cadence is the same hard deadline Spec 08 R14 sets for milestone sessions and leaves buffer for indexing lag and re-pulls [docs/specs/08-logging-and-latency-instrumentation.md:225-241; findings/09 V4; findings/07 gotcha 8]. Destination: `docs/measurements/<YYYY-MM-DD>-pilot/` per the existing convention; run `node scripts/aggregate-latency.mjs` over each extract. Queries: the Spec 08 R14 set plus `@event:tool-call` (knowledge-tool p50/p95 tracking) and `@level:error OR @event:gateway-close`.
- **Corpus updates (§6):** reference, do not duplicate, the corpus spec's procedure: edit `assets/csub-corpus.md` → push to `main` → Railway auto-deploy (~2 min) → live on the next call; deploys sever in-flight calls, so corpus edits follow the §4 batching rule. Content edits only — the SIMULATED-DATA banner and 12-section structure are owned by the corpus spec and must not be altered from the checklist path.

**R26. §7 Rollback + §8 incident triggers.** Rollback is two levers, in order: (1) **Railway**: dashboard → service → Deployments → redeploy the previous successful deployment (immediate; note a deploy that fails its healthcheck never takes traffic — the previous deployment keeps serving [docs/specs/09-deployment-and-operations.md A2]); (2) **git**: `git revert` the offending commit on `main` and push, so the auto-deployed state matches the repo again — never leave `main` ahead of the deployment you rolled back to, or the next push re-breaks the line. §8 incident triggers (any → §7): RIO answers campus facts from memory / breaks the fake-data seal; crisis path fails to speak the real resource numbers; repeated call-killing errors (`fallback-played` or `mint-failed` spikes); knowledge-tool p95 `toolTotalMs` regressing past the Spec 05 gate on live traffic.

## Interfaces

**Consumes:**
- Demo Spec 05: measured results of experiments **E4** (knowledge-tool round trip) and **E6** (end-to-end/static baseline), extracted as JSONL + aggregates under `docs/measurements/<YYYY-MM-DD>-<label>/` (Spec 08 R14 convention). R5 is hard-blocked on these.
- Build specs' shipped values (documented, not defined, here): env keys `MCP_MODEL_ID` = `google/gemini-3.1-flash-lite`, `MCP_MODEL_MAX_TOKENS` = `150`, `MCP_TOOL_TIMEOUT_MS` = `3500`; tool names `escalate_to_human`, `route_call`, `verify_identity`, `reset_password`, `send_sms`, `get_current_time`, `ask_campus_knowledge(question, topic?)`; envelope `{status: 'ok'|'not_found'|'error', response_text}`; corpus at `assets/csub-corpus.md`.
- The test-asserted preamble sentence that must survive all persona work and which the deep-dive quotes: `"Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."` — asserted verbatim by `test/gateway.session-config.test.ts:124-127` against the exported `INSTRUCTIONS` [src/gateway.ts:241-244].
- Execution-time human inputs: `[SENDER NAME/TITLE]`, `[FEEDBACK CHANNEL]`, `[PILOT END DATE]`.

**Produces:**
- `docs/demo/ARCHITECTURE.md`, `docs/demo/MCP-SERVER-DEEP-DIVE.md`, `docs/demo/LAUNCH-CHECKLIST.md` (new); `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` (finalized in place).
- The go/no-go send gate: the email may be sent only when LAUNCH-CHECKLIST §1–§2 are fully checked.

## Acceptance criteria

- **A1** (diagrams parse): both mermaid blocks in ARCHITECTURE.md render without error — verify with `npx -y @mermaid-js/mermaid-cli -i <file>` on each extracted block, or by confirming clean rendering in GitHub preview. The flowchart contains all 13 R2 node IDs; the sequence diagram contains all 6 R4 participants and 3 `alt` failure blocks.
- **A2** (no placeholders): `grep -nE 'TBD|TODO|XXX|\[[A-Z][A-Z /]+\]' docs/demo/ARCHITECTURE.md docs/demo/MCP-SERVER-DEEP-DIVE.md docs/demo/LAUNCH-CHECKLIST.md` returns nothing (LAUNCH-CHECKLIST's `T0` field is written as a labeled blank line, not a bracket token).
- **A3** (annotations traceable): every numeric latency in ARCHITECTURE.md carries a measurement date and a `docs/measurements/` path, and each number is reproducible from that path's JSONL via `scripts/aggregate-latency.mjs`; the R5 minimum set (items 1–5) is present.
- **A4** (deep-dive completeness): MCP-SERVER-DEEP-DIVE.md contains the eight R8 sections as headings; §3 states the tier rule and the four crisis numbers verbatim ((661) 654-3366, 988, (661) 654-2111, (661) 654-2782); §5 contains the $0.16-per-call vs $0.004 comparison and the "~40×" figure [findings/16 §C18]; §4 cites `src/tools.ts` line ranges for the double gate and deferred retry; §8 lists the three `MCP_*` env keys with their defaults.
- **A5** (email placeholders resolved): after finalization, `grep -nE '\[(SENDER NAME/TITLE|FEEDBACK CHANNEL|PILOT END DATE)\]' docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` returns nothing; `[NAME]` and `[SIMULATED]` still appear.
- **A6** (time item rewritten): the email no longer contains "tells you something real about what a language model does and doesn't inherently know" nor any claim that no clock tool exists; item 6 contains `get_current_time` and matches R17's text; rationale R5 no longer contradicts the registered tool.
- **A7** (table verified): the email's 8-row table reflects the shipped build per R19 (row 2 mechanism wording, row 8 tool-backed-narration wording with "no message is ever sent" retained); the "Finalization log (Spec 06 R19)" subsection lists all 8 rows.
- **A8** (honesty invariants): the four "honest part" bullets, the don't-role-play-distress paragraph with the 988 pointer, and the logging disclosure are present and unweakened (manual diff review against the pre-finalization version).
- **A9** (checklist executable): LAUNCH-CHECKLIST.md contains the 9-item smoke script with per-item expected behavior AND log check; the 72 h extraction rule citing 7-day retention; the deploy-freeze rule with its T0+24 h boundary and safety exception; the two-lever rollback with the never-leave-main-ahead rule; §8 incident triggers.
- **A10** (smoke script honest against build): every utterance in the R24 script maps to a registered tool or shipped behavior — an implementer dry-runs the mapping (item → tool/feature → source file) and records it in the checklist's appendix; no script item references a capability the build lacks.

## Non-goals / out of scope

- **No KPI dashboard** — measurement stays log-based; presentation beyond `scripts/aggregate-latency.mjs` output is future work (BRD non-goal; the email's row 6 says so).
- **No recording pipeline** — transcripts in logs only; no audio capture/retention (email row 5).
- Actually sending the email (the human sends it; this spec produces the gate and the final text), and any distribution-list management.
- Any code changes: this spec touches only `docs/demo/**`. Diagram fidelity is achieved by citing shipped code, never by changing it.
- The staged-demo apparatus retired by the self-serve pivot (slides, projected panes, printed hand-outs) [RIO-INTELLIGENT-TOOLS-CONCEPT §7.24] — none of it returns via these docs.
- Defining the corpus content, tool implementations, persona text, or experiment protocols — owned by their respective demo specs; this spec documents and verifies against them.

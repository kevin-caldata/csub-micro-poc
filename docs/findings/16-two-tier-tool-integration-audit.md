# Findings 16 — Codebase audit: wiring a delegated-intelligence (two-tier) call into the MCP tool layer

**Date:** 2026-07-19
**Author:** research agent (Claude)
**Scope:** Thought-exercise audit (NO code changes) of `D:\projects-linean\CSUB-RIO-POC` for the two-tier MCP tool direction: simple tools return fake data directly; "intelligent" tools delegate a formulated question to a high-speed text model (gemini-flash-lite class) via the same Vercel AI Gateway (text-generation modality), answering from an unstructured CSUB corpus that never enters the realtime context. Citations are `file:line` (working tree as of 2026-07-19) and URLs. Companion to findings/11 and `docs/demo/RIO-DEMO-CONCEPT.md`.

---

## 1. Where the `generateText` call lives, and what bounds it

### C1. The call sits inside a `registerTool` handler in `buildMcpServer()` — the spec-sanctioned single extension point — **VERIFIED**
- Both existing tool handlers are `async` arrow functions registered in `buildMcpServer()`: `get_current_time` (`src/mcp-server.ts:12-23`) and `hello` (`src/mcp-server.ts:27-36`). The in-file contract at `src/mcp-server.ts:37` — `// FR-5: adding a tool = one more registerTool call here. Nothing else changes.` — is spec-normative (`docs/specs/07-mcp-server-and-tool-loop.md:122, 263`).
- A delegated-intelligence tool is therefore one more `registerTool('ask_campus_knowledge', { inputSchema: { question: z.string() } }, async ({ question }, extra) => { ... await generateText(...) ... })` block at `src/mcp-server.ts:37`. The handler `await`s the gateway text call and returns `{ content: [{ type: 'text', text: answer }] }` — structurally identical to today's handlers, just with a network await inside.
- Tool defs propagate with zero wiring: per-call `listTools()` → `fetchToolDefs` (`src/tools.ts:30-36`) → `session-update` tools passthrough (`src/gateway.ts:275`, via `src/session.ts:438-446`). The new tool is live on the next phone call.

### C2. Handlers are fully async-friendly; neither the MCP SDK server nor the StreamableHTTP transport imposes any server-side timeout — **VERIFIED**
- The server side simply awaits the handler promise; the HTTP POST is held open for the duration. The route hijacks the raw reply and hands it to the transport (`src/mcp-server.ts:42-57`); the only server-side lifecycle hook is `reply.raw.on('close', ...)` closing transport+server when the HTTP connection drops (`src/mcp-server.ts:50-53`). There is no server-side deadline anywhere in that path.
- Timeouts in the MCP SDK are **client-side**: the SDK default is 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`, `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts:57`), overridable per request (`.../protocol.d.ts:73-77`).

### C3. The one end-to-end bound on a tool call is the client-side `{ timeout: 5000 }` in `runTool` — **VERIFIED**
- `src/tools.ts:42`: `client.callTool({ name, arguments: args }, undefined, { timeout: 5000 })`. On expiry the SDK raises `McpError` (RequestTimeout) from the client `request()`, which lands in `runTool`'s catch (`src/tools.ts:51-54`) and becomes `{"error": "..."}` as the tool output — the call never dies. The SDK also sends a cancellation notification, which fires the server-side handler's `extra.signal` AbortSignal (`.../protocol.d.ts:175-177`), so a well-behaved handler can stop work.
- So a delegated text call has a **hard 5 s ceiling** today, after which the model receives an error payload and apologizes verbally (Spec 07 behavior, `docs/specs/07-mcp-server-and-tool-loop.md:189`; findings/11 §C5). See §4 for where a tighter in-handler timeout should sit beneath it.

### C4. What the caller experiences while the tool runs: preamble audio, then event-gated silence — no timer anywhere — **VERIFIED**
- `ToolLoop.onFunctionCallArgsDone` fires `runTool` asynchronously (`src/tools.ts:121-128`), sends the `function-call-output` item on resolve (`src/tools.ts:130-144`), and releases exactly one follow-up `response-create` through the double gate (`src/tools.ts:161-181`): (a) tool-bearing response done, (b) all outputs sent, (c) no response active, (d) not already sent. The deferred retry is explicitly "never a timer" — re-checked on every `response-done` (`src/tools.ts:148-155`).
- Meanwhile the caller hears the R1 spoken preamble ("One moment, let me look that up" — mandated by `INSTRUCTIONS`, `src/gateway.ts:241-244`), then silence until the follow-up response's first `audio-delta` (`src/tools.ts:193-207`). Nothing about a slow tool stalls the WS loops; audio frames keep flowing both ways the whole time.

---

## 2. Latency budget for the delegated call

### C5. There are no live-call measured numbers yet — the working numbers are the design targets and one measured constant — **VERIFIED (honest limitation)**
- `docs/measurements/` contains only its README (no `turns.jsonl`/`tools.jsonl`); milestones M1–M5 (which produce real numbers) still need the human (memory: csub-rio-build-state). What exists:
  - **Measured:** warm per-call MCP client connect ≈ **5 ms** (`src/tools.ts:22`); `mcpMs` for an in-process fake-data tool is single-digit ms.
  - **Design/example numbers:** the findings/09 example tool line — `mcpMs 4.2 / gateWaitMs 112.0 / secondTtfbMs 540.8 / toolTotalMs 688.3` (`docs/findings/09-latency-instrumentation.md:155`), with `secondTtfbMs` called out as "the second model inference — the dominant term" (`docs/findings/09-latency-instrumentation.md:139`).
  - **Acceptance ceiling:** `toolTotalMs < 1500` p50 is the M3 gate (`docs/specs/00-master-build-plan.md:126`; `docs/M1-M5-EXECUTION-CHECKLIST.md:145-146`).

### C6. Arithmetic: a delegated text call can spend roughly 800 ms and still meet the M3 ceiling; up to ~2 s is masked by the preamble — **INFERENCE from verified structure**
- `toolTotalMs = mcpMs + gateWaitMs + secondTtfbMs` (derivations at `src/tools.ts:209-235`; `docs/specs/07-mcp-server-and-tool-loop.md:247-249`). Holding `gateWaitMs ≈ 110` and `secondTtfbMs ≈ 550` (findings/09 example), the delegated call's `mcpMs` budget for `toolTotalMs < 1500` is **≈ 800 ms**.
- Crucially, tool execution **overlaps the preamble**: `function-call-arguments-done` arrives while R1's preamble audio is still streaming/playing, and the gate cannot release before R1's `response-done` anyway (condition (a), `src/tools.ts:164`). Any tool time that fits inside the preamble's spoken duration (~1–2 s of audio for the mandated one-liner) is **free** — it shows up as reduced `gateWaitMs`-adjacent slack, not caller-perceived dead air. A flash-lite-class call with a short answer (typ. 400–900 ms TTLT; longer with a 25k-token stuffed prompt) therefore lands either fully masked or ~0.5 s beyond the preamble — well inside conversational tolerance and inside the 1.5 s ceiling in the common case.
- Practical guidance: keep the delegated answer **short** (cap `maxOutputTokens` ~100–150) — output length, not prompt length, dominates flash-lite generation time; and keep the in-handler hard timeout at ~3.5 s (§4) so worst case is a spoken apology at ~4 s, never the 5 s transport error.

### C7. Barge-in during tool execution is already race-safe: the caller can talk over the gap and nothing breaks — **VERIFIED**
- `speech-started` → `bargeIn(s)` (`src/session.ts:74-79`). During the tool gap (R1 finished, playback drained) the guard at `src/bargein.ts:75` (`markQueue.length === 0 && !responseActive`) makes it a **no-op** — explicitly documented as "fires on every user utterance, including … the tool gap — the no-op path is normal". If the preamble is still playing, barge-in clears it and truncates model memory (`src/bargein.ts:79-115`).
- If the caller's interjection triggers a VAD auto-response while the tool is still running, gate condition (c) blocks the follow-up `response-create`; `autoResponseIntervened` is flagged and the release retries on the next `response-done` (`src/tools.ts:168-172, 148-155`). The lost-race benign error path is also wired (`src/session.ts:209-211`; `src/gateway.ts:161-164`). The tool output itself is always delivered via `conversation-item-create` regardless (`src/tools.ts:135-138`), so the answer is in context whenever the model next responds. A slow delegated tool widens the window where this machinery engages but requires **no changes** to it.

---

## 3. Dependencies: `ai` core package, exact import, ESM

### C8. The `ai` package is NOT present — neither in `package.json` nor anywhere in the lockfile — **VERIFIED (negative result)**
- `package.json:18-27` dependencies: `@ai-sdk/gateway 4.0.23`, `@fastify/*`, `@modelcontextprotocol/sdk 1.29.0`, `fastify`, `twilio`, `ws`, `zod` — no `ai`.
- Lockfile grep: the only `@ai-sdk` entries are `gateway` (4.0.23, `package-lock.json:31-46`), `provider` (4.0.3, `:48`), `provider-utils` (5.0.11, `:60`); no `node_modules/ai` entry exists. `@ai-sdk/gateway` does **not** pull `ai` transitively (its deps are `@vercel/oidc`, `provider`, `provider-utils` — `package-lock.json:36-40`).

### C9. `ai@7.0.31` is a perfect-fit addition: its pinned deps are byte-identical to what's already installed — **VERIFIED**
- `npm view ai@latest` (2026-07-19): version **7.0.31**, dependencies exactly `@ai-sdk/gateway 4.0.23`, `@ai-sdk/provider 4.0.3`, `@ai-sdk/provider-utils 5.0.11` — the same pinned versions in this repo's lockfile. `npm i ai@7.0.31` adds one package with zero version churn/dedupe conflicts.
- Exact working import (concept):
  ```ts
  import { generateText } from 'ai';
  import { gateway } from '@ai-sdk/gateway'; // already imported in src/gateway.ts:1-11
  const { text } = await generateText({
    model: gateway('google/gemini-3.1-flash-lite'), // LanguageModelV4 — @ai-sdk/gateway dist/index.d.ts:667
    system: CORPUS_PROMPT,
    prompt: question,
    maxOutputTokens: 150,
    abortSignal, // see C13
  });
  ```
  Auth is the same `AI_GATEWAY_API_KEY` the realtime leg already requires (`src/config.ts:4-10`) — no new secret. Gateway text-generation modality: https://vercel.com/docs/ai-gateway/modalities/text-generation
- Zero-new-dependency alternatives, if adding `ai` is unwanted: (a) call the returned `LanguageModelV4.doGenerate()` directly (low-level, verbose); (b) plain `fetch` to the gateway's OpenAI-compatible REST endpoint with the same key (Node 22 native fetch; https://vercel.com/docs/ai-gateway/openai-compatible-api). `generateText` is the recommended path — it is what the modality docs document and it handles retries/normalization.

### C10. ESM/CJS: no concern — **VERIFIED**
- The repo is pure ESM: `"type": "module"` (`package.json:5`), `module`/`moduleResolution: NodeNext`, `verbatimModuleSyntax` (`tsconfig.json:5-6, 14`). `ai@7` ships ESM with proper `exports`; `import { generateText } from 'ai'` type-checks and runs under NodeNext on Node 22 (`engines` `22.x`, `package.json:6-8`; `ai`'s own engines require ≥22 via provider-utils). Only house rule: relative imports keep `.js` extensions (existing pattern throughout `src/`).

---

## 4. Error handling: failure and timeout containment

### C11. The existing tool-failure → spoken-apology path covers a gateway text-call failure with zero changes — **VERIFIED**
- A `generateText` rejection (auth error, 429, network, abort) thrown inside the handler is converted by the MCP SDK server into an `isError: true` tool result; `runTool` surfaces it as `{"error": msg}` (`src/tools.ts:43-49`) — not a throw. Transport-level failures and the 5 s timeout land in the outer catch (`src/tools.ts:51-54`) with the same shape. Either way the string becomes the `function-call-output`, the follow-up response fires normally, and the model reads the error and apologizes (`docs/specs/07-mcp-server-and-tool-loop.md:189`; findings/11 §C5 calls this the safe "resilience beat"). Nothing can kill the phone call from inside a tool handler.
- Belt-and-suspenders already present: even a wedged handler is bounded by the client's 5 s timeout (`src/tools.ts:42`); teardown disposes the ToolLoop so late continuations no-op (`src/tools.ts:114, 247-249`; `src/session.ts:361`); the HTTP request itself is torn down on connection close (`src/mcp-server.ts:50-53`).

### C12. The per-tool timeout/AbortSignal belongs INSIDE the handler, set below the 5 s transport cap — **RECOMMENDED PLACEMENT (concept)**
- Placement: in the `ask_campus_knowledge` handler in `src/mcp-server.ts`, not in `runTool`. Rationale: (1) `runTool`'s 5 s cap is a uniform transport ceiling shared by all tools — changing it per-tool would leak tool knowledge into `src/tools.ts`, violating the Spec 07 rule that tool specifics live only in `buildMcpServer()` (`docs/specs/07-mcp-server-and-tool-loop.md:122`); (2) an in-handler timeout returns a **clean handler-authored error/fallback string** through the `isError` path, which reads better when spoken than the SDK's generic RequestTimeout message; (3) it frees the gateway HTTP call immediately instead of leaving it running detached after the client gave up.
- Shape: `const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(3500)])` passed as `generateText`'s `abortSignal`. `extra.signal` is the SDK-provided cancellation signal on every request handler (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts:175-177`) — it fires if the client cancels (e.g. the 5 s timeout's cancellation notification), so the two signals compose: 3.5 s self-imposed budget, 5 s hard transport ceiling behind it. On abort, catch and return a graceful text ("I couldn't reach the campus knowledge base just now") rather than rethrowing — the model then speaks a natural apology instead of parroting an error JSON.

---

## 5. Two-tier taxonomy of the concept doc's tools

### C13. Classification of every tool proposed in `docs/demo/RIO-DEMO-CONCEPT.md` — **ANALYSIS**

| Tool (concept doc ref) | Tier | Rationale |
|---|---|---|
| `escalate_to_human(reason, urgency)` (§2 FR-3, `RIO-DEMO-CONCEPT.md:65`) | **Static-fake** | Crisis path must be deterministic and instant — canned handoff blurb with real resource numbers (988, Counseling (661) 654-3366, UPD). Deliberately NO LLM in the loop: no added latency, no paraphrase risk on safety-critical phone numbers. |
| `route_call(department, caller_name?, reason)` (§2 FR-1, `:49`) | **Static-fake** | Fake directory lookup returning `{department, phone_ext, handoff_blurb, estimated_wait}`; the return-as-script property (findings/12 §3.6) depends on it being canned. |
| `verify_identity(netid, dob_or_last4)` (§2 FR-7, `:99`) | **Static-fake** | Always-succeeds theater on fake data; zero intelligence needed. |
| `reset_password(netid)` (§2 FR-7, `:99`) | **Static-fake** | Canned MyID-flow text ("authorization code sent to the personal email on file"). |
| `create_ticket` (optional, §2 FR-7, `:99`) | **Static-fake** | Canned "ticket INC0012345" string. |
| `send_sms` (optional, §2 FR-8, `:106`) | **Static-fake** (concept doc already recommends skipping) | One narrated sentence at most. |
| `lookup_campus_info(topic)` (§2 FR-2, `:56`) | **→ Delegated-intelligence** — becomes `ask_campus_knowledge(question)` | This is the ONE tool the new direction transforms: instead of canned per-topic returns, GPT-Realtime formulates a clear natural-language question; the handler answers it from the unstructured corpus via the flash-lite call and returns a succinct text answer. |

### C14. What the new direction obsoletes in the concept doc — **ANALYSIS**
The self-serve pivot (number goes out by email; no staged live demo) retires the entire staged-performance layer of `RIO-DEMO-CONCEPT.md`:
- **All presenter/stage apparatus**: cold-open recorded IVR + slides (§1 beats 1–4), projected panes (context payload, crisis-log record, live latency readout — `:78, :181, :192`), the 2:07 AM clock prop (`:57`), printed transcript/KPI hand-outs (`:84, :91`), the three scripted calls with a rehearsed performer (§4), the wow-moment checklist, and the whole fallback plan (recorded best-take, in-room smoke test, frozen demo-day deploy — `:196-203`). The "call it yourself" close (`:22`) is no longer the close — it **is the entire demo**.
- **Honesty labels migrate media**: every "say out loud in the room" disclosure (§6 `:230-239`) must now live in (a) the outbound **email text** (what's simulated, what's fake, the 25-min session cap, deploys sever calls) and (b) the **persona itself** (AI self-identification is already in the greeting — `:119`; the fake-data nature of verifications should be voiced by RIO when relevant, since no presenter can label it).
- **Crisis-beat ethics section changes character** (`:241-243`): the scripted-mild-cue rule governed a stage performance; self-serve means *real unsupervised callers may present real distress*. That strengthens the case for `escalate_to_human` staying static-fake (deterministic real resource numbers, no LLM latency) and for the email inviting only colleagues/stakeholders, not the public.
- **`lookup_campus_info`'s canned-topic design is superseded**: the "tool return IS the script" staging rationale (`:49`, findings/12 §3.6) assumed a rehearsed caller hitting known topics. Self-serve callers ask anything — exactly the gap the corpus-backed delegated tool exists to fill. The frozen fall-2026 fake facts (findings/13 dates) move from per-topic canned strings into the corpus document.
- **Unchanged/still valid**: RIO persona + greeting (§3), bilingual behavior, the fake warm-transfer choreography (it is model-driven, needs no presenter), digit read-back, instant pickup, and all §5 effort-class mechanics (the extension points are the same).

---

## 6. Corpus placement and handler strategy

### C15. The corpus follows the existing `assets/` boot-load pattern — **VERIFIED pattern, concept application**
- Precedent: `src/fallback.ts:40-44` — asset path resolved from `import.meta.url` (`../assets/...` works from both `src/` under tsx and `dist/` after build; the comment there documents exactly why cwd-relative paths boot-crash on Railway), read with `readFileSync` **once at module load**, cached in module scope.
- Concept: `assets/csub-corpus.md` (or `.txt`), loaded the same way at the top of `src/mcp-server.ts` module scope. Note `buildMcpServer()` constructs a **fresh McpServer per request** (`src/mcp-server.ts:7-9`) — the corpus read must sit at module level, not inside `buildMcpServer()`, or it re-reads per tool call (harmless at 100 KB but pointless).
- Railway image impact: negligible. The repo already ships a 55 KB binary asset (`assets/fallback-apology.ulaw`, 55,752 bytes) through the same build; a 50–100 KB text file is noise next to `node_modules`. No `.dockerignore`/`railway.json` changes implied.

### C16. Whole-corpus prompt-stuffing is the right first strategy at 50–100 KB; keyword pre-filtering is premature — **ANALYSIS**
- 50–100 KB of English text ≈ **12k–25k tokens**. A flash-lite-class model ingests that as prompt prefill in well under a second, and at gemini-flash-lite-class input pricing (~$0.10/M tokens) a whole-corpus query costs **~$0.002–0.003** — per delegated question, not per call. The handler shape: `system: 'Answer ONLY from the following CSUB reference material. Answer in ≤2 sentences. If not covered, say so.\n\n' + CORPUS`, `prompt: question`.
- A naive keyword pre-filter (split corpus into sections, keep sections sharing terms with the question) buys little at this size and introduces the classic recall failure (caller says "money for school", corpus section says "financial aid disbursement"). Defer any retrieval until the corpus exceeds several hundred KB; even then, flash-lite-class context windows (≥1M tokens) mean the pressure is cost/latency, not fit.
- The two-tier boundary contract to preserve: only the **question** (one sentence, from GPT-Realtime's tool-call arguments) crosses in, and only the **succinct answer** (≤2 sentences, ~50–100 tokens) crosses back as the tool result. Today `runTool` returns the whole `JSON.stringify(result)` envelope (`src/tools.ts:50`) — fine, since the envelope around a two-sentence answer is still tiny; the discipline lives in the handler's `maxOutputTokens` + system-prompt brevity instruction.

---

## 7. Context-window protection: the concrete argument

### C17. What accumulates in the realtime session context today — **VERIFIED**
Everything below persists server-side in the gateway/OpenAI session for the life of the call (up to the 25-minute session cap, `docs/findings/01-vercel-ai-gateway-realtime.md:191`) and is re-processed as input on **every** model response:
- **Caller audio tokens**: one `input-audio-append` per 20 ms Twilio frame, continuously (`src/session.ts:269-273` → `src/gateway.ts:615-618`) — audio input is the expensive token class ($32/M fresh; findings/12 §6.2, §6.5).
- **Assistant audio output tokens**: every response's audio joins the conversation history.
- **Transcripts**: input transcription is enabled (`inputAudioTranscription: {}`, `src/gateway.ts:268`), and both sides' transcripts are part of the server-side items (also logged: `src/session.ts:158-163`).
- **Tool traffic**: the function-call arguments and the full stringified tool-result envelope, added as conversation items (`src/tools.ts:50, 135-138`).
- **Instructions**: sent once in the first `session-update` (`src/gateway.ts:265, 591`) — but as session state they are part of the input token count of **every subsequent inference**, i.e. per-turn recurring input, mostly at the cached rate after turn 1.

### C18. Stuffing a 50–100 KB corpus into `INSTRUCTIONS` — the math — **ANALYSIS with verified prices**
Prices for gpt-realtime-2.1 per 1M tokens (verified: `docs/findings/12-demo-realtime-model-capabilities.md:140`, matching BRD gateway pass-through): text in **$4** / cached in **$0.40** / text out $24; audio in $32 / cached $0.40 / audio out $64. Context: **128k** (findings/12 §6.3).
- 75 KB corpus ≈ **~19k tokens** appended to instructions.
- **Per-call cost**: turn 1 processes it fresh: 19k × $4/M ≈ **$0.076**. Every later turn re-reads it cached: 19k × $0.40/M ≈ **$0.0076/turn**. A modest 12-turn call ≈ **$0.16 of pure corpus overhead per call** — paid on every call, whether or not the caller asks a knowledge question, and multiplied by every self-serve caller the email produces.
- **Two-tier comparison**: the same call makes perhaps 2 knowledge queries; 2 × 19k tokens at flash-lite-class ~$0.10/M ≈ **$0.004**, plus ~100 answer tokens entering the realtime context as an ordinary tool result (≈ $0.0004 at $4/M). **~40× cheaper**, and only on knowledge turns.
- **Latency, not just cost**: those 19k tokens are prefill on *every* inference — including the greeting and every non-knowledge turn — adding prefill latency to `ttfbMs`/`secondTtfbMs` on all turns. That attacks the project's primary deliverable head-on: the M2 turn-latency and M3 `toolTotalMs < 1500` acceptance numbers (`docs/specs/00-master-build-plan.md:126`) would be measured with a 19k-token anchor dragging every response.
- **Window headroom**: 19k of 128k fits, but the remainder must hold an accumulating audio+transcript+tool history for a call that can legally run 25 minutes; audio history grows fast, and pressure on the window means server-side truncation of the oldest conversation — with a huge instruction block, the evictable budget shrinks by 19k tokens permanently.
- **Instruction-following degradation**: the RIO persona is a carefully weighted 8-section skeleton (`docs/demo/RIO-DEMO-CONCEPT.md:124-142`) whose safety section, disclosure rule, language-switch policy, and the test-asserted tool-preamble sentence (`src/gateway.ts:238-244`; findings/11 §C1) are all enforced ONLY by instruction adherence. The realtime prompting guidance this project already leans on (findings/12 §2.1–2.6: short turns, sample phrases followed near-verbatim, concise skeleton) is predicated on a compact prompt; burying ~40 lines of behavioral rules under ~19,000 tokens of reference prose measurably dilutes exactly the adherence the self-serve demo depends on — with no presenter in the room to recover from a persona drift or a skipped safety escalation.
- **Conclusion (the two-tier thesis, grounded)**: the corpus belongs behind the MCP boundary. The realtime context then carries only what it must — speech, short instructions, one-sentence questions out, two-sentence answers back — and the 19k-token corpus is read by a model priced ~40× lower per input token, only when a question actually needs it.

---

## Summary table

| Question | Answer in one line | Key citations |
|---|---|---|
| Where does `generateText` go? | New async `registerTool` handler at the FR-5 extension point | `src/mcp-server.ts:37`, `:27-36` |
| Server-side timeout? | None (SDK/transport); request held open | `src/mcp-server.ts:42-57`; SDK `protocol.d.ts:57` |
| End-to-end bound? | Client-side 5 s in `runTool`; expiry → `{"error"}` → spoken apology | `src/tools.ts:42, 51-54` |
| Affordable tool time? | ~800 ms for M3 p50 < 1500 ms; ~1–2 s masked by mandated preamble; 3.5 s in-handler cap | findings/09:155; `src/gateway.ts:241-244` |
| Barge-in mid-tool? | Already race-safe: no-op guard + deferred-retry gate + benign-error recovery | `src/bargein.ts:75`; `src/tools.ts:148-181`; `src/session.ts:209-211` |
| `ai` package present? | No; `ai@7.0.31` deps exactly match pinned `@ai-sdk/*` — clean one-package add; pure-ESM repo, no CJS issue | `package.json:18-27`; `package-lock.json:31-60` |
| Failure path covered? | Yes, both `isError` and transport catch; add `AbortSignal.any([extra.signal, AbortSignal.timeout(3500)])` inside the handler | `src/tools.ts:43-54`; SDK `protocol.d.ts:175-177` |
| Taxonomy | Static-fake: escalate_to_human, route_call, verify_identity, reset_password, create_ticket, send_sms. Delegated: ask_campus_knowledge (replaces lookup_campus_info) | `RIO-DEMO-CONCEPT.md` §2 |
| Corpus placement | `assets/csub-corpus.md`, module-scope boot load per the fallback-clip pattern; whole-corpus prompt-stuff (~19k tok, ~$0.002/query) | `src/fallback.ts:40-44` |
| Why not instructions? | ~$0.076 + $0.0076/turn recurring at realtime pricing (~40× delegated cost), prefill latency on every turn, persona/safety adherence dilution | findings/12 §6.3–6.5; `src/gateway.ts:265` |

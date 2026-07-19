# Demo Spec 00 — Master Demo Plan: CSUB-RIO Self-Serve Demo Build

Date: 2026-07-19 · Project: CSUB-RIO self-serve demo · Status: Binding master plan
Governs: Demo Specs 01–06 (`docs/demo/specs/`) · Base build: `docs/specs/00-master-build-plan.md` + `plans/README.md` (orchestration protocol this plan mirrors) · Findings: docs/findings/11–13, 15–17 · Concept docs: `docs/demo/RIO-DEMO-CONCEPT.md`, `docs/demo/RIO-INTELLIGENT-TOOLS-CONCEPT.md`, `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md`

---

## Purpose

This document binds the six demo specs into one executable build. The base PoC is live: caller phones **+1 (661) 490-9364** → Twilio Media Streams → `openai/gpt-realtime-2.1` via the Vercel AI Gateway → in-process MCP tool server (`@modelcontextprotocol/sdk@1.29.0`, StreamableHTTP stateless, tool defs re-fetched per call) on Railway us-east4, auto-deployed from GitHub `main`. The demo build extends `src/` in place: it replaces the hello-world tool surface with **RIO, the Roadrunner Intelligent Operator** — six static fake tools plus exactly one delegated-intelligence tool (`ask_campus_knowledge`) grounded in a simulated campus corpus — then measures, documents, and launches by email.

**Self-serve demo definition (binding):** the demo is a phone number sent out by email — no staged presentation, no presenter. Every disclosure a presenter would have made migrates into the product itself: RIO self-identifies as an AI in its greeting, all lookups are labeled simulated in-band, and the announcement email is the honesty layer of record [findings/16 §C14]. All data is simulated except: the four crisis resource numbers, the real CSUB directory numbers in `route_call`/the corpus allowlist, the MyID/Duo vocabulary, and `get_current_time`'s clock. Recipients call whenever they want; deploys sever in-flight calls, so all operational rules (freeze, batching) exist to protect callers we cannot see.

This plan contains: the folder-organization contract (§2), the global constraints binding every implementer (§3), the reconciled cross-spec interface table with drift adjudications (§4–§5), the wave structure with merge points (§6), the spike register (§7), test-count rules (§8), and the disposition of every open issue the six spec authors raised (§9). **Precedence rule:** where a child spec's text conflicts with an adjudication in §5 or §9 of this plan, this plan wins; each child spec wins inside its own scope for everything this plan does not adjudicate (same rule as `plans/README.md` §5.3).

## §1 Canonical spec numbering

The six specs were authored partly before their siblings existed, so several refer to each other by wrong numbers or descriptively. The canonical map — every cross-reference in Specs 01–06 must be read through this table:

| Canonical # | File | Owns |
|---|---|---|
| Demo Spec 01 | `specs/01-persona-and-realtime-instructions.md` | `INSTRUCTIONS` / `GREETING_INSTRUCTIONS` rewrite in `src/gateway.ts` |
| Demo Spec 02 | `specs/02-static-tools.md` | The six static tools in `src/mcp-server.ts`; `hello` retirement |
| Demo Spec 03 | `specs/03-knowledge-tool-and-model-config.md` | `ask_campus_knowledge`, `src/knowledge.ts`, the three `MCP_*` env keys, `ai@7.0.31` |
| Demo Spec 04 | `specs/04-corpus.md` | `assets/csub-corpus.md`, `src/corpus.ts`, `CORPUS-UPDATE-GUIDE.md` |
| Demo Spec 05 | `specs/05-performance-optimization.md` | Experiments E1–E6, `EXPERIMENTS.md`, aggregator `--knowledge` mode |
| Demo Spec 06 | `specs/06-docs-and-launch.md` | ARCHITECTURE.md, MCP-SERVER-DEEP-DIVE.md, LAUNCH-CHECKLIST.md, email finalization, send |

**Mechanical rename table (stale references, read-as):**

| In spec | Stale reference | Read as |
|---|---|---|
| 01 | "Demo Spec 02" as owner of `MCP_MODEL_ID`/`MCP_MODEL_MAX_TOKENS`/`MCP_TOOL_TIMEOUT_MS`, the `{status, response_text}` envelope, and `ask_campus_knowledge`'s handler | **Demo Spec 03** |
| 01 | "Demo Spec 02" as owner of the six static registrations and `hello` removal | Demo Spec 02 (correct as written) |
| 01 | "Demo Spec 03 (corpus)" | **Demo Spec 04** |
| 03 | "Demo Spec 02 (persona/instructions)" — in Depends/Enables, R13, and Non-goals | **Demo Spec 01** |
| 03 | "Demo Spec 04 (corpus)" | Demo Spec 04 (correct as written) |
| 02, 04, 06 | Descriptive references ("the knowledge-tool spec", "the persona spec", "the email spec", "the delegated-intelligence tool spec") | Resolve via the canonical table above |

No child spec file needs editing for numbering alone — implementers apply the read-as table. If the orchestrator amends a plan file after a failure (§6), it may fix numbering then.

## §2 Folder-organization contract — `docs/demo/`

```
docs/demo/
├── specs/                        # 00 (this file) + 01–06 — requirements, never state
├── plans/                        # execution plans for THIS build (created at dispatch time)
│   ├── LEDGER.md                 # the DEMO ledger — state store for waves DA/DB/DC/DD (§6)
│   └── <task-id>-<slug>.md       # one self-contained plan file per dispatched task
├── ARCHITECTURE.md               # deliverable (Spec 06) — demo root, not specs/
├── MCP-SERVER-DEEP-DIVE.md       # deliverable (Spec 06)
├── LAUNCH-CHECKLIST.md           # deliverable (Spec 06)
├── CORPUS-UPDATE-GUIDE.md        # deliverable (Spec 04)
├── RIO-ANNOUNCEMENT-EMAIL.md     # existing; finalized IN PLACE by Spec 06 (no new file)
├── RIO-DEMO-CONCEPT.md           # existing concept doc (read-only for this build)
└── RIO-INTELLIGENT-TOOLS-CONCEPT.md  # existing concept doc (read-only for this build)
```

Rules, each independently checkable:

- **R2.1** Specs live only in `docs/demo/specs/`; deliverable documents live at the `docs/demo/` root; execution plans live only in `docs/demo/plans/`. No spec file is ever a state store.
- **R2.2** `docs/demo/plans/LEDGER.md` is the **demo ledger** — a separate file from the base build's `plans/LEDGER.md`, same format (Current state block, per-wave task tables with Status/Commit/Note columns, Deviations log). Demo tasks never write to the base ledger.
- **R2.3** **Cross-reference rule:** on creation of the demo ledger, append exactly one row to the base `plans/LEDGER.md` Deviations/notes area reading `Demo build in progress — state in docs/demo/plans/LEDGER.md`, and the demo ledger's header links back to `plans/LEDGER.md` and to this plan. Exception to R2.2: the spike answers for base-register spikes **S1** and **S8** are recorded in BOTH ledgers — the demo ledger's experiment rows (Spec 05 R12) and the base S1–S35 answer table in `docs/specs/00-master-build-plan.md` §7 (Spec 05 Deliverables requires this).
- **R2.4** Measurement artifacts do NOT move: dated session directories and `EXPERIMENTS.md` live under the existing `docs/measurements/` root (Spec 05 R3/R12), shared with the base build, because `scripts/aggregate-latency.mjs` and the extraction procedure in `docs/measurements/README.md` are reused verbatim.
- **R2.5** Session-resume procedure mirrors `plans/README.md` §7: a resuming orchestrator reads only the demo ledger's Current state block and the active wave's table.

## §3 GLOBAL CONSTRAINTS — binding on every implementer, every wave

- **G1 — Exact-pin dependency rule.** Every dependency is exact-pinned (`npm install --save-exact`). The demo build adds exactly ONE package: `"ai": "7.0.31"` (Spec 03 R5). After install, `package-lock.json` must still pin `@ai-sdk/gateway@4.0.23`, `@ai-sdk/provider@4.0.3`, `@ai-sdk/provider-utils@5.0.11` — zero new transitive deps [findings/15 §5; findings/16 C9]. No other demo task touches `package.json`. `zod` stays `3.25.76`; `@modelcontextprotocol/sdk` stays `1.29.0`.
- **G2 — Single model, no fallback.** `google/gemini-3.1-flash-lite` (env `MCP_MODEL_ID`) is the only text model. No fallback-model key, no model list, no `providerOptions.gateway.models` anywhere in `src/` (Spec 03 R3/A3, grep-gated). On failure/timeout the tool returns an error envelope and the existing ToolLoop spoken-apology path handles it (`src/tools.ts:43-54`; base Spec 07 R9). Reintroducing fallback is a design change requiring the human.
- **G3 — Crisis path is LLM-free and simulated-only.** `escalate_to_human` is a static tool: deterministic canned return, no model call, no transfer, no TwiML/bridge change; verbs-after-`</Connect>` stays designed out. The four crisis resource numbers are spoken verbatim and must be **byte-identical wherever they appear**: Counseling Center **(661) 654-3366** (after hours press 2), **988** (call or text), UPD **(661) 654-2111** / 911, operator **(661) 654-2782** — surfaces: Spec 01 R3 Safety backup, Spec 02 R3 payload, Spec 04 corpus §9, Spec 06 deep-dive §3 and email. [findings/13 claims 20–22; findings/17 §4.5]
- **G4 — Preamble-sentence preservation (HARD).** `INSTRUCTIONS` in `src/gateway.ts` must always contain the exact substring `Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up').` — asserted at `test/gateway.session-config.test.ts:100-102` (session-update frame) and `:124-128` (export). Those assertions are never edited, weakened, or deleted by any demo task. Only Spec 01 may rewrite `INSTRUCTIONS`, and its R3 text embeds the sentence character-for-character.
- **G5 — Statelessness.** `buildMcpServer()` runs fresh per `/mcp` POST (SDK-enforced, base Spec 07 R2). No module-level **mutable** state in `src/mcp-server.ts`, `src/knowledge.ts`, or `src/corpus.ts`; module-level `const` is fine. All cross-tool state rides in tool args/results (the `SIM-V-` token flow, Spec 02 R9). Consequently the corpus and the knowledge system prompt are computed **once at module scope** (`src/corpus.ts` R6; `src/knowledge.ts` R10) — never inside a handler or builder.
- **G6 — Latency gates.** `toolTotalMs` p50 **< 1500 ms** remains the M3 gate and applies to the pooled tool population **including** `ask_campus_knowledge` (Spec 05 R10). Supporting bounds: `knowledgeMs` p95 ≤ 3000 ms, error/timeout share < 10% (E4 gate); `MCP_TOOL_TIMEOUT_MS` is zod-validated `< 5000` (the `runTool` transport cap, `src/tools.ts:42`).
- **G7 — Experiment revert rule; the live line never regresses.** Every performance change is a written experiment (hypothesis / one env flip / measurement / numeric gate / revert rule) in `docs/measurements/EXPERIMENTS.md`. Gate FAIL → revert same day. One flipped variable at a time. After the email is sent, the deploy freeze is in force (Spec 06 R25): no flips, no deploys T0→T0+24h except safety-critical fixes; then batched ≤ 1/day.
- **G8 — Never weaken the Twilio signature gate.** `POST /twiml` stays signature-validated (`validateRequest`, 403 `invalid signature` on failure — `src/twiml.ts:82-109`). No demo task touches `src/twiml.ts` at all.
- **G9 — No bridge/session-mechanics changes.** `src/session.ts`, `src/tools.ts`, `src/dsp.ts`, `src/bargein.ts`, `src/twiml.ts`, `src/fallback.ts`, `src/latency.ts` are untouched by Waves DA–DB. The only permitted edits outside the specs' declared files: Spec 03's one-line change at `src/server.ts:75` (`await mcpRoutes(app)` → `await mcpRoutes(app, config)`).
- **G10 — No network in tests.** All knowledge-tool tests use the injected `KnowledgeGenerateFn` seam or `vi.mock('ai')` (Spec 03 R14); no vitest test ever opens a socket to the gateway. Vitest node environment, never jsdom.
- **G11 — Whole-corpus, no RAG.** No retrieval, embeddings, pre-filter, or chunking; the whole `CSUB_CORPUS` string is prompt-stuffed corpus-first/question-last on every knowledge call. The 4-line SIMULATED-DATA banner is never stripped. The >100 KB per-topic pre-filter upgrade is documented-but-deferred (Spec 04 R9.4). Corpus is English-only; Spanish comes from the realtime model translating the English answer.
- **G12 — Phone allowlist, repo-wide.** No dialable number may be fabricated anywhere in the demo build (corpus, tools, prompts, docs, email). Every phone number comes from the Spec 04 R3 allowlist (drawn from findings/13). Fabricated offices point to the operator (661) 654-2782 or an email address.
- **G13 — No placeholders.** `TBD`/`TODO`/`XXX`/bracket placeholders are forbidden in every shipped artifact. The only permitted blanks: `[NAME]` + `[SIMULATED]` tags in the email (mail-merge/honesty markers), the three Spec 06 R20 execution-time human inputs until the human supplies them, and LAUNCH-CHECKLIST's labeled `T0` fill-in line.
- **G14 — Exclusive file ownership per dispatch.** Two concurrent tasks never edit the same file. The wave design in §6 enforces this; the orchestrator verifies each completion commit touches only the task's declared files (`plans/README.md` §3.1).

## §4 Cross-spec interface table (reconciled — the single source of truth)

### Env keys and config

| Key | Default | Constraint | Owner | Consumers |
|---|---|---|---|---|
| `MCP_MODEL_ID` | `google/gemini-3.1-flash-lite` | `z.string().min(1)` | Spec 03 | 05 (E4/E5), 06 (docs) |
| `MCP_MODEL_MAX_TOKENS` | `150` | int, positive | Spec 03 | 05, 06 |
| `MCP_TOOL_TIMEOUT_MS` | `3500` | int, positive, `.lt(5000)` | Spec 03 | 05, 06 |
| `AUDIO_MODE` | `transcode` | existing (`src/config.ts:16`) | base | 05 (E1) |
| `VAD_SILENCE_MS` | `500` | existing (`src/config.ts:19`) | base | 05 (E2) |
| `VOICE` / `VOICE_FALLBACK` | `marin` / `alloy` | existing (`src/config.ts:17-18`), untouched by Spec 01 | base | 01 (statement only), 05 (E3) |

`AppConfig` additions (Spec 03 R2, exact spelling): `mcpModelId`, `mcpModelMaxTokens`, `mcpToolTimeoutMs`. `.env.example` gains the three lines of Spec 03 R4. **No other spec adds, renames, or consumes new env keys** (Specs 01, 02, 04 introduce zero; Spec 05 flips existing ones; Spec 06 documents them).

### Tool surface (exactly seven — frozen)

| Tool | Signature | Tier | Owner |
|---|---|---|---|
| `escalate_to_human` | `(reason: string, urgency: 'routine'\|'urgent'\|'crisis')` | static | Spec 02 |
| `route_call` | `(department: string, context?: string)` | static | Spec 02 |
| `verify_identity` | `(name?: string, dob?: string)` | static | Spec 02 |
| `reset_password` | `(verification_token: string)` | static | Spec 02 |
| `send_sms` | `(to_summary: string)` | static | Spec 02 |
| `get_current_time` | `()` — no inputSchema key | static (real data) | Spec 02 |
| `ask_campus_knowledge` | `(question: string, topic?: enum)` | delegated | Spec 03 |

`hello` is deleted (Spec 02 R1). Spec 01's prompt names exactly these seven and no others (parity test, Spec 01 A4). `topic` enum = `KNOWLEDGE_TOPICS` = `['directory_hours','financial_aid','registration','orientation','it_help','parking','events','other'] as const` — identical to the corpus `<!-- topic: ... -->` tag vocabulary (Spec 04 R4). All schemas are zod raw shapes, `zod@3.25.76`.

### Module paths, exports, signatures

| Export | Module | Owner |
|---|---|---|
| `export const CSUB_CORPUS: string` (banner included) | `src/corpus.ts` (import path `./corpus.js`) | Spec 04 |
| `export const ROUTE_DIRECTORY: RouteEntry[]`, `export const VERIFICATION_TOKEN_REGEX = /^SIM-V-[0-9A-F]{6}$/` | `src/mcp-server.ts` | Spec 02 |
| `buildMcpServer(cfg: AppConfig, deps?: BuildMcpServerDeps): McpServer`, `mcpRoutes(app, cfg, deps?)`, `interface BuildMcpServerDeps { knowledgeGenerate?: KnowledgeGenerateFn }` | `src/mcp-server.ts` (final shape after Wave DB) | Spec 03 |
| `KNOWLEDGE_TOPICS`, `KNOWLEDGE_ENVELOPE_SCHEMA`, `KnowledgeEnvelope`, `NOT_FOUND_SENTINEL = 'NOT_FOUND'`, `NOT_FOUND_SPOKEN`, `KNOWLEDGE_ERROR_SPOKEN`, `buildKnowledgeSystemPrompt`, `askCampusKnowledge`, `makeGatewayGenerate`, `KnowledgeGenerateFn` | `src/knowledge.ts` (the ONLY module importing from `'ai'`) | Spec 03 |
| `export const INSTRUCTIONS` (R3 text), module-private `GREETING_INSTRUCTIONS` (R11 text) | `src/gateway.ts` | Spec 01 |
| `KNOWLEDGE_METRICS = ['knowledgeMs']`, `--knowledge` flag | `scripts/aggregate-latency.mjs` | Spec 05 |

Server identity: `new McpServer({ name: 'rio-demo', version: '1.0.0' })` (Spec 02 R1). The `// FR-5:` comment stays the last line of the tool block — Spec 03's insertion point.

### Log events

| Event | Emitter | Fields | Consumer |
|---|---|---|---|
| `crisis-escalation` | `escalate_to_human` | level `'warn'` iff `urgency==='crisis'` else `'info'`; message `'escalation requested'`; `tool`, `urgency`, `reason` (sliced to 200) | ops/incident review |
| `static-tool` | other five static tools | level `'info'`, message `'static tool served'`, `tool` + per-tool scalars | ops |
| **`knowledge-call`** | `askCampusKnowledge` | flat: `status`, `topic?`, `questionChars`, `answerChars`, `knowledgeMs` (1-decimal), `inputTokens?`, `outputTokens?`, `cachedInputTokens?`, `reasoningTokens?`, `modelId`, `errName?` | Spec 05 (E4/E5), export query `@event:knowledge-call` → `knowledge.jsonl` |
| `tool-call`, `turn`, `greeting`, `stream-stop`, `session-updated` | existing base build | unchanged | Spec 05 |

No `callSid` on the MCP-side lines (stateless server); correlation via the session-level `tool-call` line.

### Magic strings (exact, cross-asserted)

- Preamble sentence (G4) — quoted above, character-exact.
- `NEVER answer campus facts from memory` — exact casing, in `INSTRUCTIONS` (Spec 01 R4, test-asserted A3).
- Envelope: `{"status":"ok"|"not_found"|"error","response_text":string}`; sentinel `NOT_FOUND` never reaches the caller (Spec 03 R9.4).
- `SIM-V-` + 6 uppercase hex (verification token); `SMS-SIM-` + 6 digits (message id); payload first key `"simulated"` everywhere (`false` only for `get_current_time`).
- Corpus banner line 1, byte-exact: `# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA` (em dash).
- Demo number `+1 (661) 490-9364`; crisis numbers per G3.

## §5 Drift adjudications (winners picked; corrections binding)

Each row: what the specs disagree on → the winner → the exact correction the affected implementer applies. These override child-spec text (Precedence rule, Purpose section).

**D1 — Corpus export name.** Spec 03 consumes `CORPUS` from `src/corpus.ts`; Spec 04 exports `CSUB_CORPUS`. **Winner: Spec 04** (owns the module). Correction to Spec 03: import `{ CSUB_CORPUS } from './corpus.js'`; where Spec 03's R7/R10 snippets say `CORPUS`, use `CSUB_CORPUS` (a local alias `const CORPUS = CSUB_CORPUS` is acceptable if the snippet is kept verbatim).

**D2 — Knowledge log event name.** Spec 03 emits `knowledge-call`; Spec 05 assumed `'knowledge-tool'` (self-flagged open item). **Winner: Spec 03** (the producer). Corrections to Spec 05: R4 `wantEvent = 'knowledge-call'`; R3 export query `@event:knowledge-call` → `knowledge.jsonl`; A1 fixture lines use `"event":"knowledge-call"`. Field name `knowledgeMs` is confirmed.

**D3 — `buildMcpServer` signature ownership/timing.** Spec 02 says "signatures unchanged"; Spec 03 changes them to `(cfg, deps?)`. **Resolution by sequencing:** Spec 02 executes in Wave DA against the current zero-arg signature; Spec 03 executes in Wave DB and owns the signature change plus ALL call-site updates (`src/server.ts:75`; `test/mcp-server.test.ts:10`; `test/tools.test.ts:14,110`). Neither spec's text changes; the "whichever lands first" ambiguity is closed by wave order.

**D4 — Exact-list vs containment tool assertion.** Spec 02 converts `test/mcp-server.test.ts`'s list assertion to containment+exclusion so Spec 03 can add its tool without touching that file. **Accepted.** To keep the final surface pinned server-side, Spec 03's `test/knowledge.test.ts` additionally asserts that `tools/list` returns **exactly seven** names equal to the §4 set (one sorted-array deep-equal). Spec 01's A4 parity test pins the prompt side.

**D5 — `get_current_time` email wording.** Spec 02 requires the email showcase to describe **real campus (Pacific) time**; Spec 06 R17's replacement text says "reads back the server's clock". **Winner: Spec 02's constraint.** Correction to Spec 06 R17: in the replacement text, the clause `and reads back the server's clock` becomes `and reads back the real current time on the Bakersfield campus (Pacific Time), straight from the server's clock`; the rest of R17 stands verbatim. Smoke-test item 5 (R24) expects spoken Pacific campus time.

**D6 — `route_call` gained `context?: string`.** Confirmed as specified (Spec 02 R4). The context-note handoff payload is the "caller never repeats themselves" demo beat; one optional arg, no state.

**D7 — `get_current_time` JSON payload shape.** Confirmed (Spec 02 R8): `{simulated:false, utc, campus_time, timezone:'America/Los_Angeles'}` replaces the old plain string; the R10 test migrations are in scope for Spec 02.

**D8 — `send_sms` inclusion.** Stays. findings/16 §C13 and the concept doc recommended dropping it; the approved six-tool surface (binding decision) includes it. Spec 01 keeps it CONFIRMATION-FIRST; Spec 02 R7 ships it.

**D9 — Crisis preamble.** The G4 sentence mandates a spoken line before ANY tool, including `escalate_to_human` on crisis. **Decision: keep it, no carve-out.** Spec 01 R3's Safety section ("respond with warmth in one sentence, then IMMEDIATELY call escalate_to_human") already provides that pre-tool utterance — the warm sentence IS the audible beat; the static tool resolves in microseconds so no latency mask is needed. No spec text or test changes.

**D10 — `escalate_to_human` urgency enum.** Spec 02 R3 ships `z.enum(['routine','urgent','crisis'])`; Spec 01's Safety text says `urgency "crisis"`. Consistent — frozen as-is.

**D11 — Usage/metadata logging (Spec 05 open item).** Resolved YES: Spec 03 R12 logs `inputTokens`/`outputTokens`/`cachedInputTokens`/`reasoningTokens` (omit-if-undefined). Therefore E5 evidence class 2 (logged cached tokens) and E4's secondary thinking evidence (`reasoningTokens` ≈ 0) are both available. Cosmetic AI-SDK field-name drift is confirmed at install time by the Spec 03 implementer, contained to `makeGatewayGenerate` + the log line.

**D12 — E4/E6 experiment identity (Spec 06 open item).** Confirmed: E4 = delegated knowledge-tool latency baseline (Spec 05 R8), E6 = turn-level conversation-quality budget (Spec 05 R10); artifacts land under `docs/measurements/<YYYY-MM-DD>-<label>/` per the existing README procedure. Spec 06 R5's annotation sourcing is unblocked once those directories exist.

**D13 — `verify_identity`→`reset_password` payload shape (Spec 06 open item).** Confirmed by Spec 02 R5/R6: token minted inside the verify return, shape-validated by regex in reset; the deep-dive §6 walkthrough documents exactly that (state rides in the realtime conversation).

**D14 — Test-count phrasing.** Spec 01 A2 / Spec 03 A12 say "356 pre-existing tests" — read as "the pre-demo baseline suite (356) plus every demo test added by earlier waves". The binding rule is §8, not the literal number in a child spec.

## §6 Wave structure and execution protocol

Execution follows the base orchestration protocol (`plans/README.md`): the orchestrator NEVER implements; one sub-agent per plan file in `docs/demo/plans/`; dispatch prompt = "Execute the plan at docs/demo/plans/<file> in repo root D:\projects-linean\CSUB-RIO-POC"; ledger updates per `plans/README.md` §4; failure protocol per §5. State lives in `docs/demo/plans/LEDGER.md` (§2 of this plan).

### Wave DA — offline foundations (parallel, disjoint files)

| Task | Spec | Exclusive file set |
|---|---|---|
| **DA1** corpus | 04 (all) | `assets/csub-corpus.md`, `src/corpus.ts`, `test/corpus.test.ts`, `docs/demo/CORPUS-UPDATE-GUIDE.md` |
| **DA2** static tools | 02 (all) | `src/mcp-server.ts`, `test/static-tools.test.ts`, `test/mcp-server.test.ts`, `test/tools.test.ts`, `test/harness.test.ts`, `test/fakes/fake-gateway.ts` |
| **DA3** aggregator (early-dispatch allowance) | 05 R4 only | `scripts/aggregate-latency.mjs`, `docs/measurements/README.md` |

DA1⊥DA2⊥DA3 — fully parallel (3 lanes max). DA3 uses event name `knowledge-call` (D2). **Merge point M-A:** full `npx vitest run` green (§8); no shared files, so no manual merge. DA2 lands against the zero-arg `buildMcpServer()` (D3).

### Wave DB — knowledge tool + persona (parallel, disjoint files; depends on M-A)

| Task | Spec | Exclusive file set | Depends |
|---|---|---|---|
| **DB1** knowledge tool + config | 03 (all, incl. D1/D3/D4 corrections) | `src/knowledge.ts`, `src/config.ts`, `.env.example`, `package.json`, `package-lock.json`, `src/mcp-server.ts` (edit), `src/server.ts` (line 75 only), `test/knowledge.test.ts`, `test/config.test.ts`, `test/mcp-server.test.ts` (call sites), `test/tools.test.ts` (call sites) | DA1 (`CSUB_CORPUS`), DA2 (mcp-server body) |
| **DB2** persona | 01 (all) | `src/gateway.ts`, `test/gateway.session-config.test.ts` | DA2 landed (tool names frozen in §4 regardless) |

DB1⊥DB2 (disjoint files) — parallel, 2 lanes. `src/mcp-server.ts`, `test/mcp-server.test.ts`, `test/tools.test.ts` are cross-wave sequential (DA2 → DB1), never concurrent.

**Merge point M-B (the deploy gate):** (1) full suite green, `npm run typecheck` green; (2) grep gates: Spec 03 A3 (no fallback), Spec 04 A5 (corpus read only in `src/corpus.ts`), Spec 02 A9 (no live `'hello'` references); (3) G3 crisis-number byte-identity spot check across `src/gateway.ts`, `src/mcp-server.ts`, `assets/csub-corpus.md`; (4) push to `main` → Railway auto-deploy (~2 min) → **the demo build is live**. First post-deploy call is human-run (queue item H1, §7).

### Wave DC — live measurement + docs drafting (after M-B)

| Task | Spec | Files | Notes |
|---|---|---|---|
| **DC1** experiments | 05 (R1–R3, R5–R12) | `docs/measurements/**` (EXPERIMENTS.md, dated dirs); NO `src/` changes | Human-in-the-loop (H2). Order per Spec 05 R11: R2 baseline → E3 (S8) → E4+E5 → E1/E2 (any order, one at a time) → E6 |
| **DC2** docs drafting | 06 R8–R26 except R5 commit | `docs/demo/MCP-SERVER-DEEP-DIVE.md`, `docs/demo/LAUNCH-CHECKLIST.md`, `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` (R17 per D5, R18, R19, R21) | ARCHITECTURE.md may be drafted but NOT committed with missing numbers (Spec 06 R6) |

DC1⊥DC2 (disjoint files) — parallel. **Merge point M-C:** E4 row reads PASS in `EXPERIMENTS.md` (this releases the email — Spec 05 R11.3 / A7); E6 evaluated; every FAIL row reverted; ledger current; S1/S8 answers recorded in both ledgers (R2.3).

### Wave DD — launch (after M-C; human required)

| Task | Spec | Files / actions |
|---|---|---|
| **DD1** architecture commit | 06 R1–R7 | `docs/demo/ARCHITECTURE.md` with measured E4/E6 annotations, mermaid checks (Spec 06 A1–A3) |
| **DD2** launch execution | 06 R20, R22–R26 | Human supplies `[SENDER NAME/TITLE]`, `[FEEDBACK CHANNEL]`, `[PILOT END DATE]`; 9-item smoke-test call (R24) against +1 (661) 490-9364; send (T0 recorded); deploy freeze; 72 h extraction cadence into `docs/measurements/<date>-pilot/` |

**The build is done** when: email sent, freeze in force, LAUNCH-CHECKLIST §1–§2 fully checked, ledger's Current state reads LAUNCHED.

### Human-required queue (extends the base M1–M5 pattern)

- **H1** (at M-B): watch the deploy, place the first RIO call, run Spec 01 A8's live behavioral checks (a)–(e); record in the demo ledger.
- **H2** (Wave DC): all measurement sessions — E1 blind A/B (2 listeners), E2 clipping judgment (caller self-report), E3/S8 voice check, E4's ≥ 20 live knowledge questions across ≥ 5 calls, E6 budget read-out. Log extraction within 72 h of every session (hard rule).
- **H3** (Wave DD): the three email inputs, the smoke-test call, the send itself, and any freeze-exception decision.

## §7 Spike register (this build)

| ID | Question | Evidence that answers it | Where | On NO |
|---|---|---|---|---|
| **DS-1** (= base **S8**) | Is `marin` a valid/applied voice for `openai/gpt-realtime-2.1` through the gateway? | Applied voice in `session-updated.raw` + audible check (E3, Spec 05 R7) | Wave DC, before E4 | Flip `VOICE=alloy`; file a change against Spec 01's persona copy; record in both ledgers |
| **DS-2** (= base **S1**) | Does the gateway honor `audio/pcmu` end-to-end (structurally NO `rate` key)? | `session-updated.raw` from a pcmu call (E1, Spec 05 R5) | Wave DC | Revert `AUDIO_MODE=transcode` same day; Path A dead, Path B ships |
| **DS-3** | Does `providerOptions.google.thinkingConfig.thinkingLevel:'minimal'` actually pass through to Google? | Primary: E4 latency distribution — `knowledgeMs` p50 < 1500 ms with < 10% timeouts = confirmed; p50 pinned at the 3500 ceiling or ≥ 50% timeouts = broken. Secondary: logged `reasoningTokens` ≈ 0 (D11). Build-time: Spec 03 A10 asserts the option is *sent* | Wave DC (E4) | Stop; fix Spec 03 R11 `providerOptions` syntax; redeploy; re-run E4 |
| **DS-4** | Knowledge latency baseline — the number that locks RIO's preamble length and releases the email | E4: `knowledgeMs` p50/p95, `toolTotalMs` p50 over ≥ 20 live questions; gate = G6 numbers | Wave DC → gates Wave DD | Email blocked until Spec 03 fixed and E4 re-passes |
| **DS-5** | Does implicit caching bite (corpus-first ordering)? | `cachedInputTokens` ≥ 50% of input on repeat questions, or gateway dashboard cache-read line items (E5) | Wave DC (piggybacks E4) | Non-blocking: record as cost fact (~$0.0005/question uncached), never reverts, never blocks the email |

## §8 Test-count and suite-green requirements

- **R8.1 Baseline.** The pre-demo suite is **356 tests**. Verified 2026-07-19: full-suite run = 354 passed, 2 failed — the two failures (`test/harness.test.ts` barge-in scenario: "clear precedes conversation-item-truncate" and "truncate carries a valid audioEndMs") are **timing-flaky under full-suite load and pass in isolation** (re-run of the file alone: 13/13). This is recorded as known flake **KF-1**.
- **R8.2 KF-1 rule.** A merge-point run failing ONLY on KF-1's two tests gets one targeted re-run (`npx vitest run test/harness.test.ts`); green in isolation = the gate passes, noted in the ledger. Any other failure, or a KF-1 failure that persists in isolation, is a real regression and blocks the merge. No demo task may modify these two tests except DA2's R10.4 migration, which must leave them passing in isolation.
- **R8.3 Suite green at every merge point** (M-A, M-B, M-C) and in every task completion report: `npx vitest run` with zero non-KF-1 failures and **zero skips introduced**. `npm run typecheck` green at M-B.
- **R8.4 Count never shrinks.** No test deletions — the `hello` tests are migrated/retargeted (Spec 02 R10), not removed. Expected additions: Spec 04 ≥ 7 (corpus), Spec 02 ≥ 12 (static tools + migrations), Spec 03 ≥ 13 (knowledge/config incl. the D4 exact-seven assertion), Spec 01 ≥ 4 (A3–A6). Final count strictly > 356; the actual number is recorded in the demo ledger at each wave end and reused by LAUNCH-CHECKLIST §1 gate 1 ("≥ the pre-demo baseline of 356, new tool/corpus tests included").
- **R8.5** The two G4 preamble assertions and the voice-default assertion (`test/gateway.session-config.test.ts:103`) must appear UNMODIFIED in every wave's diff audit.

## §9 Disposition of all author-raised open issues

Numbering: origin spec → issue → **disposition** (adjudications D1–D14 referenced from §5).

1. **01** cross-spec numbering → resolved, §1 rename table.
2. **01** `send_sms` vs findings/16 §C13 → **D8**: stays.
3. **01** Safety section needs `urgency` enum containing `'crisis'` → **D10**: Spec 02 ships it; frozen.
4. **02** `route_call` `context?` arg beyond original one-arg scope → **D6**: confirmed.
5. **02** `get_current_time` JSON shape change + test ripples → **D7**: confirmed; email wording per **D5**.
6. **02** crisis-preamble question → **D9**: keep, warm sentence doubles as the preamble.
7. **02** containment vs exact-list assertion → **D4**: containment stands; Spec 03 adds the exact-seven pin.
8. **03** corpus export name → **D1**: `CSUB_CORPUS` wins.
9. **03** signature-change ownership → **D3**: wave-sequenced; Spec 03 owns it.
10. **03** AI-SDK usage field names → **D11**: confirm at install time; contained.
11. **03** thinking-passthrough verified from docs, not live → **DS-3** is the runtime detector; accepted.
12. **04** sibling numbering unknown → §1 table.
13. **04** SEARCH-SNIPPET values (Runner Rundown $150/$105; NextTech Oct 28, 2026) kept verbatim → **confirmed**: keep as-is; the R2 banner is the simulation cover; re-fabricating them would only reduce authenticity [findings/13].
14. **04** en-dash time ranges (`7 AM–6 PM`, `closed noon–1 PM`) → **confirmed en-dash-exact**: the corpus author uses en dashes in all time ranges; the R8 test strings stand unchanged.
15. **05** knowledge event name + field set → **D2**: `knowledge-call`; full field set per §4.
16. **05** usage/providerMetadata logging → **D11**: yes, Spec 03 logs it.
17. **05** E6 `ttfbMs` p50 ≤ 900 ms provisional target → **HUMAN-DECISION (non-blocking)**: the 900 ms gate stands as the default; at the R2 baseline review the human may re-set it — concrete question: *"Given the measured baseline ttfbMs p50, keep 900 ms or re-baseline E6's simple-turn gate to <value>?"* Any change is a ledger row.
18. **05** E1/E2 human-in-the-loop judgments → queued as **H2** (§6); accepted.
19. **06** sibling numbering → §1 table.
20. **06** E4/E6 identity + artifact convention → **D12**: confirmed.
21. **06** verify→reset payload shape for the deep-dive → **D13**: confirmed.
22. **06** 24 h freeze + ≤ 1/day batching are proposals → **adopted as the default, HUMAN-adjustable (non-blocking)**: concrete question at DD2: *"Keep the T0+24 h hard freeze and ≤ 1/day batching, or set different windows?"* Whatever the human picks is written into LAUNCH-CHECKLIST before the send.

## Interfaces

**Consumes:** the six demo specs (§1); the base build's orchestration protocol (`plans/README.md`), ledger format (`plans/LEDGER.md`), spike register (`docs/specs/00-master-build-plan.md` §7), measurement procedure (`docs/measurements/README.md`, `scripts/aggregate-latency.mjs`), and the live line (+1 (661) 490-9364, Railway us-east4).

**Produces (for the orchestrator and all implementer sub-agents):** the canonical numbering (§1); the folder contract incl. `docs/demo/plans/LEDGER.md` (§2); global constraints G1–G14 (§3); the frozen interface table (§4); binding adjudications D1–D14 (§5); the DA/DB/DC/DD wave plan with merge points M-A/M-B/M-C and human queue H1–H3 (§6); spikes DS-1…DS-5 (§7); test rules incl. KF-1 (§8).

## Acceptance criteria

- **A1** (folder contract): after Wave DA dispatch begins, `docs/demo/plans/LEDGER.md` exists with a Current state block and the DA table; base `plans/LEDGER.md` contains the single cross-reference note (R2.3); no demo state was written into `plans/LEDGER.md`.
- **A2** (adjudications applied): grep evidence — `grep -rn "CSUB_CORPUS" src/` shows `src/corpus.ts` (export) and `src/knowledge.ts` or `src/mcp-server.ts` (import) only (D1); `grep -n "knowledge-call" src/knowledge.ts scripts/aggregate-latency.mjs` hits both (D2); `grep -c "knowledge-tool" scripts/aggregate-latency.mjs` = 0.
- **A3** (surface frozen): post-M-B, `tools/list` returns exactly the seven §4 names (Spec 03's exact-seven test, D4); `INSTRUCTIONS` names exactly those seven (Spec 01 A4); `hello` appears in no live-server test or registration.
- **A4** (global-constraint gates at M-B): `npx vitest run` green per §8; `grep -rE 'FALLBACK_MODEL|MCP_FALLBACK|gateway.*models\s*:' src/` empty (G2); `git diff --stat` across the demo commits shows `src/twiml.ts`, `src/session.ts`, `src/tools.ts`, `src/dsp.ts`, `src/bargein.ts` untouched (G8/G9); `package.json` diff adds only `"ai": "7.0.31"` (G1).
- **A5** (crisis-number identity, G3): `(661) 654-3366`, `988`, `(661) 654-2111`, `(661) 654-2782` each appear in `src/gateway.ts`, `src/mcp-server.ts`, and `assets/csub-corpus.md` after M-B, and in `docs/demo/MCP-SERVER-DEEP-DIVE.md` after DC2 — with identical formatting.
- **A6** (ordering provable): ledger + `EXPERIMENTS.md` dates prove R2-baseline before any flip, E3 before E4, and E4 PASS before the email send (Spec 05 A7); at freeze time every FAIL row has a matching revert (Spec 05 A10).
- **A7** (launch complete): LAUNCH-CHECKLIST §1–§2 fully checked; the three R20 inputs substituted (`grep` per Spec 06 A5 clean); T0 recorded; demo ledger Current state = LAUNCHED; first pilot extraction scheduled within 72 h.

## Non-goals / out of scope

- **Relitigating approved decisions** — self-serve format, two-tier surface incl. `send_sms`, single-model/no-fallback, whole-corpus/no-RAG, crisis-simulated-only, marin-pending-S8, `get_current_time` retention: all binding; changes require the human, not a spec author or implementer.
- **Base-build changes** — no edits to `docs/specs/01–10`, the base ledger tables, `src/` bridge/session/DSP/TwiML code (G9), or the base test suite beyond the migrations Specs 01–03 declare.
- **New infrastructure** — no region moves, no auth/`allowedHosts` hardening for `/mcp` (base Spec 07 R6 risk-acceptance stands), no recording pipeline, no KPI dashboard, no OpenTelemetry.
- **Post-freeze tuning and >100 KB corpus growth** — deferred to the post-demo window (Spec 05 R11.6; Spec 04 R9.4).
- **Sending the email** — the human sends it; this plan (via Spec 06) produces the gate and the final text only.

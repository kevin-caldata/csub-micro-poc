# DC2.1 — `docs/demo/MCP-SERVER-DEEP-DIVE.md` (Spec 06 R8–R16)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Write `docs/demo/MCP-SERVER-DEEP-DIVE.md` — the written replacement for the technical Q&A a presenter would have fielded — covering transport architecture, the per-call tool re-fetch guarantee, the two-tier taxonomy, ToolLoop mechanics, the delegated-intelligence pattern with its cost math, statelessness + the SIM-V token flow, the use-case catalog with extension recipe, and operational characteristics. Every technical claim in the document is verified against the SHIPPED post-M-B code before commit.

**Global Constraints reference:** All Global Constraints in `docs/demo/specs/00-master-demo-plan.md` §G bind every step of this plan. Load-bearing here: **G3** (crisis numbers byte-identical everywhere they appear — this document is one of the enumerated surfaces), **G2** (document single-model/no-fallback as a decision, never soften it), **G4** (the preamble sentence is quoted character-exact), **G13** (no placeholders — `TBD`/`TODO`/`XXX`/bracket tokens forbidden), **G14** (this task owns exactly one file).

**Wave:** DC (task DC2, deep-dive slice) · **Depends on:** merge point M-B — the demo build deployed and live (Waves DA+DB landed). NO measurement dependency: this document cites spec constants and code-comment measurements only, never E4/E6 numbers (those belong to ARCHITECTURE.md, a different task). · **Blocks:** LAUNCH-CHECKLIST §1 gate 4 (Spec 06 R23) and the DD1 architecture commit's cross-links.

**References (read ALL before writing a word):**
- `docs/demo/specs/00-master-demo-plan.md` — §3 (G1–G14), §4 (interface table: tool surface, env keys, magic strings, log events), §5 D13 (verify→reset payload confirmed as the §6 walkthrough content)
- `docs/demo/specs/06-docs-and-launch.md` — **R8–R16** (the per-section content contracts; this plan does not re-paste them — the spec text is the authority for what each section must say), acceptance **A2, A4**
- `docs/demo/specs/02-static-tools.md` — R2 (shared conventions), R3–R8 (per-tool payloads), R9 (verify→reset token flow)
- `docs/demo/specs/03-knowledge-tool-and-model-config.md` — R9.4 (envelope + `NOT_FOUND` sentinel), R11 (providerOptions/thinking), R12 (`knowledge-call` log line)
- `docs/demo/RIO-INTELLIGENT-TOOLS-CONCEPT.md` — §2 (tier rule source text), §4.17 (boundary contract), §5.18 (whole-corpus/no-RAG), §6.23 (instructions↔tools sync)
- `docs/findings/16-two-tier-tool-integration-audit.md` — §C18 cost math at lines 140–145 and 162; §C3, §C6, §C7, §C11–C13, §C15
- `docs/findings/15-gateway-text-generation-for-tools.md` — §21–23 (pricing/caching), line 9 (~$0.0005/question)
- `docs/findings/11-mcp-server-tool-loop.md` — §C3–C5, §C7, §C12
- **SHIPPED code (the deep-dive documents the build as deployed, never the specs' intent):** `src/mcp-server.ts` (entire file, AS BUILT after DA2+DB1 — do not trust pre-demo line anchors), `src/knowledge.ts`, `src/corpus.ts`, `src/tools.ts`, `src/session.ts:280-320,430-450`, `src/gateway.ts` (as built after DB2 — the `INSTRUCTIONS` export and session-update assembly), `src/fallback.ts:40-44`, `src/bargein.ts:70-80`, `src/config.ts`

## Files

- **Create:** `docs/demo/MCP-SERVER-DEEP-DIVE.md` (the only file this task may create or modify — G14)
- **Modify:** none. No `src/` edits, no test edits, no email/checklist/architecture edits.
- **Test:** none added. Doc-only task; the verify tail proves the suite is untouched.

## Interfaces

**Consumes:**
- The shipped seven-tool surface (master plan §4, frozen): `escalate_to_human`, `route_call`, `verify_identity`, `reset_password`, `send_sms`, `get_current_time` (static) + `ask_campus_knowledge(question, topic?)` (delegated).
- Shipped exports read (never modified): `buildMcpServer(cfg, deps?)`, `mcpRoutes(app, cfg, deps?)`, `ROUTE_DIRECTORY`, `VERIFICATION_TOKEN_REGEX` from `src/mcp-server.ts`; `KNOWLEDGE_ENVELOPE_SCHEMA`, `NOT_FOUND_SENTINEL`, `askCampusKnowledge`, `makeGatewayGenerate` from `src/knowledge.ts`; `CSUB_CORPUS` from `src/corpus.ts`.
- Magic strings (master plan §4, restated so the writer cannot drift): envelope `{"status":"ok"|"not_found"|"error","response_text":string}`; token regex `/^SIM-V-[0-9A-F]{6}$/`; message id prefix `SMS-SIM-` + 6 digits; payload first key `"simulated"` (`false` only for `get_current_time`); env keys `MCP_MODEL_ID` (default `google/gemini-3.1-flash-lite`), `MCP_MODEL_MAX_TOKENS` (default `150`), `MCP_TOOL_TIMEOUT_MS` (default `3500`, zod `.lt(5000)`); preamble sentence `Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up').`
- Crisis numbers, byte-identical per G3: `(661) 654-3366` (after hours press 2), `988` (call or text), `(661) 654-2111` / 911, `(661) 654-2782`.

**Produces:**
- `docs/demo/MCP-SERVER-DEEP-DIVE.md` with exactly these eight numbered section headings in this order (Spec 06 R8; A4 greps for them): `## 1. Transport architecture` · `## 2. Tool registry and the per-call re-fetch guarantee` · `## 3. The two-tier taxonomy` · `## 4. ToolLoop mechanics` · `## 5. The delegated-intelligence pattern` · `## 6. Statelessness and cross-tool state` · `## 7. Use-case catalog` · `## 8. Operational characteristics`.
- The claims-check appendix (a short `## Appendix: verification log` table inside the doc is NOT required by the spec — the claims check lives in this plan's Steps and the completion report, not in the deliverable).

## Steps

### Prepare

- [ ] Read every file in References. While reading the shipped `src/mcp-server.ts`, `src/knowledge.ts`, `src/corpus.ts`, and `src/gateway.ts`, record fresh `file:line` anchors for every fact the deep-dive will cite from them. **Anchor rule:** Spec 06's inline anchors for these four files (e.g. `src/mcp-server.ts:37`, `:41-70`; `src/gateway.ts:275`, `:590-592`) date from the pre-demo build and are hints only — DA2/DB1/DB2 rewrote those files, so every anchor into them is re-derived from the code as built. Anchors into G9-protected files are stable and may be used as given: `src/tools.ts:21-22` (warm connect ≈ 5 ms), `:30-36` (`fetchToolDefs`, `$schema` stripped, never spread), `:39-55` (`runTool` never-throws), `:42` (5000 ms transport cap), `:121-144` (args-done → runAndSend → `conversation-item-create`), `:148-155` (deferred retry, "never a timer"), `:161-181` (double gate (a)–(d)), `:168-172` (`autoResponseIntervened`), `:209-235` (`tool-call` log line fields); `src/session.ts:441` (per-call `fetchToolDefs`), `:209-211` (benign create-while-active error); `src/fallback.ts:40-44` (`import.meta.url` path precedent); `src/bargein.ts:75` (tool-gap no-op).
- [ ] Confirm M-B actually landed before drafting: `git log --oneline -5` shows the DB-wave commits, and `npx vitest run test/knowledge.test.ts` passes. If `src/knowledge.ts` does not exist, STOP and return blocked ("dispatched before M-B").

### Outline (skeleton commit-ready, no claims yet)

- [ ] Create `docs/demo/MCP-SERVER-DEEP-DIVE.md` with: title; the R8 purpose paragraph (two obligatory ideas, in the writer's own words: this document replaces the technical Q&A a presenter would have fielded in a staged demo, and it is written for an engineer who has the repo open); then the eight `## N. <heading>` sections exactly as listed under Produces, each initially containing only its source pointers. House citation style throughout: `[findings/NN §claim]` / `[file:line]`, matching Spec 06 R1's convention. G13 applies from the first keystroke: never park a `TODO` in the skeleton — draft section-by-section instead.

### Draft (one step per section; content contract = the named spec requirement, not this plan)

- [ ] **§1 Transport architecture** per Spec 06 **R9**. Must include verbatim: `sessionIdGenerator: undefined`, `enableJsonResponse: true`, and the SDK enforcement string `'Stateless transport cannot be reused across requests'`; the fresh-`McpServer`-per-POST rationale; JSON mode keeps `/mcp` curl-debuggable; `GET`/`DELETE` → 405; in-process client at `http://127.0.0.1:$PORT/mcp`, warm connect ≈ 5 ms [src/tools.ts:21-22]. Anchor the transport block and 405 handlers to the as-built `src/mcp-server.ts` lines.
- [ ] **§2 Tool registry and per-call re-fetch** per Spec 06 **R10**. Quote the in-file `// FR-5:` extension-point comment exactly as it appears in the shipped file (it must still be the last line of the tool block — master plan §4); describe `fetchToolDefs` (`listTools()` → realtime mapping, `$schema` stripped, never spread) [src/tools.ts:30-36] running per phone call before every `session-update` [src/session.ts:441; as-built gateway.ts anchor]; state the consequence: a pushed tool is live on the next call with zero bridge changes.
- [ ] **§3 The two-tier taxonomy** per Spec 06 **R11**. The tier-decision rule is stated verbatim as quoted in R11 (source: RIO-INTELLIGENT-TOOLS-CONCEPT §2 — copy from the spec, do not paraphrase). Then the seven-tool table with per-tool tier rationale, and the two corollaries: (1) safety paths never touch the intelligent tier — the four crisis numbers appear here formatted byte-identically per G3 (copy them from `src/mcp-server.ts` as built, then diff against the Consumes list above — they must match both); simulated handoff, nobody dialed; (2) exactly ONE delegated tool — topic-sharded `ask_*` tools recreate the intent-tree misfire class [RIO-INTELLIGENT-TOOLS-CONCEPT §2.8].
- [ ] **§4 ToolLoop mechanics** per Spec 06 **R12**, citing the stable `src/tools.ts` anchors from the Prepare step: args-done → async `runTool` → `conversation-item-create {function-call-output}`; the double gate's four conditions (a)–(d) [src/tools.ts:161-181; findings/11 §C5]; deferred retry re-checked on every `response-done`, "never a timer" [src/tools.ts:148-155]; the three barge-in races (tool-gap guarded no-op [src/bargein.ts:75], VAD auto-response blocks (c) and sets `autoResponseIntervened` [src/tools.ts:168-172], lost-race `conversation_already_has_active_response`-class error treated benign and retried [src/session.ts:209-211]); `runTool`'s never-throws contract and the spoken-apology outcome [src/tools.ts:39-55]. In the preamble-masking discussion, quote the G4 preamble sentence character-exact (Spec 06 Interfaces requires the deep-dive to quote it) and note it is test-asserted [test/gateway.session-config.test.ts:100-102,124-128].
- [ ] **§5 The delegated-intelligence pattern** per Spec 06 **R13**, with the numbers copied exactly from the findings (never recomputed): ≈ $0.076 turn-1 corpus cost + ≈ $0.0076/turn cached ≈ **$0.16 per 12-turn call** vs ≈ **$0.004** delegated — **~40× cheaper**, only on knowledge turns [findings/16 §C18 — `docs/findings/16-two-tier-tool-integration-audit.md:140-145`]; price asymmetry $4/M realtime text-in vs $0.25/M flash-lite ($0.40/M vs $0.03/M cached) [findings/15 §22–23]; 128k vs 1M context; the non-dollar half (persona-adherence dilution, prefill latency) [findings/16 §C18]. Boundary contract: one-sentence question in, 2–3-sentence envelope out; the corpus never enters the realtime context [RIO-INTELLIGENT-TOOLS-CONCEPT §4.17]. Single-model decision: `MCP_MODEL_ID` default `google/gemini-3.1-flash-lite`, **no fallback chain** (G2); failure → envelope `status:'error'` → existing spoken-apology path. Envelope quoted exactly: `{status: 'ok'|'not_found'|'error', response_text}`; note the `NOT_FOUND` sentinel never reaches the caller [Spec 03 R9.4; as-built src/knowledge.ts anchor].
- [ ] **§6 Statelessness and cross-tool state** per Spec 06 **R14** and master plan **D13**. Zero server-side state between requests (fresh server per POST; G5 — no module-level mutable state). The walkthrough uses the SHIPPED payload shapes: open `src/mcp-server.ts` as built and transcribe (a) the exact JSON `verify_identity` returns including the minted `SIM-V-` token field, and (b) `reset_password`'s validation of `verification_token` against `VERIFICATION_TOKEN_REGEX = /^SIM-V-[0-9A-F]{6}$/` — do NOT reconstruct these from Spec 02's text; the code is the authority and the two must be quoted from it with fresh line anchors. State rides in the realtime conversation: the tool result becomes a conversation item; the model passes the token back as an argument; the MCP server never remembers the caller. Close with the honesty note R14 requires (theater on fake data, verification always succeeds, production would server-validate).
- [ ] **§7 Use-case catalog** per Spec 06 **R15**: the can-handle-today list, the cannot-handle-today list (each item with its reason and citation — no `<Dial>` [as-built src/twiml.ts anchor near the `</Connect>` close; twiml.ts is untouched by the demo build so pre-demo lines 151-153 remain valid], no SMS REST client [findings/11 §C12], out-of-corpus → `not_found` + routing offer by design, no per-caller persistence [findings/11 §C7]), and the four-step extension recipe ending with push-to-main → Railway auto-deploy (~2 min) → live next call, deploys sever in-flight calls. Verify every "can handle" item maps to a registered tool or shipped behavior before writing it down.
- [ ] **§8 Operational characteristics** per Spec 06 **R16**, tabulated: the timeout ladder (in-handler `MCP_TOOL_TIMEOUT_MS` 3500 ms → transport cap 5000 ms [src/tools.ts:42] → SDK default 60 s, unused); the three `MCP_*` env keys with defaults (exact spellings from Consumes — A4 greps for them); the three error paths all reaching the same spoken apology [findings/16 §C11]; the `tool-call` log line with flat `mcpMs`/`gateWaitMs`/`secondTtfbMs`/`toolTotalMs` [src/tools.ts:209-235] and the Railway query `@event:tool-call AND @toolTotalMs:>1500`; the `knowledge-call` event and its `knowledgeMs` field [Spec 03 R12; as-built src/knowledge.ts anchor]; the M3 gate `toolTotalMs` p50 < 1500 ms (G6 — cite it as the gate constant, NOT as a measured result; this document carries no E4/E6 numbers); corpus loaded once at module scope and why (`buildMcpServer` runs per request) with the `import.meta.url` precedent [src/fallback.ts:40-44; findings/16 §C15].

### Verify against code (the claims check — every § before commit)

- [ ] Walk the finished document top to bottom. For EVERY `[file:line]` anchor, open that file at that line and confirm the cited code says what the sentence claims. For every quoted string (FR-5 comment, SDK error string, envelope, regex, payloads, preamble sentence, crisis numbers), confirm byte-equality against the source with grep, not by eye:
  - `grep -n "FR-5:" src/mcp-server.ts` — comment exists and §2's quote matches.
  - `grep -c "SIM-V-\[0-9A-F\]{6}" src/mcp-server.ts docs/demo/MCP-SERVER-DEEP-DIVE.md` — regex appears in both, identically.
  - `grep -n "Before calling any tool, briefly say you're checking" src/gateway.ts docs/demo/MCP-SERVER-DEEP-DIVE.md` — both hit; sentence character-identical (G4).
  - `grep -n "654-3366\|654-2111\|654-2782" docs/demo/MCP-SERVER-DEEP-DIVE.md src/mcp-server.ts` — formatting `(661) 654-XXXX` identical across both, and `988` present in the doc's §3 (G3 / master plan A5).
  - `grep -nE "\\$0\.16|\\$0\.004|~40×" docs/demo/MCP-SERVER-DEEP-DIVE.md` — all three present (Spec 06 A4); numbers match `docs/findings/16-two-tier-tool-integration-audit.md:140-145` exactly.
  - `grep -nE "MCP_MODEL_ID|MCP_MODEL_MAX_TOKENS|MCP_TOOL_TIMEOUT_MS" docs/demo/MCP-SERVER-DEEP-DIVE.md` — all three, each with its default (`google/gemini-3.1-flash-lite`, `150`, `3500`) nearby.
  - `grep -cE "^## [1-8]\." docs/demo/MCP-SERVER-DEEP-DIVE.md` → `8`, in R8's order (A4).
- [ ] Placeholder gate (Spec 06 A2 / G13): `grep -nE 'TBD|TODO|XXX|\[[A-Z][A-Z /]+\]' docs/demo/MCP-SERVER-DEEP-DIVE.md` → zero hits. If the doc legitimately needs a literal all-caps bracket (it should not), rewrite the sentence instead.
- [ ] Latency-number gate (protects the R5/R6 boundary owned by ARCHITECTURE.md): confirm by read-through that every millisecond figure in the doc is one of the spec/code constants (3500, 5000, 60 s, ≈ 5 ms warm connect, < 1500 gate, ~2 min deploy) — no p50/p95 measured values appear anywhere.
- [ ] Markdown lint-by-read: render the file (IDE preview or `git show`/plain read) checking — heading hierarchy is `#` then `##` (no skipped levels), every fenced block has a language tag or is intentionally plain, tables are pipe-aligned and render, no broken reference links, no smart-quote corruption inside code spans (the regex and envelope must survive as typed).

### Verify tail

- [ ] `npx vitest run` — expected: the full suite passes at the count recorded in `docs/demo/plans/LEDGER.md` at M-B (strictly > the 356 pre-demo baseline; no change from this task — zero tests added, zero touched). KF-1 rule (master plan §8.2): if the ONLY failures are the two `test/harness.test.ts` barge-in tests, run `npx vitest run test/harness.test.ts`; 13/13 in isolation = pass, note it in the completion report. Any other failure blocks — this task cannot have caused it, so return blocked with the evidence rather than "fixing" code (G14).
- [ ] `npx tsc --noEmit` — clean (doc-only change; any error is pre-existing → report, don't touch).
- [ ] Targeted check re-run (this task's "test"): re-run the five grep gates from the claims-check step plus the placeholder gate in one pass; all green.
- [ ] `git status` — exactly one new file: `docs/demo/MCP-SERVER-DEEP-DIVE.md`. Nothing else modified.
- [ ] Commit:
  ```
  docs(demo): add MCP-SERVER-DEEP-DIVE.md — transport, two-tier taxonomy, ToolLoop, delegated intelligence (Spec 06 R8-R16)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Acceptance

Discharges Spec 06 **A4** in full and **A2** for this file; contributes the deep-dive surface of master plan **A5** (crisis-number identity). Leaves for sibling tasks: LAUNCH-CHECKLIST.md (R22–R26), email finalization (R17–R21), ARCHITECTURE.md (R1–R7, measurement-blocked). This document must NOT be cited by LAUNCH-CHECKLIST gate 4 until this task's commit exists.

## Completion Report

```
Task: DC2.1 — MCP-SERVER-DEEP-DIVE.md
Status: <complete | blocked: reason>
Files changed: docs/demo/MCP-SERVER-DEEP-DIVE.md (new)
Commands run: <cmd → outcome, one line each — include all grep gates>
Spec 06 acceptance verified: A2 (this file) <p/f>, A4 <p/f>
Claims check: <N anchors verified, N quotes grep-confirmed; list any anchor that moved vs Spec 06's hints>
Deviations from plan: <none | list>
Notes for ledger: <≤3 lines>
```

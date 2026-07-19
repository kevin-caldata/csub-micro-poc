# DD1 — ARCHITECTURE.md: measured process-flow document (Spec 06 R1–R7)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Create `docs/demo/ARCHITECTURE.md` — one mermaid flowchart (exactly 13 nodes), one mermaid sequence diagram (6 participants, 3 `alt` failure blocks), a consolidated latency table whose every number is a **measured** E4/E6 aggregate with date + source path, and failure-path prose — then claims-check every code citation and commit. This is Wave DD task DD1 (master plan §6); it discharges Demo Spec 06 R1–R7 and acceptance A1–A3.

**Global Constraints reference:** All Global Constraints in `docs/demo/specs/00-master-demo-plan.md` §G bind every step of this plan. Load-bearing here: **G13** (no placeholders — restated by Spec 06 R6: `TBD`, `TODO`, `XXX`, `~?`, `N ms`, and square-bracket placeholders are forbidden in this file), **G14** (this task creates `docs/demo/ARCHITECTURE.md` and touches NO other repo file), **G8/G9** (docs only — zero `src/` edits; diagram fidelity comes from citing shipped code, never changing it), **G3** (if any crisis number appears in prose it must be byte-identical to the G3 set).

**Wave:** DD · **Depends on:** M-C (Wave DC complete — E4 PASS in `docs/measurements/EXPERIMENTS.md`, E6 evaluated) · **Blocks:** DD2 (LAUNCH-CHECKLIST §1 gate 4 requires this file committed)

## HARD PRECONDITION — halt as BLOCKED if unmet

This task is **hard-blocked on Spec 05 E4+E6 measured results existing under `docs/measurements/`** (Spec 06 R5; master plan D12). Step 1 verifies this before anything is authored. If it fails: do NOT create or commit `docs/demo/ARCHITECTURE.md` in any form (a draft with missing numbers stays uncommitted — Spec 06 Ordering constraint), do NOT substitute estimates or placeholders (Spec 06 R5/R6), and return a completion report with `Status: BLOCKED — <exactly which artifact is missing>`. The fix is running/extracting Spec 05, which is not this task's job.

## Files

**Create:**
- `docs/demo/ARCHITECTURE.md` — the only repo file this task may create or modify.

**Modify:** none. (Ledger updates are the orchestrator's job, not yours.)

**Test:** no vitest file — a docs task. Verification is the command gates in Steps 8–10 (mermaid parse, node-ID/participant inventory, placeholder grep, annotation traceability) plus the standard Verify tail.

Scratch artifacts (extracted `.mmd` blocks, rendered `.svg`, split JSONL): write them ONLY to the session scratchpad/OS temp directory, never inside the repo.

## Interfaces

**Consumes:**
- Spec 05 measured artifacts (exact files, resolved in Step 1): `docs/measurements/EXPERIMENTS.md` (E4/E6 rows — R12 ledger); the E4 session directory's `tools.jsonl`, `knowledge.jsonl`, `notes.md`; the E6 population directory's (`<date>-demo-baseline` or the superseding pre-freeze session per Spec 05 R1c/R10) `turns.jsonl`, `tools.jsonl`, `notes.md`.
- `scripts/aggregate-latency.mjs` — default, `--tools`, and `--knowledge` modes (Spec 05 R4; event `knowledge-call`, metric `knowledgeMs` per master plan D2).
- Shipped-build facts to cite (documented, not defined, here — master plan §4): seven tool names; envelope `{status:'ok'|'not_found'|'error', response_text}`; env keys `MCP_MODEL_ID`=`google/gemini-3.1-flash-lite`, `MCP_MODEL_MAX_TOKENS`=`150`, `MCP_TOOL_TIMEOUT_MS`=`3500`; corpus at `assets/csub-corpus.md`; demo number `+1 (661) 490-9364`.
- Code anchors (verified in Step 7): `src/twiml.ts:95-109` (signature gate, 403), `src/twiml.ts:141-153` (`<Connect><Stream>`, no verbs after `</Connect>`), `src/gateway.ts:590-592` (`session-update` is the first frame), `src/tools.ts:30-36` (`fetchToolDefs`), `src/tools.ts:39-55` (`runTool` never throws), `src/tools.ts:42` (5000 ms transport cap), `src/session.ts:381-385` (`mint-failed` teardown), `src/server.ts:142` (`setOnGatewayFailure(playFallbackAndClose)`), `src/fallback.ts:94-150` (`playFallbackAndCloseWith`), `src/bargein.ts:72-82` (barge-in guard + clear), `src/latency.ts:557-583` (`tool-call` line fields incl. `tool` name).

**Produces:**
- `docs/demo/ARCHITECTURE.md` (master plan §2 folder contract: deliverable at the `docs/demo/` root), satisfying Spec 06 A1 (diagrams parse; 13 node IDs; 6 participants; 3 `alt` blocks), A2 (no placeholders), A3 (every latency annotation traceable and reproducible). Consumed by DD2 (LAUNCH-CHECKLIST §1 gate 4).

## Steps

### 1. Precondition check (BLOCKED-halt gate)

- [ ] Confirm `docs/measurements/EXPERIMENTS.md` exists and contains an **E4 row with verdict PASS** and an **E6 row evaluated** (numbers stated; misses have a named follow-up or documented exception — Spec 05 R10/R12). Cross-check the demo ledger `docs/demo/plans/LEDGER.md` Current state shows M-C reached.
- [ ] From the E4 row's `measurement dir` column, resolve the E4 directory `docs/measurements/<YYYY-MM-DD>-<e4-label>/` and confirm it contains **`tools.jsonl`, `knowledge.jsonl`, `notes.md`** (Spec 05 R3/R8), with `notes.md` carrying the pasted aggregator output and the thinking-passthrough sentence (Spec 05 A6).
- [ ] Resolve the E6 population directory — `docs/measurements/<YYYY-MM-DD>-demo-baseline/` or, if a later PASS superseded the baseline (Spec 05 R1c), the last pre-freeze session directory named in the E6 ledger row — and confirm it contains **`turns.jsonl`, `tools.jsonl`, `notes.md`**.
- [ ] If ANY check above fails → STOP. Return `Status: BLOCKED` naming the missing file/row verbatim. Write nothing to the repo.

### 2. Read sources

- [ ] Read `docs/demo/specs/00-master-demo-plan.md` §3 (G-constraints), §4 (interface table), D12.
- [ ] Read `docs/demo/specs/06-docs-and-launch.md` R1–R7 and A1–A3 in full — R2's node table and R3's edge inventory are the verbatim content authority for the flowchart; this plan deliberately does not re-paste them.
- [ ] Read `docs/demo/RIO-INTELLIGENT-TOOLS-CONCEPT.md` §3 steps 1–8 (the sequence the R4 diagram walks).
- [ ] Read every code anchor listed under Interfaces → Consumes (the ranges only), plus `docs/measurements/README.md` ("Honest accounting" phrasing rule and the n<20 p95 caveat).

### 3. Compute the annotation numbers (before authoring — the numbers shape the labels)

- [ ] Knowledge-tool metrics (R5 items 3–4) from the **E4 directory**:
  - `node scripts/aggregate-latency.mjs --knowledge docs/measurements/<e4-dir>/knowledge.jsonl` → `knowledgeMs` p50/p95/max/n.
  - Split the E4 `tools.jsonl` by tool name (the `tool-call` line carries `tool` — `src/latency.ts:575`) into scratch files, e.g. in Git Bash:
    ```
    node -e "const fs=require('fs');const L=fs.readFileSync(process.argv[1],'utf8').split('\n').filter(Boolean);const p=l=>{try{return JSON.parse(l)}catch{return{}}};fs.writeFileSync(process.argv[2],L.filter(l=>p(l).tool==='ask_campus_knowledge').join('\n'));fs.writeFileSync(process.argv[3],L.filter(l=>p(l).event==='tool-call'&&p(l).tool!=='ask_campus_knowledge').join('\n'))" docs/measurements/<e4-dir>/tools.jsonl <scratch>/e4-knowledge-tools.jsonl <scratch>/e4-static-tools.jsonl
    ```
  - `node scripts/aggregate-latency.mjs --tools <scratch>/e4-knowledge-tools.jsonl` → knowledge `toolTotalMs`, `gateWaitMs`, `secondTtfbMs` p50/p95/max/n.
- [ ] Turn + static-tool metrics (R5 items 1–2, 5) from the **E6 directory**:
  - `node scripts/aggregate-latency.mjs docs/measurements/<e6-dir>/turns.jsonl` → `ttfbMs` p50/p95/max/n.
  - Split the E6 `tools.jsonl` with the same one-liner; `node scripts/aggregate-latency.mjs --tools <scratch>/e6-static-tools.jsonl` → static `toolTotalMs` (+ `gateWaitMs`/`secondTtfbMs`) p50/p95/max/n.
- [ ] Cross-check every computed number against the pasted aggregates in the two `notes.md` files — a mismatch means you aggregated the wrong files: stop and reconcile before authoring.
- [ ] Barge-in (R5 item 6): `grep -c '"event":"barge-in"' docs/measurements/<e4-dir>/*.jsonl docs/measurements/<e6-dir>/*.jsonl`. If no numeric barge-in cutoff data exists in the measured sessions, the barge-in annotation is **qualitative** (no number) — the only permitted unnumbered path annotation (Spec 06 R5.6). Do not pull a number from anywhere else.
- [ ] Record for the §3 table: whether knowledge `toolTotalMs` p50 meets the M3 gate `< 1500 ms` (Spec 06 R5.3 requires this stated explicitly), and `n` for every metric (if any n < 20, report `max` and `n` alongside p95 with the README caveat).

### 4. Author skeleton + flowchart (§1 of the doc)

- [ ] Create `docs/demo/ARCHITECTURE.md` with the R1 skeleton: purpose paragraph (audience; "every number is measured" with measurement dates and source paths), then §1 flowchart, §2 sequence diagram, §3 latency table, §4 failure paths. House citation style `[findings/NN §claim]` / `[file:line]` throughout.
- [ ] Author the flowchart in a ` ```mermaid ` fence per **Spec 06 R2** — exactly the 13 node IDs `caller, twilio, bridge, webhook, gw, rt, mcp, t1, fake, t2, flash, corpus, apology` with the R2 table's double-quoted labels verbatim (tighten wording only if every R2 fact survives). Subgraph placement per R2: `webhook` inside a `bridge` subgraph; `t1`+`t2` inside an `mcp` subgraph; `rt` and `flash` as separate consumers behind the single `gw` node.
- [ ] Add the 10 edges per **Spec 06 R3**, each label carrying that edge's required fact (R3 items 1–10 are the authority — including the envelope verbatim on edge 9 and the `playFallbackAndClose` failure edge 10). Add the R3 barge-in annotation on the `twilio ↔ bridge` edge or `bridge` node: clear + truncate on caller speech; tool-gap barge-in is a designed no-op `[src/bargein.ts:72-82; findings/16 §C7]`.
- [ ] Where an R3 edge carries a latency figure (edges 4–7), annotate it from Step 3's measured numbers in the R5 format `p50/p95 <n> ms (measured <YYYY-MM-DD>, docs/measurements/<dir>)` — never a design estimate.

### 5. Author the sequence diagram (§2 of the doc)

- [ ] One `sequenceDiagram` per **Spec 06 R4** with participants exactly `Caller`, `Twilio`, `Bridge`, `Gateway`, `MCP`, `FlashLite` — `Gateway` is one participant serving both models; annotate on each Gateway arrow which model it targets.
- [ ] Walk the knowledge round trip of `RIO-INTELLIGENT-TOOLS-CONCEPT.md` §3 steps 1–8 exactly as R4 sequences it: caller question → VAD end-of-speech → R1 response streams the preamble AND emits `function-call-arguments-done` → ToolLoop `runTool` → MCP handler → `generateObject` on flash-lite over the corpus → envelope → `function-call-output` via `conversation-item-create` → double gate releases exactly one `response-create` → R2 speaks the answer.
- [ ] Add the `note over` marking the preamble-masking window (tool time inside the preamble's spoken duration is free of caller-perceived dead air `[findings/16 §C6]`), annotated with the measured knowledge `toolTotalMs` p50 it must mask.
- [ ] Add exactly THREE `alt` failure blocks (content mirrors R7):
  1. **mint fail** — `pendingCall.gatewayAuth` rejects → `mint-failed` log → clean teardown, no gateway leg `[src/session.ts:381-385]`.
  2. **gateway death → apology clip** — `onGatewayFailure` seam → `playFallbackAndClose`: clear stale audio, play `assets/fallback-apology.ulaw`, wait for mark echo, close the Twilio WS (closing it ends the call) `[src/server.ts:142; src/fallback.ts:94-150]`.
  3. **tool timeout → spoken apology** — in-handler abort at `MCP_TOOL_TIMEOUT_MS` (3500) returns a `status:'error'` envelope under the 5000 ms transport cap; `runTool` never throws; the model apologizes verbally and the call continues `[src/tools.ts:39-55,:42; findings/16 §C11-C12]`.
- [ ] Annotate the sequence's timing marks from Step 3: `ttfbMs` p50 on the R1 leg, knowledge `toolTotalMs` + `knowledgeMs` p50/p95 on the tool leg, `gateWaitMs` + `secondTtfbMs` p50 on the gate/R2 legs — every one in the R5 sourced format.

### 6. Author §3 latency table + §4 failure prose

- [ ] §3 table: one row per annotation, columns metric / p50 / p95 / max / n / measured date / source path (`docs/measurements/<dir>`) / where-it-appears. Must contain the R5 minimum set items 1–5 (item 6 only if numeric data existed). The M3-gate statement for knowledge `toolTotalMs` (R5.3) goes here. The findings/15 §14 design estimates (0.7–1.2 s p50 etc.) may appear ONLY in a separate "design estimate" column beside the measured value — never as the annotation (Spec 06 R5 tail).
- [ ] Any turn-latency number reported as caller-perceived uses the mandatory honest-accounting phrasing from `docs/measurements/README.md` ("measured server-side turn core X ms; estimated caller-perceived ≈ X + ~500 ms (VAD window) + ~200–450 ms (PSTN/network legs, unmeasured)").
- [ ] §4 failure-path prose per **Spec 06 R7**: three subsections (mint failure / gateway death mid-call / tool timeout-failure), each trigger → mechanism → what the caller hears → log evidence, with R7's citations (`mint-failed`, `fallback-played` with `echoed`/`waitedMs`, the never-throws contract).

### 7. Claims-check against code (before any verify command)

- [ ] For EVERY `[file:line]` citation now in the doc, open the cited range and confirm the claim is literally true of the shipped code (the Interfaces list above was verified at plan-write time; re-verify — Waves DA–DC landed since). Fix the doc, never the code (G9).
- [ ] Verify diagram facts against the shipped build: `grep -n "registerTool" src/mcp-server.ts` shows exactly the six static tools + `ask_campus_knowledge` (t1/t2 labels); `grep -n "response_text" src/knowledge.ts` confirms the envelope; `grep -c "^## " assets/csub-corpus.md` confirms the 12-section claim and `ls -l assets/csub-corpus.md` the ~30–50 KB size claim in the `corpus` label; `grep -n "mcpModelId\|mcpModelMaxTokens\|mcpToolTimeoutMs" src/config.ts` confirms the three defaults cited in the `flash` label and §4.
- [ ] Confirm the doc's demo number is exactly `+1 (661) 490-9364` and any crisis number matches G3 byte-for-byte.

### 8. Verify — diagrams parse (Spec 06 A1)

- [ ] Extract each ` ```mermaid ` fence to a scratch file (`<scratch>/flow.mmd`, `<scratch>/seq.mmd`) and run:
  - `npx -y @mermaid-js/mermaid-cli -i <scratch>/flow.mmd -o <scratch>/flow.svg` → expect exit 0.
  - `npx -y @mermaid-js/mermaid-cli -i <scratch>/seq.mmd -o <scratch>/seq.svg` → expect exit 0.
  - (If mmdc cannot run in this environment, A1's alternative is confirming clean rendering in GitHub preview — record which evidence you used.)
- [ ] Node inventory: for each of the 13 IDs (`caller twilio bridge webhook gw rt mcp t1 fake t2 flash corpus apology`) confirm it appears as a node in the flowchart block, and that NO other node IDs exist. Participant inventory: the sequence block declares exactly `Caller`, `Twilio`, `Bridge`, `Gateway`, `MCP`, `FlashLite`; `grep -c "alt " <scratch>/seq.mmd` shows exactly 3 `alt` blocks.

### 9. Verify — no placeholders (Spec 06 A2 / R6, G13)

- [ ] `grep -nE 'TBD|TODO|XXX|~\?|\bN ms\b|\[[A-Z][A-Z /]+\]' docs/demo/ARCHITECTURE.md` → expect NO output. Any hit means a number is missing — go back to Step 1's blocking rule, never soften the annotation.

### 10. Verify — annotations traceable (Spec 06 A3)

- [ ] For every numeric latency in the doc: confirm it carries `(measured <YYYY-MM-DD>, docs/measurements/<dir>)` and re-run the exact Step 3 aggregator command for its source path — the printed p50/p95 must equal the doc's number. R5 items 1–5 all present.
- [ ] Confirm scratch files are outside the repo and `git status` shows exactly ONE new file: `docs/demo/ARCHITECTURE.md`.

### Verify tail (standard)

- [ ] `npx vitest run` → expect all tests passing, count = the demo ledger's recorded post-Wave-DB count (baseline 356 + demo additions, strictly > 356; master plan §8 R8.4). If the ONLY failures are KF-1's two `test/harness.test.ts` barge-in tests, run `npx vitest run test/harness.test.ts` → 13/13 in isolation = pass per master plan R8.2; note it in the report. Any other failure blocks — this task touched no code, so investigate for a dirty tree before suspecting the docs.
- [ ] `npx tsc --noEmit` → clean.
- [ ] Targeted verification for this task = Steps 8–10 above (mermaid parse ×2, inventory counts, placeholder grep empty, aggregator reproduction) — re-confirm all passed after any last edit.

### Commit

- [ ] Commit exactly one file with message:
  ```
  docs(demo): ARCHITECTURE.md — measured process-flow diagrams (Spec 06 R1-R7)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Acceptance

Discharges Spec 06 **A1, A2, A3** and requirements **R1–R7**. Leaves for DD2: LAUNCH-CHECKLIST gates, email finalization, send. If Step 1 blocked: nothing is discharged; report BLOCKED (the orchestrator re-dispatches after Spec 05's artifacts land).

## Completion Report

```
Task: DD1 — ARCHITECTURE.md (Spec 06 R1-R7)
Status: <complete | BLOCKED: exact missing E4/E6 artifact>
Files changed: docs/demo/ARCHITECTURE.md (only)
Measurement sources used: <e4-dir>, <e6-dir> (exact paths)
Commands run: <cmd → outcome, one line each — incl. both mmdc runs, placeholder grep, aggregator reproductions>
Spec 06 acceptance verified: A1 <p/f>, A2 <p/f>, A3 <p/f>
M3 gate statement (R5.3): <knowledge toolTotalMs p50 = X ms vs < 1500 ms — met/not met as stated in doc §3>
Deviations from plan: <none | list>
Notes for ledger: <≤3 lines>
```

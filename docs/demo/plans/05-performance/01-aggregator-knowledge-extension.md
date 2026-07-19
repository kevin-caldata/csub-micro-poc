# DA3 — Aggregator `--knowledge` mode + EXPERIMENTS.md ledger scaffold

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Extend `scripts/aggregate-latency.mjs` with a `--knowledge` aggregation mode for the demo build's `knowledgeMs` metric (Demo Spec 05 R4), document the new mode and the `knowledge.jsonl` export in `docs/measurements/README.md` (Spec 05 R3/R4), and create the empty experiment-ledger scaffold `docs/measurements/EXPERIMENTS.md` (Spec 05 R12 columns). This is Wave DA task **DA3** (master plan §6) — fully offline, no `src/` or `test/` changes.

**Global Constraints reference:** All Global Constraints in `docs/demo/specs/00-master-demo-plan.md` §G bind every step of this plan. Specifically load-bearing here:

- The knowledge log event name is **`knowledge-call`** — adjudicated by master plan **D2**; the string `knowledge-tool` must appear nowhere in the script (master plan A2: `grep -c "knowledge-tool" scripts/aggregate-latency.mjs` = 0).
- The script stays **plain Node ESM, zero dependencies, no imports from `src/`**, runnable by bare `node` — the constraints in its own header comment (`scripts/aggregate-latency.mjs:1-14`) are binding (Spec 05 R4, A1).
- **This task changes no `src/` file and no `test/` file** (Spec 05 A11; master plan G9). The vitest suite is untouched — the count stays at the 356 baseline.
- **G13 — no placeholders**: no `TBD`/`TODO`/bracket placeholders in EXPERIMENTS.md or the README edits. An empty ledger table body is correct (rows are runtime data added by Wave DC task DC1); a `TBD` cell is not.
- **G14 — exclusive file ownership**: this task's commit touches ONLY the three files declared below. `docs/measurements/EXPERIMENTS.md` is a declared addition to the DA3 file set (scaffold here; DC1 appends rows later); no other DA/DB task touches any of these files.

**Wave:** DA · **Depends on:** nothing (early-dispatch allowance, master plan §6) · **Blocks:** DC1 (all E1–E6 measurement sessions aggregate through this script and record verdicts in this ledger)

**References (read BEFORE writing anything):**
- `docs/demo/specs/00-master-demo-plan.md` — §3 (G7, G9, G13, G14), §4 log-events table (`knowledge-call` fields), §5 **D2**, §6 (DA3 row), A2
- `docs/demo/specs/05-performance-optimization.md` — **R3** (extraction: `@event:knowledge-call` → `knowledge.jsonl`), **R4** (the aggregator extension — every requirement bullet), **R12** (ledger row format), **A1** (the fixture smoke-run acceptance), R1/R1a/R1b/R1c and R11 (referenced by the EXPERIMENTS.md intro text)
- `scripts/aggregate-latency.mjs` — the whole file (157 lines): header constraints `:1-14`, `TURN_METRICS`/`TOOL_METRICS` `:26-27`, `usage()` `:29-33`, `parseArgs` `:35-50`, `wantEvent`/metric-list selection `:119-122`, `--tools` output branch `:128-131`
- `docs/measurements/README.md` — "Extraction procedure" step 1 list (`:24-31`) and "Aggregation" section (`:54-74`)

## Files

| Action | Path |
|---|---|
| Modify | `scripts/aggregate-latency.mjs` |
| Modify | `docs/measurements/README.md` |
| Create | `docs/measurements/EXPERIMENTS.md` |
| Temp (never committed) | `tmp-knowledge-fixture.jsonl` at repo root — created for the smoke run, deleted before commit |

No test file: the script has no vitest coverage (verified — no file under `test/` references it), and it must stay importable-by-nothing/zero-dep, so per Spec 05 A1 the verification is a fixture-JSONL smoke run with exact expected output (Steps 2, 5).

## Interfaces

**Consumes:**
- Event name `'knowledge-call'` and flat numeric field `knowledgeMs` on that line — master plan §4 log-events table + D2 (producer is Demo Spec 03's `askCampusKnowledge`; DA3 does not depend on it landing first — the fixture stands in).
- Existing script internals: `parseArgs` (`:35-50`), `wantEvent` selection (`:119`), metric-list selection (`:121-122`), `tableForMetrics`/`renderMarkdownTable`, the `--tools` output branch shape (`:128-131`).

**Produces (exact names — frozen in master plan §4 module table):**
- `KNOWLEDGE_METRICS = ['knowledgeMs']` (module-level `const` in `scripts/aggregate-latency.mjs`).
- `--knowledge` CLI flag: `wantEvent = 'knowledge-call'`, metric list `KNOWLEDGE_METRICS`, `--metric knowledgeMs` works through the same filtering path as existing modes; `--tools` and `--knowledge` mutually exclusive (usage + exit 1).
- Usage line (byte-exact, in both the `usage()` function and the header comment `:14`): `node scripts/aggregate-latency.mjs [--tools|--knowledge] [--metric <name>] <file.jsonl> [more.jsonl...]`
- `docs/measurements/EXPERIMENTS.md` — the R12 ledger DC1 writes rows into; the R3 `knowledge.jsonl` export documented in README.

## Steps

- [ ] **1. Read** every file in References. Confirm the script's four standing constraints from its header (`:1-14`): plain Node ESM; zero deps beyond `node:fs`/`node:process`; no imports from `src/`; pooled-raw-values only, never percentile-of-percentiles. Your changes must violate none of them.

- [ ] **2. Create the smoke fixture** (Write tool) at repo root `tmp-knowledge-fixture.jsonl` with exactly these six lines. This satisfies Spec 05 A1's minimum (three `knowledge-call` lines + one non-JSON line) and additionally proves event filtering (the `turn` and `tool-call` lines must be excluded in `--knowledge` mode):

  ```
  {"event":"knowledge-call","knowledgeMs":812.4}
  {"event":"knowledge-call","knowledgeMs":1103.9}
  {"event":"knowledge-call","knowledgeMs":2950.1}
  {"event":"tool-call","toolTotalMs":1200}
  {"event":"turn","ttfbMs":640.2,"bargedIn":false}
  not json
  ```

- [ ] **3. Run the failing baseline** (this is the "failing test" — the script has no unit-test harness by design):
  - `node scripts/aggregate-latency.mjs --knowledge tmp-knowledge-fixture.jsonl` → **expected failure:** `parseArgs` (`:39-48`) treats the unknown `--knowledge` as a file path, `readFileSync('--knowledge')` throws `ENOENT`, node prints the stack trace and exits nonzero.
  - `node scripts/aggregate-latency.mjs --tools --knowledge tmp-knowledge-fixture.jsonl` → currently the same `ENOENT` crash (record it — after implementation this exact invocation must instead print usage and exit 1).

- [ ] **4. Implement per Demo Spec 05 R4** — every bullet of R4 is the requirement text; the exact edits, by anchor:
  - After `TOOL_METRICS` (`:27`): add `const KNOWLEDGE_METRICS = ['knowledgeMs'];` (exact name and single-element list — master plan §4).
  - `parseArgs` (`:35-50`): recognize `--knowledge` as a boolean flag alongside `--tools`; return it.
  - `main()` before any file read: if both `tools` and `knowledge` are set → `usage()`, `process.exitCode = 1`, return (R4 bullet 2 — this must fire even before the empty-file-list check).
  - `wantEvent` (`:119`): three-way — `knowledge` → `'knowledge-call'` (exact string, D2), else `tools` → `'tool-call'`, else `'turn'`.
  - Metric list (`:121`): `knowledge` → `KNOWLEDGE_METRICS`, else as today. Leave the `--metric` filter line (`:122`) untouched — that IS the "same filtering path" R4 requires.
  - Output branch: `--knowledge` mirrors the `--tools` branch (`:128-131`) — single pooled table, no partitions (the three-partition block is turn-mode-only) — with heading `## knowledge-call metrics`.
  - Update the usage string in `usage()` (`:31`) AND the header-comment usage line (`:14`) to the byte-exact line in Interfaces above.
  - Add nothing else: no new imports, no new metrics, no partitions in knowledge mode, no changes to `pct`/`parseLines`/`tableForMetrics`.

- [ ] **5. Run the passing smoke suite** (all four, exact expected results):
  1. `node scripts/aggregate-latency.mjs --knowledge tmp-knowledge-fixture.jsonl` → exit 0, stdout exactly:

     ```
     Skipped: 1 non-JSON line(s).

     ## knowledge-call metrics

     | metric | p50 | p95 | max | n |
     | --- | --- | --- | --- | --- |
     | knowledgeMs | 1103.9 | 2950.1 | 2950.1 | 3 |
     ```

     (Nearest-rank over sorted `[812.4, 1103.9, 2950.1]`: p50 = 2nd value, p95 = 3rd; the `tool-call` and `turn` lines are filtered out, so n=3 not 5.)
  2. `node scripts/aggregate-latency.mjs --knowledge --metric knowledgeMs tmp-knowledge-fixture.jsonl` → same single-row table (A1's `--metric` check; with a bogus `--metric nope` the table has header only).
  3. `node scripts/aggregate-latency.mjs --tools --knowledge tmp-knowledge-fixture.jsonl` → usage line on stderr, no table, exit code 1 (verify: `echo $LASTEXITCODE` in PowerShell / `echo $?` in bash).
  4. Regression, both legacy modes unchanged: `node scripts/aggregate-latency.mjs --tools tmp-knowledge-fixture.jsonl` → `## tool-call metrics` table with `toolTotalMs … n=1` (other three tool metrics n=0, `—` values); `node scripts/aggregate-latency.mjs tmp-knowledge-fixture.jsonl` → the three turn partitions (`all turns`, `bargedIn:false`, `has-ttfbMs`) each showing `ttfbMs 640.2 … n=1`. `Skipped: 1` in both.

- [ ] **6. Update `docs/measurements/README.md`** per Spec 05 R4 (last bullet) + R3:
  - "Extraction procedure" step 1 list (`:24-31`): append one query line after the `anomalies.jsonl` line: `` - `@event:knowledge-call` → `knowledge.jsonl` (demo build — `ask_campus_knowledge` latency, Demo Spec 05 R3) ``.
  - "Aggregation" section (`:54-74`): replace the CLI-shape code block's usage line with the new byte-exact usage line; add `node scripts/aggregate-latency.mjs --knowledge docs/measurements/<dir>/knowledge.jsonl` to the commands code block; extend the `--metric` vocabulary sentence with `knowledgeMs` in `--knowledge` mode. State that `--tools` and `--knowledge` are mutually exclusive.
  - Touch nothing else in the README (the S33 checklist, query cookbook, and honest-accounting sections are out of scope).

- [ ] **7. Create `docs/measurements/EXPERIMENTS.md`** — the Spec 05 R12 ledger scaffold. Content (compose from the cited spec sections — do not invent policy):
  - Title `# EXPERIMENTS — CSUB-RIO Demo Performance Ledger` and one intro paragraph stating, with citations to Demo Spec 05: every experiment is written here BEFORE it runs with the five R1 parts (hypothesis / one-variable config change / measurement / pass gate / revert rule); one flipped variable at a time, gate FAIL → revert same day (R1c); ordering per R11 (R2 baseline first, E3 before E4, E4 PASS releases the email, freeze ends all flips); the configuration of record is derivable from this ledger alone (R12); subjective gates must name procedure and judge count (R1a); committed with each session's measurement directory within the 72 h deadline (R3).
  - The ledger table: exactly the R12 columns, header rows only, empty body. Header rows byte-exact:

    ```
    | date | experiment | variable=value | measurement dir | gate | result (numbers) | verdict | notes |
    | --- | --- | --- | --- | --- | --- | --- | --- |
    ```

  - One line under the table defining the verdict vocabulary: `PASS` / `FAIL+REVERTED` / `BLOCKED` (R12), and noting E3's row records the S8 answer and E1's row records the S1 answer (Spec 05 R12; both are ALSO recorded in the base S1–S35 answer table per master plan R2.3 — by DC1, not by this task).
  - No experiment rows, no `TBD` (G13). DC1 (Spec 05 R1–R3, R5–R12) writes all rows.

- [ ] **8. Delete `tmp-knowledge-fixture.jsonl`.** Run `git status` → exactly three changed/new paths: `scripts/aggregate-latency.mjs`, `docs/measurements/README.md`, `docs/measurements/EXPERIMENTS.md`.

- [ ] **9. Static gates** (master plan A2 + Spec 05 A1):
  - `grep -c "knowledge-tool" scripts/aggregate-latency.mjs` → `0`
  - `grep -n "knowledge-call" scripts/aggregate-latency.mjs` → at least one hit (the `wantEvent` value and the output heading)
  - `head -20 scripts/aggregate-latency.mjs` → the only import is still `node:fs`; usage comment shows `[--tools|--knowledge]`

- [ ] **10. Verify** (tail — see section below): `npx vitest run`, `npx tsc --noEmit`, and re-run smoke command 5.1 as the targeted check.

- [ ] **11. Commit** exactly:

  ```
  feat(measurements): aggregator --knowledge mode + EXPERIMENTS.md ledger scaffold

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Verify

- `npx vitest run` → **356 tests passing** (the pre-demo baseline, master plan §8 R8.1 — this task adds no tests and touches no `src/`; if other Wave DA tasks have already merged, expect their additions on top, never fewer). **KF-1 rule (master plan R8.2):** if the ONLY failures are the two `test/harness.test.ts` barge-in timing tests, re-run `npx vitest run test/harness.test.ts` — green in isolation = pass, note it in the completion report. Any other failure blocks.
- `npx tsc --noEmit` → clean (the `.mjs` script is outside the TS program; this proves the task regressed nothing).
- Targeted: `node scripts/aggregate-latency.mjs --knowledge tmp-knowledge-fixture.jsonl` reproduces the Step 5.1 table exactly (re-create the fixture if already deleted, delete again after).

## Acceptance

Discharges Demo Spec 05 **A1** in full, plus the R3/R4 documentation duties (README) and the R12 ledger's existence. Leaves for DC1: all experiment rows, all measurement sessions, S1/S8 answer recording. Leaves for the orchestrator: ledger update in `docs/demo/plans/LEDGER.md` (Wave DA table, DA3 row).

## Completion Report

```
Task: DA3 — aggregator --knowledge mode + EXPERIMENTS.md scaffold
Status: <complete | blocked: reason>
Files changed: <list — must be exactly the three declared files>
Commands run: <cmd → outcome, one line each, incl. all four Step 5 smoke runs with exit codes>
Spec 05 acceptance verified: A1 <p/f>; master plan A2 grep gates <p/f>
Vitest: <n passed / n failed; KF-1 isolation re-run result if invoked>
Deviations from plan: <none | list>
New interfaces exposed: KNOWLEDGE_METRICS, --knowledge flag, EXPERIMENTS.md ledger scaffold
Notes for ledger: <≤3 lines>
```

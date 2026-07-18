# T08.5 — Measurements home: extraction procedure, S33 checklist, query cookbook

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Create `docs/measurements/` with the R14 log-extraction procedure, the R15 Log Explorer verification checklist (S33), the query cookbook, and the R13 honest-accounting/calibration language the M5 report must reuse.

**Wave:** B · **Depends on:** T08.4 · **Blocks:** T09 (RUNBOOK cross-references), T10 (M5 procedure), M4/M5

**References:**
- `docs/specs/08-logging-and-latency-instrumentation.md` — R13 (mandatory report phrasing + calibration-call plan), R14 (extraction procedure — document VERBATIM, including the six query→file pairs, the directory naming rule, and the 72 h hard deadline), R15 (7-item checklist + query cookbook), R16 (script invocation to document), acceptance A10, A11
- `docs/findings/09-latency-instrumentation.md` — V3/V4 (filter syntax, 7-day retention), §9 (honest accounting decomposition), §10 (query list), gotchas 1, 12, 13
- `docs/specs/09-deployment-and-operations.md` — Deliverables list ONLY (RUNBOOK will point here; keep this README self-contained so T09 can link, not copy)
- `plans/08-logging-latency/04-aggregation-script.md` — Interfaces (exact CLI shape to document)

## Interfaces

**Consumes:** T08.4's `scripts/aggregate-latency.mjs` CLI (documented, not executed at runtime).

**Produces:**
- `docs/measurements/.gitkeep` — empty file so the directory exists in git (Spec 08 Deliverables)
- `docs/measurements/README.md` with these exact sections (later tasks/T09/T10 link to them by heading):
  1. `## Why this directory exists` — Railway Hobby 7-day retention; repo is the durable store, Railway is a cache (R14 preamble, gotcha 1)
  2. `## Extraction procedure` — R14 steps 1–3 verbatim: the six Log Explorer queries and their target filenames (`turns.jsonl`, `summaries.jsonl`, `tools.jsonl`, `greetings.jsonl`, `session-config.jsonl`, `anomalies.jsonl`); directory convention `docs/measurements/<YYYY-MM-DD>-<milestone-or-label>/` + `notes.md` contents (caller, call count, AUDIO_MODE, deploy SHA from `RAILWAY_GIT_COMMIT_SHA`, anomalies); target same-day, hard deadline 72 h; commit + push
  3. `## Aggregation` — the exact T08.4 commands (`node scripts/aggregate-latency.mjs docs/measurements/<dir>/turns.jsonl` and `--tools .../tools.jsonl`), plus the rule: cross-call percentiles come ONLY from this script over raw turn lines, never from averaging per-call p50s (R12/R14, gotcha 13)
  4. `## Log Explorer verification checklist (S33 — run on the FIRST deployed build)` — R15 items 1–7 as literal markdown checkboxes each with a `Date checked: ____` blank; note that no M2+ measurement session is valid before this is dated (A11), and the numeric-filter fallback (S33: if `@ttfbMs:>800` fails, export `@event:turn` and filter offline — R16 covers it)
  5. `## Query cookbook` — the seven queries from R15/findings-09 §10, one fenced code block
  6. `## Honest accounting & calibration` — the R13 mouth-to-ear decomposition block, the mandatory report phrasing sentence in bold quotes, the n<20 "p95 is effectively max" caveat (R12), and the 2–3 speakerphone calibration-call plan (R13) with where its results land (this directory + README findings section)
- No source-code changes; no `package.json` changes.

## Steps

- [ ] Read the References. This is a docs/build-verify task — no tests to write.
- [ ] Create `docs/measurements/.gitkeep` (empty).
- [ ] Write `docs/measurements/README.md` with the six sections above, transcribing R13–R16 content faithfully (quote the spec's queries, filenames, deadlines, and phrasing exactly — do not paraphrase numbers or query syntax).
- [ ] Verify content mechanically: `node -e "const s=require('fs').readFileSync('docs/measurements/README.md','utf8'); const need=['turns.jsonl','summaries.jsonl','tools.jsonl','greetings.jsonl','session-config.jsonl','anomalies.jsonl','@event:turn AND @ttfbMs:>800','@toolTotalMs:>1500','RAILWAY_GIT_COMMIT_SHA','72 h','aggregate-latency.mjs']; const miss=need.filter(x=>!s.includes(x)); if(miss.length){console.log('MISSING:',miss);process.exit(1)};console.log('ok')"` — expect `ok`.
- [ ] Verify the documented aggregation command actually runs: `node scripts/aggregate-latency.mjs scripts/fixtures/aggregate/turns.jsonl` — expect the markdown table (same outcome as T08.4's verify).
- [ ] Confirm the checklist section contains exactly 7 `- [ ]` items (R15) — count manually or via the node one-liner pattern above.
- [ ] Commit with message:
  `docs(measurements): extraction procedure, S33 checklist, query cookbook, honest-accounting language`
  plus the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges the docs half of Spec 08 **A10** (README with R14 procedure, R15 checklist, cookbook). **A11** is enabled here but executed later: the checklist gets dated on the first deployed build (T09/M1) — record this hand-off in the Completion Report. A1/A3 remain live-call checks at M1+ (T05/T10).

## Completion Report

```
Task: T08.5 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec A-numbers verified: [A10 docs half; A11 enabled, execution deferred to first deploy]
Deviations from plan: [none | list]
New interfaces exposed: docs/measurements/README.md section headings (linked by T09 RUNBOOK / T10 M5)
Notes for ledger: S33 checklist must be dated on first deployed build before any M2+ measurement counts
```
(keep under ~20 lines)

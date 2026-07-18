# T08.4 — Offline cross-call aggregation script (`scripts/aggregate-latency.mjs`)

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Ship the zero-dependency Node ESM script that aggregates exported `event:turn` / `event:tool-call` JSONL across calls into nearest-rank p50/p95/max/n markdown tables, never averaging per-call percentiles, plus committed fixtures proving it.

**Wave:** B · **Depends on:** T01 · **Blocks:** T10, M5 (and T09's RUNBOOK references it)

**References:**
- `docs/specs/08-logging-and-latency-instrumentation.md` — R16 (script contract), R12 (the `pct` nearest-rank algorithm — reimplement the same 5-line function inside the .mjs; the script must stay runnable by bare `node` with no TS import), R14 step 3 (invocation shape the docs promise), R11 (canonical `turn`/`tool-call` line examples — the fixture format), acceptance A10
- `docs/findings/09-latency-instrumentation.md` — §7 (nearest-rank + percentile-of-percentiles prohibition, gotcha 13), §5 (line shapes)
- `docs/specs/10-testing-spikes-and-milestones.md` — header "Offline cross-call percentile aggregation is Spec 08's `scripts/aggregate-latency.mjs`" + R25 (T10 wires the `"aggregate"` npm script LATER — do not edit `package.json` here)

## Interfaces

**Consumes:** nothing from other modules at runtime (plain `node`, zero deps, no imports from `src/`). Input format: JSONL lines shaped like Spec 08 R11's canonical `turn` and `tool-call` examples.

**Produces:**
- `scripts/aggregate-latency.mjs` — CLI: `node scripts/aggregate-latency.mjs [--tools] [--metric <name>] <file.jsonl> [more.jsonl...]`
  - Default mode: filters `event === 'turn'`; per metric (`ttfbMs`, `bridgeMs`, `turnMs`, `playbackConfirmMs`) computes nearest-rank p50/p95/max/n over the pooled raw per-turn values from ALL files; partitions reported as: all turns, `bargedIn:false` only, and turns-with-`ttfbMs` only (R16)
  - `--tools` mode: filters `event === 'tool-call'`; metrics `mcpMs`, `gateWaitMs`, `secondTtfbMs`, `toolTotalMs`
  - `--metric <name>`: restrict output to one metric
  - Tolerates non-JSON lines (skip + report skipped count); prints a markdown table to stdout ready to paste into the README; exits non-zero with a usage line when no file args
  - Structurally cannot average percentiles: it only ever reads per-turn metric fields, never `*P50`/`*P95` fields from `stream-stop` lines (guard: it filters those lines out by `event`)
- `scripts/fixtures/aggregate/turns.jsonl` — synthetic fixture: ≥2 distinct `callSid`s, ≥6 `turn` lines total, at least one `bargedIn:true` line and one line missing `ttfbMs`, hand-computable values
- `scripts/fixtures/aggregate/tools.jsonl` — ≥2 `tool-call` lines, plus one deliberately non-JSON garbage line
- `scripts/aggregate-latency.test.mjs` is NOT created — verification is by running the script on fixtures (this is a script deliverable, build-verify not TDD; T10 adds harness coverage later)

## Steps

- [ ] Read the References; copy the exact field names from Spec 08 R11's example `turn` and `tool-call` lines into the fixtures (do not invent field names).
- [ ] Write `scripts/fixtures/aggregate/turns.jsonl` and `scripts/fixtures/aggregate/tools.jsonl` with hand-computed expected p50/p95/max/n noted in a comment... JSONL cannot carry comments — record the expected numbers in the Completion Report and in the verify step below instead.
- [ ] Write `scripts/aggregate-latency.mjs` per Spec 08 R16 (plain ESM, zero imports beyond `node:fs`/`node:path`/`node:process`; embed the R12 `pct` function).
- [ ] Verify run 1: `node scripts/aggregate-latency.mjs scripts/fixtures/aggregate/turns.jsonl` — expect a markdown table whose p50/p95/max/n per metric match the hand-computed fixture values, with the `bargedIn:false` and `has-ttfbMs` partitions showing the correct reduced n.
- [ ] Verify run 2: `node scripts/aggregate-latency.mjs --tools scripts/fixtures/aggregate/tools.jsonl` — expect the four tool metrics and `skipped: 1` (the garbage line) reported.
- [ ] Verify run 3: `node scripts/aggregate-latency.mjs --metric ttfbMs scripts/fixtures/aggregate/turns.jsonl` — expect only the `ttfbMs` row.
- [ ] Verify run 4 (multi-file pooling): `node scripts/aggregate-latency.mjs scripts/fixtures/aggregate/turns.jsonl scripts/fixtures/aggregate/turns.jsonl` — expect n to double and p50 to stay identical (proves pooling of raw values, not averaging of per-file results).
- [ ] Verify run 5: `node scripts/aggregate-latency.mjs` (no args) — expect non-zero exit + usage line.
- [ ] Run `npm test && npm run typecheck` — expect PASS / exit 0 (script must not break the TS build; it lives outside `src/`).
- [ ] Commit with message:
  `feat(scripts): offline cross-call latency aggregation over exported turn JSONL`
  plus the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges the script half of Spec 08 **A10** (fixture run with ≥2 synthetic calls, correct cross-call p50/p95/max/n, structurally never percentile-of-percentiles). The `docs/measurements/README.md` half of A10 is T08.5.

## Completion Report

```
Task: T08.4 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec A-numbers verified: [A10 script half]
Deviations from plan: [none | list]
New interfaces exposed: scripts/aggregate-latency.mjs CLI (args: [--tools] [--metric <m>] <files...>)
Notes for ledger: expected fixture values [list them]; T10 wires the "aggregate" npm script
```
(keep under ~20 lines)

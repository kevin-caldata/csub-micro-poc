# T10.1 — Vitest scaffold, env-guard & test-runner consolidation

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Install exact-pinned vitest, create `vitest.config.ts` + the env-guard regression test, migrate every interim `node:test` suite under `test/` so `npm test` = `vitest run` is green repo-wide.

**Wave:** E · **Depends on:** T01, T02, T03, T04, T05, T06, T07, T08 · **Blocks:** T10.2, T10.3, T10.4, T10.5, T10.6, T10.7, T10.8

**References:**
- `docs/specs/10-testing-spikes-and-milestones.md` — §Deliverables, R1, R2, A1
- `docs/specs/00-master-build-plan.md` — §8 Risk register item **R-1** (test-runner consolidation is THIS task), §6 gap G6
- `docs/findings/01-vercel-ai-gateway-realtime.md` — gotcha 6 (getToken throws when `globalThis.window` is defined)
- `docs/findings/10-gap-analysis-and-contradictions.md` — G6 (jsdom trap)
- `docs/specs/01-scaffolding-and-toolchain.md` — R2 (`package.json` scripts block this task edits; interim `"test": "tsx --test ..."` is what gets replaced)

## Interfaces

**Consumes:**
- Existing interim suites written during Waves A–D (e.g. `src/config.test.ts`, `src/twilio-media.test.ts`, `src/dsp.test.ts`, `src/bargein.test.ts`, `src/teardown.test.ts` — inventory at run time with a glob over both `src/**/*.test.ts` and `test/**/*.test.ts`; some may already be vitest-style per risk R-1).
- `package.json` (T01's scripts block).

**Produces:**
- `vitest.config.ts` — default export per Spec 10 R1 snippet verbatim (`environment: 'node'`, `include: ['test/**/*.test.ts']`, `testTimeout: 15_000`).
- `test/env-guard.test.ts` — the R2 regression test verbatim.
- `package.json` — devDependency `vitest` exact-pinned; scripts `"test": "vitest run"`, `"probe:concurrency": "tsx scripts/concurrency-probe.ts"`, `"aggregate": "node scripts/aggregate-latency.mjs"` (script targets are created by T10.7 / already exist from T08 — adding the script lines now is the Spec 10 §Deliverables package.json edit, done once here).
- All pre-existing suites relocated/converted so they live under `test/**/*.test.ts` and import from `'vitest'` (notably `src/config.test.ts` → `test/config.test.ts`, mechanical port only — content extension is T10.2's job).
- README dependency table row recording the resolved vitest version (Spec 10 R1: no findings doc pins it).

## Steps

- [ ] Read the References. Inventory existing tests: run `npx tsx -e "console.log(1)"` to confirm tsx works, then list test files (Glob `src/**/*.test.ts` and `test/**/*.test.ts`) and note which use `node:test` imports vs `vitest`.
- [ ] Resolve the pin: `npm view vitest dist-tags.latest`. Install exactly that: `npm install -D --save-exact vitest@<version>`. Record the version in `README.md`'s dependency table (add the table row; create a `## Dependencies` note row only if the table exists per Spec 01 — otherwise append under the existing toolchain section).
- [ ] Write `vitest.config.ts` using the Spec 10 R1 snippet verbatim (do not add plugins, do not set `environment` to anything but `'node'`).
- [ ] Write `test/env-guard.test.ts` using the Spec 10 R2 snippet verbatim.
- [ ] Run `npx vitest run test/env-guard.test.ts` — expect PASS (1 test).
- [ ] Migrate interim suites: move `src/config.test.ts` to `test/config.test.ts`; for every suite using `node:test`/`node:assert`, convert imports and assertion calls to vitest (`describe/it/expect`) with zero behavioral change to what is asserted. Fix relative import paths after the move (imports of `src/` modules become `../src/<name>.js`).
- [ ] Update `package.json` scripts: `"test": "vitest run"`, add `"probe:concurrency"` and `"aggregate"` exactly as named in Interfaces. Remove the interim `tsx --test` script value.
- [ ] Run `npm test` — expect PASS, all suites, zero skips introduced by the migration. If a migrated suite fails, fix the migration (not the source module); if the failure reproduces a real source bug, report it in the Completion Report deviations instead of patching source.
- [ ] Grep gates: `test/` and `src/` contain no remaining `from 'node:test'` imports; `vitest.config.ts` contains no `jsdom`. Run `npm run typecheck` — expect PASS. (If `tsconfig.json` excludes `test/`, add `test` to `include` or rely on vitest's own transform — but `npm run typecheck` must stay green either way; note which route was taken.)
- [ ] Commit: `test(runner): consolidate suites onto exact-pinned vitest with node environment` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 10 **A1** (`npm test` runs vitest, `environment: 'node'`, env-guard exists and would fail under jsdom). Closes master-plan risk **R-1**.

## Completion Report

```
Task: T10.1 — Status: DONE | BLOCKED(<why>)
Files changed: <list>
Vitest version pinned: <x.y.z>
Commands run: npm test → <n passed>; npm run typecheck → <result>
Spec A-numbers verified: A1
Suites migrated (node:test → vitest): <list>
Deviations from plan: <none | list>
New interfaces exposed: vitest.config.ts include pattern test/**/*.test.ts; npm scripts test / probe:concurrency / aggregate
Notes for ledger: <1-2 lines>
```

# T09.1 — railway.json final-content & deploy-hygiene verification

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Verify (and fix if divergent) that `railway.json` matches Spec 09 R1 exactly and that the repo satisfies the Railpack deploy-hygiene constraints (R2), locking both in with an automated test.

**Wave:** D · **Depends on:** T01 · **Blocks:** T10 (M1 deploy)

**References:**
- `docs/specs/09-deployment-and-operations.md` — R1 (exact railway.json), R2.1–R2.5 (Railpack constraints), A1 (static half), A10 (repo half)
- `docs/specs/01-scaffolding-and-toolchain.md` — R2 (package.json scripts/engines), R7 (test runner: `node:test` via `tsx --test "src/**/*.test.ts"`, files live at `src/<name>.test.ts`), R10 (railway.json owner — this task verifies, never forks)
- `docs/findings/07-railway-deployment.md` — §1 (schema field types), §5 (Railpack build facts), gotchas 9/14

## Interfaces

**Consumes:**
- `railway.json` (repo root, created by T01 per Spec 01 R10)
- `package.json` (repo root, created by T01 per Spec 01 R2)

**Produces:**
- `src/railway-config.test.ts` — regression test locking Spec 09 R1/R2 repo-side invariants. No exported runtime symbols; later tasks rely only on the invariants it enforces.

## Steps

- [ ] Read `railway.json` and compare against the JSON block in Spec 09 R1. If any field differs (value, type, or missing `overlapSeconds`), edit `railway.json` to match R1 exactly — Spec 09 R1 is the authority and is declared identical to Spec 01 R10; record any divergence found in the Completion Report as a deviation.
- [ ] Write `src/railway-config.test.ts` using `node:test` + `node:assert/strict` (conventions per Spec 01 R7; import `node:fs` to read files — no relative imports needed). Assert, per Spec 09 R1/R2/A1/A10:
  - `railway.json` parses as JSON; `$schema` is `https://railway.com/railway.schema.json`; `build.builder === 'RAILPACK'`.
  - `deploy.startCommand === 'node dist/server.js'`, `deploy.healthcheckPath === '/health'`.
  - `deploy.healthcheckTimeout`, `deploy.overlapSeconds`, `deploy.drainingSeconds`, `deploy.restartPolicyMaxRetries` are all `typeof 'number'` with values 120 / 10 / 60 / 3 (findings/07 gotcha 14: strings are the documented trap).
  - `deploy.restartPolicyType === 'ON_FAILURE'`; `deploy.multiRegionConfig['us-east4-eqdc4a'].numReplicas === 1`.
  - No `Dockerfile` exists at the repo root (`fs.existsSync('Dockerfile') === false` — findings/07 gotcha 9).
  - `package.json`: `engines.node === '22.x'`; `scripts.build === 'tsc -p tsconfig.json'`; `scripts.start === 'node dist/server.js'`; `scripts.dev === 'tsx watch --env-file=.env src/server.ts'`; no `preinstall` and no `postinstall` key in `scripts` (Spec 09 R2.1/R2.4).
- [ ] Run `npm test` — expect the new test file to run and PASS (all other suites stay green). If it fails, fix `railway.json`/`package.json` per the spec references (never weaken an assertion) and re-run until PASS.
- [ ] Run `npm run typecheck` — expect exit 0.
- [ ] Commit all changes with message:
  `test(deploy): lock railway.json final content and Railpack hygiene invariants (Spec 09 R1-R2)`
  including trailer line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Spec 09 **A1** — static half: `railway.json` byte-equivalent to R1, numeric fields numeric. (The boot-log `region: us-east4-eqdc4a` half is verified live at M1 by T10 using the RUNBOOK from T09.5.)
- Spec 09 **A10** — repo half: no Dockerfile, no preinstall/postinstall. (The "no PORT variable / no watchPatterns on the Railway service" half is console-side, documented in T09.5's RUNBOOK.)

## Completion Report

```
Task: T09.1 — railway.json & deploy-hygiene verification
Status: <done | blocked: reason>
Files changed: <list>
Commands run: npm test → <PASS/FAIL summary>; npm run typecheck → <exit code>
Spec acceptance verified: 09-A1 (static), 09-A10 (repo)
Deviations from plan: <none | railway.json divergences found+fixed | other>
New interfaces exposed: none (test-only)
Ledger notes: <1-2 lines>
```

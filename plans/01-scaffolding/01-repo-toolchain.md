# T01.1 — Repo init, toolchain config files, pinned dependency install

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Initialize the git repo and create every non-`src/` scaffold file (`package.json`, `.npmrc`, `tsconfig.json`, `railway.json`, `.env.example`, `.gitignore`) with exact-pinned dependencies installed and `package-lock.json` committed.

**Wave:** A · **Depends on:** none · **Blocks:** T01.2, T01.3, T01.4 (and via T01.4: T02, T04, T06, T08)

**References:**
- `docs/specs/01-scaffolding-and-toolchain.md` — §Deliverables, R1, R2, R3, R6, R8, R9, R10, R13; Acceptance A1, A7, A9
- `docs/findings/07-railway-deployment.md` — claims 1, 5; Implementation §railway.json, §package.json (railway.json numeric fields; Railpack build flow; no Dockerfile/.nvmrc/preinstall)
- `docs/findings/10-gap-analysis-and-contradictions.md` — G1, G7, C13, C14, C17 (pin decisions)
- `docs/findings/05-mcp-sdk-streamable-http.md` — C2, C11 (MCP monopackage 1.29.0, zod 3.25.76, ignore `@cfworker/json-schema` peer warning)

## Interfaces

**Consumes:** nothing (first task of the project).

**Produces** (all repo-root relative; later tasks rely on these exact names):
- `package.json` — scripts `build`, `start`, `dev`, `test`, `typecheck` exactly as Spec 01 R2; dependencies pinned exact: `@ai-sdk/gateway@4.0.23`, `@fastify/formbody@8.0.2`, `@fastify/websocket@11.3.0`, `@modelcontextprotocol/sdk@1.29.0`, `fastify@5.10.0`, `twilio@6.0.2`, `ws@8.21.1`, `zod@3.25.76`
- `package-lock.json` (committed), `.npmrc` (`save-exact=true`)
- `tsconfig.json` — ESM/NodeNext per Spec 01 R6 (all later specs compile against it)
- `railway.json` — per Spec 01 R10 (Spec 09 finalizes; must already match)
- `.env.example` — per Spec 01 R8 (Spec 04 adds keys later, additive)
- `.gitignore` — per Spec 01 R9

## Steps

- [ ] Verify toolchain: run `node --version` — expect `v22.x`. If not 22.x, STOP and report (engines pin requires it).
- [ ] Verify the repo exists: `git rev-parse --abbrev-ref HEAD` — expect `main` (the repo was initialized during the planning phase with docs/ and plans/ already committed). Only if this fails, run `git init -b main`. Do not create a remote.
- [ ] Write `.npmrc` with the exact one-line content from Spec 01 R3. Must exist BEFORE any `npm install` so `save-exact` governs devDependency resolution.
- [ ] Write `.gitignore` with the exact content from Spec 01 R9.
- [ ] Write `.env.example` with the exact content from Spec 01 R8.
- [ ] Write `tsconfig.json` with the exact JSON from Spec 01 R6 (no additions, no omissions).
- [ ] Write `railway.json` with the exact JSON from Spec 01 R10. `overlapSeconds`, `drainingSeconds`, `healthcheckTimeout`, `restartPolicyMaxRetries`, `numReplicas` are JSON numbers, never strings.
- [ ] Write `package.json` with the exact content from Spec 01 R2 but OMIT the `devDependencies` block entirely (it is filled by the install step below; the `<resolved at install>` placeholders in the spec are not literal values).
- [ ] Run `npm install` — expect success; a peer warning about `@cfworker/json-schema` is expected and must be ignored (do NOT install it).
- [ ] Run `npm install -D typescript tsx @types/node @types/ws` — expect exact versions recorded in `package.json` (no carets) because of `.npmrc`.
- [ ] Verify pins: run `npm ls @modelcontextprotocol/sdk @ai-sdk/gateway fastify @fastify/websocket @fastify/formbody ws twilio zod` — expect exactly `1.29.0`, `4.0.23`, `5.10.0`, `11.3.0`, `8.0.2`, `8.21.1`, `6.0.2`, `3.25.76`.
- [ ] Verify `@types/node` is a 22.x line: run `npm ls @types/node` — expect `22.*`. If npm resolved a newer major, re-run `npm install -D @types/node@22` and re-verify.
- [ ] Verify forbidden packages absent from direct deps: open `package.json` and confirm no `dotenv`, `alawmulaw`, `openai`, `ai`, `@ai-sdk/react`, `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and no test framework (vitest/jest).
- [ ] Verify `railway.json` parses with numeric fields: run `node -e "const j=require('./railway.json');const d=j.deploy;const ok=typeof d.overlapSeconds==='number'&&typeof d.drainingSeconds==='number'&&typeof d.healthcheckTimeout==='number';if(ok){console.log('railway.json ok')}else{process.exit(1)}"` — expect `railway.json ok`, exit 0.
- [ ] Confirm no `Dockerfile` and no `.nvmrc` exist at repo root, and `package.json` has no `preinstall`/`postinstall` script (Spec 01 §Deliverables "Do NOT create").
- [ ] Verify ignore rules: run `git check-ignore .env` — expect exit 0 (path is ignored); run `git check-ignore package-lock.json` — expect non-zero exit (NOT ignored).
- [ ] Stage and commit everything created (including `package-lock.json` and `.npmrc`; `node_modules/` must not be staged) with message:
  `chore(scaffold): init repo with pinned toolchain, tsconfig, railway.json`
  followed by a blank line and `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 01 **A1** (install + pin check + forbidden-dep check), **A7** (railway.json numeric parse; no Dockerfile/.nvmrc/preinstall), **A9** (lockfile/.npmrc/.gitignore/.env.example committed; `.env` ignored). A7/A8/A9 are re-swept in T01.4.

## Completion Report

```
Task: T01.1 — Repo init & toolchain
Status: <complete | blocked (why)>
Files changed: <list>
Commands run: <command → outcome, one line each>
Spec A-numbers verified: A1, A7 (partial — no src yet), A9
Deviations from plan: <none | list>
New interfaces exposed: package.json scripts (build/start/dev/test/typecheck); pinned dep set; tsconfig NodeNext ESM
Notes for ledger: <resolved devDependency versions; anything unusual from npm>
```

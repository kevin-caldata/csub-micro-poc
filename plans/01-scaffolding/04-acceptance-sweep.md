# T01.4 — Spec 01 acceptance sweep: grep gates, dev-watcher check, full A1–A9 verification

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Run every Spec 01 acceptance criterion end-to-end (including the A8 grep gates and the A6 `npm run dev` behavior) so the orchestrator can open Wave B on a verified foundation.

**Wave:** A · **Depends on:** T01.1, T01.2, T01.3 · **Blocks:** T02, T04, T06, T08 (all of Wave B per master plan §4)

**References:**
- `docs/specs/01-scaffolding-and-toolchain.md` — Acceptance A1–A9 (the authority for every check below), R4 (dev env-file rules), R8 (`.env.example` content), §Deliverables "Do NOT create" list
- `docs/specs/00-master-build-plan.md` — §3 T01 Verify block (the orchestrator's acceptance command set — this task pre-runs it), §8 R-10 (why the grep/pin gates exist)
- `docs/findings/07-railway-deployment.md` — claim 5, gotcha 9 (Dockerfile/preinstall hazards)

## Interfaces

**Consumes:** everything produced by T01.1–T01.3 (`package.json` scripts, `src/config.ts`, `src/logger.ts`, `src/server.ts`, `railway.json`, `.env.example`).

**Produces:** no new modules. Produces the verified Wave-A baseline (a passing A1–A9 matrix) plus one commit. If any gate fails, this task fixes the offending file (staying within Spec 01's R-numbers) and re-runs the gate — it does not redesign anything.

## Steps

- [ ] Full pipeline: run `npm install && npm run build && npm run typecheck && npm test` — expect all four exit 0 (works verbatim in PowerShell 7 and POSIX shells).
- [ ] Pin gate (A1): run `npm ls @modelcontextprotocol/sdk @ai-sdk/gateway fastify @fastify/websocket @fastify/formbody ws twilio zod` — expect exactly `1.29.0`, `4.0.23`, `5.10.0`, `11.3.0`, `8.0.2`, `8.21.1`, `6.0.2`, `3.25.76`; confirm `package.json` direct deps contain no `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `dotenv`, `alawmulaw`, `openai`.
- [ ] Grep gate — no CommonJS (A8): run `git grep -n "require(" -- src` — expect no matches (exit code 1).
- [ ] Grep gate — extension-less relative imports (A8): run `git grep -nP "from '\.\.?/(?:[^']*(?<!\.js))'" -- src` — expect no matches (exit code 1). Git for Windows and Linux git both ship PCRE2; if `-P` is unavailable, run this equivalent check instead — expect `imports ok`, exit 0:
  `node -e "const fs=require('fs');const bad=[];for(const f of fs.readdirSync('src')){if(f.endsWith('.ts')){const m=fs.readFileSync('src/'+f,'utf8').match(/from '[.][.]?[/][^']*'/g)||[];for(const i of m){if(i.endsWith('.js' + String.fromCharCode(39))===false)bad.push(f+' '+i)}}}if(bad.length){console.error(bad.join('; '));process.exit(1)}console.log('imports ok')"`
  (rule: every relative `from './...'`/`from '../...'` specifier must end in `.js`.)
- [ ] Grep gate — banned imports (A8): run `git grep -n "alawmulaw" -- src` and `git grep -n "dotenv" -- src` — expect no matches from both (exit code 1 each).
- [ ] Structure gate (A7): confirm `railway.json` parses with numeric `overlapSeconds`/`drainingSeconds`/`healthcheckTimeout` (re-run the `node -e` check from plan T01.1); confirm no `Dockerfile`, no `.nvmrc` at repo root; confirm `package.json` has no `preinstall`/`postinstall` script.
- [ ] Dev-watcher negative case (A6): with NO `.env` file present at repo root, run `npm run dev` — expect Node's missing-env-file error and non-zero exit (R4 rule 1).
- [ ] Dev-watcher positive case (A6): copy `.env.example` to `.env`, fill dummy values (`AI_GATEWAY_API_KEY=x`, `TWILIO_AUTH_TOKEN=y`, `PUBLIC_HOST=localhost`; note R8's inline `#` comments sit on the same line — Node's `--env-file` treats them as comments, but if boot fails on a value like `PORT`, put values without trailing comments in `.env`), start `npm run dev` in the background, run `curl http://localhost:3000/health` — expect 200 `{"ok":true}` — then stop the watcher.
- [ ] Delete the local `.env` (it must never be committed); run `git check-ignore .env` — expect exit 0; run `git status --porcelain` — expect no `.env` entry either way (A9).
- [ ] Committed-files gate (A9): run `git ls-files .npmrc package-lock.json .gitignore .env.example railway.json tsconfig.json package.json` — expect all seven listed.
- [ ] Boot smoke re-run (A3/A4): repeat plan T01.3's boot smoke and both fail-fast cases once more from a clean shell — expect identical outcomes (200 health + single boot line; two non-zero fail-fast exits naming their variables).
- [ ] Commit (use `--allow-empty` if no files changed during the sweep) with message:
  `chore(scaffold): spec 01 acceptance sweep A1-A9 verified`
  followed by a blank line and `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 01 **A6** and **A8**; re-verifies **A1, A2, A3, A4, A5, A7, A9** as the Wave A → Wave B gate (master plan §3 T01 Verify).

## Completion Report

```
Task: T01.4 — Acceptance sweep
Status: <complete | blocked (why)>
Files changed: <none expected | list fixes made>
Commands run: <command → outcome, one line each>
Spec A-numbers verified: A1–A9 (full matrix; note any that needed a fix first)
Deviations from plan: <none | list>
New interfaces exposed: none (baseline verified for Wave B: loadConfig/AppConfig, logEvent boundary, npm scripts)
Notes for ledger: <resolved devDep versions; env-file comment handling observed in A6; anything Wave B agents must know>
```

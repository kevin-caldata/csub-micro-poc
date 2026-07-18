# T09.4 — `scripts/check-credits.ts` cost-tracking helper

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Ship the standalone gateway-spend script that prints `{balance, totalUsed}` from `gateway.getCredits()` with a timestamp, runnable before/after every milestone test batch.

**Wave:** D · **Depends on:** T01 · **Blocks:** T09.5, T10 (M5 cost accounting / A8)

**References:**
- `docs/specs/09-deployment-and-operations.md` — R10.1 (procedure: `/v1/report` is 403 on Hobby, credits-delta is the plan-proof), R10.2 (script contract), R3.4 (missing-key OIDC trap), A8
- `docs/findings/01-vercel-ai-gateway-realtime.md` — §detail 11 (`gateway.getCredits()` → `{balance, totalUsed}` USD strings), gotcha 14 (`/v1/report` 403 on Hobby), gotcha 5 (missing `AI_GATEWAY_API_KEY` → confusing OIDC error)
- `docs/specs/01-scaffolding-and-toolchain.md` — R2 (`@ai-sdk/gateway` pinned `4.0.23` already in dependencies), R1 (ESM, `.js` extensions — N/A here beyond style)

## Interfaces

**Consumes:** `{ gateway }` export of the installed `@ai-sdk/gateway@4.0.23` package (T01 pin). Nothing from project `src/` — the script must NOT import `src/config.ts` (config fail-fast requires `PUBLIC_HOST`/`TWILIO_AUTH_TOKEN`, which this standalone script does not need).

**Produces:**
- `scripts/check-credits.ts` — standalone; invocation contract used by RUNBOOK (T09.5) and milestones (T10): `npx tsx --env-file=.env scripts/check-credits.ts` → one JSON line to stdout: `{"timestamp":"<ISO-8601>","balance":"<usd string>","totalUsed":"<usd string>"}`.

## Steps

- [ ] Write `scripts/check-credits.ts` per Spec 09 R10.2:
  - Guard first: if `process.env.AI_GATEWAY_API_KEY` is unset/empty, print a one-line error to stderr naming `AI_GATEWAY_API_KEY` and mentioning that the SDK would otherwise fall back to Vercel OIDC with a misleading error (R3.4; findings/01 gotcha 5), then `process.exit(1)` — before any SDK call.
  - Otherwise: `import { gateway } from '@ai-sdk/gateway';` → `await gateway.getCredits()` → print exactly one minified JSON line to stdout with `timestamp` (`new Date().toISOString()`), `balance`, `totalUsed` (pass the SDK's USD-string values through untouched).
  - Wrap the call: on rejection, print the error message to stderr and exit non-zero (never a raw stack-only crash).
- [ ] Verify the guard path (offline, deterministic): run `npx tsx scripts/check-credits.ts` **without** `--env-file` in a shell where `AI_GATEWAY_API_KEY` is not set — expect exit code 1 and a stderr line containing `AI_GATEWAY_API_KEY`. (Windows PowerShell: check `$LASTEXITCODE`; Linux: `echo $?`.)
- [ ] Verify the live path IF a populated `.env` exists in the repo root: run `npx tsx --env-file=.env scripts/check-credits.ts` — expect exit 0 and one JSON line with non-empty `balance`/`totalUsed`. If no `.env` with a real key exists, record "live run deferred to M1 (RUNBOOK cost procedure)" in the Completion Report — this is the expected build-time outcome, not a failure.
- [ ] Confirm `npm run typecheck` and `npm run build` still exit 0 (if `tsconfig.json` `include` covers only `src/`, the script is type-checked by tsx at run time — acceptable per Spec 01 R6 note; do NOT widen the tsconfig include, which would put scripts into `dist/`).
- [ ] Commit with message:
  `feat(ops): check-credits gateway spend script (Spec 09 R10.2)`
  including trailer line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Spec 09 **A8** — script half: `scripts/check-credits.ts` prints `{balance, totalUsed}` from live `/v1/credits` when a key is present and fails fast with a named-variable error when not. (The recorded before/after credits-deltas, S30–S32 dashboard notes, and S27 Railway usage are milestone-time procedures owned by T09.5's RUNBOOK + T10.)

## Completion Report

```
Task: T09.4 — check-credits script
Status: <done | blocked: reason>
Files changed: <list>
Commands run: guard-path run → <exit 1, stderr names AI_GATEWAY_API_KEY>; live run → <output | deferred to M1>; npm run typecheck/build → <exits>
Spec acceptance verified: 09-A8 (script half)
Deviations from plan: <none | ...>
New interfaces exposed: npx tsx --env-file=.env scripts/check-credits.ts → {"timestamp","balance","totalUsed"} JSON line
Ledger notes: <1-2 lines>
```

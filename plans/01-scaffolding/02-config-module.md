# T01.2 — Zod fail-fast config module (`src/config.ts`) via TDD

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Implement `src/config.ts` (`loadConfig` + `AppConfig`) exactly per Spec 01 R5, proven by the `node:test` suite in `src/config.test.ts` per Spec 01 R7, including the G6 no-jsdom environment guard.

**Wave:** A · **Depends on:** T01.1 · **Blocks:** T01.3, T01.4

**References:**
- `docs/specs/01-scaffolding-and-toolchain.md` — R1 (ESM `.js` extensions), R4 (env-loading rules — tests never load `.env`), R5 (exact `config.ts` content + 6 module requirements), R7 (test-runner decision + exact `config.test.ts` content), Acceptance A5
- `docs/findings/10-gap-analysis-and-contradictions.md` — G2 (env loading), G6 (node-env testing, jsdom forbidden)
- `docs/findings/01-vercel-ai-gateway-realtime.md` — claim 14, gotchas 5, 6 (OIDC fallback trap message; `getToken` throws under `globalThis.window`)

## Interfaces

**Consumes:** T01.1's `package.json` scripts (`npm test` = `tsx --test "src/**/*.test.ts"`), tsconfig NodeNext, `zod@3.25.76`.

**Produces** (relied on by T01.3, T02, T03, T04, T05, T06, T08 — every spec reads config through this surface):
- `src/config.ts` exporting:
  - `export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig` — pure, no side effects at import time, throws `Error` with per-issue message lines on invalid env
  - `export interface AppConfig { aiGatewayApiKey: string; twilioAuthToken: string; port: number; publicHost: string; modelId: string; audioMode: 'pcmu' | 'transcode'; voice: string }`
- `src/config.test.ts` — the R7 suite + environment-guard case

Note for later waves (do not implement here): T03/T04 make ADDITIVE edits to this file's `EnvSchema`/`AppConfig` (e.g. `TWILIO_VALIDATE_UPGRADE`, gateway R2 keys). Keep the module a single schema + single `loadConfig` so additive edits stay trivial.

## Steps

- [ ] Write `src/config.test.ts` with the exact test content from Spec 01 R7, plus ONE additional test case required by A5 (this skeleton exists nowhere in the spec verbatim, hence inlined):
  ```ts
  it('runs in a plain Node environment (G6: no jsdom window)', () => {
    assert.equal((globalThis as Record<string, unknown>).window, undefined);
  });
  ```
  All relative imports use explicit `.js` extensions (`./config.js`) per R1.
- [ ] Run `npm test` — expect FAIL (cannot resolve `./config.js`: module not yet written).
- [ ] Write `src/config.ts` with the exact content from Spec 01 R5. Do not add extra exports, defaults, or env keys beyond R5.
- [ ] Run `npm test` — expect PASS: all 6 R7 cases plus the environment-guard case, run by `tsx --test` in a plain Node process with an empty/arbitrary ambient environment (tests pass fixture objects explicitly; per R4 rule 3 they must not depend on a `.env` file).
- [ ] Sanity-check the fail-fast messages: confirm the missing-key test failure text surfaced by zod names `AI_GATEWAY_API_KEY` and mentions the OIDC fallback (R5 schema message), and the missing-host error names both `PUBLIC_HOST` and `RAILWAY_PUBLIC_DOMAIN` (these regexes are already asserted in the R7 tests — just confirm they ran).
- [ ] Commit `src/config.ts` and `src/config.test.ts` with message:
  `feat(config): zod fail-fast env validation with node:test suite`
  followed by a blank line and `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 01 **A5** (full R7 suite green under `tsx --test`, with the `globalThis.window === undefined` guard). Contributes the `loadConfig` half of A4 (exercised end-to-end in T01.3).

## Completion Report

```
Task: T01.2 — Config module
Status: <complete | blocked (why)>
Files changed: src/config.ts, src/config.test.ts
Commands run: <command → outcome, one line each; include failing-first npm test run>
Spec A-numbers verified: A5
Deviations from plan: <none | list>
New interfaces exposed: loadConfig(env?) → AppConfig; AppConfig fields (aiGatewayApiKey, twilioAuthToken, port, publicHost, modelId, audioMode, voice)
Notes for ledger: <anything unusual>
```

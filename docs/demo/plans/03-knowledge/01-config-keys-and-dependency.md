# DB1.1 — MCP knowledge env keys in `config.ts` + `.env.example` + exact-pin `ai@7.0.31`

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Add the three Demo Spec 03 env keys (`MCP_MODEL_ID`, `MCP_MODEL_MAX_TOKENS`, `MCP_TOOL_TIMEOUT_MS`) to `src/config.ts` and `.env.example` as strictly additive edits, and add the single new dependency `ai@7.0.31` (exact pin, lockfile-verified), so the later `03-knowledge` tasks can build `src/knowledge.ts` against `AppConfig.mcpModelId` / `mcpModelMaxTokens` / `mcpToolTimeoutMs` and `import { generateObject } from 'ai'`.

All Global Constraints in `docs/demo/specs/00-master-demo-plan.md` §G bind every step of this plan. Restated where they bite here:

- **G1 (exact-pin):** this is the ONLY demo task that touches `package.json`/`package-lock.json`. It adds exactly one package, `"ai": "7.0.31"`, and the lockfile must still pin `@ai-sdk/gateway@4.0.23`, `@ai-sdk/provider@4.0.3`, `@ai-sdk/provider-utils@5.0.11` unchanged — zero new transitive deps (verify step below).
- **G2 (single model, NO fallback):** add NO fallback-model key. No `MCP_FALLBACK*`, no `FALLBACK_MODEL*`, no model list, no `providerOptions.gateway.models` anywhere in `src/`. Spec 03 R3 explicitly rejects findings/15 claim 25's fallback-chain recommendation; reintroducing it is a design change requiring the human.
- **G14 (exclusive file ownership):** touch only the files declared below. In particular do NOT touch `src/knowledge.ts`, `src/mcp-server.ts`, `src/server.ts`, or `test/gateway.session-config.test.ts` — those belong to later tasks (the G4 preamble assertions at `test/gateway.session-config.test.ts:100-102` and `:124-128` must appear unmodified in this wave's diff audit).

**Wave:** DB — but early dispatch during any idle Wave DA slot is sanctioned (README §2 early-dispatch allowance / demo-ledger Depends-on: this task's file set is disjoint from every DA task; only DB1.2 hard-requires M-A) · **Spec:** Demo Spec 03 (`docs/demo/specs/03-knowledge-tool-and-model-config.md`) R1–R5, A1–A4 · **Blocks:** every later `docs/demo/plans/03-knowledge/*` task (knowledge module, registration, config threading).

**References (read before coding):**
- `docs/demo/specs/00-master-demo-plan.md` — §3 (G1, G2, G14), §4 "Env keys and config" table (the canonical defaults/constraints), §8 (test rules, KF-1)
- `docs/demo/specs/03-knowledge-tool-and-model-config.md` — R1 (the three `EnvSchema` lines, verbatim, with the transport-cap comment), R2 (the three `AppConfig` fields, exact spelling), R3 (no-fallback rationale), R4 (the three `.env.example` lines, verbatim), R5 (dependency facts), A1–A4
- `src/config.ts` — existing `EnvSchema` (`:3-37`), `AppConfig` (`:39-61`), `loadConfig` return object (`:89-108`); the coercion pattern to follow is `PORT` at `src/config.ts:12` (`z.coerce.number().int().positive()`)
- `test/config.test.ts` — the suite you are extending; its `BASE` fixture (`:4-8`) and `/Invalid environment configuration/` throw pattern
- `test/config.gateway.test.ts` — the house pattern for a spec-scoped `describe` block of config additions (defaults test + coercion test + rejection tests); model the new block on it

## Files

- **Create:** none.
- **Modify:** `src/config.ts` (additive: 3 `EnvSchema` keys, 3 `AppConfig` fields, 3 return-object lines), `.env.example` (append 3 lines to the Tunables block), `package.json` + `package-lock.json` (via `npm install --save-exact ai@7.0.31` only — never hand-edit), `test/config.test.ts` (append one new `describe` block; existing tests unmodified per Spec 03 R2).
- **Test:** `test/config.test.ts` (targeted command: `npx vitest run test/config.test.ts`).

## Interfaces

**Consumes:**
- `loadConfig(env?: NodeJS.ProcessEnv): AppConfig` and `interface AppConfig` from `src/config.ts` — extend additively, never reorder or touch existing keys (`zod@3.25.76` stays; `@modelcontextprotocol/sdk` stays `1.29.0`).
- Current lockfile pins (pre-state to preserve): `@ai-sdk/gateway@4.0.23` (`package-lock.json:31-32`), `@ai-sdk/provider@4.0.3` (`:48-49`), `@ai-sdk/provider-utils@5.0.11` (`:60-61`).

**Produces** (exact names from master plan §4 — later `03-knowledge` tasks and Specs 05/06 depend on them):

| Env var | `AppConfig` field | Type | Default | Constraint |
|---|---|---|---|---|
| `MCP_MODEL_ID` | `mcpModelId` | `string` | `'google/gemini-3.1-flash-lite'` | `z.string().min(1)` |
| `MCP_MODEL_MAX_TOKENS` | `mcpModelMaxTokens` | `number` (int) | `150` | positive |
| `MCP_TOOL_TIMEOUT_MS` | `mcpToolTimeoutMs` | `number` (int) | `3500` | positive, `.lt(5000)` |

- Dependency: `"ai": "7.0.31"` exact-pinned in `package.json` dependencies (the `generateObject` import for the later `src/knowledge.ts` task; that later task is the ONLY module allowed to import from `'ai'` — this task imports nothing from it in `src/`).

## Steps

- [ ] Read the References. Confirm `src/config.ts` currently ends `EnvSchema` at `GATEWAY_WS_URL` (`src/config.ts:36`), `AppConfig` at `gatewayWsUrl` (`:60`), and the return object at `gatewayWsUrl: e.GATEWAY_WS_URL` (`:107`) — the three new entries append at the END of each of those blocks (additive rule, same as base T04.1).
- [ ] Write failing tests: append ONE new `describe('loadConfig — Demo Spec 03 MCP knowledge keys', ...)` block at the end of `test/config.test.ts`, reusing the file's existing `BASE` fixture (`test/config.test.ts:4-8`), modeled on `test/config.gateway.test.ts`'s block structure. Exact cases (they discharge Spec 03 A1/A2):
  - `'applies the three MCP defaults when unset'` — `loadConfig({ ...BASE })` yields `mcpModelId === 'google/gemini-3.1-flash-lite'`, `mcpModelMaxTokens === 150`, `mcpToolTimeoutMs === 3500` (A1).
  - `'coerces MCP numeric strings and accepts the 4999 boundary'` — `MCP_MODEL_MAX_TOKENS: '200'` → `200` (typeof number); `MCP_TOOL_TIMEOUT_MS: '4999'` → `4999` (A2 boundary success).
  - `'rejects MCP_TOOL_TIMEOUT_MS at the transport cap with the cap message'` — `MCP_TOOL_TIMEOUT_MS: '5000'` → `loadConfig` throws matching `/runTool transport cap/` (A2).
  - `'rejects non-positive and non-integer MCP_TOOL_TIMEOUT_MS'` — `'0'`, `'-1'`, `'1.5'` each throw `/Invalid environment configuration/` (A2).
  - `'rejects MCP_MODEL_MAX_TOKENS=0'` — throws `/Invalid environment configuration/` (A2).
  - `'rejects an empty MCP_MODEL_ID'` — `MCP_MODEL_ID: ''` throws `/Invalid environment configuration/` (A2).
- [ ] Run `npx vitest run test/config.test.ts` — expect FAIL: the six new tests fail (`mcpModelId` etc. are `undefined`; the rejection cases do not throw). All pre-existing tests in the file still pass.
- [ ] Implement in `src/config.ts` per Demo Spec 03 R1/R2 — the three `EnvSchema` lines (including the `── Demo Spec 03 ──` section comment and the transport-cap comment above `MCP_TOOL_TIMEOUT_MS`) are specified in R1 **verbatim**; copy them exactly, appended after `GATEWAY_WS_URL` inside `EnvSchema`. The one magic string an implementer could get wrong is the `.lt` message — it is exactly: `MCP_TOOL_TIMEOUT_MS must be < 5000 (runTool transport cap, src/tools.ts:42)`. Then append the three `AppConfig` fields in R2's exact spelling (`mcpModelId`, `mcpModelMaxTokens`, `mcpToolTimeoutMs`) after `gatewayWsUrl`, and the three return-object lines (`mcpModelId: e.MCP_MODEL_ID,` etc.) after `gatewayWsUrl: e.GATEWAY_WS_URL,`. No other line of `src/config.ts` changes.
- [ ] Run `npx vitest run test/config.test.ts` — expect PASS (all tests in the file, existing + 6 new).
- [ ] Append the three Demo Spec 03 R4 lines to the `# ── Tunables ... ──` block at the end of `.env.example`, byte-for-byte:

  ```
  MCP_MODEL_ID=google/gemini-3.1-flash-lite  # knowledge-tool text model via the same AI Gateway; SINGLE model, NO fallback (demo spec 03 R3)
  MCP_MODEL_MAX_TOKENS=150                   # knowledge answer cap; output length dominates flash-lite latency
  MCP_TOOL_TIMEOUT_MS=3500                   # in-handler abort budget; MUST be < 5000 (runTool transport cap, src/tools.ts:42)
  ```

  Do not add any fallback-model line (G2).
- [ ] Run `npx tsc --noEmit` — expect exit 0.
- [ ] Commit: `feat(config): add MCP knowledge env keys per demo spec 03 R1-R4` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Diff audit before committing: `git diff --stat` shows only `src/config.ts`, `.env.example`, `test/config.test.ts`; the `src/config.ts` diff is append-only inside the three blocks.
- [ ] Install the dependency: `npm install --save-exact ai@7.0.31` (requires registry access). Never hand-edit either JSON file.
- [ ] **G1 lockfile verify (blocking):**
  - `package.json` dependencies now contain exactly one new entry, `"ai": "7.0.31"`; no other dependency line changed (`git diff package.json`).
  - `package-lock.json` still pins `@ai-sdk/gateway` at `4.0.23`, `@ai-sdk/provider` at `4.0.3`, `@ai-sdk/provider-utils` at `5.0.11` (grep the three `"node_modules/@ai-sdk/..."` blocks — pre-state was `package-lock.json:31-32`, `:48-49`, `:60-61`), and the diff adds only the `ai` entries (root dep + one `node_modules/ai` block) — zero new transitive dependencies, no dedupe churn (Spec 03 R5; findings/15 claim 5; findings/16 C9).
  - Import smoke check (no network, no test file): `node -e "import('ai').then(m => process.exit(typeof m.generateObject === 'function' ? 0 : 1))"` — expect exit 0 (pure-ESM/NodeNext sanity per Spec 03 R5).
  - If ANY pin moved or extra packages appeared: `git checkout -- package.json package-lock.json && npm install`, do NOT commit, and return BLOCKED citing G1 — resolving version drift is a human decision, not an implementer fix.
- [ ] **G2 grep gate:** `grep -rE 'FALLBACK_MODEL|MCP_FALLBACK|gateway.*models\s*:' src/` → no matches (Spec 03 A3). Also confirm `EnvSchema` gained exactly the three keys and nothing else.
- [ ] Run `npx tsc --noEmit` — expect exit 0 (unchanged by the install, proves node_modules is coherent).
- [ ] Commit: `feat(deps): exact-pin ai@7.0.31, lockfile pins verified per demo spec 03 R5` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. This commit touches only `package.json` + `package-lock.json`.

## Verify

- [ ] `npx vitest run` — full suite green: zero non-KF-1 failures, zero skips introduced. Expected count: the Wave-DA-end total recorded in `docs/demo/plans/LEDGER.md` **plus 6** (strictly > the 356 pre-demo baseline — master plan §8.4). If the run fails ONLY on the two `test/harness.test.ts` barge-in tests, apply the KF-1 rule (master plan §8.2): `npx vitest run test/harness.test.ts` — green in isolation = pass, note it in the completion report; any other failure blocks.
- [ ] `npx tsc --noEmit` — exit 0.
- [ ] Targeted: `npx vitest run test/config.test.ts` — all pass, including the six new Demo Spec 03 tests.
- [ ] Spot checks: `git log --oneline -2` shows the two commits above touching only the declared files; existing `test/config.test.ts` describe blocks are byte-unchanged (Spec 03 R2: "existing config tests must pass unmodified").

## Completion Report

```
Task: DB1.1 (03-knowledge/01-config-keys-and-dependency) — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec 03 items verified: R1, R2, R4 (config); R5 + G1 lockfile pins (dependency); A1, A2 (tests); A3 grep clean; A4 (pin + typecheck)
Full-suite count: [N passed] (KF-1 invoked: yes/no)
Deviations from plan: [none | list]
New interfaces exposed: AppConfig.{mcpModelId,mcpModelMaxTokens,mcpToolTimeoutMs}; env MCP_MODEL_ID/MCP_MODEL_MAX_TOKENS/MCP_TOOL_TIMEOUT_MS; dep ai@7.0.31
Notes for ledger: [anything notable, else "clean"]
```

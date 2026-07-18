# T04.2 — Token mint: `mintRealtimeToken` + `GatewayMintError`

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Create `src/gateway.ts` with the factory-form token mint (`gateway.experimental_realtime.getToken`), typed `MintResult`, and `GatewayMintError` classification, fully unit-tested against a stubbed factory.

**Wave:** B · **Depends on:** T01, T04.1 · **Blocks:** T04.3; Spec 02→04 mint delegation at the Wave B/C boundary (master plan §3 T02 note)

**References:**
- `docs/specs/04-gateway-realtime-leg.md` — §R1 (imports/pins), §R3 (mint: verbatim signature intent, error classes, classification rules, log lines), §A1, §A11, §A13
- `docs/findings/01-vercel-ai-gateway-realtime.md` — §Implementation-grade detail 1 (correct connection sequence — authoritative over findings/02's ternary, per findings/10 T1), §2 (mint endpoint), §9 (error taxonomy table — drives the parameterized test)
- `docs/specs/01-scaffolding-and-toolchain.md` — §R12 (`logEvent` boundary: the ONLY logging import allowed until Spec 08 lands), §R7 (test harness), §R1 (ESM `.js` extensions)
- `docs/findings/09-latency-instrumentation.md` — §3 (why `getTokenMs` is logged per call)

## Interfaces

**Consumes:**
- `AppConfig` incl. T04.1 fields `tokenTtlSeconds`, plus Spec 01's `modelId` — from `src/config.ts` (`loadConfig`)
- `logEvent(fields: LogFields)` from `src/logger.ts` (Spec 01 R12 stub)
- `gateway`, `GatewayError` + the seven `Gateway*Error` classes from `@ai-sdk/gateway@4.0.23`

**Produces** (in NEW file `src/gateway.ts`):
- `export interface MintResult { token: string; url: string; expiresAt?: number; getTokenMs: number }` — verbatim from Spec 04 R3
- `export class GatewayMintError extends Error` — fields `errorType`, `statusCode`, `getTokenMs` verbatim from Spec 04 R3
- `export async function mintRealtimeToken(cfg: AppConfig, callSid: string, modelId?: string): Promise<MintResult>` — **signature amendment (record as deviation-by-design):** Spec 04's snippet reads `config.modelId` and logs `callSid` from ambient scope, but Spec 01 R5 forbids a config singleton (pure `loadConfig`, no import-time side effects). Therefore `cfg` and `callSid` are explicit parameters; `modelId` defaults to `cfg.modelId`. Spec 02's `/twiml` handler and Spec 05 will call it this way — name this in the completion report so downstream planners see it.

## Steps

- [ ] Read the References, especially Spec 04 R3 in full and findings/01 Impl 1 + §9.
- [ ] Write failing tests in `src/gateway.mint.test.ts` (`node:test` + `node:assert/strict`; plain Node env — assert `globalThis.window === undefined` once, per findings/10 G6). Stub the factory with `mock.method(gateway.experimental_realtime, 'getToken', ...)` (the factory is a function object; its `getToken` property is patchable). Cases:
  - success: stub resolves `{token:'vcst_x', url:'wss://ai-gateway.vercel.sh/v4/ai/realtime-model?ai-model-id=openai%2Fgpt-realtime-2.1', expiresAt: 123}` → returned `MintResult` echoes all three + numeric `getTokenMs`; the stub was called with `{ model: cfg.modelId, expiresAfterSeconds: cfg.tokenTtlSeconds }` and NO `sessionConfig` key (Spec 04 R3: gateway ignores it — must not be passed) — this is the A1 factory-form assertion
  - a `get-token` log line was emitted containing `event:'get-token'`, `callSid`, `getTokenMs`, `expiresAt` (capture logger output by spying on the stream/function Spec 01 R12's `logEvent` writes to)
  - failure classification (parameterized over findings/01 §9): stub rejects with each of `GatewayAuthenticationError`, `GatewayInvalidRequestError`, `GatewayRateLimitError`, `GatewayModelNotFoundError`, `GatewayInternalServerError`, `GatewayFailedDependencyError`, `GatewayForbiddenError` → `mintRealtimeToken` rejects with `GatewayMintError` carrying the matching `errorType` and `statusCode`, plus one `get-token-failed` log line. If a class proves non-constructible in tests, fall back to a plain object with the class's prototype or a `GatewayError`-shaped `{statusCode}` — the `statusCode`-fallback and `'unknown'` branches must each have one case regardless (A11)
  - `model_not_found` case additionally logs a line whose message names `MODEL_ID=openai/gpt-realtime-2` (Spec 04 R3 / S7 hint)
- [ ] Run `npx tsx --test src/gateway.mint.test.ts` — expect FAIL (module absent).
- [ ] Implement `src/gateway.ts` per Spec 04 R1 (exact import block, verbatim type aliases) + R3 (mint body, `performance.now()` timing, try/catch classification via `instanceof` then `GatewayError.statusCode` then `'unknown'`). Logging goes through `logEvent({level, message, ...fields})` — map every Spec 04 `log('info', msg, fields)` snippet to the Spec 01 R12 boundary; do NOT import a `log()` that doesn't exist yet (Spec 08 lands in parallel).
- [ ] Run `npx tsx --test src/gateway.mint.test.ts` — expect PASS. Then `npm test` and `npm run typecheck` — exit 0.
- [ ] Grep gate (cross-platform): `node -e "const fs=require('fs'),p=require('path');const bad=fs.readdirSync('src').filter(f=>f.endsWith('.ts')&&fs.readFileSync(p.join('src',f),'utf8').includes('rt.getToken'));if(bad.length){console.error(bad);process.exit(1)}console.log('OK: no rt.getToken')"` — expect `OK` (A1's zero-hits rule).
- [ ] Commit: `feat(gateway): mintRealtimeToken with factory-form getToken and typed mint errors` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Discharges Spec 04 **A1** (factory form, zero `rt.getToken`) and **A11** (getTokenMs/expiresAt logged; `GatewayMintError` covers the findings/01 §9 classes). Contributes to **A13** (no new deps; verify `npm ls @ai-sdk/gateway ws` shows 4.0.23 / 8.21.1).

## Completion Report

```
Task: T04.2 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome]
Spec 04 A-numbers verified: A1, A11 (+A13 pin check)
Deviations from plan: mintRealtimeToken takes (cfg, callSid, modelId?) — spec-snippet ambient config resolved per Spec 01 R5 [plus any others]
New interfaces exposed: MintResult, GatewayMintError, mintRealtimeToken(cfg, callSid, modelId?)
Notes for ledger: [e.g. which Gateway*Error classes were directly constructible in tests]
```

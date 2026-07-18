# T04.1 — Gateway config keys in `config.ts` + `.env.example`

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Add the twelve Spec 04 R2 env keys (parsing, defaults, validation) to `src/config.ts` and `.env.example` as strictly additive edits, so every later T04 task can read them off `AppConfig`.

**Wave:** B · **Depends on:** T01 · **Blocks:** T04.2, T04.3, T04.4, T04.5

**References:**
- `docs/specs/04-gateway-realtime-leg.md` — §R2 (the key table + boot-validation note) and the R2 rows' findings citations
- `docs/specs/01-scaffolding-and-toolchain.md` — §R5 (existing `EnvSchema` / `AppConfig` / `loadConfig` shape you are extending), §R7 (interim `node:test` harness conventions)
- `docs/specs/00-master-build-plan.md` — §4 (Wave B: `config.ts`/`.env.example` edits are ADDITIVE, merged at wave end) and §8 risk R-2
- `docs/findings/08-fastify-ws-server-architecture.md` — gotcha 11 (why `GATEWAY_HANDSHAKE_TIMEOUT_MS` exists)
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — D6 (VAD tuning ranges)

## Interfaces

**Consumes** (from T01, `src/config.ts`):
- `loadConfig(env?: NodeJS.ProcessEnv): AppConfig` and `interface AppConfig` per Spec 01 R5. Already present: `modelId` (MODEL_ID), `voice` (VOICE), `audioMode` (AUDIO_MODE), `aiGatewayApiKey` fail-fast. Do NOT re-add or reorder these.

**Produces** (additive fields on `AppConfig`, exact names — later tasks and Spec 05 depend on them):

| Env var | `AppConfig` field | Type | Default |
|---|---|---|---|
| `VOICE_FALLBACK` | `voiceFallback` | `string` | `'alloy'` |
| `VAD_SILENCE_MS` | `vadSilenceMs` | `number` (int) | `500` |
| `VAD_THRESHOLD` | `vadThreshold` | `number` (0.0–1.0, reject outside) | `0.5` |
| `VAD_PREFIX_PADDING_MS` | `vadPrefixPaddingMs` | `number` (int) | `300` |
| `TOKEN_TTL_SECONDS` | `tokenTtlSeconds` | `number` (int) | `600` |
| `GATEWAY_HANDSHAKE_TIMEOUT_MS` | `gatewayHandshakeTimeoutMs` | `number` (int) | `5000` |
| `GATEWAY_PING_SECONDS` | `gatewayPingSeconds` | `number` (int) | `0` |
| `WAIT_FOR_SESSION_UPDATED` | `waitForSessionUpdated` | `boolean` | `false` |
| `GATEWAY_TAGS` | `gatewayTags` | `string[] \| undefined` (comma-split, trimmed, empty→`undefined`) | `undefined` |

(`MODEL_ID`/`VOICE`/`AUDIO_MODE` rows of Spec 04 R2 are already satisfied by Spec 01 R5 — verify presence only.)

## Steps

- [ ] Read the References. Confirm in `src/config.ts` that Spec 01 R5 already implements `MODEL_ID`, `VOICE`, `AUDIO_MODE`, and the `AI_GATEWAY_API_KEY` fail-fast message (Spec 04 R2's boot-validation rule) — if so, those need no edit.
- [ ] Write failing tests in a NEW file `src/config.gateway.test.ts` (new file, not `src/config.test.ts`, to avoid Wave B merge contention — master plan R-2). Use `node:test` + `node:assert/strict` with explicit `.js` relative imports per Spec 01 R7. Cases, each calling `loadConfig(fixtureEnv)` with the three mandatory base vars (`AI_GATEWAY_API_KEY`, `TWILIO_AUTH_TOKEN`, `PUBLIC_HOST`) set:
  - all nine new fields get the defaults in the table above when their env vars are unset
  - string ints coerce (`VAD_SILENCE_MS='400'` → `400`)
  - `VAD_THRESHOLD='1.5'` and `'-0.1'` → throws the Spec 01 R5 "Invalid environment configuration" error
  - `WAIT_FOR_SESSION_UPDATED='true'` → `true`; `'false'` → `false`; unset → `false`
  - `GATEWAY_TAGS='poc, voice'` → `['poc','voice']`; `GATEWAY_TAGS=''` and unset → `undefined`
- [ ] Run `npx tsx --test src/config.gateway.test.ts` — expect FAIL (fields don't exist yet).
- [ ] Implement per Spec 04 R2: append the new keys to `EnvSchema`, `AppConfig`, and the `loadConfig` return object at the END of each block (additive; do not touch existing lines). Boolean trap: do NOT use `z.coerce.boolean()` (it maps the string `'false'` to `true`); parse `WAIT_FOR_SESSION_UPDATED` via an explicit enum/transform such as `z.enum(['true','false']).default('false').transform(v => v === 'true')`. `VAD_THRESHOLD`: `z.coerce.number().min(0).max(1)`. `GATEWAY_TAGS`: optional string, transform to trimmed non-empty array or `undefined`.
- [ ] Append the same nine keys to `.env.example` with their defaults and one-line comments (copy intent from the Spec 04 R2 table, e.g. the S6/S8/S32 notes), below the existing entries.
- [ ] Run `npx tsx --test src/config.gateway.test.ts` — expect PASS. Then `npm test` (whole interim suite) and `npm run typecheck` — expect both exit 0.
- [ ] Commit: `feat(config): add gateway realtime env keys per spec 04 R2` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Discharges the config half of Spec 04 A2/A5/A12 preconditions (keys exist with correct defaults); directly verifies Spec 04 R2 parsing/validation. No other A-number closes here.
- Merge-point compliance: `git diff` on `src/config.ts` shows only appended lines inside `EnvSchema`, `AppConfig`, and the return object (master plan §4 Wave B rule).

## Completion Report

```
Task: T04.1 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec 04 items verified: R2 (parsing+defaults+validation); A2/A5/A12 config preconditions
Deviations from plan: [none | list]
New interfaces exposed: AppConfig.{voiceFallback,vadSilenceMs,vadThreshold,vadPrefixPaddingMs,tokenTtlSeconds,gatewayHandshakeTimeoutMs,gatewayPingSeconds,waitForSessionUpdated,gatewayTags}
Notes for ledger: [merge-point: config.ts additive edits done; anything else]
```

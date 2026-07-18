# T10.2 — Config, logger & aggregation-fixture suites

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Bring `test/config.test.ts` up to Spec 10 R7, write `test/logger.test.ts` per R8, and exercise Spec 08's `scripts/aggregate-latency.mjs` against a committed JSONL fixture.

**Wave:** E · **Depends on:** T10.1, T01, T04, T08 · **Blocks:** T10.8

**References:**
- `docs/specs/10-testing-spikes-and-milestones.md` — R7, R8, R25 (aggregation rules), §Deliverables note that NO second aggregator is shipped
- `docs/specs/01-scaffolding-and-toolchain.md` — config.ts contract (env parsing, fail-fast); the `AI_GATEWAY_API_KEY` boot-throw
- `docs/specs/04-gateway-realtime-leg.md` — R2 config-key table (`MODEL_ID`, `VOICE`, defaults)
- `docs/specs/06-audio-dsp-transcoding.md` — R1 (`AUDIO_MODE` semantics: legal values, default `transcode`, typo → boot throw)
- `docs/specs/08-logging-and-latency-instrumentation.md` — R1 (logger source, `ms`/`now`), R2 (line contract), and the `pct()` nearest-rank helper in `src/latency.ts`
- `docs/findings/09-latency-instrumentation.md` — §5 (example `turn`/`stream-stop` lines — the fixture's shape authority), §6 (logger), §7 (percentile formula, gotcha 13 never percentile-of-percentiles)
- `docs/findings/01-vercel-ai-gateway-realtime.md` — gotcha 5 (OIDC late-failure trap the boot throw prevents)
- `docs/findings/03-twilio-media-streams.md` — Impl B (`PUBLIC_HOST`/`RAILWAY_PUBLIC_DOMAIN` resolution order)

## Interfaces

**Consumes:**
- `src/config.ts` — `loadConfig()` (or the exported parse function T01 shipped; use its actual exported name), `config.audioMode: 'pcmu' | 'transcode'`.
- `src/logger.ts` — `log(level, message, fields)`, `logEvent(fields)`, `ms(a, b)`, `now()` (Spec 08 R1 exports).
- `src/latency.ts` — `pct()` nearest-rank helper (Spec 08 deliverable; import by its actual exported name).
- `scripts/aggregate-latency.mjs` — T08's offline aggregator (invoked, not imported).

**Produces:**
- `test/config.test.ts` — full R7 coverage (extends the file T10.1 relocated).
- `test/logger.test.ts` — full R8 coverage.
- `test/fixtures/turn-lines.jsonl` — ~20 hand-written `@event:turn` + 2 `@event:stream-stop` lines matching findings/09 §5 shapes, spanning two callSids, at least 3 `bargedIn:true` turns, and at least one line without `ttfbMs` (so both Spec 08 R16 partitions — `bargedIn:false` and turns-with-`ttfbMs` — are non-empty). Turn lines carry no `audioMode` field; Spec 10 R25's per-audio-mode cut is realized by running the aggregator on separate per-mode session extracts, not by a field split.

## Steps

- [ ] Read the References; open `src/config.ts`, `src/logger.ts`, `src/latency.ts` to confirm actual exported names before writing assertions.
- [ ] Extend `test/config.test.ts` per Spec 10 R7 items 1–5 exactly: (1) missing `AI_GATEWAY_API_KEY` → throw naming the variable; (2) missing `TWILIO_AUTH_TOKEN` → throw; (3) `AUDIO_MODE` union + default `transcode` + typo throw (per Spec 06 R1); (4) `MODEL_ID` default `openai/gpt-realtime-2.1`, `VOICE` default `marin` (per Spec 04 R2); (5) `PORT` numeric parse and `PUBLIC_HOST`/`RAILWAY_PUBLIC_DOMAIN` precedence per findings/03 Impl B. Drive via mutating `process.env` in `beforeEach`/`afterEach` snapshots (config must be re-evaluated per test — if `config.ts` caches at module load, use vitest `vi.resetModules()` + dynamic `await import`).
- [ ] Run `npx vitest run test/config.test.ts` — expect FAIL first only if assertions expose real config bugs; otherwise expect PASS. Any real bug: report, do not silently patch `src/config.ts` beyond what Spec 01/04/06 mandate.
- [ ] Write `test/logger.test.ts` per Spec 10 R8: capture stdout by stubbing `process.stdout.write` (restore in `afterEach`); assert (1) single-line minified JSON, string `message` + string `level`, `undefined` fields dropped, circular `.raw` serialization falls back without throwing; (2) nothing written to stderr (stub `process.stderr.write` and assert zero calls); (3) `pct()` nearest-rank edge cases per R8.3 including input-array non-mutation; (4) `ms()` rounds to 1 decimal.
- [ ] Run `npx vitest run test/logger.test.ts` — expect PASS.
- [ ] Create `test/fixtures/turn-lines.jsonl` modeled line-for-line on findings/09 §5 example lines (flat fields, numeric metrics as JSON numbers). Include known values so aggregate output is predictable (e.g. a metric whose p50 you can state in advance).
- [ ] Run `node scripts/aggregate-latency.mjs test/fixtures/turn-lines.jsonl` (also verify `npm run aggregate -- test/fixtures/turn-lines.jsonl` resolves) — expect: p50/p95/max/n per metric with the Spec 08 R16 partitions (all turns, `bargedIn:false` only, turns-with-`ttfbMs` only), matching the hand-computed values. (Spec 08 owns the script contract — master plan "no second aggregator"; R25's audio-mode comparison is done by aggregating per-mode extracts separately.) Record the exact output in the Completion Report. If the script's CLI contract differs (arg name, stdin), follow Spec 08's documented usage and note the deviation.
- [ ] Run `npm test` — expect PASS (whole repo).
- [ ] Commit: `test(config-logger): full R7/R8 suites plus aggregation fixture exercise` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Contributes to Spec 10 **A1** (suite green) and discharges the R7/R8 deliverables; proves the R25 pipeline runs (aggregator exercised against fixtures — prerequisite for **A11**'s offline percentiles).

## Completion Report

```
Task: T10.2 — Status: DONE | BLOCKED(<why>)
Files changed: <list>
Commands run: vitest per-file → <results>; node scripts/aggregate-latency.mjs test/fixtures/turn-lines.jsonl → <one-line summary of output>; npm test → <n passed>
Spec A-numbers verified: (supports A1, A11 pipeline)
Deviations from plan: <none | list>
New interfaces exposed: test/fixtures/turn-lines.jsonl (reusable fixture)
Notes for ledger: <1-2 lines>
```

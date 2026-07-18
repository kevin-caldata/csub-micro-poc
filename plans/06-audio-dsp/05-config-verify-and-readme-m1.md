# T06.5 — `AUDIO_MODE` config verification + README M1 spike checklist + grep gates

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Verify T01's `AUDIO_MODE` config semantics against Spec 06 R1 (patch tests only if gaps exist), ship the README "M1 audio-format spike" checklist + results table stub, and run the Spec 06 repo hygiene gates.

**Wave:** B · **Depends on:** T06.3, T01 · **Blocks:** T09/M1 (the checklist is the M1 decision procedure)

**References:**
- `docs/specs/06-audio-dsp-transcoding.md` — R1 (`AUDIO_MODE` semantics — this spec is authoritative for them), R13 (the 7-step M1 procedure + results-table columns, verbatim source for the README section), A2, A4, A8; §Open items (S1, S2, S3, S17, S18 — referenced by the checklist)
- `docs/specs/01-scaffolding-and-toolchain.md` — R5 (zod schema: `AUDIO_MODE: z.enum(['pcmu','transcode']).default('transcode')`, `config.audioMode` union type), R7 (config test conventions incl. the `rejects an invalid AUDIO_MODE` case)
- `docs/findings/06-audio-dsp-transcoding.md` — gotcha 11 (spike outcome = config change, not refactor), §C2
- `docs/specs/00-master-build-plan.md` — decision C7 (`AUDIO_MODE` typo-guard), Risk R-2 (config.ts is a merge point — edits must be additive)

## Interfaces

**Consumes:** `src/config.ts` + `src/config.test.ts` from T01 (Spec 01 R5/R7); `src/dsp.ts` complete from T06.1–T06.3.

**Produces:**
- `README.md` — created at repo root if absent (T01 does not create one); contains an `## M1 audio-format spike` section with the R13 checklist and an EMPTY results table stub. Keep the section self-contained and additive — Spec 10 later adds its own README sections (Spike Results, M5 report skeleton); do not scaffold those.
- Possibly additional cases in `src/config.test.ts` (additive only — master plan R-2 merge-point rule; `src/config.ts` itself is modified ONLY if T01 failed to implement Spec 06 R1, which Spec 01 R5 says it did).

## Steps

- [ ] Read Spec 06 R1/R13 and Spec 01 R5/R7 in full; read the current `src/config.ts` and `src/config.test.ts`.
- [ ] Verify R1/A4 coverage in `src/config.test.ts`: (a) unset `AUDIO_MODE` → `config.audioMode === 'transcode'`; (b) `'pcmu'` accepted; (c) invalid values (`'garbage'`, `''`, `'pcm'`, `'mulaw'`) each rejected with an error whose message names both legal values `pcmu` and `transcode`; (d) `audioMode` is typed as the union `'pcmu' | 'transcode'`, not `string`. Add any MISSING cases additively (do not rewrite existing tests). If `config.ts` itself lacks R1 semantics (it should not — Spec 01 R5 owns it), implement per Spec 06 R1 and flag the deviation in the report.
- [ ] Run `npm test` — expect PASS (config + dsp suites green).
- [ ] Create/extend `README.md` with the `## M1 audio-format spike` section: transcribe the 7 numbered steps of Spec 06 R13 (Path A `pcmu` first → record `session-updated.raw` → keep-or-flip → deliberate S3 misconfig probe once then revert → sine-sweep-by-ear → optional S18/S17 observations) and the empty results table with exactly the columns `date · AUDIO_MODE tested · session-updated.raw excerpt · audible OK? · decision`. State explicitly that the DSP module stays in the repo behind the flag regardless of the S1 outcome (findings/06 gotcha 11).
- [ ] Run the A2 gate: `node -e "const fs=require('fs');const t=['package.json',...fs.readdirSync('src').map(f=>'src/'+f)].map(f=>fs.readFileSync(f,'utf8')).join();if(/alawmulaw|wave-resampler/.test(t)){console.error('FORBIDDEN DEP REFERENCE FOUND');process.exit(1)}console.log('A2 clean')"` — expect `A2 clean`, exit 0.
- [ ] Confirm `npm ls alawmulaw wave-resampler` shows neither installed.
- [ ] Run `npm run typecheck` and `npm run build` — expect exit 0 (whole-module sanity after the T06 series).
- [ ] Commit: `git add README.md src/config.test.ts` (plus `src/config.ts` only if it was patched) then `git commit -m "chore(dsp): M1 audio-format spike checklist and AUDIO_MODE config verification" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

## Acceptance

- Discharges Spec 06 A4 (boot-time typo-guard semantics, verified at the `loadConfig` unit level per Spec 01 R7 — the env-injected boot smoke is covered by Spec 01's acceptance and re-run by the orchestrator), A8 (checklist + empty results table shipped; the table gets its Path A row during M1 execution, which is milestone work, not this task), and re-confirms A2 repo-wide.
- Executing the spike itself (R13 steps 1–7) is Spec 06 "Out of scope" / Milestone M1 — do not attempt it.

## Completion Report

```
Task: T06.5 — status: [done/blocked]
Files changed: [list]
Commands run: [npm test → result; A2 node gate → result; npm run typecheck/build → results]
Spec A-numbers verified: A4, A8, A2 (re-confirmed)
Deviations from plan: [e.g. config.ts needed patching — should be none]
New interfaces exposed: none (README + tests)
Notes for ledger: README M1 results table is EMPTY by design until M1 execution (A8 second half lands at M1)
```

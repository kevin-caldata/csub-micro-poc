# T06.1 — Vendored μ-law codec tables + frame-math constants

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Create `src/dsp.ts` with the vendored G.711 μ-law encode/decode lookup tables and the frame-math sanity constants, proven byte-exact by a test suite.

**Wave:** B · **Depends on:** T01 · **Blocks:** T06.2, T06.3

**References:**
- `docs/specs/06-audio-dsp-transcoding.md` — R5 (vendored codec, verbatim snippet), R10 (constants), R12.1, R12.2, R12.8 (constants half), A2
- `docs/findings/06-audio-dsp-transcoding.md` — §C1 (codec math), §C5 (frame math), §C8 (why `alawmulaw` is banned), §Implementation-grade detail / μ-law codec
- `docs/specs/01-scaffolding-and-toolchain.md` — R7 (test runner: `node:test` via `tsx --test`, test files as `src/<name>.test.ts`, `.js` import extensions), R1 (ESM rules)
- `docs/specs/00-master-build-plan.md` — Risk R-1 (interim runner adjudication), R-10 (banned deps)

## Interfaces

**Consumes:** nothing from other tasks beyond T01's toolchain (`npm test` = `tsx --test "src/**/*.test.ts"`, tsconfig NodeNext ESM).

**Produces** (in `src/dsp.ts`, all later T06 tasks extend this same file):
- `export const MULAW_DEC: Int16Array` — 256 entries, full-scale 16-bit (±32124 extremes), built at module top level from the spec's `muLawDecodeSample` (keep the sample-level functions module-private).
- `export const MULAW_ENC: Uint8Array` — 65536 entries, index `pcm & 0xffff`, built from the spec's `muLawEncodeSample` (note the trailing `& 0xff` — Spec 06 R5).
- `export const FRAME_MS`, `MULAW_BYTES_PER_20MS`, `MULAW_B64_CHARS_PER_20MS`, `PCM24K_SAMPLES_PER_20MS`, `PCM24K_BYTES_PER_20MS`, `PCM24K_B64_CHARS_PER_20MS` — exact values in Spec 06 R10.
- `src/dsp.test.ts` — the DSP suite file (T06.2–T06.4 append to it). Interim location/runner per master plan R-1: `node:test` + `node:assert/strict` beside the source so T01's `npm test` glob picks it up; Spec 10 later migrates it to `test/dsp.test.ts` under vitest — do NOT create `test/` or install vitest here.

## Steps

- [ ] Read Spec 06 R5 + R10 and findings/06 §μ-law codec in full.
- [ ] Write `src/dsp.test.ts` (imports from `./dsp.js` with the `.js` extension) covering:
  - R12.1: `MULAW_DEC` matches all 256 values of a locally re-derived reference decoder (re-implement the ~10-line `muLawDecodeSample` from Spec 06 R5 inside the test); spot-assert `MULAW_DEC[0xFF] === 0` and that table extremes reach ±32124.
  - R12.2: `MULAW_ENC[MULAW_DEC[b] & 0xffff] === b` for all 256 codes except exactly `b === 0x7F`, which must map to `0xFF`; any other exception fails the test.
  - R12.8 (constants half): `Buffer.alloc(160).toString('base64').length === 216` and `Buffer.alloc(960).toString('base64').length === 1280`, and each R10 constant equals its spec value.
- [ ] Run `npm test` — expect FAIL (module `./dsp.js` does not exist yet).
- [ ] Implement `src/dsp.ts` per Spec 06 R5 (vendor the codec verbatim — do not "improve" it; keep the `& 0xff` mask and the no-`<<2`-scaling rule) and R10 constants.
- [ ] Run `npm test` — expect PASS (all dsp tests green; pre-existing `src/config.test.ts` still green).
- [ ] Run `npm run typecheck` — expect exit 0.
- [ ] Verify A2 (no forbidden packages): run `npm ls alawmulaw wave-resampler` — expect both reported as `(empty)`/not installed; confirm you added no dependencies to `package.json`.
- [ ] Commit: `git add src/dsp.ts src/dsp.test.ts` then `git commit -m "feat(dsp): vendored mu-law codec tables and frame-math constants" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

## Acceptance

- Discharges Spec 06 A2 (codec vendored, forbidden packages absent — re-verified again in T06.5) and the R12.1/R12.2/R12.8-constants slices of A1.
- A1 overall remains open until T06.4 completes the suite.

## Completion Report

```
Task: T06.1 — status: [done/blocked]
Files changed: [list]
Commands run: [npm test → result; npm run typecheck → result; npm ls alawmulaw wave-resampler → result]
Spec A-numbers verified: A2; A1 partial (R12.1, R12.2, R12.8-constants)
Deviations from plan: [none or list]
New interfaces exposed: MULAW_DEC, MULAW_ENC, FRAME_MS, MULAW_BYTES_PER_20MS, MULAW_B64_CHARS_PER_20MS, PCM24K_SAMPLES_PER_20MS, PCM24K_BYTES_PER_20MS, PCM24K_B64_CHARS_PER_20MS (src/dsp.ts)
Notes for ledger: [anything the orchestrator must know]
```

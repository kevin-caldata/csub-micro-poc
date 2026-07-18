# T06.2 — FIR designer + Upsampler3x / Downsampler3x with persistent state

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Add the streaming ×3 polyphase upsampler (8 k→24 k) and ÷3 decimating downsampler (24 k→8 k) to `src/dsp.ts`, with chunk-boundary state carry proven bit-identical to one-shot processing.

**Wave:** B · **Depends on:** T06.1 · **Blocks:** T06.3, T06.4

**References:**
- `docs/specs/06-audio-dsp-transcoding.md` — R6 (FIR design, verbatim snippet), R7 (Upsampler3x, verbatim), R8 (Downsampler3x + mandatory mod-3 phase counter, verbatim), R12.3, R12.4, R12.9 (resampler half), A6, A7 (resampler half)
- `docs/findings/06-audio-dsp-transcoding.md` — §C6 (boundary clicks: 7995 vs 2339 failure signature), §C12 (filter params), §FIR design, §Upsampler, §Downsampler, gotchas 4, 8, 9, 10
- `plans/06-audio-dsp/01-mulaw-codec-and-constants.md` — Produces section (the `src/dsp.ts` / `src/dsp.test.ts` files this task extends)

## Interfaces

**Consumes:** `src/dsp.ts` and `src/dsp.test.ts` from T06.1 (extend both files; do not create new files).

**Produces** (appended to `src/dsp.ts`):
- `export class Upsampler3x { constructor(numTaps?: number, cutoffHz?: number); process(pcm8k: Int16Array): Int16Array }` — output length exactly `3 × input.length`; carries 15-sample history; **deliberately has NO `reset` method** (Spec 06 R7/R11.1 — structural enforcement).
- `export class Downsampler3x { constructor(numTaps?: number, cutoffHz?: number); process(pcm24k: Int16Array): Int16Array; reset(): void }` — carries 47-sample history + mod-3 phase counter; `reset()` zeros both.
- `designLowpassFIR` stays module-private (48 taps / Hamming / 3600 Hz cutoff / fs 24 kHz; upsampler prototype `gain = 3`, downsampler `gain = 1` — Spec 06 R6).

## Steps

- [ ] Read Spec 06 R6–R8 and findings/06 §C6, §FIR design, gotchas 4/8/10 in full.
- [ ] Append to `src/dsp.test.ts` (deterministic fixed-frequency sines only, no RNG):
  - R12.3 chunked-vs-oneshot bit-identity: ≥1 s of 1 kHz sine at amplitude 8000; process one-shot vs (a) 160-sample chunks and (b) ragged chunk cycle `[100, 333, 481, 7, 480, 1000]`; assert max diff 0 for both `Upsampler3x` and `Downsampler3x` (ragged chunks on the downsampler exercise non-multiple-of-3 lengths → the phase counter).
  - R12.4 click detector: 440 Hz sine, amplitude 8000, chunked; assert max `|y[i] − y[i−1]|` across chunk boundaries ≤ max within chunks.
  - R12.9 (resampler half): zero-length `Int16Array` input to both classes returns zero-length output AND subsequent chunks remain bit-identical to a run without the empty chunk (state not corrupted).
  - A7 (structural): `('reset' in Upsampler3x.prototype) === false`; `Downsampler3x.prototype.reset` is a function; after `down.reset()`, processing a chunk equals processing that chunk on a freshly constructed instance (zero history = start-from-silence, Spec 06 R11.3).
  - R12.8 remainder: `new Upsampler3x().process(new Int16Array(160)).length === 480`.
- [ ] Run `npm test` — expect FAIL (classes missing).
- [ ] Implement `designLowpassFIR`, `Upsampler3x`, `Downsampler3x` in `src/dsp.ts` per Spec 06 R6/R7/R8 (vendor verbatim; keep clamping + `Math.round`, the `hist.set(x.subarray(...))` state carry, and the downsampler `first`/`count`/`phase` arithmetic exactly).
- [ ] Run `npm test` — expect PASS.
- [ ] Run `npm run typecheck` — expect exit 0.
- [ ] Commit: `git add src/dsp.ts src/dsp.test.ts` then `git commit -m "feat(dsp): polyphase 3x resamplers with persistent chunk state" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

## Acceptance

- Discharges Spec 06 A6 (chunked bit-identity, both directions, 160-sample + ragged) and the resampler half of A7 (no reset on `Upsampler3x`; `Downsampler3x.reset()` zeroes state). Extends A1 partial (R12.3, R12.4, R12.8, R12.9-resampler).

## Completion Report

```
Task: T06.2 — status: [done/blocked]
Files changed: [list]
Commands run: [npm test → result; npm run typecheck → result]
Spec A-numbers verified: A6; A7 (resampler half); A1 partial (R12.3, R12.4, R12.8, R12.9-resampler)
Deviations from plan: [none or list]
New interfaces exposed: Upsampler3x, Downsampler3x (src/dsp.ts)
Notes for ledger: [anything the orchestrator must know]
```

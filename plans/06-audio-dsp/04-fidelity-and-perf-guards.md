# T06.4 — Tone-fidelity (THD+N) projection test + per-frame perf guard

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Complete the Spec 06 R12 suite with the least-squares tone-fidelity test (THD+N ≥ 60 dB, gain ±1 dB) and the < 500 µs/frame production-round-trip performance guard.

**Wave:** B · **Depends on:** T06.3 · **Blocks:** — (closes Spec 06 A1)

**References:**
- `docs/specs/06-audio-dsp-transcoding.md` — R12.5 (fidelity method: least-squares projection, why naive shifted comparison is wrong), R12.6 (perf budget: what "full production round trip" includes), A1
- `docs/findings/06-audio-dsp-transcoding.md` — §C10 (benchmark: 21.4 µs measured, method), §C12 (expected fidelity: 83–99 dB, ≤ 0.4 dB gain), §Test strategy (tests 4 and 6 — the measured procedure to port), gotcha 8 (group delay / projection rationale)
- `docs/specs/00-master-build-plan.md` — decision T5 (< 500 µs guard), spike S26 (shared-vCPU multiplier — why the 23× headroom exists)

## Interfaces

**Consumes:** `MULAW_DEC`, `MULAW_ENC`, `Upsampler3x`, `Downsampler3x`, `createTranscoder`, `MULAW_BYTES_PER_20MS`, `PCM24K_BYTES_PER_20MS` from T06.1–T06.3 (`src/dsp.ts`).

**Produces:** no new runtime exports — only test cases appended to `src/dsp.test.ts`. (If the perf test needs isolation from slow CI interleaving, a separate `src/dsp.perf.test.ts` is acceptable; it must still match T01's `src/**/*.test.ts` glob.)

## Steps

- [ ] Read Spec 06 R12.5/R12.6 and findings/06 §Test strategy tests 4 & 6, §C10, §C12, gotcha 8 in full.
- [ ] Append R12.5 tone fidelity to the suite: for each f ∈ {300, 1000, 2000, 3000} Hz, amplitude 8000, round-trip 8 k→24 k→8 k through fresh `Upsampler3x`/`Downsampler3x` instances; over the steady-state region (skip the filter warm-up head per findings/06 §Test strategy), least-squares-project the output onto `A·sin(2πft) + B·cos(2πft)`; residual power vs projected power → assert THD+N ≥ 60 dB at every f, and projected amplitude within ±1 dB of input for f < 3000 Hz. Deterministic — no RNG. Do NOT use a naive sample-shifted difference (the fractional 47-sample@24 k group delay makes it falsely report ~4 dB — Spec 06 R12.5).
- [ ] Run `npm test` — expect PASS if implementation from T06.2/T06.3 is correct (this is a characterization guard, not TDD-red; if it FAILS, stop and fix `src/dsp.ts` against Spec 06 R6–R8 before proceeding — a failure here means the vendored DSP was mis-transcribed).
- [ ] Append R12.6 perf guard: full production round trip on 20 ms frames — inbound `b64(160 B μ-law) → twilioToGateway → b64` and outbound `b64(960 B PCM16LE) → gatewayToTwilio → b64` using one `createTranscoder('transcode')` instance; warm up (≥ 200 iterations), then time ≥ 2,000 iterations with `performance.now()`; assert mean combined round trip < 500 µs/frame (expected ~21 µs on desktop; the margin absorbs CI/shared-vCPU variance per S26).
- [ ] Run `npm test` — expect PASS. Note the measured mean µs/frame in the Completion Report (feeds the M5 S26 row).
- [ ] Run `npm run typecheck` — expect exit 0.
- [ ] Commit: `git add src/dsp.test.ts` (plus `src/dsp.perf.test.ts` if split) then `git commit -m "test(dsp): THD+N projection fidelity and <500us per-frame perf guard" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

## Acceptance

- Closes Spec 06 A1: the full R12 suite (R12.1–R12.9) now passes on a clean checkout via `npm test`, including the < 500 µs/frame perf assertion.
- The manual sine-sweep-by-ear check is R13/M1 milestone work — explicitly NOT part of this task (Spec 06 R12 note).

## Completion Report

```
Task: T06.4 — status: [done/blocked]
Files changed: [list]
Commands run: [npm test → result; npm run typecheck → result]
Spec A-numbers verified: A1 (full R12 suite green)
Measured: THD+N per tone = [...]; perf mean = [N] µs/frame (record for M5/S26)
Deviations from plan: [none or list]
New interfaces exposed: none (tests only)
Notes for ledger: [anything the orchestrator must know]
```

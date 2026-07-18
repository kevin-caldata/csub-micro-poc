# CSUB-RIO Voice PoC

## M1 audio-format spike

This section is the versioned decision procedure for Milestone 1 (BRD §10 M1):
which audio path — Path A (`AUDIO_MODE=pcmu`, zero-copy G.711 μ-law passthrough)
or Path B (`AUDIO_MODE=transcode`, μ-law ⇄ PCM16@24k) — the OpenAI Realtime
gateway actually honors end-to-end. `AUDIO_MODE` exists precisely so that the
outcome of this spike is a **config change, not a refactor**: whichever path
wins, `src/dsp.ts` stays in the repo behind the flag — it is never deleted,
regardless of the S1 result (docs/findings/06-audio-dsp-transcoding.md,
gotcha 11).

Executing the steps below is Milestone 1 work, not part of any build task;
this checklist ships now (Spec 06 R13) so the procedure is versioned ahead of
the spike being run.

### Procedure

1. Deploy with `AUDIO_MODE=pcmu`. Place one call.
2. Record from logs: `session-updated.raw` verbatim (does the applied config
   show `audio/pcmu` in both directions? — S1), plus whether output audio is
   audibly correct (correct pitch/speed; wrong-rate symptoms are
   chipmunk/slow-motion audio).
3. If Path A works: record "pcmu honored: YES + raw excerpt" in the results
   table below; **keep `AUDIO_MODE=pcmu` as the production setting** (zero DSP
   on the hot path). The DSP module stays in the repo behind the flag — it is
   not deleted (`AUDIO_MODE` exists so the outcome is a config change, not a
   refactor).
4. If Path A fails (error event, close, or garbage audio): record the failure
   evidence (`error.raw` / close code / symptom), flip the Railway variable to
   `AUDIO_MODE=transcode`, redeploy config, re-call. Before trusting Path B
   constants, confirm from `session-updated.raw` that the applied format is
   `audio/pcm` @ 24000 (S2).
5. One deliberate misconfig probe (once, then revert): send
   `{type:'audio/pcmu', rate: 8000}` and log whether the gateway rejects or
   ignores the rate (S3). Never ship this.
6. Manual sine-sweep-by-ear check on the winning path (200 Hz → 3.2 kHz
   through a live call; boundary defects are audible as buzz even when unit
   tests pass).
7. If both paths produce audio: optionally compare `speech-stopped` timing
   across paths (S18, noise-reduction/VAD behavior on 8 kHz μ-law vs 24 kHz
   PCM input) and note gateway `audio-delta` chunk sizes/cadence (S17) for
   Spec 05's mark-granularity decision.

### Results

_Empty by design until M1 is executed — the Path A row lands during milestone
work, not this task._

| date | AUDIO_MODE tested | session-updated.raw excerpt | audible OK? | decision |
|---|---|---|---|---|
| | | | | |

## Dependencies

Test-runner pin resolved at T10.1 scaffold time (Spec 10 R1 — no findings doc pins a
version ahead of time):

| package | version | pin type | why |
|---|---|---|---|
| vitest | 4.1.10 | exact (`--save-exact`, repo-wide via `.npmrc`) | test runner; `environment: 'node'` mandatory — findings/01 gotcha 6, findings/10 G6 |

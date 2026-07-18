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

## Spike Results

Recorded here per Spec 10 R14/R15 during M1 execution (BRD §10 M1). Not executed by this
task — the twelve stubs below are the versioned procedure, one per Spec 10 R15 ordered
checklist item; fill them in-place at M1, top to bottom, and do not renumber.

The exact per-item format (Spec 10 R14), copied verbatim as the worked example — keep this
block as reference, do not delete it when filling in real entries below:

```markdown
### M1-03 · S1 S8 — pcmu + marin honored?
- Date/callSid: 2026-07-XX · CAxxxxxxxx
- Procedure: <one line>
- Verdict: YES | NO | PARTIAL (one line)
- Evidence: <verbatim log line(s) or dashboard screenshot ref>
- Consequence: <config/code change made, if any>
```

### M1-01 · S15 — getToken smoke
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-02 · S1 S4 S5 S6 S7 S8 S13 S16 S17 S21 S22 — first live call (pcmu / marin / gpt-realtime-2.1)
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-03 · S1 S7 S8 — fallback ladder (model / voice / audio mode)
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-04 · S2 S18 — Path B call (transcode)
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-05 — sine-sweep by ear (DSP in-vivo)
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-06 · S3 — deliberate misconfig (rate alongside pcmu)
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-07 · S11 S12 — error-string harvest
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-08 · S14 — close-code probes
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-09 · S19 — Twilio kill tests
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-10 · S23 — spoken-fallback clip check (clip half; conditional on G4 adoption)
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-11 · S30 S31 — billing check
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

### M1-12 · S32 S10 — gateway tags / providerOptions
- Date/callSid:
- Procedure:
- Verdict: YES | NO | PARTIAL
- Evidence:
- Consequence:

## Dependencies

Test-runner pin resolved at T10.1 scaffold time (Spec 10 R1 — no findings doc pins a
version ahead of time):

| package | version | pin type | why |
|---|---|---|---|
| vitest | 4.1.10 | exact (`--save-exact`, repo-wide via `.npmrc`) | test runner; `environment: 'node'` mandatory — findings/01 gotcha 6, findings/10 G6 |

## Findings Report (M5)

Skeleton per Spec 10 R26 (section headers are normative — fill sections 1–5 and 7 at M5;
section 6's 35-row spike table is pre-filled below per Spec 10 R27's classification so
sign-off only requires filling in Answer/Evidence, not re-deriving which rows are
must-answer/opportunistic/conditional/accepted-risk).

### 1. Headline latency (server-observable)
| metric | p50 | p95 | max | n | notes |
|---|---|---|---|---|---|
| ttfbMs (speech-stopped → first audio-delta = model+gateway TTFB) | | | | | clean turns only |
| bridgeMs (first audio-delta → first Twilio send) | | | | | per audio mode |
| turnMs (server-side voice-to-voice core) | | | | | |
| playbackConfirmMs (first-mark echo) | | | | | |
| greeting (Twilio start → first Twilio send) | | | | | FR-1 |
| getTokenMs | | | | | |
| toolTotalMs (+ mcpMs / gateWaitMs / secondTtfbMs p50s) | | | | | FR-4/M3 |

### 2. Honest voice-to-voice estimate
Measured server-side turn core X ms; estimated caller-perceived ≈ X + ~500 ms (VAD
silence window) + ~200–450 ms (PSTN/network legs, unmeasured). Calibration: N
speakerphone recordings, waveform-measured gap vs server-measured offset = Y ms.
Comparison vs BRD 1.0–1.5 s target and published comparables (Twilio 1,115 ms
median; techsy server_vad ~1.4 s p50). If missed: which leg, per the table above.

### 3. Path A vs Path B (pcmu vs transcode)
Verdict + `session-updated.raw` excerpts for both paths; per-leg latency
comparison; VAD-timing difference on 8 kHz μ-law vs 24 kHz PCM input (S18);
audible-quality notes; final AUDIO_MODE.

### 4. Concurrency
Team concurrent-session ceiling = N (probe date); rejection locus (mint vs
WS-open) + exact error/close code; FR-3 cross-talk result at 3–5 calls;
loopP99Ms / bridgeMs at 5 calls vs baseline; deploy-mid-call behavior (S25);
Twilio-side notes (account class, S20).

### 5. Cost
Method: /v1/credits balance before/after each measured batch (Hobby cannot use
/v1/report). Total credits delta $Z over M total call-minutes → $/call-minute.
Dashboard token-type breakdown; answer to the audio-token pricing question
(S30); Railway usage burn (S27) vs $5 Hobby credit.

### 6. Spike answer table (S1–S35)
| S# | Question (short) | Answer | Evidence (callSid/log/date) |
|---|---|---|---|
| S1 | pcmu honored end-to-end (Path A) | | |
| S2 | default/applied output rate really PCM16@24k (Path B) | | |
| S3 | rate-alongside-pcmu misconfig probe | | |
| S4 | speech-started normalized vs custom passthrough | | |
| S5 | `.raw` shapes (session-updated etc.) | | |
| S6 | session-update → response-create ordering (WAIT_FOR_SESSION_UPDATED fallback) | | |
| S7 | gpt-realtime-2.1 connect acceptance | | |
| S8 | VOICE=marin validity | | |
| S9 | truncate forwarded + conversation.item.truncated ack | | |
| S10 | providerOptions passthrough | | conditional — only if a knob is actually wanted |
| S11 | benign error code strings | | |
| S12 | response-done.status values | | |
| S13 | array frames from the gateway | | |
| S14 | WS close-code vocabulary | | |
| S15 | token TTL semantics + getTokenMs distribution | | |
| S16 | response-created-before-first-audio-delta ordering | | |
| S17 | audio-delta chunk size/cadence (mark granularity) | | |
| S18 | VAD behavior 8 kHz μ-law vs 24 kHz PCM input | | |
| S19 | caller experience on handshake failure / mid-call drop | | |
| S20 | Twilio account upgraded + approved Business Profile | | |
| S21 | upgrade-signature header presence | | |
| S22 | Twilio frame cadence/timeout | | |
| S23 | canned-clip playback before close (clip half, conditional on G4) / ping-vs-idle-timer (ping half) | | ping half — accepted-risk: WS pings vs idle timer are irrelevant while media flows (findings/10 T2); clip half pending G4 adoption decision |
| S24 | concurrency limit number + rejection locus (mint vs WS-open) | | |
| S25 | Railway WS routing during deploy-mid-call (overlap/drain) | | |
| S26 | shared-vCPU DSP multiplier + event-loop loopP99Ms at load | | |
| S27 | Hobby usage burn vs $5 credit | | |
| S28 | /twiml 503 during drain | accepted-risk | accepted-risk: covered by the "deploy between calls" operating rule |
| S29 | /mcp DNS-rebinding hardening | | conditional — only if allowedHosts hardening was adopted |
| S30 | audio-token pricing | | |
| S31 | generation IDs in session-created.raw | | |
| S32 | gateway.tags spend attribution | | |
| S33 | Log Explorer flat-field filtering (nested/numeric queries) | | |
| S34 | audio_end_ms semantics on speech_stopped | | only meaningful if S5 shows raw passthrough |
| S35 | gateway-hop latency overhead (the ttfb dataset) | | |

### 7. Deviations from BRD & recommendations
Corrections applied (C1–C18 confirmations where observed), config deltas
(model/voice/VAD tuning), and what a production build should do differently.

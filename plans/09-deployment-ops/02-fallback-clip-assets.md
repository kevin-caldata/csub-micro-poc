# T09.2 — Pre-rendered μ-law apology clip + generation script

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Produce the committed FR-7 spoken-fallback assets — `assets/fallback-apology.ulaw` (raw headerless μ-law/8000 mono), its provenance note, and the ffmpeg regeneration script — with an automated asset-format regression test.

**Wave:** D · **Depends on:** T01 · **Blocks:** T09.3

**References:**
- `docs/specs/09-deployment-and-operations.md` — R6.1 (clip content/format), R6.2 (size sanity), R6.3 (generation script), A5
- `docs/findings/03-twilio-media-streams.md` — claim 5 (outbound media = raw μ-law/8000 base64, ANY size, header bytes ⇒ garbled audio)
- `docs/specs/01-scaffolding-and-toolchain.md` — R7 (test conventions), R9 (.gitignore — confirm `assets/` is not ignored)

## Interfaces

**Consumes:** nothing from other tasks (repo scaffold only).

**Produces:**
- `assets/fallback-apology.ulaw` — raw μ-law bytes, 8000 Hz, mono, no container/header, ~3–6 s. Consumed by T09.3's `src/fallback.ts` via `readFileSync('assets/fallback-apology.ulaw')`.
- `assets/README.md` — provenance: exact spoken text, TTS/recording source, regeneration command.
- `scripts/make-fallback-clip.sh` — ffmpeg one-liner regenerating the clip from a WAV (Spec 09 R6.3).
- `src/fallback-asset.test.ts` — format regression test.

## Steps

- [ ] Confirm ffmpeg is available: run `ffmpeg -version` — expect a version banner. If absent, install it (Windows: `winget install Gyan.FFmpeg` then reopen the shell; Linux: `apt-get install -y ffmpeg`). If installation is impossible in this environment, STOP and report blocked — never commit a hand-faked byte blob as the clip.
- [ ] Write `scripts/make-fallback-clip.sh` (LF line endings, first line `#!/bin/sh`): takes an optional input WAV path (default `apology.wav`) and runs exactly the Spec 09 R6.3 command form: `ffmpeg -i "$1" -ar 8000 -ac 1 -f mulaw assets/fallback-apology.ulaw` (add `-y` to allow regeneration). Keep it to a few lines with a comment pointing at Spec 09 R6.3.
- [ ] Generate the source WAV in the scratchpad directory (do NOT commit the WAV — Spec 09 R6.3). Spoken text (also goes in `assets/README.md`, per Spec 09 R6.1): *"I'm sorry — I'm having a technical problem and have to hang up. Please call back in a moment."*
  - Windows (this environment): PowerShell TTS —
    ```powershell
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SetOutputToWaveFile("<scratchpad>\apology.wav")
    $s.Speak("I'm sorry - I'm having a technical problem and have to hang up. Please call back in a moment.")
    $s.Dispose()
    ```
  - Linux fallback: `espeak -w apology.wav "<same text>"`.
  (This snippet is inlined because it exists nowhere in specs/findings; the normative conversion step is the ffmpeg command.)
- [ ] Run the conversion (via `bash scripts/make-fallback-clip.sh <scratchpad>/apology.wav`, or run the identical ffmpeg command directly if `bash` is unavailable) — expect `assets/fallback-apology.ulaw` created.
- [ ] Write `assets/README.md`: one paragraph covering the exact spoken text, how the WAV was produced, the regeneration command (`scripts/make-fallback-clip.sh`), and the format warning: raw μ-law/8000 mono, NO container/header — header bytes cause garbled playback (Spec 09 R6.1; findings/03 claim 5).
- [ ] Write `src/fallback-asset.test.ts` (`node:test` + `node:assert/strict` per Spec 01 R7) asserting on `assets/fallback-apology.ulaw`:
  - file exists and first 4 bytes are NOT `RIFF` (headerless check, Spec 09 A5);
  - byte length is within 24 000–56 000 (≈ 3–7 s at 8000 B/s — Spec 09 R6.1/R6.2 size math);
  - byte length equals raw size exactly (no trailing container chunk: assert length is what `fs.statSync` reports and > 0 — trivially true, keep the two assertions above as the real gate).
- [ ] Run `npm test` — expect PASS including the new asset test.
- [ ] Verify git hygiene: the `.ulaw` and both new text files are staged; no `.wav` is staged (`git status` shows no WAV). If `.gitignore` matches the `.ulaw`, add a negation entry so the asset commits (Spec 01 R9 owns the file — additive edit only).
- [ ] Commit with message:
  `feat(fallback): pre-rendered mu-law apology clip, provenance note, regen script (Spec 09 R6.1-R6.3)`
  including trailer line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Spec 09 **A5** — `assets/fallback-apology.ulaw` is raw headerless μ-law/8000 mono, size ≈ 8000 × duration, first bytes not `RIFF`, regenerable via `scripts/make-fallback-clip.sh`. (Live playback verification is spike S23 at M1, owned by T10 with T09.5's RUNBOOK.)

## Completion Report

```
Task: T09.2 — fallback clip assets
Status: <done | blocked: reason>
Files changed: <list>
Commands run: ffmpeg conversion → <ok>; npm test → <PASS/FAIL>
Clip: <byte length> bytes ≈ <seconds> s; first 4 bytes: <hex>
Spec acceptance verified: 09-A5 (repo half; S23 live check deferred to M1)
Deviations from plan: <none | ...>
New interfaces exposed: assets/fallback-apology.ulaw (path consumed by T09.3)
Ledger notes: <1-2 lines>
```

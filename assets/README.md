# assets/fallback-apology.ulaw — provenance

**Spoken text** (Spec 09 R6.1): *"I'm sorry — I'm having a technical problem and have to hang up. Please call back in a moment."*

**Format:** raw μ-law (G.711), 8000 Hz, mono, **no container/header of any
kind**. Twilio Media Streams expects exactly this — any framing bytes (e.g. a
WAV/RIFF header) at the front of the payload cause garbled playback
(`docs/findings/03-twilio-media-streams.md` claim 5).

## How it was produced (DEV-04 route — no ffmpeg on this host)

Spec 09 R6.3 originally specified an ffmpeg one-liner
(`ffmpeg -i apology.wav -ar 8000 -ac 1 -f mulaw assets/fallback-apology.ulaw`).
This host has no ffmpeg available, so the asset is instead produced with two
repo-native steps (ledger DEV-04):

1. **Render the source WAV** with Windows' built-in `System.Speech` TTS,
   already at 8 kHz / 16-bit / mono so no resampling is needed. Run from
   PowerShell:

   ```powershell
   Add-Type -AssemblyName System.Speech
   $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
   $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
     8000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
   $s.SetOutputToWaveFile("<scratch>\apology.wav", $format)
   $s.Speak("I'm sorry - I'm having a technical problem and have to hang up. Please call back in a moment.")
   $s.Dispose()
   ```

   Write the WAV to a scratch/temp path — it is intermediate and must **not**
   be committed.

2. **Convert to raw μ-law** with the committed helper script, which parses
   the WAV's RIFF chunks (walks to the actual `data` chunk rather than
   assuming a fixed 44-byte header) and mu-law encodes the PCM16 samples
   using this repo's own `MULAW_ENC` table (`src/dsp.ts`, vendored per Spec 06
   R5/A2 — no ffmpeg, no third-party codec package):

   ```
   npx tsx scripts/build-fallback-clip.ts <scratch>\apology.wav
   ```

   This writes `assets/fallback-apology.ulaw` directly (path is fixed in the
   script, matching the interface `src/fallback.ts` consumes via
   `readFileSync('assets/fallback-apology.ulaw')`).

If ffmpeg becomes available on a future host, the original Spec 09 R6.3
command form remains a valid alternative regeneration path — the output
format contract (raw headerless μ-law/8000 mono) is identical either way.

## Regression test

`src/fallback-asset.test.ts` asserts the committed asset exists, is
headerless (first 4 bytes are not `RIFF`), is sized ~3–7 s at 8000 B/s
(24,000–56,000 bytes), and round-trips through `MULAW_DEC` without producing
out-of-range samples.

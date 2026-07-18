---
# Spec 06 — Audio Formats: Path A (pcmu passthrough) and Path B (transcode) behind AUDIO_MODE
Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Draft for review
Depends on: 01 (scaffold: tsconfig/ESM, vitest runner, config.ts env parsing) · Enables: 05 (Session wiring), 09 (M1 spike/README findings)
Findings referenced: findings/06 (ALL sections — C1–C12, Implementation-grade detail, gotchas 1–11, open questions 1–6); findings/02 (§Session config, §Gateway implementation facts, gotchas 2–3); findings/10 (C7, C8, T4, T5, G1, G6, S1–S3, S17, S18, S22, S26); BRD §5.5, §5.4, §10 M1, §12
---

## Objective

When this spec is done, `src/dsp.ts` exists as the single audio-format module of the bridge: it exports the session-update audio-format fragments for both paths, a per-call transcoder object whose Path A is a zero-copy base64 passthrough and whose Path B is a verified streaming μ-law ⇄ PCM16@24k transcoder with persistent per-call filter state, plus frame-math sanity constants. A vitest suite proves bit-identical chunked processing, boundary continuity, μ-law byte-exactness, and per-frame CPU budget. The M1 decision procedure (test Path A first, record, flip `AUDIO_MODE`) is written down so the spike outcome is a config change, not a refactor [findings/06 gotcha 11].

## Deliverables

- `src/dsp.ts` — vendored μ-law codec tables, FIR designer, `Upsampler3x`, `Downsampler3x`, `createTranscoder(mode)`, `audioFormatsFor(mode)`, frame-math constants. (BRD §9 skeleton path.)
- `test/dsp.test.ts` — the unit-test suite of R12 (node environment, never jsdom per findings/10 G6; the final vitest config is owned by Spec 10 — until the T10 consolidation the suite may run on Spec 01's interim `node:test` harness, master plan risk R-1).
- Modify `src/config.ts` (created by Spec 01) only if Spec 01 has not already implemented R1's `AUDIO_MODE` parsing; this spec is authoritative for its semantics.
- Modify `README.md` — add the "M1 audio-format spike" checklist + results table stub of R13.

Not deliverables here: no changes to `src/session.ts` (Spec 05 consumes this module; its required call sites are specified in R11 as a contract).

## Requirements

### R1 — `AUDIO_MODE` config semantics

`AUDIO_MODE` is an env var parsed at boot in `config.ts` with exactly two legal values: `'pcmu'` and `'transcode'`.

- Default when unset: `'transcode'` (Path B is the baseline that works regardless of the gateway's pcmu behavior; BRD §12). After the M1 spike passes for Path A, the operator flips the Railway variable to `pcmu` — zero code change (S1).
- Any other value (including empty string, `'pcm'`, `'mulaw'`): **fail at boot** with a message naming the two legal values. Rationale: `inputAudioFormat.type` is a plain `string` with no compile-time or SDK-side validation [findings/02 claim 11, gotcha 2; findings/10 C7] — the config layer is the only place a typo can be caught before it becomes a silent garbage-audio call.
- Export the parsed value as `config.audioMode: 'pcmu' | 'transcode'` (a TypeScript union, not `string`).

### R2 — Session-update format fragments derive from `AUDIO_MODE`

`dsp.ts` exports:

```ts
export type AudioMode = 'pcmu' | 'transcode';

export function audioFormatsFor(mode: AudioMode): {
  inputAudioFormat: { type: string; rate?: number };
  outputAudioFormat: { type: string; rate?: number };
} {
  return mode === 'pcmu'
    ? { inputAudioFormat: { type: 'audio/pcmu' },
        outputAudioFormat: { type: 'audio/pcmu' } }
    : { inputAudioFormat: { type: 'audio/pcm', rate: 24000 },
        outputAudioFormat: { type: 'audio/pcm', rate: 24000 } };
}
```

Exact rules, all load-bearing:

- **`audio/pcmu` MUST NOT carry a `rate` field in either direction.** G.711 is fixed at 8000 Hz and the GA OpenAI schema defines no `rate` on the pcmu format object (`interface AudioPCMU { type?: 'audio/pcmu'; }` — no rate member) [findings/06 C2; findings/10 C8]. The key must be *absent*, not `undefined`-valued, in the serialized JSON (JSON.stringify drops `undefined`, so the object literal above is sufficient — do not "helpfully" add `rate: 8000`). Gateway behavior when a rate IS sent alongside pcmu is unknown → S3; the deliberate-misconfig probe lives in the M1 procedure (R13), never in production code.
- **`audio/pcm` MUST carry `rate: 24000` in both directions** — 24000 is the only PCM rate OpenAI supports (`interface AudioPCM { rate?: 24000; type?: 'audio/pcm'; }`, docstring "Only a 24kHz sample rate is supported.") [findings/06 C2]. PCM sample layout is 16-bit signed little-endian mono [findings/06 C2].
- Spec 05 MUST inject `audioFormatsFor(config.audioMode)` into Spec 04's `openGatewayLeg` (`opts.formats`), which spreads it into the `session-update` config (the first client message after WS open); format objects MUST NOT be hand-built anywhere else.
- The gateway's *applied* format is only observable via `session-updated.raw` (the normalized `session-updated` event has no fields beyond `raw`) [findings/02 gotcha 3]. Whether the gateway default really is PCM16@24k (S2) and whether it honors pcmu at all (S1) are M1 runtime observations — Specs 04/08 must log `session-updated.raw` verbatim on every call.

### R3 — Per-call transcoder interface

`dsp.ts` exports a factory; Spec 05 creates **exactly one instance per Session**, stored on the Session object, never shared across calls (FR-3 isolation):

```ts
export interface Transcoder {
  /** Twilio media.payload (base64 μ-law 8k) → gateway input-audio-append.audio (base64). */
  twilioToGateway(payloadB64: string): string;
  /** Gateway audio-delta.delta (base64) → Twilio outbound media.payload (base64 μ-law 8k). */
  gatewayToTwilio(deltaB64: string): string;
  /** Reset outbound downsampler state. No-op in pcmu mode. See R11 for required call sites. */
  resetOutbound(): void;
  readonly mode: AudioMode;
}
export function createTranscoder(mode: AudioMode): Transcoder;
```

### R4 — Path A (`mode === 'pcmu'`): zero-copy base64 passthrough

Both `twilioToGateway` and `gatewayToTwilio` return their argument **unchanged — the same string reference, no decode, no re-encode, no copy** [findings/06 §Wiring, last line]. `resetOutbound()` is a no-op. Twilio's `audio/x-mulaw` 8000 Hz base64 and OpenAI's `audio/pcmu` are the same bytes; if the gateway honors pcmu (S1), the bridge does zero audio work. No `alawmulaw`, no tables touched on this path.

### R5 — Vendored μ-law codec (Path B) — do NOT use `alawmulaw`

Vendor the codec verbatim from findings/06 §Implementation-grade detail (the ~30-line Sun `ulaw.c` variant, full 16-bit domain, output range ±32124):

```ts
// ---- G.711 mu-law (Sun ulaw.c variant, full 16-bit domain, range ±32124) ----
const BIAS = 0x84, CLIP = 32635;
const MULAW_DECODE_EXP = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

function muLawDecodeSample(mu: number): number {
  mu = ~mu & 0xff;
  const exponent = (mu >> 4) & 0x07;
  const sample = MULAW_DECODE_EXP[exponent] + ((mu & 0x0f) << (exponent + 3));
  return (mu & 0x80) ? -sample : sample;
}
function muLawEncodeSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  sample += BIAS;
  if (sample > CLIP) sample = CLIP;
  let exponent = 7;
  for (let mask = 0x4000; !(sample & mask) && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;  // NOTE the & 0xff
}
// Precompute once per process (module top level):
export const MULAW_DEC = new Int16Array(256);
for (let i = 0; i < 256; i++) MULAW_DEC[i] = muLawDecodeSample(i);
export const MULAW_ENC = new Uint8Array(65536);            // 64 KB, index = pcm & 0xffff
for (let s = -32768; s <= 32767; s++) MULAW_ENC[s & 0xffff] = muLawEncodeSample(s);
```

Rules:

- Tables are **module-level, process-wide, shared read-only** across all calls (they are pure lookup data; per-call state lives only in the resamplers).
- **Do not add `alawmulaw` to package.json.** Reasons, all verified [findings/06 C8, gotchas 1–2]: (a) its UMD `main` with no `exports` field makes `import { mulaw } from 'alawmulaw'` throw `SyntaxError: Named export 'mulaw' not found` under Node ESM — a first-call runtime crash given the repo's `"type": "module"` toolchain decision [findings/10 G1]; (b) its `encodeSample()` returns the unmasked `~x` (e.g. `encodeSample(1000) === -50`), a footgun outside `Uint8Array` assignment; (c) the vendored tables measured ~40% faster (0.75 µs vs 1.07 µs per 160-sample decode+encode). Also do not use `wave-resampler` under any circumstance — one-shot zero-phase (forward-then-backward) filtering, non-causal, mutates its input, unusable for streaming [findings/06 C7].
- No extra `<< 2` scaling on decode — this table variant is already full-scale 16-bit [findings/06 C1]. Correct decode table check value: `MULAW_DEC[~0x80 & 0xff]`-class extremes reach ±32124.
- Known codec identity: `MULAW_ENC[MULAW_DEC[b] & 0xffff] === b` for 255 of 256 codes; the sole exception is `0x7F → 0xFF` (both encode ±0 — harmless) [findings/06 C1]. Tests assert exactly this (R12.3).

### R6 — Shared FIR design (Path B)

Verbatim from findings/06 §FIR design. Parameters are fixed and verified by measurement [findings/06 C12]: **48 taps, Hamming window, cutoff 3600 Hz, designed at fs = 24 kHz** (@3 kHz −0.4 dB, @4 kHz −17 dB, images ≤ −53 dB, in-band THD+N 83–99 dB — far above μ-law's ~38 dB SNDR floor, so never spend taps beyond 48 [findings/06 gotcha 9]). Taps must stay divisible by 3 for the polyphase split [findings/06 gotcha 8].

```ts
function designLowpassFIR(numTaps: number, cutoffHz: number, fs: number, gain = 1): Float64Array {
  const fc = cutoffHz / fs, M = numTaps - 1, h = new Float64Array(numTaps);
  let sum = 0;
  for (let n = 0; n < numTaps; n++) {
    const k = n - M / 2;                                   // M/2 = 23.5 for 48 taps: k never 0
    const sinc = k === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * k) / k;
    h[n] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M));  // Hamming
    sum += h[n];
  }
  for (let n = 0; n < numTaps; n++) h[n] = (h[n] / sum) * gain;     // unity DC gain × gain
  return h;
}
```

Upsampler prototype is designed with `gain = 3` (compensates ×3 zero-stuffing); downsampler with `gain = 1`.

### R7 — `Upsampler3x` (8 k → 24 k, ×3 polyphase; persistent state = 15 samples)

Verbatim from findings/06. Polyphase identity `y[3m + p] = Σₖ h[3k + p] · x[m − k]`: 3 phases × 16 taps, never materialize the zero-stuffed signal; 16 MACs per output sample. History = `perPhase − 1 = 15` input samples carried across chunks. Accepts **any input length** (Twilio frame size is not contractual [findings/06 gotcha 10; BRD §5.4]); output length is exactly `3 × input length`. Output samples are clamped to [−32768, 32767] and `Math.round`-ed.

```ts
export class Upsampler3x {
  private perPhase: number;
  private phases: Float64Array[];       // phases[p][k] = h[3k + p]
  private hist: Float64Array;           // last (perPhase − 1) = 15 input samples, oldest→newest

  constructor(numTaps = 48, cutoffHz = 3600) {
    const h = designLowpassFIR(numTaps, cutoffHz, 24000, 3);   // gain 3!
    this.perPhase = numTaps / 3;                               // must divide by 3
    this.phases = [0, 1, 2].map(p => {
      const c = new Float64Array(this.perPhase);
      for (let k = 0; k < this.perPhase; k++) c[k] = h[3 * k + p];
      return c;
    });
    this.hist = new Float64Array(this.perPhase - 1);
  }

  /** any input length; output length is exactly 3 × input length */
  process(pcm8k: Int16Array): Int16Array {
    const N = pcm8k.length, P = this.perPhase, H = P - 1;
    const x = new Float64Array(H + N);
    x.set(this.hist);
    for (let i = 0; i < N; i++) x[H + i] = pcm8k[i];
    const out = new Int16Array(N * 3);
    for (let m = 0; m < N; m++) {
      const base = H + m;
      for (let p = 0; p < 3; p++) {
        const c = this.phases[p];
        let acc = 0;
        for (let k = 0; k < P; k++) acc += c[k] * x[base - k];
        out[3 * m + p] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
      }
    }
    this.hist.set(x.subarray(x.length - H));                   // carry state across chunks
    return out;
  }
}
```

The class deliberately has **no `reset()` method** — the inbound direction must never be reset mid-call (R11).

### R8 — `Downsampler3x` (24 k → 8 k, LPF + ÷3 polyphase decimation; persistent state = 47 samples + mod-3 phase counter)

Verbatim from findings/06. FIR computed only at kept positions: `y[j] = Σₖ h[k] · x[3j − k]`. History = `numTaps − 1 = 47` input samples. The `phase` counter (input samples consumed mod 3) is **required, not optional**: gateway `audio-delta` sizes are not guaranteed to be multiples of 3 samples, or even even byte counts; dropping the counter silently time-shifts audio ⅓ sample per ragged chunk and drifts the `audioEndMs` alignment math [findings/06 gotcha 4].

```ts
export class Downsampler3x {
  private h: Float64Array;
  private numTaps: number;
  private hist: Float64Array;           // last (numTaps − 1) = 47 input samples
  private phase = 0;                    // input samples consumed mod 3

  constructor(numTaps = 48, cutoffHz = 3600) {
    this.h = designLowpassFIR(numTaps, cutoffHz, 24000, 1);
    this.numTaps = numTaps;
    this.hist = new Float64Array(numTaps - 1);
  }

  /** any input length; output length ≈ input/3 (exact accounting via phase) */
  process(pcm24k: Int16Array): Int16Array {
    const N = pcm24k.length, T = this.numTaps, H = T - 1;
    const x = new Float64Array(H + N);
    x.set(this.hist);
    for (let i = 0; i < N; i++) x[H + i] = pcm24k[i];
    const first = (3 - this.phase) % 3;                        // offset of first kept sample
    const count = first >= N ? 0 : Math.floor((N - first - 1) / 3) + 1;
    const out = new Int16Array(count);
    for (let j = 0; j < count; j++) {
      const center = H + first + 3 * j;
      let acc = 0;
      for (let k = 0; k < T; k++) acc += this.h[k] * x[center - k];
      out[j] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
    }
    this.phase = (this.phase + N) % 3;
    this.hist.set(x.subarray(x.length - H));
    return out;
  }

  reset(): void { this.hist.fill(0); this.phase = 0; }         // zero history = start-from-silence
}
```

### R9 — Path B conversion wrappers (inside `createTranscoder('transcode')`)

Each `transcode` Transcoder instance owns one `Upsampler3x` (`up`) and one `Downsampler3x` (`down`). Wrappers verbatim from findings/06 §Wiring:

```ts
// Inbound: Twilio media event → gateway input-audio-append
function twilioToGateway(payloadB64: string): string {
  const mu = Buffer.from(payloadB64, 'base64');                       // 160 B typical, not contractual
  const pcm8 = new Int16Array(mu.length);
  for (let i = 0; i < mu.length; i++) pcm8[i] = MULAW_DEC[mu[i]];
  const pcm24 = up.process(pcm8);
  return Buffer.from(pcm24.buffer, 0, pcm24.byteLength).toString('base64');  // 1280 chars per 20 ms
}

// Outbound: gateway audio-delta → Twilio media payload
function gatewayToTwilio(deltaB64: string): string {
  const raw = Buffer.from(deltaB64, 'base64');
  // zero-copy view needs even byteOffset & even length; fall back to a copy otherwise
  const pcm24 = (raw.byteOffset % 2 === 0 && raw.byteLength % 2 === 0)
    ? new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1)
    : new Int16Array(new Uint8Array(raw.subarray(0, raw.byteLength & ~1)).buffer);
  const pcm8 = down.process(pcm24);
  const mu = new Uint8Array(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) mu[i] = MULAW_ENC[pcm8[i] & 0xffff];
  return Buffer.from(mu).toString('base64');                          // any size is fine for Twilio (C11)
}
```

Hard rules baked into this code, each independently verified:

- **No outbound re-framing to 160-byte/20 ms chunks and no pacing loop** — Twilio docs: outbound `media` payloads can be "of any size", are buffered, and play in order; sending faster than realtime is fine. Barge-in responsiveness is preserved because `clear` flushes Twilio's buffer instantly (Spec 05's job) [findings/06 C11; findings/10 C8; BRD §5.4].
- **No WAV/file header bytes in either direction** — Twilio documents header bytes break playback; both legs are raw samples [findings/06 gotcha 7].
- **Endianness:** platform is little-endian and OpenAI PCM16 is little-endian, so `Int16Array` views are byte-correct with no swapping [findings/06 C9].
- **The defensive odd-offset/odd-length fallback is mandatory** — `Buffer.from(b64,'base64')` pool alignment (`byteOffset % 8 === 0` observed on Node 22) is an implementation detail, not a contract; a Node upgrade must not turn audio into noise [findings/06 C9, gotcha 5].
- **Never `new Int16Array(buf)` with a Buffer argument** — that copies per byte and yields garbage; only the 3-arg `(buf.buffer, buf.byteOffset, buf.byteLength >> 1)` form or an explicit even-length copy [findings/06 gotcha 6].
- `resetOutbound()` delegates to `down.reset()`; `up` has no reset path.

### R10 — Frame-math sanity constants

Export as `const` (used by tests, Spec 05 log sanity checks, and Spec 08 instrumentation):

```ts
export const FRAME_MS = 20;                    // observed Twilio cadence, NOT contractual
export const MULAW_BYTES_PER_20MS = 160;       // 8000 Hz × 0.02 s × 1 B
export const MULAW_B64_CHARS_PER_20MS = 216;   // ceil(160/3)·4
export const PCM24K_SAMPLES_PER_20MS = 480;    // 160 × 3
export const PCM24K_BYTES_PER_20MS = 960;      // 480 × 2 (16-bit LE mono)
export const PCM24K_B64_CHARS_PER_20MS = 1280; // 960/3·4  (~1.3 KB ≈ 0.5% of gateway 256 KB cap)
```

All values verified by execution [findings/06 C5]. These are sanity anchors only — no code may *assume* inbound frames are exactly 160 bytes (length-agnostic DSP is a hard requirement [findings/06 gotcha 10]).

### R11 — State lifecycle contract (integration points for Spec 05)

Per-call state = one `Transcoder` per Session object, created at Session construction, garbage-collected with it. Lifecycle rules [findings/06 gotcha 3; findings/10 T4]:

1. **Never reset the inbound upsampler mid-call.** Caller audio is one continuous stream; resetting would inject a boundary click (C6: stateless boundaries measured jumps up to 7995 vs 2339 in-chunk — an audible 50 Hz click track). Enforced structurally: `Upsampler3x` has no reset method.
2. **Reset the outbound downsampler at every response boundary.** Spec 05 MUST call `session.transcoder.resetOutbound()` in exactly two places when `AUDIO_MODE=transcode` (safe to call unconditionally — it is a no-op in pcmu mode):
   - in the `response-created` server-event handler (each response's audio is discontinuous with the previous one; 47 samples of stale tail otherwise colors the first ~2 ms of the next response);
   - inside the barge-in sequence (`bargeIn()`), alongside the Twilio `clear` / truncate steps of Spec 05.
   This is the T4 integration seam findings/10 calls out: findings/04's "complete" Session pseudocode omits it — Spec 05 must not copy that pseudocode without adding these two calls.
3. Reset semantics: zero history + phase 0 = starting from silence, which is correct for a fresh response [findings/06 §Downsampler comment].
4. No transcoder state is shared across Sessions (tables from R5 are shared; they are immutable).

### R12 — Unit tests (`test/dsp.test.ts`, node environment — never jsdom per G6; final vitest config owned by Spec 10, master plan R-1)

All thresholds come from measured values in findings/06 §Test strategy; every test is deterministic (fixed-frequency sines, no RNG).

1. **μ-law byte-exactness vs reference table** — assert `MULAW_DEC` matches the 256 values produced by the reference `muLawDecodeSample` (decode table `[0, 132, 396, 924, 1980, 4092, 8316, 16764]`, range ±32124), and spot-assert known pairs (e.g. `MULAW_DEC[0xFF] === 0`, extremes = ±32124).
2. **Codec round trip** — `MULAW_ENC[MULAW_DEC[b] & 0xffff] === b` for all 256 codes **except exactly `0x7F`, which must map to `0xFF`** (±0 pair) [findings/06 C1, test 1]. Any other exception fails.
3. **Chunked-vs-oneshot bit-identity (the critical one)** — generate a 1 kHz sine (≥ 1 s, amplitude 8000); process one-shot vs chunked in (a) 160-sample chunks and (b) ragged chunks `[100, 333, 481, 7, 480, 1000]` cycling; assert outputs **bit-identical (max diff 0)** for both `Upsampler3x` and `Downsampler3x` (downsampler ragged chunks specifically exercise the mod-3 phase counter with non-multiple-of-3 lengths) [findings/06 C6, test 2]. Any nonzero diff = broken state carry.
4. **Boundary-continuity / click detector (regression guard)** — 440 Hz sine, amplitude 8000, chunked processing: assert max `|y[i] − y[i−1]|` across chunk boundaries ≤ max within chunks (stateless processing measured 7995 vs 2339 — the failure signature) [findings/06 C6, test 3].
5. **Tone fidelity** — for f ∈ {300, 1000, 2000, 3000} Hz at amplitude 8000, round-trip 8 k→24 k→8 k; least-squares-project onto `A·sin + B·cos` at f over the steady-state region (projection sidesteps the fractional 47-sample@24 k cascade group delay — naive shifted comparison falsely reports ~4 dB); assert THD+N ≥ 60 dB and gain within ±1 dB below 3 kHz (measured: 83–99 dB, ≤ 0.4 dB) [findings/06 test 4, gotcha 8].
6. **Per-frame perf budget** — full production round trip (b64 → decode → upsample → b64; b64 → view → decimate → encode → b64) on 20 ms frames, ≥ 2,000 iterations after warmup: assert mean round trip **< 500 µs per frame** (measured 21.4 µs on desktop x64; the 23× headroom absorbs CI/shared-vCPU variance while still catching an accidentally quadratic refactor) [findings/06 C10, test 6; findings/10 S26, T5].
7. **Path A identity** — `createTranscoder('pcmu')`: both directions return the exact input string (`toBe`, reference equality), and `resetOutbound()` does not throw.
8. **Frame math** — R10 constants: base64 of a 160-byte buffer has length 216; base64 of a 960-byte buffer has length 1280; `up.process(new Int16Array(160)).length === 480`.
9. **Ragged/degenerate inputs** — zero-length input to both resamplers returns zero-length output without state corruption (subsequent chunks still bit-identical); odd-byte-length outbound delta exercises the copy fallback in `gatewayToTwilio` without throwing.

The manual sine-sweep-by-ear check (200 Hz→3.2 kHz through a live call; boundary defects audible as buzz even when unit tests pass) is part of the M1 procedure (R13), not CI [findings/06 test 5].

### R13 — M1 decision procedure (Path A first; README record; flip AUDIO_MODE)

Add to `README.md` an "M1 audio-format spike" section with this checklist; executing it is Milestone 1 work (BRD §10 M1), but the checklist text ships with this spec so the procedure is versioned:

1. Deploy with `AUDIO_MODE=pcmu`. Place one call.
2. Record from logs: `session-updated.raw` verbatim (does the applied config show `audio/pcmu` both directions? — S1), plus whether output audio is audibly correct (correct pitch/speed; wrong-rate symptoms are chipmunk/slow-motion audio).
3. If Path A works: record "pcmu honored: YES + raw excerpt" in the README results table; **keep `AUDIO_MODE=pcmu` as the production setting** (zero DSP on the hot path). The DSP module stays in the repo behind the flag — do not delete (`AUDIO_MODE` exists so the outcome is a config change, not a refactor [findings/06 gotcha 11]).
4. If Path A fails (error event, close, or garbage audio): record the failure evidence (`error.raw` / close code / symptom), flip the Railway variable to `AUDIO_MODE=transcode`, redeploy config, re-call. Before trusting Path B constants, confirm from `session-updated.raw` that the applied format is `audio/pcm` @ 24000 (S2).
5. One deliberate misconfig probe (once, then revert): send `{type:'audio/pcmu', rate: 8000}` and log whether the gateway rejects or ignores the rate (S3). Never ship this.
6. Manual sine-sweep-by-ear check on the winning path (R12 note).
7. If both paths produce audio: optionally compare `speech-stopped` timing across paths (S18, noise-reduction/VAD behavior on 8 kHz μ-law vs 24 kHz PCM input) and note gateway `audio-delta` chunk sizes/cadence (S17) for Spec 05's mark granularity decision.

README results table stub columns: `date · AUDIO_MODE tested · session-updated.raw excerpt · audible OK? · decision`.

## Acceptance criteria

- A1. `npm test` (vitest, node environment) passes all R12 tests on a clean checkout; the perf test asserts < 500 µs/frame round trip. (Backs BRD NFR "DSP is not a bottleneck"; findings/06 C10.)
- A2. `grep -r "alawmulaw\|wave-resampler" package.json src/` returns nothing — codec is vendored, forbidden packages absent (R5).
- A3. `audioFormatsFor('pcmu')` serializes to JSON containing no `rate` key in either format object; `audioFormatsFor('transcode')` contains `"rate":24000` in both (R2). Checkable by a one-line unit test.
- A4. Boot with `AUDIO_MODE=garbage` exits non-zero with a message naming `pcmu` and `transcode`; boot with it unset selects `transcode` (R1).
- A5. `createTranscoder('pcmu').twilioToGateway(s) === s` (reference equality) for an arbitrary base64 string — Path A is provably zero-copy (R4).
- A6. Chunked-vs-oneshot tests are bit-identical (max diff 0) for 160-sample and ragged `[100,333,481,7,480,1000]` chunking in both directions (R12.3) — the property that makes Twilio's "frame size not contractual" caveat safe (BRD §5.4).
- A7. `Upsampler3x` exposes no reset method (compile-time check: `'reset' in Upsampler3x.prototype === false` in a test); `Downsampler3x.reset()` + `Transcoder.resetOutbound()` exist and zero state (R7/R8/R11).
- A8. README contains the M1 spike checklist and empty results table (R13); after M1 execution the table has a recorded Path A result (BRD §10 M1 acceptance: "Path A (pcmu) tested first and result recorded in the README").
- A9. Spec 05's session code contains exactly two `resetOutbound()` call sites (`response-created` handler and `bargeIn()`) — verified at Spec 05 review against R11 (this criterion is a contract on Spec 05; it cannot pass or fail within this spec's files alone).

## Out of scope

- Session/WS wiring, event dispatch, mark queue, `clear`/truncate sequencing, and *when* `twilioToGateway`/`gatewayToTwilio` are invoked — Spec 05 (this spec only defines the transcoder contract and the two mandatory `resetOutbound()` call sites).
- Gateway connection, `session-update` assembly and send order — Spec 04/05 (this spec only supplies the format fragments).
- Latency instrumentation and `.raw` logging mechanics — Spec 08 (this spec only requires that `session-updated.raw` be observable for R13).
- The FR-7 canned μ-law apology clip (findings/10 G4/S23) — owned by Spec 09; note only that pre-encoding it as μ-law makes it Path-A-format and playable in both modes.
- A-law (`audio/pcma`) support; any sample rate other than 8 k/24 k; semantic-vad interactions.
- Executing the M1 spike itself (R13 ships the procedure; running it is milestone work).

## Open items deferred to runtime spikes (findings/10 Part 4)

- **S1** — does the gateway honor `audio/pcmu` end-to-end? Decides which path is production; both are built regardless. Observe: `session-updated.raw` + audible output (R13 steps 1–4).
- **S2** — is the gateway's applied default/PCM format really PCM16@24 kHz? Path B constants assume it; confirm from `session-updated.raw` before trusting (R13 step 4).
- **S3** — gateway behavior on `rate` sent alongside `audio/pcmu` (reject vs ignore)? Omit regardless; one deliberate misconfig probe (R13 step 5).
- **S17** — real gateway `audio-delta` chunk sizes/cadence (pcmu vs pcm). Correctness already handled (phase counter, odd-length fallback); informs Spec 05 mark granularity only.
- **S18** — does OpenAI input noise-reduction/VAD behave differently on 8 kHz μ-law vs 24 kHz PCM (perceived VAD latency shift between paths)? Compare `speech-stopped` timing if both paths work (R13 step 7).
- **S22** — actual Twilio inbound frame cadence/size on this account (expected 20 ms/160 B; DSP is length-agnostic either way).
- **S26** — Railway shared-vCPU multiplier on the 21.4 µs/frame benchmark (expected ≤ 5×, still negligible); observe in M4 concurrency summaries. The CI budget (R12.6, < 500 µs) already absorbs it.

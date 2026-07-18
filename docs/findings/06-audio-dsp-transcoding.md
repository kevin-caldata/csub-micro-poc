# Findings 06 — Audio Formats & the DSP Transcode Path

**Date:** 2026-07-18 · **Verifier:** research agent (audio/DSP domain) · **BRD sections covered:** §5.5 (two-path audio decision), parts of §5.3 (format config), §5.4 (Twilio media contract as it touches DSP)

**Scope.** Independently verify and deepen: G.711 μ-law codec math; whether OpenAI realtime natively supports μ-law (`audio/pcmu`) and at what rate; the PCM16@24 kHz default; streaming 8 k↔24 k sample-rate conversion with persistent per-call state; why chunk-boundary state matters; frame math; the `alawmulaw` and `wave-resampler` npm packages; Node Buffer/Int16Array/base64 mechanics; realistic per-frame CPU cost; Twilio outbound re-framing. All numeric claims below were **verified by executing code** (Node v22.14.0, Windows x64) against installed package source in the scratchpad (`dsp-verify/` project); package claims were verified by reading the published tarball source, not docs.

---

## Verified claims

### C1. G.711 μ-law codec math — **VERIFIED** (source read + exhaustive execution)

The canonical algorithm (Sun Microsystems `ulaw.c`, the same code Twilio-ecosystem tools use) is exactly what `alawmulaw@6.0.0` ships (`node_modules/alawmulaw/lib/mulaw.js`):

- **Encode** (PCM16 → 8-bit μ-law): sign-magnitude split via `sign = (sample >> 8) & 0x80`, negate if negative, add `BIAS = 0x84` (132), clip at `CLIP = 32635`, exponent from a 256-entry log-segment table indexed by `(sample >> 7) & 0xFF`, `mantissa = (sample >> (exponent + 3)) & 0x0F`, output `~(sign | exponent << 4 | mantissa)` (bit-inverted per G.711).
- **Decode** (8-bit μ-law → PCM16): invert bits, `exponent = (b >> 4) & 7`, `mantissa = b & 0x0F`, `sample = decodeTable[exponent] + (mantissa << (exponent + 3))`, negate on sign bit, with `decodeTable = [0, 132, 396, 924, 1980, 4092, 8316, 16764]`.
- Output range is **±32124** — this table variant already produces full-scale 16-bit values; **no extra `<< 2` scaling is needed** (that shift is only for the 14-bit-domain table variant `[0, 33, …]·4`).
- The BRD's "256-entry decode table" framing is correct for the production decode path: precompute `Int16Array(256)` once per process. Encode is best done with a precomputed **65,536-entry `Uint8Array`** indexed by `sample & 0xFFFF` (64 KB, shared, fastest — measured below).
- Round-trip identity `encode(decode(b)) === b` holds for **255 of 256** codes; the sole exception is `0x7F → 0xFF` (both encode ±0 — harmless, verified by execution).
- μ-law itself has ≈ 38 dB SNDR on speech (13-bit-equivalent companding, standard literature value) — this, not the resampler, is the quality floor of Path B.

### C2. OpenAI realtime natively supports G.711 μ-law at 8 kHz — **VERIFIED** (openai@6.48.0 SDK types, the machine-readable GA schema)

`openai@6.48.0` `resources/realtime/realtime.d.ts`:

```ts
export type RealtimeAudioFormats = AudioPCM | AudioPCMU | AudioPCMA;
interface AudioPCM  { rate?: 24000;        type?: 'audio/pcm';  } // "Only a 24kHz sample rate is supported."
interface AudioPCMU {                      type?: 'audio/pcmu'; } // "The G.711 μ-law format."
interface AudioPCMA {                      type?: 'audio/pcma'; } // "The G.711 A-law format."
```

- `audio/pcmu` **takes no `rate` field** — G.711 is defined at 8000 Hz (ITU-T G.711), matching Twilio's `audio/x-mulaw` 8000 exactly. **Do not send a `rate` with `audio/pcmu`.**
- The beta API's flat `input_audio_format: 'pcm16' | 'g711_ulaw' | 'g711_alaw'` still exists in the types with docstring: *"For `pcm16`, input audio must be 16-bit PCM at a 24kHz sample rate, single channel (mono), and little-endian byte order."* — this is the authoritative statement of PCM sample layout (16-bit LE mono).
- Default when unspecified: *"defaults to PCM 16-bit 24kHz mono"* (assistant-message audio docstring, same file). So the **PCM16@24 kHz default is VERIFIED at the OpenAI layer**; whether the *gateway* leaves that default untouched is still the M1 spike (see C4).

### C3. The normalized protocol types `audio/pcmu` — **VERIFIED, with a nuance**

`@ai-sdk/provider@4.0.3` `dist/index.d.ts` (`RealtimeModelV4SessionConfig`, ~line 6405/6461):

```ts
inputAudioFormat?: {
  type: string;   // "Audio format type (e.g. \"audio/pcm\", \"audio/pcmu\", \"audio/pcma\")."
  rate?: number;  // "Sample rate in Hz. Only applicable for PCM format."
};
outputAudioFormat?: { type: string; rate?: number; }; // same shape
```

**Nuance vs BRD:** the type is a plain `string` with pcmu only in the docstring — there is **no compile-time enum**, so nothing client-side guarantees the gateway honors it. And `@ai-sdk/gateway@4.0.23` is a pure identity codec at the client: `parseServerEvent(raw) { return raw; }`, `serializeClientEvent(event) { return event; }`, `buildSessionConfig(config) { return config; }` (dist/index.js ~line 2274). All format mapping happens server-side (closed source) → the BRD's [SPIKE] for Path A stands and is correctly scoped.

### C4. Gateway default output = PCM16@24 kHz — **LIKELY** (inherited from OpenAI default; unverifiable without runtime)

Nothing in the gateway client source sets a default audio format; the gateway server presumably forwards OpenAI's default (`audio/pcm` @ 24000, C2). Confirm at M1 via `session-updated.raw`. Path B must assume 24 kHz until then — correct per BRD.

### C5. Frame math — **VERIFIED by execution**

| Quantity | Value | Check |
|---|---|---|
| 20 ms μ-law @ 8 kHz | 160 bytes | Twilio's observed frame |
| its base64 | **216 chars** | `ceil(160/3)·4 = 216` ✔ measured |
| 20 ms PCM16 @ 24 kHz | 480 samples = **960 bytes** | 160 × 3 ✔ |
| its base64 | **1280 chars ≈ 1.3 KB** | `960/3·4 = 1280` ✔ measured — BRD's "~1.3 KB" exact |
| vs gateway 256 KB message cap | 0.5 % of cap | non-issue |

### C6. Chunk-boundary state matters (clicks) — **VERIFIED by execution**

- Stateful chunked processing (my implementations below) is **bit-identical** to one-shot whole-signal processing: max sample diff **0** in both directions, for 160-sample chunks *and* ragged chunk sizes (100/333/481/7/480/1000) — the Twilio "frame size not contractual" caveat is fully handled by state + a decimator phase counter.
- Stateless per-chunk processing (fresh filter each chunk, i.e. the `wave-resampler` usage pattern) on a 440 Hz sine at amplitude 8000 produced inter-sample jumps up to **7995 at chunk boundaries** vs 2339 max within chunks — i.e. a near-full-signal-amplitude step **every 20 ms → a 50 Hz buzz/click track** superimposed on all audio. This is why persistent per-call filter state is mandatory, exactly as the BRD says.

### C7. `wave-resampler@1.0.0` unsuitable for streaming — **VERIFIED from source**

`node_modules/wave-resampler/index.js`: `resample(samples, oldRate, newRate)` is **one-shot whole-buffer**, and worse than merely stateless:
- It runs the LPF **forward then backward** over the buffer (zero-phase filtering) — non-causal, requires the entire signal, impossible in streaming.
- `downsample_` **mutates the caller's input array in place** while filtering.
- Returns `Float64Array` (needs re-quantizing), default method is `cubic` with an IIR Butterworth LPF (order 16).
- The `Interpolator` is constructed per call from buffer lengths — per-chunk use restarts everything at each boundary → the C6 click. One release (2020-01), effectively unmaintained. **Do not use.** BRD correct.

### C8. `alawmulaw@6.0.0` — **VERIFIED suitable for the codec half, with import/masking gotchas**

- Latest is 6.0.0 (published 2022-04-11; repo dormant, 0 open issues, MIT, ~48 stars). Pure JS, zero deps, `engines: node >= 8`.
- API (from `index.d.ts`): `mulaw.decode(Uint8Array): Int16Array`, `mulaw.encode(Int16Array): Uint8Array`, plus per-sample `decodeSample`/`encodeSample` (and an `alaw` namespace with the same shape).
- **Correctness verified exhaustively**: its decode matches my reference for all 256 codes (max diff 0); encode matches for all tested PCM values (0 diffs across the 16-bit range, stride 7).
- **Gotcha 1:** `encodeSample()` returns the **unmasked** `~x` (e.g. `encodeSample(1000) === -50`, verified) — correct only when assigned into a `Uint8Array` (which the array-level `encode()` does); mask `& 0xFF` if you use it standalone.
- **Gotcha 2 (build-breaking):** package `main` is a UMD bundle with no `exports` field. In Node ESM, `import { mulaw } from 'alawmulaw'` **throws** `SyntaxError: Named export 'mulaw' not found` (verified). Use `import pkg from 'alawmulaw'; const { mulaw } = pkg;` — or CJS `require('alawmulaw').mulaw`, which works.
- **Verdict:** fine to use, but the whole codec is ~30 lines and a hand-rolled table version measured **faster** (0.75 µs vs 1.07 µs per 160-sample decode+encode). Recommendation: **vendor the two tables** (code below) and skip the dependency; either choice is acceptable.

### C9. Node Buffer / Int16Array / base64 mechanics — **VERIFIED by execution**

- Platform is little-endian (verified; all Railway/x86-64 and ARM64 Node targets are LE), and OpenAI's PCM16 wire format is little-endian (C2) — so `Int16Array` views over buffers are byte-correct with **no swapping**.
- `Buffer.from(b64, 'base64')` allocates from Node's 8 KB pool; observed `byteOffset % 8 === 0` across 200 allocations (Node's `alignPool` rounds the pool offset to 8). An even offset is required for a zero-copy `Int16Array` view; alignment is an implementation detail, so use the defensive pattern in the implementation section.
- `Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64')` round-trips exactly (verified).

### C10. Per-frame CPU cost — **VERIFIED by benchmark** (consistent with the BRD's number)

Full production path per 20 ms frame, 20,000 iterations, Node 22.14.0, desktop x64:

| Path | Work | Cost |
|---|---|---|
| Inbound | b64-decode → μ-law table decode (160) → ×3 polyphase 48-tap upsample → b64-encode | **10.9 µs** |
| Outbound | b64-decode → Int16 view → 48-tap polyphase decimate ÷3 → μ-law table encode → b64-encode | **10.4 µs** |
| **Round trip** | | **21.4 µs ≈ 0.107 % of one core per call** |

BRD's "~32 µs / ~0.16 %" is the same order (different hardware); even at a 5× shared-vCPU penalty on Railway, 5 concurrent calls ≈ 2–3 % of one core. **DSP is confirmed not a bottleneck.** μ-law codec alone: 0.75 µs/frame (tables) vs 1.07 µs (alawmulaw).

### C11. Twilio outbound re-framing — **VERIFIED against Twilio docs: chunk size does NOT matter**

Twilio Media Streams docs (websocket-messages), outbound `media` to Twilio: payload must be `audio/x-mulaw`, 8000 Hz, base64, **"The audio can be of any size"**, **"The media.payload should not contain audio file type header bytes"** (raw μ-law only — no WAV header), and **"The media messages are buffered and played in the order received"**. Consequences:
- **No re-framing to 160-byte/20 ms chunks and no pacing loop is needed.** Transcode each gateway `audio-delta` as it arrives and send it as one `media` message; Twilio buffers and plays in order. (You may send faster than realtime.)
- The only outbound sizing constraint is your own barge-in responsiveness: what's already in Twilio's buffer plays until you send `clear` — which flushes it instantly, so even multi-second buffered leads are fine given the BRD §5.6 `clear`-first sequence.
- `mark` after each media send is echoed **after that audio finishes playing** (and all pending marks return early on `clear`) — this is what makes `audioEndMs` truncation math work; unchanged by chunk size.

### C12. Filter design & fidelity — **VERIFIED by measurement** (design params below)

48-tap Hamming windowed-sinc prototype at fs = 24 kHz, measured magnitude response and round-trip (8 k→24 k→8 k) tone THD+N via sin/cos projection (immune to the cascade's fractional group delay):

| Cutoff | @3 kHz | @3.4 kHz | @4 kHz (Nyquist₈ₖ) | @≥4.6 kHz (first image of 3.4 k) | In-band THD+N |
|---|---|---|---|---|---|
| 3400 Hz | −1.3 dB | −6.0 dB | −27 dB | ≤ −53 dB | ≥ 75 dB |
| **3600 Hz (recommended)** | **−0.4 dB** | **−3.1 dB** | **−17 dB** | **≤ −53 dB** | ≥ 75 dB (83–99 dB at 300 Hz–3 kHz) |
| 3800 Hz | −0.1 dB | −1.3 dB | −10.6 dB | ≤ −43 dB | — |

In-band THD+N of 75–99 dB is ~40 dB better than μ-law's own ~38 dB floor — 48 taps is more than sufficient; 72 taps bought nothing audible (verified). PSTN audio has essentially no energy above 3.4 kHz, so the modest attenuation right at 4 kHz is irrelevant in practice. Group delay: 23.5 samples @24 k ≈ **0.98 ms per direction (~2 ms round trip)** — negligible against the 1.0–1.5 s latency budget.

---

## Implementation-grade detail

Everything below was executed and tested (bit-identical chunked-vs-oneshot, ragged chunks, tone SNR, benchmark) — a build agent can lift it verbatim into `src/dsp.ts`.

### μ-law codec (vendored tables — no dependency needed)

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
// Precompute once per process:
export const MULAW_DEC = new Int16Array(256);
for (let i = 0; i < 256; i++) MULAW_DEC[i] = muLawDecodeSample(i);
export const MULAW_ENC = new Uint8Array(65536);            // 64 KB, index = pcm & 0xffff
for (let s = -32768; s <= 32767; s++) MULAW_ENC[s & 0xffff] = muLawEncodeSample(s);
```

If using `alawmulaw@6.0.0` instead: `import pkg from 'alawmulaw'; const { mulaw } = pkg;` (named ESM import breaks — C8), then `mulaw.decode(Uint8Array): Int16Array` / `mulaw.encode(Int16Array): Uint8Array`. Identical output, ~40 % slower, both negligible.

### FIR design (shared by both directions)

Parameters: **48 taps, Hamming window, cutoff 3600 Hz, designed at fs = 24 kHz** (C12). Upsampler prototype gets **gain = 3** baked in (compensates zero-stuffing); downsampler gain = 1.

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

### Upsampler 8 k → 24 k (×3 polyphase; persistent state = 15 samples)

Polyphase identity: `y[3m + p] = Σₖ h[3k + p] · x[m − k]` — never materialize the zero-stuffed signal. 48 taps → 3 phases × 16 taps; per output sample only 16 MACs.

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

### Downsampler 24 k → 8 k (LPF + ÷3 decimation; persistent state = 47 samples + phase counter)

Compute the FIR **only at kept positions** (polyphase decimation): `y[j] = Σₖ h[k] · x[3j − k]`. The `phase` counter makes non-multiple-of-3 chunk lengths seamless (gateway `audio-delta` sizes are not guaranteed to be multiples of 3 samples).

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

  reset(): void { this.hist.fill(0); this.phase = 0; }         // call at each new response (see gotchas)
}
```

### Wiring it into the Session (Path B, `AUDIO_MODE=transcode`)

```ts
// Per-call state (in the Session object): one of each, NEVER shared across calls
const up = new Upsampler3x();     // Twilio → gateway; never reset mid-call
const down = new Downsampler3x(); // gateway → Twilio; reset() on each new response

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

Path A (`AUDIO_MODE=pcmu`): both functions become the identity on the base64 string — pass `media.payload` straight through in both directions.

### Session config to request each path (normalized protocol, §5.3 shape)

```jsonc
// Path A (spike first):
{ "inputAudioFormat": { "type": "audio/pcmu" }, "outputAudioFormat": { "type": "audio/pcmu" } }
// NO rate field with pcmu — G.711 is fixed 8 kHz; the GA OpenAI schema has no rate on pcmu (C2).

// Path B (baseline):
{ "inputAudioFormat": { "type": "audio/pcm", "rate": 24000 }, "outputAudioFormat": { "type": "audio/pcm", "rate": 24000 } }
// 24000 is the ONLY supported PCM rate (C2). Confirm applied format via session-updated.raw.
```

### Test strategy (all implemented and passing in the scratchpad; port into the repo's tests)

1. **Codec round trip:** `MULAW_ENC[MULAW_DEC[b] & 0xffff] === b` for all 256 codes except `0x7F → 0xFF` (±0 pair). If using alawmulaw, additionally assert its output matches the vendored tables for all 256 / a sweep of the 16-bit range.
2. **Boundary continuity (the critical one):** process a 1 kHz sine one-shot vs chunked (a) in 160-sample chunks, (b) in ragged chunks `[100, 333, 481, 7, 480, 1000]` — outputs must be **bit-identical** (max diff 0; measured 0 for both directions). Any nonzero diff = broken state carry.
3. **Click detector (regression guard):** on a 440 Hz sine, assert max `|y[i] − y[i−1]|` at chunk boundaries ≤ max within chunks (stateless processing measured 7995 vs 2339 — a click; stateful must show no boundary excess).
4. **Tone fidelity:** for f ∈ {300, 1000, 2000, 3000} Hz at amplitude 8000, round-trip 8 k→24 k→8 k, least-squares-fit `A·sin + B·cos` at f over the steady-state region (projection sidesteps the cascade's fractional 47-sample@24 k group delay — naive integer-shift comparison on a chirp falsely reports ~4 dB), assert THD+N ≥ 60 dB and |gain| within 1 dB below 3 kHz. (Measured: 83–99 dB, ≤ 0.4 dB.)
5. **Sine sweep by ear (manual, M1):** play a 200 Hz→3.2 kHz sweep through the full call path; boundary defects are audible as buzz even when single-frame tests pass.
6. **Bench guard (optional):** assert round-trip per-20 ms-frame cost < 500 µs on CI (measured 21 µs) so a future refactor can't silently go quadratic.

---

## Gotchas & pitfalls

1. **`import { mulaw } from 'alawmulaw'` crashes Node ESM** (`Named export 'mulaw' not found` — UMD main, no `exports` field). Use default-import destructuring or vendor the tables. This would otherwise be a runtime crash on first call.
2. **`encodeSample()` returns a negative (unmasked `~`) value** — mask `& 0xFF` anywhere it isn't being assigned into a `Uint8Array`.
3. **Never reset the inbound upsampler mid-call** (caller audio is continuous). **Do reset the outbound downsampler at each new response** (`response-created` or first `audio-delta` of a new response, and on barge-in): audio is discontinuous across responses, and 47 samples of a previous response's tail otherwise colors the first ~2 ms of the next one. Reset = zero history (equivalent to starting from silence — correct).
4. **Decimator phase counter is required**, not optional: gateway `audio-delta` payload sizes are not guaranteed to be multiples of 3 samples (or even to be even byte counts — hence the defensive odd-offset/odd-length fallback in `gatewayToTwilio`). Dropping the counter silently time-shifts audio by ⅓ sample per ragged chunk and drifts A/V-style alignment of `audioEndMs` math.
5. **`Buffer.from(b64, 'base64').byteOffset` alignment is an implementation detail.** Observed always 8-aligned on Node 22 (pool `alignPool`), but the zero-copy `Int16Array` view must guard `byteOffset % 2` anyway (pattern above) — a Node upgrade changing pool behavior must not corrupt audio into noise.
6. **Do not double the sample count via `Uint8Array` misuse:** `new Int16Array(buf)` (passing a Buffer, not its `.buffer`) *copies per byte*, yielding garbage. Always the 3-arg `new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1)` form or an explicit even-length copy.
7. **No WAV/file headers anywhere** — Twilio explicitly documents that header bytes in `media.payload` break playback; both directions are raw samples.
8. **Even tap count (48) ⇒ fractional group delay** (23.5 samples @24 k per stage). Irrelevant audibly and for latency (~2 ms round trip), but it is why naive shifted-reference SNR tests mislead — use the projection test (Test 4). Keep taps divisible by 3 for clean polyphase split (48 ✔).
9. **μ-law is the quality ceiling (~38 dB SNDR), not the resampler** — don't burn time on >48-tap filters; inaudible through a phone.
10. **Twilio inbound frame size is not contractual** (BRD §5.4 correct) — all DSP here is length-agnostic; keep it that way.
11. **Path A first**: if `audio/pcmu` is honored end-to-end, delete/flag-off all of the above (base64 passthrough both ways, zero DSP). The DSP module must live behind `AUDIO_MODE` so the spike outcome is a config change, not a refactor.

---

## Open questions (need runtime spike — align with BRD M1)

1. **Does the gateway's server-side mapping honor `audio/pcmu`?** Client SDK is an identity codec (C3); OpenAI supports it natively (C2); the gateway hop is the only unknown. M1: send Path A `session-update`, check `session-updated.raw` and audible output.
2. **Is the gateway's default/`session-updated` applied format actually `audio/pcm` @ 24 kHz** (as OpenAI's default implies)? Confirm from `.raw` before trusting Path B constants.
3. **Does the gateway reject or ignore a `rate` field sent alongside `audio/pcmu`?** Omit it regardless (GA schema has no such field), but log behavior if misconfigured.
4. **Real gateway `audio-delta` chunk sizes** (bytes per delta, even/odd, cadence) — affects nothing correctness-wise (handled), but informs the mark-queue granularity for `audioEndMs` precision.
5. **Railway shared-vCPU multiplier** on the 21 µs/frame benchmark — expected ≤ 5×, still negligible; confirm in M4 concurrency test (5 calls ≈ a few % of a core predicted).
6. **Whether OpenAI applies its input noise-reduction/VAD differently for 8 kHz μ-law vs 24 kHz PCM input** (could shift perceived VAD latency between Path A and Path B) — compare `speech-stopped` timing across paths during M1 if both work.

---

## Sources

- `alawmulaw@6.0.0` published tarball — `lib/mulaw.js`, `index.d.ts`, `package.json` (installed at `…\scratchpad\dsp-verify\node_modules\alawmulaw\`); repo https://github.com/rochars/alawmulaw (MIT, 0 open issues, dormant since ~2019/2022)
- `wave-resampler@1.0.0` published tarball — `index.js`, `lib/fir-lpf.js` (same scratchpad); repo https://github.com/rochars/wave-resampler
- `@ai-sdk/provider@4.0.3` — `dist/index.d.ts` (`RealtimeModelV4SessionConfig`, audio format shapes)
- `@ai-sdk/gateway@4.0.23` — `dist/index.js` (identity `parseServerEvent`/`serializeClientEvent`/`buildSessionConfig`, ~line 2274)
- `openai@6.48.0` — `resources/realtime/realtime.d.ts` (`RealtimeAudioFormats`: `audio/pcm` rate 24000 only, `audio/pcmu`, `audio/pcma`; "16-bit PCM at a 24kHz sample rate, single channel (mono), and little-endian byte order"; default "PCM 16-bit 24kHz mono")
- Twilio Media Streams WebSocket messages — https://www.twilio.com/docs/voice/media-streams/websocket-messages ("The audio can be of any size"; "must be encoded audio/x-mulaw with a sample rate of 8000 and must be base64 encoded"; "buffered and played in the order received"; no file-header bytes; mark/clear semantics)
- OpenAI realtime guide — https://developers.openai.com/api/docs/guides/realtime-conversations (session format examples `{"type":"audio/pcm","rate":24000}`, `{"type":"audio/pcmu"}`)
- OpenAI community thread on GA μ-law format naming — https://community.openai.com/t/gpt-realtime-2-ga-api-what-is-the-correct-audio-format-for-g711-ulaw-twilio-telephony/1380750 (documents beta→GA naming confusion; resolved here via SDK types)
- Executed verification code: `…\scratchpad\dsp-verify\dsp-test.mjs` (codec equivalence, round trip, chunked-vs-oneshot, stateless-click demo, Buffer/base64/endianness, benchmark) and `…\scratchpad\dsp-verify\snr-test.mjs` (frequency response + projection THD+N), Node v22.14.0 x64
- ITU-T G.711 (μ-law companding, 8000 Hz) — standard reference for rate and companding math

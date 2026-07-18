# T06.3 — `createTranscoder` (Path A zero-copy / Path B wrappers) + `audioFormatsFor`

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Export the per-call `Transcoder` factory (Path A = same-string-reference passthrough; Path B = base64 μ-law ⇄ PCM16@24k streaming wrappers) and the `audioFormatsFor` session-update fragments consumed by Specs 04/05.

**Wave:** B · **Depends on:** T06.2 · **Blocks:** T05, T06.4, T06.5

**References:**
- `docs/specs/06-audio-dsp-transcoding.md` — R2 (format fragments, verbatim + exact rules), R3 (Transcoder interface, verbatim), R4 (Path A), R9 (Path B wrappers, verbatim + hard rules), R11 (lifecycle contract — read so `resetOutbound` semantics are right), R12.7, R12.9 (wrapper half), A3, A5, A7 (resetOutbound part)
- `docs/findings/06-audio-dsp-transcoding.md` — §C2 (no `rate` on pcmu; pcm rate 24000 LE), §C9 (Buffer/Int16Array/base64 mechanics), §C11 (no re-framing/pacing), §Wiring, gotchas 5, 6, 7
- `docs/specs/04-gateway-realtime-leg.md` — §Interfaces around `OpenGatewayLegOptions.formats` (line ~142) — the consumer shape `{ inputAudioFormat; outputAudioFormat }` your return type must satisfy
- `docs/specs/05-session-bridge-and-barge-in.md` — Session field `transcoder: Transcoder` and §A13 (the two `resetOutbound()` call sites live in Spec 05, NOT here)
- `docs/specs/00-master-build-plan.md` — C7, C8, T4 decision-register rows

## Interfaces

**Consumes:** `MULAW_DEC`, `MULAW_ENC`, `Upsampler3x`, `Downsampler3x` from T06.1/T06.2 (same file `src/dsp.ts`).

**Produces** (appended to `src/dsp.ts` — these exact names are consumed by Spec 05 `src/session.ts` and injected into Spec 04's `openGatewayLeg(opts.formats)`):
- `export type AudioMode = 'pcmu' | 'transcode'`
- `export function audioFormatsFor(mode: AudioMode): { inputAudioFormat: { type: string; rate?: number }; outputAudioFormat: { type: string; rate?: number } }` — pcmu objects carry structurally NO `rate` key; transcode objects carry `rate: 24000` both directions (Spec 06 R2 — never add `rate: 8000` "helpfully").
- `export interface Transcoder { twilioToGateway(payloadB64: string): string; gatewayToTwilio(deltaB64: string): string; resetOutbound(): void; readonly mode: AudioMode }`
- `export function createTranscoder(mode: AudioMode): Transcoder` — each `'transcode'` instance owns one private `Upsampler3x` + one `Downsampler3x` (per-call state, never shared — Spec 06 R11.4); `resetOutbound()` delegates to `down.reset()` and is a no-op in pcmu mode.

## Steps

- [ ] Read Spec 06 R2–R4, R9, R11 and findings/06 §C9/§C11/§Wiring/gotchas 5–7 in full.
- [ ] Append to `src/dsp.test.ts`:
  - A3: `JSON.stringify(audioFormatsFor('pcmu'))` contains no `"rate"` substring and `('rate' in audioFormatsFor('pcmu').inputAudioFormat) === false` (both directions); `audioFormatsFor('transcode')` serializes with `"rate":24000` in both objects and `type` `'audio/pcm'`.
  - A5 / R12.7: for an arbitrary base64 string `s`, `createTranscoder('pcmu').twilioToGateway(s)` and `.gatewayToTwilio(s)` are `===` the SAME reference (strict-equality assertion on identity, not just value); `resetOutbound()` does not throw; `.mode === 'pcmu'`.
  - Path B correctness: build a known 160-byte μ-law frame (encode a 20 ms 1 kHz sine via `MULAW_ENC`), run `twilioToGateway` → expect a base64 string of length `PCM24K_B64_CHARS_PER_20MS` (1280); run a 960-byte PCM16LE base64 delta through `gatewayToTwilio` → expect 216-char base64 (R12.8 through the wrappers); decoded output bytes must equal running the same samples through the tables+resamplers directly (wrapper adds no headers, no re-framing — findings/06 gotcha 7, C11).
  - R12.9 (wrapper half): an odd-byte-length base64 delta exercises the copy fallback in `gatewayToTwilio` without throwing, and the following even-length delta still transcodes (state intact).
  - `resetOutbound()` on a `'transcode'` instance makes the next `gatewayToTwilio` output equal a fresh instance's output for the same delta (delegates to `down.reset()`), while `twilioToGateway` continuity is unaffected (inbound upsampler never reset — Spec 06 R11.1).
- [ ] Run `npm test` — expect FAIL (exports missing).
- [ ] Implement per Spec 06 R2/R3/R4/R9 — vendor the wrapper bodies verbatim from R9, preserving all five hard rules (no re-framing/pacing; no header bytes; LE `Int16Array` views; mandatory odd-offset/odd-length copy fallback; never `new Int16Array(buf)` with a Buffer argument).
- [ ] Run `npm test` — expect PASS.
- [ ] Run `npm run typecheck` — expect exit 0 (confirms the `audioFormatsFor` return shape is assignable where Spec 04 declares `OpenGatewayLegOptions['formats']` once T05 wires it).
- [ ] Commit: `git add src/dsp.ts src/dsp.test.ts` then `git commit -m "feat(dsp): createTranscoder paths A/B and audioFormatsFor fragments" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

## Acceptance

- Discharges Spec 06 A3 (format fragments), A5 (Path A provably zero-copy), and the `resetOutbound` part of A7. Extends A1 partial (R12.7, R12.8-wrappers, R12.9-wrapper).
- A9 is a contract on Spec 05 (exactly two `resetOutbound()` call sites: `response-created` + `bargeIn()`); it is verified at T05 review — note it in the report, do not implement anything for it here.

## Completion Report

```
Task: T06.3 — status: [done/blocked]
Files changed: [list]
Commands run: [npm test → result; npm run typecheck → result]
Spec A-numbers verified: A3, A5; A7 (resetOutbound); A1 partial (R12.7, R12.8, R12.9)
Deviations from plan: [none or list]
New interfaces exposed: AudioMode, audioFormatsFor, Transcoder, createTranscoder (src/dsp.ts) — consumed by T05 (session) and injected into T04 opts.formats
Notes for ledger: [remind orchestrator: A9 contract lands on T05 — two resetOutbound() call sites]
```

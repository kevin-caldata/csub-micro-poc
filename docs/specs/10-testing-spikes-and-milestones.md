# Spec 10 — Testing, Spikes & Milestone Acceptance
Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Draft for review
Depends on: 01, 02, 03, 04, 05, 06, 07, 08, 09 (this spec tests everything the other specs build) · Enables: none (terminal — it produces the M5 deliverable)
Findings referenced: findings/10 (full — S1–S35, G1–G7, C1–C18), findings/09 (§V1–V12, Impl 1–10, gotchas 1–13), findings/06 (§Test strategy 1–6, C1, C6, C8, C10, gotcha 3), findings/05 (C8–C10, Impl client/server), findings/04 (V3–V7, D1–D6, G1–G8, O1–O7), findings/03 (claims 4, 5, 9, 14, 15, Impl A–F), findings/02 (vendored protocol, corrections 1–11), findings/01 (claims 2, 8–15, Impl 1/9/10/11, gotchas 5, 6, 9, 10, 14), findings/07 (claims 6, 9, 12), findings/08 (drain section, error matrix)

---

## Objective

When this spec is done, the repo has (a) an offline test suite (vitest, node environment) covering DSP, mu-law tables, tool mapping, the barge-in state machine (including the stale-epoch regression), mark accounting, config validation, and the logger; (b) an offline integration harness — a fake-Twilio WS client and a fake-gateway WS server — that drives the real bridge through a full scripted conversation with zero network access; (c) executable, ordered protocols for the M1 audio spike and M2/M3/M4 milestone acceptance, each with named evidence; and (d) the M5 findings-report README template including the S1–S35 spike-answer table. This spec is the operational plan that converts findings/10's spike list into recorded answers.

## Deliverables

Create:
- `vitest.config.ts`
- `test/env-guard.test.ts`
- `test/dsp.test.ts`
- `test/tool-mapping.test.ts`
- `test/bargein.test.ts`
- `test/marks.test.ts`
- `test/config.test.ts`
- `test/logger.test.ts`
- `test/fakes/fake-gateway.ts` (WS server: importable module + `node`-runnable CLI entry)
- `test/fakes/fake-twilio.ts` (WS client: importable module + CLI entry)
- `test/harness.test.ts` (integration: boots the real Fastify app against the fakes)
- `scripts/concurrency-probe.ts` (S24 gateway-session ramp)

(Offline cross-call percentile aggregation is Spec 08's `scripts/aggregate-latency.mjs` — this spec exercises it against fixtures and wires the npm script; it does NOT ship a second aggregator.)

Modify:
- `package.json` — add `"test": "vitest run"`, `"probe:concurrency": "tsx scripts/concurrency-probe.ts"`, `"aggregate": "node scripts/aggregate-latency.mjs"`; add `vitest` to devDependencies (exact-pinned, see R1)
- `src/config.ts` + `src/gateway.ts` — add the test-only `GATEWAY_WS_URL` override (R10)
- `README.md` — add the `## Spike Results` section (R14 format) and the `## Findings Report (M5)` skeleton (R26)

## Requirements

### Test runner (G6 — the jsdom trap)

**R1.** Test runner is **vitest** with `environment: 'node'` — this is mandatory, not a preference: `gateway.experimental_realtime.getToken` **throws in any environment where `globalThis.window` is defined**, so a jsdom default silently poisons any test that imports `src/gateway.ts` [findings/01 gotcha 6; findings/10 G6]. No findings doc pins a vitest version (G6 is an acknowledged gap): at scaffold time run `npm view vitest dist-tags.latest`, install that exact version with `--save-exact`, and record it in the README dependency table. `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',        // NEVER 'jsdom' — findings/01 gotcha 6
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,        // harness boots a real Fastify server
  },
});
```

**R2.** `test/env-guard.test.ts` contains one regression test that fails if anyone ever flips the environment:

```ts
import { describe, it, expect } from 'vitest';
describe('test environment', () => {
  it('is node (no window) — gateway getToken throws under jsdom', () => {
    expect(typeof (globalThis as any).window).toBe('undefined');
  });
});
```

### Unit suites

**R3. DSP suite (`test/dsp.test.ts`)** — implement findings/06 §Test strategy items 1–4 and 6 verbatim against `src/dsp.ts` (Spec 06's deliverable). Item 5 (sine sweep by ear) is manual and belongs to the M1 checklist (R15, step M1-05). Exact assertions:
1. **Codec round trip:** `MULAW_ENC[MULAW_DEC[b] & 0xffff] === b` for all 256 codes **except** `0x7F → 0xFF` (the ±0 pair — assert that exception explicitly) [findings/06 C1].
2. **Boundary continuity (the critical one):** 1 kHz sine, one-shot vs chunked in (a) 160-sample chunks and (b) ragged chunks `[100, 333, 481, 7, 480, 1000]` — outputs **bit-identical** (max diff 0) in both directions. Any nonzero diff = broken filter-state carry [findings/06 C6].
3. **Click detector:** 440 Hz sine at amplitude 8000; assert max `|y[i]−y[i−1]|` at chunk boundaries ≤ max within chunks (stateless processing measured 7995 vs 2339) [findings/06 C6].
4. **Tone fidelity:** f ∈ {300, 1000, 2000, 3000} Hz, amplitude 8000, round trip 8k→24k→8k, least-squares `A·sin + B·cos` projection over the steady-state region (never naive shifted-reference — the 47-sample fractional group delay falsely reports ~4 dB [findings/06 gotcha 8]); assert THD+N ≥ 60 dB and |gain| within 1 dB below 3 kHz (measured 83–99 dB / ≤0.4 dB).
5. **Bench guard:** assert full round-trip cost per 20 ms frame < 500 µs (measured 21.4 µs) so a refactor can't silently go quadratic [findings/06 C10, test 6].
6. **Decimator phase counter:** feed the downsampler chunks with lengths not divisible by 3 (incl. odd byte counts through `gatewayToTwilio`) and assert total output sample count equals `floor(totalInput/3)` accounting via the phase counter [findings/06 gotcha 4].

**R4. Tool-mapping suite (`test/tool-mapping.test.ts`)** — against `src/tools.ts` `fetchToolDefs`-equivalent, using the verbatim `listTools()` fixture from findings/05 C8 (including the `"execution": {"taskSupport": "forbidden"}` field and `"$schema": "http://json-schema.org/draft-07/schema#"`). Assert:
1. Output objects have **exactly** the keys `type, name, description, parameters` (`type === 'function'`); `execution`, `title`, `annotations`, `_meta` never leak (never spread) [findings/05 C8, gotcha 4; findings/10 C11].
2. `$schema` is stripped from `parameters`; `additionalProperties` and `properties` are preserved.
3. The no-args tool maps `inputSchema: {"type":"object","properties":{}}` through unchanged.
4. `runTool`-equivalent: (a) `isError:true` results (all three classes: handler throw, `MCP error -32602: Input validation error…`, `MCP error -32602: Tool nope not found` [findings/05 C10]) return a `JSON.stringify({error: <joined text>})` string and **do not throw**; (b) a thrown transport error also yields an error-output JSON string; (c) `arguments` passed to `callTool` is a parsed **object**, and empty-string/`"{}"` argument payloads are guarded [findings/05 gotchas 5–6].

**R5. Barge-in state machine (`test/bargein.test.ts`)** — the Session/barge-in module (Spec 05's deliverable) must be drivable without sockets: it must accept injected `sendToTwilio(msg)` / `sendToGateway(event)` functions (and a `now()` clock). If the build spec did not expose that seam, this spec authorizes the minimal constructor-injection refactor. Tests feed normalized server events (exact shapes from findings/02 vendored protocol) and Twilio messages (exact shapes from findings/03 claim 4) and assert on the captured sends:

1. **Stale-epoch regression (THE test — would fail against a literal BRD §5.6 implementation [findings/04 G1; findings/10 C2]):**
   - `start` (streamSid `MZtest1`); `media` frames advance `latestMediaTimestamp` to 1000.
   - `response-created {responseId:'r1'}` → 3× `audio-delta {responseId:'r1', itemId:'item_a', delta:<b64>}`; echo every emitted mark back; advance media timestamps to 6000. Mark queue drains → epoch must disarm (`responseStartTimestamp = null`).
   - `response-created {responseId:'r2'}`; media at 8000; 2× `audio-delta {responseId:'r2', itemId:'item_b'}` (epoch re-arms at 8000); media advances to 8500.
   - `speech-started {raw:{}}`.
   - **Assert:** Twilio received `{event:'clear', streamSid:'MZtest1'}` first; gateway received `{type:'conversation-item-truncate', itemId:'item_b', contentIndex:0, audioEndMs:500}` — i.e. 8500−8000, **not** 7500 (8500−1000, the stale-epoch bug value). Assert `contentIndex` is present and `0` [findings/02 gotcha 4].
2. **No `response-cancel`** is sent on barge-in (server-vad `interrupt_response` defaults true and is not overridable) — or, if the Session implementation chose to send it, the test instead asserts the subsequent `error` event is whitelisted as benign [findings/04 V5, G3; findings/10 C3]. Pick one branch matching the Session spec's decision; do not leave both.
3. **Guard no-ops:** `speech-started` with empty mark queue / disarmed epoch → **no** clear, **no** truncate sent [findings/04 G4]. Multiple `speech-started` inside one response after the first barge-in → no-ops until next response's first delta re-arms [findings/04 G5].
4. **Array frame contract (S13):** deliver one message whose JSON is `[{type:'response-created',responseId:'r3',raw:{}},{type:'audio-delta',responseId:'r3',itemId:'i3',delta:'AAAA',raw:{}}]` — assert both events are processed in order [findings/01 claim 15; findings/02 claim 4].
5. **Benign-error whitelist:** `{type:'error', message:'…no active response…', code:'response_cancel_not_active', raw:{}}` → logged, session stays alive; an unknown `error` code → FR-7 teardown path invoked. (Exact live code strings are S11 — the test pins the whitelist mechanism, the M1 checklist pins the strings.)
6. **Path B DSP reset seam (T4):** with `AUDIO_MODE=transcode`, assert `down.reset()` is invoked on `response-created` and on barge-in, and the inbound upsampler is **never** reset mid-call [findings/06 gotcha 3; findings/10 T4].
7. **Unknown/ignorable events:** `conversation-item-added`, `output-item-done`, `content-part-added/done`, `audio-done`, `text-delta/done`, `function-call-arguments-delta` are consumed silently (no warn, no throw) [findings/10 C9].

**R6. Mark registry (`test/marks.test.ts`)** — post-clear echo tolerance [findings/04 G2; findings/03 claim 16.3; findings/10 C4]:
1. Response `r1` emits deltas → marks `m1..m3` queued with unique per-response names (`r<responseId>:<seq>` scheme per findings/10 T3); echo `m1`; barge-in → `clear` sent, queue flushed locally.
2. Echoes of `m2`, `m3` then arrive (the post-clear storm). **Assert:** ignored — no crash, no negative/undercount, no epoch re-arm; removal is **by name**, never bare `shift()`.
3. Response `r2` delta → mark `n1` queued; assert queue is exactly `[n1]`; echo `n1` → queue drains → epoch disarms.
4. A `mark` echo with a never-sent name is ignored.
5. The first mark of each response doubles as the `tFirstMarkEcho` instrumentation point (single namespace, per findings/10 T3 resolution) — assert the turn record stamps it.

**R7. Config validation (`test/config.test.ts`)** — against `src/config.ts` (Spec 01):
1. Missing `AI_GATEWAY_API_KEY` → boot-time throw with a message naming the variable (never the late OIDC fallback error) [findings/01 gotcha 5; findings/10 G2].
2. Missing `TWILIO_AUTH_TOKEN` → boot-time throw.
3. `AUDIO_MODE` must be `'pcmu' | 'transcode'`; anything else throws; default per BRD §12 is `transcode` until M1 flips it.
4. `MODEL_ID` defaults to `openai/gpt-realtime-2.1`; `VOICE` defaults to `marin` (S8 fallback `alloy` is an env change, not code).
5. `PORT` parses numeric; `PUBLIC_HOST`/`RAILWAY_PUBLIC_DOMAIN` resolution order matches findings/03 Impl B (configured host, never request headers).

**R8. Logger + percentiles (`test/logger.test.ts`)** — against `src/logger.ts` (Spec 08's logging deliverable, findings/09 §6–7):
1. Every line is single-line JSON on **stdout** with string `message` and string `level` fields (Railway contract, findings/09 V1); `undefined` fields dropped; a `.raw` that fails `JSON.stringify` falls back via try/catch without throwing.
2. Nothing is written to stderr (findings/09 gotcha 3).
3. `pct()` nearest-rank: empty → `undefined`; single value → that value; p95 of n=10 = max-adjacent behavior per the findings/09 §7 formula; input array not mutated.
4. `ms()` rounds to 1 decimal.

### Integration harness (offline bridge test — no Twilio, no gateway, no network)

**R9. Fake gateway (`test/fakes/fake-gateway.ts`).** A `ws` WebSocket server speaking the normalized protocol verbatim from findings/02 (§client/server unions). Behavior contract:
- On connection: start a 5 s timer; the **first** client message must be `session-update` (assert; this mirrors the 30 s first-message rule [findings/01 claim 8]). Reply `{type:'session-created', sessionId:'sess_fake', raw:{}}` then `{type:'session-updated', raw: <assumed OpenAI GA shape below>}`.
- The `session-updated.raw` fixture mimics the assumed GA shape (this exact shape is spike S5 — the fixture documents the assumption and must carry a comment saying so):
  ```jsonc
  { "type": "session.updated", "event_id": "evt_1",
    "session": { "type": "realtime", "model": "gpt-realtime-2.1",
      "audio": { "input":  { "format": { "type": "audio/pcmu" }, "turn_detection": { "type": "server_vad" } },
                 "output": { "format": { "type": "audio/pcmu" }, "voice": "marin" } } } }
  ```
- On `response-create`: emit, in order, `response-created {responseId}` → `output-item-added {responseId, itemId}` → N× `audio-delta {responseId, itemId, delta}` at ~50 ms cadence (delta = base64 of 160 bytes 0xFF μ-law silence) → `audio-transcript-delta`/`-done` → `audio-done` → `response-done {status:'completed'}` [findings/04 D2].
- Scripted VAD turn: after receiving ≥25 `input-audio-append` frames, emit `speech-started` → `speech-stopped` → `audio-committed` → auto `response-created` + audio (server-vad flow, findings/09 §2).
- Scripted barge-in: mid-audio-response, emit `speech-started`; then, when the client's `conversation-item-truncate` arrives, validate `{itemId, contentIndex:0, audioEndMs≥0}` and reply `{type:'custom', rawType:'conversation.item.truncated', raw:{type:'conversation.item.truncated', item_id:'<itemId>', content_index:0, audio_end_ms:<echoed>}}` (the ack arrives as `custom` [findings/04 V9]); then `response-done {status:'cancelled', raw:{response:{status_details:{reason:'turn_detected'}}}}`.
- Scripted tool call: emit `response-created r2` → `output-item-added` → `function-call-arguments-done {responseId, itemId, callId:'call_1', name:'hello', arguments:'{"name":"Kevin"}'}` → `response-done {status:'completed'}`; assert the client then sends `conversation-item-create {item:{type:'function-call-output', callId:'call_1', name:'hello', output:<JSON string>}}` followed by exactly **one** `response-create` (the findings/04 G7 gate); serve a follow-up audio response.
- Scripted anomalies (each behind a scenario flag): benign `error` event (R5.5 string); one **JSON-array** frame (R5.4); an unmapped `custom {rawType:'rate_limits.updated'}`.

**R10. Gateway URL override.** `src/config.ts` gains optional `GATEWAY_WS_URL` (undocumented in `.env.example` beyond a `# test harness only` comment). When set, `src/gateway.ts` skips `getToken`/`getWebSocketConfig` and opens `new WebSocket(GATEWAY_WS_URL, [], { perMessageDeflate: false })` directly. Production behavior is bit-identical when unset. This is the only production-code change this spec makes, and it is what lets the harness run with zero network.

**R11. Fake Twilio (`test/fakes/fake-twilio.ts`).** A `ws` client that drives the real bridge exactly as Twilio would [findings/03 claims 4–5 — all numeric fields are **strings**]:
1. Obtain a token first: POST `/twiml` as `application/x-www-form-urlencoded` with params `{CallSid:'CAfake…', AccountSid:'ACfake…', From:'+15550001', To:'+15550002', CallStatus:'ringing', Direction:'inbound'}` and header `X-Twilio-Signature` computed via `getExpectedTwilioSignature(TWILIO_AUTH_TOKEN, 'https://' + PUBLIC_HOST + '/twiml', params)` from `twilio@6.0.2` [findings/03 claim 15] — the harness sets `PUBLIC_HOST=localhost:<port>` so signing matches validation. Parse the `<Parameter name="token" value="…"/>` from the returned TwiML. (This makes the harness cover signature validation and token mint too.)
2. Open `ws://localhost:<port>/twilio-media`; send `{"event":"connected","protocol":"Call","version":"1.0.0"}`, then the `start` message with `streamSid:'MZfake…'`, `callSid`, `mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1}`, `customParameters:{token}` and incrementing string `sequenceNumber`.
3. Stream `media` frames every 20 ms: `payload = Buffer.alloc(160, 0xff).toString('base64')` (μ-law digital silence), `timestamp` a string advancing by 20, `track:'inbound'`, string `chunk`.
4. Playback simulation: record every outbound `media` payload (byte-count accounting at 8 bytes/ms); on receiving `mark`, echo it back after the simulated remaining-buffer delay; on `clear`, **immediately echo every pending mark** (this is what exercises R6's post-clear tolerance against the real Session) and zero the simulated buffer [findings/03 claim 5, gotcha 3].
5. Send `stop` and close at scenario end; expose collected outbound traffic + timings to assertions.

**R12. Harness test (`test/harness.test.ts`).** Boots the real Fastify app in-process (fake env: `GATEWAY_WS_URL=ws://localhost:<fakeGwPort>`, `AUDIO_MODE=pcmu`, fake `AI_GATEWAY_API_KEY`/`TWILIO_AUTH_TOKEN`), starts the fake gateway, runs the fake-Twilio client through one scripted call and asserts, end to end: (a) `session-update` is the first gateway message and contains `tools` mapped from the live in-process `/mcp` route with `$schema` stripped; (b) greeting `response-create` follows `session-update` [findings/04 D5]; (c) inbound media frames arrive at the fake gateway as one `input-audio-append` per frame with **unchanged** base64 payload (Path A identity); (d) `audio-delta` payloads reach fake-Twilio as `media` messages each followed by a `mark`; (e) the barge-in scenario produces `clear`-then-`truncate` with correct `audioEndMs`; (f) the tool scenario round-trips through the real MCP server and emits exactly one follow-up `response-create`; (g) `stop` tears down both legs and emits the `stream-stop` summary line with `ttfbP50`/`turns` fields [findings/09 §5]; (h) no unhandled rejection or stray stderr output during the run. The two fakes are also runnable standalone (`node --import tsx test/fakes/fake-gateway.ts` etc.) for manual debugging.

### M1 — audio-format spike + first call (ordered checklist)

**R13.** Preconditions (human, before any call): Twilio account is upgraded/non-trial with approved profile (**S20** — console check; gates M4 and FR-3); Twilio number webhook → `https://<RAILWAY_PUBLIC_DOMAIN>/twiml`; `<Stream statusCallback>` set to the log-only `/stream-status` route (Spec 02 deliverable — the only channel that surfaces `StreamError` [findings/03 claim 14, Impl E]); the deployed build logs, verbatim and once per call: `session-updated.raw`, every `error.raw`, every `custom.rawType`+`raw`, WS `close` `{code, reason}` on both legs, `unexpected-response` status+body on the gateway upgrade, and `getTokenMs`/`expiresAt`. Per findings/10: "the single most valuable build artifact for the research phase is the M1 logging of `.raw`, close codes, and `session-updated` verbatim."

**R14.** Every checklist item is recorded in `README.md` under `## Spike Results` in this exact per-item format (BRD M1 requires README recording):

```markdown
### M1-03 · S1 S8 — pcmu + marin honored?
- Date/callSid: 2026-07-XX · CAxxxxxxxx
- Procedure: <one line>
- Verdict: YES | NO | PARTIAL (one line)
- Evidence: <verbatim log line(s) or dashboard screenshot ref>
- Consequence: <config/code change made, if any>
```

**R15.** Ordered checklist (run top to bottom; each item lists: procedure → evidence → S-numbers answered):

| # | Procedure | Expected evidence to capture | Answers |
|---|---|---|---|
| **M1-01** | `getToken` smoke: hit `/twiml` (or a one-off script) with the deployed env; no call needed | log `getTokenMs` (budget ~100 ms — if seconds, it eats the FR-1 2 s budget), `expiresAt` (TTL actually granted for `expiresAfterSeconds: 600`), token prefix `vcst_` | **S15** |
| **M1-02** | First live call, `AUDIO_MODE=pcmu`, `VOICE=marin`, `MODEL_ID=openai/gpt-realtime-2.1`. Speak two turns. | (a) gateway WS opens (no `unexpected-response`) → 2.1 connects; (b) `session-updated.raw` verbatim — applied input/output format + voice + full raw shape; (c) greeting audible, in configured voice/format, `session-update`→`response-create` applied in order; (d) `speech-started` arrived normalized or as `custom {rawType:'input_audio_buffer.speech_started'}` (D4 handler covers both — log which fired); (e) whether `.raw` carries OpenAI-native events (`speech_stopped.audio_end_ms` present?); (f) `response-created` before first `audio-delta` per responseId (log ordering); (g) any `Array.isArray(parsed)` frames (log a counter); (h) first-call debug: per-delta size/cadence for ~one response only; (i) `x-twilio-signature` header presence on the WS upgrade (log it); (j) inbound frame cadence/size from `media.timestamp` deltas | **S1, S4, S5, S6, S7, S8, S13, S16, S17, S21, S22** |
| **M1-03** | Fallback ladder — only for items that failed in M1-02, one variable at a time: 2.1 refuses → `MODEL_ID=openai/gpt-realtime-2`; `marin` rejected (error event or wrong voice in `.raw`) → `VOICE=alloy`; pcmu not honored → flip `AUDIO_MODE=transcode` permanently | which fallback was needed, recorded per R14 | closes **S1/S7/S8** |
| **M1-04** | Path B call regardless of Path A outcome: one call with `AUDIO_MODE=transcode`; confirm `session-updated.raw` shows `audio/pcm` @ 24000 (Path B constants) | applied format from `.raw`; audible quality note; compare `speech-stopped` arrival timing vs the Path A call (same test phrase) | **S2, S18** |
| **M1-05** | Manual sine-sweep-by-ear (findings/06 test 5): play a 200 Hz→3.2 kHz sweep into the call on both paths; listen for boundary buzz | pass/fail note per path | (DSP in-vivo) |
| **M1-06** | Deliberate misconfig, once, then revert: send `inputAudioFormat: {type:'audio/pcmu', rate: 8000}` | `error.raw` or silent-ignore evidence | **S3** |
| **M1-07** | Error-string harvest: during M1 calls do one barge-in; log every `error` event's `code`/`message`/`.raw` and `response-done.status` values (+`.raw.response.status_details.reason`) | the exact strings for the benign-error whitelist (cancel-no-active-response, truncate-out-of-range if it occurs, create-while-active) and observed `status` vocabulary incl. `cancelled`/`turn_detected` | **S11, S12** (finish at M2) |
| **M1-08** | Close-code probes (script or manual): (a) normal caller hangup → gateway close code/reason; (b) reuse an already-used `vcst_` token in a bare WS connect → expect `unexpected-response` (status+body) — also answers single-use; (c) connect and send nothing for 31 s → close code (30 s rule); (d) optional: idle a session 5 min off-call | close-code table: {scenario → code, reason} | **S14** |
| **M1-09** | Twilio kill tests (FR-7 evidence, caller experience): (a) TwiML pointing at a dead WS path (or server stopped) → call in, note seconds-to-failure and what caller hears; check `/stream-status` log for `stream-error` + Twilio console debugger for error 31920; (b) mid-call `railway restart` (or process kill) → seconds until Twilio hangs up, any dead air | timings + `statusCallback` log lines + caller-experience notes | **S19** |
| **M1-10** | Only if the G4 spoken-fallback design was adopted by the server spec: trigger a gateway failure (e.g. bogus `MODEL_ID` for one deploy) and verify the canned μ-law apology plays before close | audible confirmation + log ordering (send-clip → close) | **S23** (clip half) |
| **M1-11** | Billing check after the first billed calls: `gateway.getCredits()` (or `GET /v1/credits`) before/after; Vercel dashboard → AI Gateway → Requests for the session rows and token-type breakdown; inspect `session-created.raw` for a generation id | credits delta vs listed $4/$24/M expectation; how realtime sessions appear in the dashboard; generation-id presence | **S30, S31** |
| **M1-12** | Set `providerOptions: {gateway: {tags:['voice-poc']}}` in `session-update` on one call; check dashboard attribution. Optional (only if a knob is actually needed): send an OpenAI-native `providerOptions` field and diff `session-updated.raw` | tag visible in dashboard? merge shape observed? | **S32** (+ **S10** if attempted) |

M1 exit gate (BRD M1): live call answered by gpt-realtime-2.1 (or documented fallback) through the gateway; README records at minimum S1, S4, S7, S8; `AUDIO_MODE` env flipped to the winning path.

### M2 — conversation quality acceptance (FR-2, transcripts, instrumentation)

**R16.** Procedure (two calls minimum, on Railway — never through ngrok for latency [BRD §8]):
1. Prompt the model into a long answer ("tell me a two-minute story"). Interrupt loudly mid-sentence. Do this ≥3 times per call, **including at least one barge-in on turn ≥3 after at least one un-interrupted completed turn** — this is the live stale-epoch regression check: the `conversation-item-truncate` must NOT produce a truncate-out-of-range error [findings/04 G1].
2. After one barge-in, ask **"what did you just say?"** — the model must recall only the portion actually heard (truncate memory-alignment worked), and the `custom {rawType:'conversation.item.truncated'}` ack must appear in logs with its `audio_end_ms` [findings/04 O2] → answers **S9**.
3. FR-2 evidence, two layers: (a) server-side: `barge-in` log line with Δ(`speech-started` arrival → `clear` sent) < 50 ms (bridge cost is single-digit ms; the rest of the <500 ms budget is VAD detection + network, not bridge-controllable [findings/04 D6]); (b) caller-perceived: one calibration call on speakerphone recorded next to a laptop (Audacity) — measure the audible model-stop gap in the waveform; must be < 500 ms [findings/09 §9 ground-truth method]. Record both numbers.
4. Transcripts: `input-transcript` (`input-transcription-completed.transcript`) and `output-transcript` (`audio-transcript-done`) log lines present for every turn (requires `inputAudioTranscription: {}` in session config).
5. Instrumentation live: consolidated `turn` lines with `ttfbMs/bridgeMs/turnMs/playbackConfirmMs` and a `stream-stop` summary with p50/p95/max/n per findings/09 §5 example lines. Verify Railway Log Explorer queries work on the deployed build: `@callSid:<sid>`, `@event:turn AND @ttfbMs:>800`, `@event:stream-stop` — this is **S33** (nested/numeric filtering must be confirmed before M5 relies on it).
6. Extract (copy/download) all `@event:turn` + `@event:stream-stop` lines the same day — 7-day Hobby retention [findings/09 V4, gotcha 1]. Repeat this extraction step after every milestone session.

M2 exit gate: FR-2 pass (both layers recorded); S9 answered; S33 verified; transcripts + turn lines in logs.

### M3 — tools acceptance (FR-4, FR-5)

**R17.** Procedure:
1. **FR-4:** call, ask "what time is it". Expect: verbal acknowledgment first (the "One moment…" instruction masks the second inference [BRD §5.7]), then the spoken time. Evidence: one `tool-call` log line with the full decomposition `mcpMs / gateWaitMs / secondTtfbMs / toolTotalMs` [findings/09 §4] and `toolTotalMs < 1500`. Run ≥5 tool turns across 2 calls; record p50. Query: `@event:tool-call AND @toolTotalMs:>1500` must return nothing (or each hit explained).
2. **FR-5 add-a-tool test:** add exactly one `server.registerTool` block to `src/mcp-server.ts` (suggested: `get_fun_fact`, no args, returns a static string), commit, push to `main` (this jointly exercises FR-8), wait for auto-deploy, call, ask for a fun fact. **Pass iff the diff touches only `mcp-server.ts`** (zero bridge changes) and the tool works on the next call. Verify the `session-update.tools` count grew (log the tool list at call start).
3. **Tool-failure resilience:** temporarily register a `always_fails` tool whose handler throws; ask the model to use it. Expect: `isError:true` surfaced as an error-JSON `function-call-output`, model apologizes verbally, call survives [findings/05 C10; BRD §5.7]. Remove the tool after the test.
4. **Gate correctness live:** while a tool call is pending, speak immediately — the VAD auto-response must not collide with the bridge's tool `response-create` (no `conversation_already_has_active_response`-class error, or if one appears it is whitelisted and recovered) [findings/04 G7]. Harvest any new error codes into the S11 whitelist.

M3 exit gate: FR-4 + FR-5 pass with the R14-format README entries; tool p50 recorded for M5.

### M4 — concurrency + platform (FR-3, FR-7, FR-8)

**R18. Parallel-call sourcing (FR-3, 3–5 calls).** Two options; use A for the cross-talk test, B for repeatable ramps:
- **Option A (primary):** 3–5 humans, each dialing the number from their own phone. Each caller opens with a unique scripted keyword: "My name is <Alpha|Bravo|Charlie|Delta|Echo>", holds a short conversation, then asks "what is my name?".
- **Option B (scripted):** Twilio-CLI-originated calls to the PoC number with inline TwiML playing distinct speech per leg:
  ```bash
  twilio api:core:calls:create --from "$TWILIO_NUMBER" --to "$TWILIO_NUMBER" \
    --twiml '<Response><Pause length="2"/><Say>My name is caller bravo. What is my name?</Say><Pause length="30"/></Response>'
  ```
  Notes: the inbound leg hits `/twiml` exactly like a human call; both legs bill; outbound CPS limits apply [findings/03 claim 12]. Self-calling (`from == to`) is **not verified by any findings doc** — if Twilio rejects it, fall back to Option A or use a second cheap number as `--from`. Option B callers can't converse, so it validates concurrency/isolation, not conversation quality.

**R19. Cross-talk check (FR-3 pass criteria).** With 3–5 calls live simultaneously: for every `callSid`, the `input-transcript` lines contain only that call's keyword and the model's "your name is X" answer matches that call's X; grep the extracted logs to assert **no** log line for callSid A contains the keyword of call B; every `stream-stop` summary shows an independent turn count. Any cross-contamination = FR-3 fail.

**R20. S24 concurrency-limit probe (`scripts/concurrency-probe.ts`).** No phones needed: for `i = 1..15` (then continue in steps of 5 until rejection or 30): `gateway.experimental_realtime.getToken({model, expiresAfterSeconds: 600})` [the factory form — never `rt.getToken`, findings/01 claim 2 / C1] → open the WS with the returned url/protocols (`perMessageDeflate: false`, `handshakeTimeout: 5000`) → immediately send a minimal `session-update` (`{config:{instructions:'probe', turnDetection: null}}`, satisfies the 30 s rule, VAD off so no billing-relevant audio) → hold open. Per connection record: `getToken` outcome (on throw: `GatewayError` class + `statusCode` [findings/01 Impl 9]), WS outcome (`open` | `unexpected-response` status+body | `close` code+reason). Stop at first rejection, then close all sockets. Output a table: connection # → result. This answers **the number** and **the locus** (mint vs WS-open) and the rejection code — all of S24. Also file the number with Vercel support for confirmation. Cost note: idle sessions, closed within ~60 s; negligible tokens.

**R21. FR-7 concurrency-rejection behavior (kill test, live).** Immediately after R20 finds the limit: hold `limit` sessions open with the probe, then place one **real phone call**. Expected: the call's `getToken`/WS-open is rejected → the bridge takes the FR-7 path (spoken fallback if adopted per G4, else clean hangup — never dead air). Evidence: caller-experience note, bridge log showing the rejection mapped to the fallback path, `/stream-status` `stream-stopped` callback. Combined with M1-09 this completes FR-7's "kill test + concurrency-limit test" [BRD FR-7].

**R22. S25 deploy-mid-call probe.** With `overlapSeconds: 10, drainingSeconds: 60` committed [findings/10 C17]: place one call, keep talking, push a trivial commit. Observe and record: does audio keep flowing after the new deploy goes Active (old-replica WS routing during overlap/drain)? When does the call die, and how does it die (SIGTERM handler drain log vs hard sever)? Do **new** calls during the window land on the new replica? Evidence: bridge SIGTERM/drain log lines [findings/08 drain section; findings/10 C18], call timeline, `stream-stopped` callback. The operating rule "deploy between test calls" stays regardless of outcome [findings/07 claim 9].

**R23. S26 event-loop / DSP-under-load check.** During the 5-call session (run at least one M4 session with `AUDIO_MODE=transcode` so DSP is on the hot path): compare `bridgeMs` p50/p95 and `loopP99Ms` in the `stream-stop` summaries against single-call baselines from M2. Pass: `loopP99Ms < 50` and `bridgeMs` p95 within 2× of baseline (expected: DSP ≈ 2–3 % of a core at 5 calls even with a 5× shared-vCPU penalty [findings/06 C10; findings/09 §8]). Record the shared-vCPU multiplier estimate. Also snapshot the Railway usage dashboard (→ **S27**).

**R24. FR-8 push-deploy check.** Timed: `git push` a visible change (greeting instruction text) → record minutes until a call reflects it, with zero manual deploy actions. (Already jointly exercised in R17.2; record the timing here.)

M4 exit gate: FR-3, FR-7, FR-8 pass; S24 number + locus recorded; S25/S26/S27 recorded.

### M5 — findings report

**R25.** Data pipeline: all cross-call percentiles are computed **offline** by Spec 08's `scripts/aggregate-latency.mjs` over the extracted `@event:turn` JSONL (input: file(s) of log lines; output: p50/p95/max/n per metric, partitioned by `bargedIn` and `ttfbMs` presence per Spec 08 R16 — the script does NOT partition by audio mode; the pcmu-vs-transcode comparison comes from running it once per measurement-session directory, since each session runs a single `AUDIO_MODE` recorded in its `notes.md` per Spec 08 R14) — never by averaging per-call p50s [findings/09 §7, gotcha 13]. Turns where barge-in preceded first audio are excluded from TTFB stats; `bargedIn` tagging enables both cuts [findings/09 §2 edge cases].

**R26.** `README.md` gains this skeleton (fill at M5; the section headers are normative):

```markdown
## Findings Report (M5)

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
(one row per S1–S35; unanswered accepted-risk rows say "accepted-risk: <why>")

### 7. Deviations from BRD & recommendations
Corrections applied (C1–C18 confirmations where observed), config deltas
(model/voice/VAD tuning), and what a production build should do differently.
```

**R27. Spike classification (which S-items are must-answer vs accepted-risk).** The M5 table must contain all 35 rows; the following classification governs whether an empty answer blocks sign-off:
- **Must-answer (block the milestone they're mapped to):** S1, S2, S4, S6, S7, S8 (M1 core); S11, S12, S14, S15 (M1 error/close/token evidence — S11/S12 may finish at M2/M3); S19, S20 (Twilio-leg FR-7/FR-3 gates); S9, S33 (M2); S24, S25, S26 (M4); S30 (M5 cost line); S35 (M5 — it IS the ttfb dataset).
- **Answer-opportunistically (log-and-record; no dedicated procedure beyond R13 logging):** S5, S13, S16, S17, S21, S22, S27, S31, S32, S34 (S34 only meaningful if S5 shows raw passthrough).
- **Conditional:** S3 (one deliberate misconfig — do it, it's 2 minutes); S10 (only if a knob like `idle_timeout_ms` is actually wanted); S18 (only if both audio paths work); S23 clip-half (only if the G4 spoken-fallback design was adopted; ping-half accepted-risk); S29 (only if `allowedHosts` hardening was adopted).
- **Accepted-risk (record as such in the table, no procedure):** S23 ping-half (WS pings vs idle timer — irrelevant while media flows [findings/10 T2]); S28 (`/twiml` 503 during drain — covered by the "deploy between calls" rule).

## Acceptance criteria

- **A1.** `npm test` runs vitest with `environment: 'node'` and passes; `test/env-guard.test.ts` exists and would fail under jsdom. (G6)
- **A2.** DSP suite enforces all six R3 assertions, including bit-identical ragged-chunk continuity and the ≥60 dB projection THD+N. (Spec 06 / findings 06)
- **A3.** `test/bargein.test.ts` contains the stale-epoch regression exactly as scripted in R5.1, asserting `audioEndMs === 500` (and would compute 7500 under the literal BRD §5.6 reset list). (C2)
- **A4.** `test/marks.test.ts` proves post-clear mark echoes are ignored by name-based removal and cannot corrupt the next response's accounting. (C4)
- **A5.** `test/tool-mapping.test.ts` proves `$schema`/`execution` never reach `session-update.tools` and that all three `isError` classes produce error-JSON outputs without throwing. (C11, FR-5 substrate)
- **A6.** `test/harness.test.ts` passes offline (no network): full scripted call through the real bridge + real `/mcp` route covering greeting order, per-frame append passthrough, barge-in clear→truncate, single gated tool `response-create`, array-frame handling, benign-error survival, and clean teardown with a `stream-stop` summary line.
- **A7.** M1 executed: README `## Spike Results` has R14-format entries answering at least S1, S2, S4, S6, S7, S8, S14, S15, S19 with verbatim evidence; `AUDIO_MODE` reflects the Path A/B verdict. (Maps BRD M1)
- **A8.** M2 executed: FR-2 evidence recorded at both layers (bridge Δ < 50 ms; waveform-measured stop < 500 ms), truncate ack observed (S9), turn ≥3 barge-in produced no truncate error, transcripts + `turn` lines in logs, S33 queries verified. (Maps BRD M2 / FR-2 / FR-6)
- **A9.** M3 executed: `tool-call` log lines show `toolTotalMs < 1500` (p50 over ≥5 tool turns recorded); add-a-tool diff touched only `mcp-server.ts` and the tool worked on the next call after auto-deploy. (Maps BRD M3 / FR-4 / FR-5)
- **A10.** M4 executed: 3–5 simultaneous calls with zero cross-talk per R19; S24 ceiling + locus recorded; concurrency-rejection phone call took the FR-7 path with statusCallback evidence; deploy-mid-call (S25) and loopP99Ms (S26) recorded; FR-8 push→live timing recorded. (Maps BRD M4 / FR-3 / FR-7 / FR-8)
- **A11.** M5: README Findings Report filled per R26, including the complete 35-row spike table classified per R27, offline-aggregated percentiles (never percentile-of-percentiles), and $/call-minute from a credits delta. (Maps BRD M5)
- **A12.** Log extraction of `@event:turn` + `@event:stream-stop` performed within retention after every milestone session; raw extracts committed under `docs/measurements/<YYYY-MM-DD>-<label>/` (Spec 08 R14 convention) so the M5 numbers are reproducible. (findings/09 gotcha 1)

## Out of scope

- CI pipeline / GitHub Actions ("Wait for CI" stays off per BRD §7.1); tests run locally.
- Load testing beyond 5 concurrent calls; soak tests; chaos testing beyond the specified kill/deploy probes.
- pino or any logging framework (hand-rolled logger per findings/09 §6 is Spec 08's deliverable; this spec only tests it).
- Call recording infrastructure (the FR constraint stands; the M2/FR-2 calibration uses an external room recording, not Twilio recording).
- Automated speech-quality metrics (PESQ/MOS) — by-ear + sweep only.
- Testing the Vercel gateway's internals; anything not observable from the bridge, logs, dashboard, or a phone.
- ngrok-based latency measurement (functional dev only, per BRD §8).

## Open items deferred to runtime spikes (findings/10 S-numbers)

This spec *is* the operational plan for S1–S35; nothing here carries a free-floating TBD. Mapping of every open item to its procedure:
- S1–S18 → R15 (M1 checklist, items M1-01…M1-12) with S9 finishing at R16.2 and S11/S12 finishing at R16/R17 error harvesting.
- S19–S23 → R15 items M1-09/M1-10 (S20 is the R13 pre-M1 human console check; S21/S22 are M1-02 log lines; S23 split per R27).
- S24–S29 → R20 (S24), R21 (FR-7 live rejection), R22 (S25), R23 (S26, S27), R27 accepted-risk entries (S28, S29).
- S30–S35 → R15 M1-11/M1-12 (S30, S31, S32), R16.5 (S33), R15 M1-02(e)+M2 observation (S34, contingent on S5), R25/R26 (S35 — the aggregated ttfb dataset is the answer).
- Vitest version pin (G6 residue): resolved at scaffold time per R1 and recorded in the README; no findings pin exists.
- Fake-gateway `session-updated.raw` fixture shape is an S5 assumption and is commented as such (R9); update the fixture to the observed shape after M1-02 so the harness tracks reality.

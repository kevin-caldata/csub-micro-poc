# T04.4 — First frames: `session-update` config + greeting `response-create`

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** On WS open, send the full `session-update` (instructions, voice, injected formats, VAD, injected tools, optional gateway tags) as the first frame, then the greeting `response-create`, with the `WAIT_FOR_SESSION_UPDATED` fallback gate.

**Wave:** B · **Depends on:** T04.3 · **Blocks:** T04.5, T05

**References:**
- `docs/specs/04-gateway-realtime-leg.md` — §R7 (tools passthrough), §R8 (full section: `buildCallSessionConfig` snippet, INSTRUCTIONS text, greeting variant, ordering rules, voice-fallback note), §A3, §A4, §A5
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — V11/D5 (ordering + greeting variant 1), V12 (turnDetection limits)
- `docs/findings/06-audio-dsp-transcoding.md` — C2/C3 (format-object shapes; pcmu has NO rate key)
- `docs/findings/02-ai-sdk-realtime-event-protocol.md` — §Session config (field names of the normalized `SessionConfig`), correction 6 (`inputAudioTranscription: {}`)
- `docs/specs/06-audio-dsp-transcoding.md` — §R2 (`audioFormatsFor` return shape — this task only injects literals matching it; never import `dsp.ts`)
- `docs/specs/07-mcp-server-and-tool-loop.md` — §R8 (`fetchToolDefs` output shape — injected verbatim; never import `tools.ts`)
- Neighboring plan interfaces: `plans/04-gateway-leg/03-ws-client-leg.md` §Interfaces (`OpenGatewayLegOptions`, `startMockGateway`)

## Interfaces

**Consumes:** `openGatewayLeg`/`OpenGatewayLegOptions` internals (T04.3, same file); `AppConfig` fields `voice`, `audioMode`, `vadSilenceMs`, `vadThreshold`, `vadPrefixPaddingMs`, `waitForSessionUpdated`, `gatewayTags` (T04.1); `startMockGateway` (T04.3).

**Produces** (appended to `src/gateway.ts`):
- `export const INSTRUCTIONS: string` — the exact default text from Spec 04 R8, containing the BRD §5.7 tool-preamble sentence verbatim: `Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up').`
- `buildCallSessionConfig(...)` (module-internal is fine) returning `SessionConfig` per the Spec 04 R8 snippet
- Behavior contract for Spec 05: first frame after open is always `session-update`; greeting `response-create` fires immediately (default) or on first `session-updated` (`waitForSessionUpdated: true`, via an internal `pendingGreeting` thunk)

## Steps

- [ ] Read the References, especially all of Spec 04 R8 including the bullets after the snippet.
- [ ] Write failing tests in `src/gateway.session-config.test.ts` (`node:test`; reuse `startMockGateway` from `./gateway.mock.test.js` and the fixture-config pattern from T04.3). Inject formats as literals (`{inputAudioFormat:{type:'audio/pcmu'}, outputAudioFormat:{type:'audio/pcmu'}}` or the pcm/24000 pair) and a two-entry `tools` fixture matching Spec 07 R8's output shape (`{type:'function', name, description, parameters}`). Cases:
  - **A3:** after upgrade, mock's frame #1 is `{type:'session-update', config: {...}}` where config has `instructions` containing the exact tool-preamble sentence, `voice: 'marin'`, `turnDetection` deep-equal `{type:'server-vad', silenceDurationMs:500, threshold:0.5, prefixPaddingMs:300}`, `inputAudioTranscription: {}`, and `tools` deep-equal to the injected fixture (verbatim passthrough, R7); frame #2 is `{type:'response-create'}` with non-empty `options.instructions`
  - **A4:** with pcmu-mode formats injected, both format objects in the SENT JSON satisfy `('rate' in obj) === false` (assert on the parsed frame, structurally); with transcode formats, both deep-equal `{type:'audio/pcm', rate:24000}` (this proves passthrough — `gateway.ts` never hand-builds formats)
  - **A5:** `waitForSessionUpdated: true` → after frame #1, no second frame arrives within a short window; mock then sends `{"type":"session-updated","raw":{"session":{"voice":"marin"}}}` → frame #2 (`response-create`) arrives, and a verbatim `session-updated` log line with `.raw` was emitted; with default `false` → frame #2 follows frame #1 with no server event needed
  - tags: `gatewayTags: ['poc']` → sent config contains `providerOptions: {gateway: {tags: ['poc']}}`; `undefined` → no `providerOptions` key at all
  - a `session-update-sent` log line with `audioMode` + `voice` is emitted (Spec 04 R13)
- [ ] Run `npx tsx --test src/gateway.session-config.test.ts` — expect FAIL.
- [ ] Implement per Spec 04 R8 inside the existing `'open'` handler: `send(session-update)` then greeting per the R8 snippet (greeting text verbatim); `pendingGreeting` thunk stored when `waitForSessionUpdated`, fired from the message path on the FIRST `session-updated` (interim: a pre-forward check in T04.3's `handleEvent`; T04.5 folds it into the full dispatch table). Ordering rules are normative: never `response-create` before `session-update`; never send `input-audio-commit` anywhere in this module.
- [ ] Run `npx tsx --test src/gateway.session-config.test.ts` — expect PASS. Then `npm test` and `npm run typecheck` — exit 0.
- [ ] Commit: `feat(gateway): session-update first frame and greeting response-create with S6 gate` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Discharges Spec 04 **A3**, **A4**, **A5**. Implements spike seams S6 (`WAIT_FOR_SESSION_UPDATED`), S8 (boot-config voice, verbatim `session-updated` logging), S32 (`GATEWAY_TAGS` off by default).

## Completion Report

```
Task: T04.4 — status: [done|blocked]
Files changed: [list]
Commands run: [command → outcome]
Spec 04 A-numbers verified: A3, A4, A5
Deviations from plan: [none | list]
New interfaces exposed: INSTRUCTIONS; first-frame/greeting behavior contract for Spec 05
Notes for ledger: [e.g. where pendingGreeting firing lives pending T04.5]
```

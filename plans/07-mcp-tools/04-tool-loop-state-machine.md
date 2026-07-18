# T07.4 — ToolLoop: double-gated tool-call state machine + timing instrumentation

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Export a per-call `ToolLoop` from `src/tools.ts` that turns `function-call-arguments-done` into `runTool` → `conversation-item-create {function-call-output}` → exactly one double-gated `response-create`, with `ToolTiming` stamps and the single flat-field `tool-call` log line, plus race-safe deferral and disposal.

**Wave:** C · **Depends on:** T07.3, T08 · **Blocks:** T05

**References:**
- `docs/specs/07-mcp-server-and-tool-loop.md` — R10 (state), R11 (event handling incl. the verbatim `conversation-item-create` payload with `name` included), R12 (the double gate, deferral, benign create-while-active recovery), R13 (`ToolTiming` + the four derived ms fields + example line shape), R14 (dispose), A8/A10/A11
- `docs/findings/04-barge-in-and-realtime-voice-patterns.md` — §G7 (why the BRD gate alone is insufficient), §V5 (server-vad `create_response: true` not overridable), §D3/D4 (`responseActive` bookkeeping)
- `docs/findings/09-latency-instrumentation.md` — §2 (`ToolTiming`), §4 (tool round-trip decomposition), §5 (flat one-line log design), §1/V9 (`performance.now()` only)
- `docs/findings/02-ai-sdk-realtime-event-protocol.md` — §Client → server events (`conversation-item-create`, `response-create`), `RealtimeModelV4FunctionCallOutput` (`name` required by some providers — gotcha 5)
- `docs/specs/08-logging-and-latency-instrumentation.md` — Deliverables (`src/latency.ts` exports `ToolTiming` — import it, do not redefine) and R10 (derived-field formulas must match)
- `docs/specs/05-session-bridge-and-barge-in.md` — R8 + gateway-event table rows `function-call-arguments-done`, `response-done`, `audio-delta` (how T05 will wire this class; read-only context)
- `docs/specs/04-gateway-realtime-leg.md` — R1 import surface (`Experimental_RealtimeModelV4ClientEvent as ClientEvent` from `@ai-sdk/provider`), `GatewayLeg.send(ev: ClientEvent): Promise<void>`

## Interfaces

**Consumes:**
- `runTool(client, name, argsJson)` (T07.3); `Client` type (T07.2)
- `import type { ToolTiming } from './latency.js'` (T08). If T08's export is missing or shape-divergent from Spec 07 R13, define a structurally identical local `ToolTiming` in `src/tools.ts`, export it, and flag the divergence in the Completion Report — do NOT edit `src/latency.ts`.
- `import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider'` (type-only; same import Spec 04 R1 uses)
- `LogFields` type from `src/logger.ts` (Spec 01 R12 boundary)

**Produces (in `src/tools.ts`; this is the contract T05 wires — signatures are normative for Spec 05's plans):**

```ts
export interface ToolLoopDeps {
  client: Client;
  gwSend: (ev: ClientEvent) => Promise<void>;      // Session passes GatewayLeg.send (already no-ops when WS not OPEN)
  isResponseActive: () => boolean;                 // Session's responseActive flag (Spec 05 R8) — queried at gate time
  log: (fields: LogFields) => void;                // Session injects a wrapper adding callSid/streamSid/turn
}
export interface PendingToolCall { callId: string; name: string; outputSent: boolean; timing: ToolTiming; }
export class ToolLoop {
  constructor(deps: ToolLoopDeps);
  onFunctionCallArgsDone(ev: { responseId: string; itemId: string; callId: string; name: string; arguments: string }): void;
  onResponseDone(ev: { responseId: string; status?: string }): void;
  onAudioDelta(responseId: string): void;          // lazy follow-up attach (S16) — Session calls on EVERY audio-delta
  onBenignCreateWhileActiveError(): void;          // R12 lost-race recovery: reset followupCreateSent
  dispose(): void;                                 // R14 — does NOT close the client (Session owns closeMcpClient)
}
```

(Internal state exactly per Spec 07 R10 `ToolLoopState`; keep it private. `function-call-arguments-delta` is deliberately absent — Spec 05 ignores it.)

## Steps

- [ ] Write `src/tool-loop.test.ts` (`node:test` + `node:assert/strict`, Spec 01 R7 conventions). Use a fake `Client` (`{ callTool: async () => ... } as unknown as Client`, with manually-resolvable promises for race control) and a recording `gwSend` that appends events to an array; `isResponseActive` backed by a mutable boolean; `log` records lines. Test cases (Spec 07 R11–R14):
  - **happy path:** `onFunctionCallArgsDone({responseId:'r1', itemId:'i1', callId:'c1', name:'get_current_time', arguments:''})` → after tool resolves and `onResponseDone({responseId:'r1', status:'completed'})` with `isResponseActive() === false`: gwSend saw exactly one `conversation-item-create` whose `item` deep-includes `{ type: 'function-call-output', callId: 'c1', name: 'get_current_time' }` with a string `output`, followed by exactly one `response-create`
  - **order-independence:** `onResponseDone` for r1 arrives BEFORE the tool promise resolves → still exactly one `response-create`, sent only after the output item (gate condition (b))
  - **gate condition (c) deferral:** `isResponseActive` true when gate first evaluates → NO `response-create`; then a later `onResponseDone({responseId:'rX'})` (any response) with `isResponseActive` now false → the single `response-create` fires, and the eventual `tool-call` line carries `autoResponseIntervened: true`
  - **idempotence (d):** after the gated send, three more `onResponseDone({responseId:'r1'})` calls add zero further `response-create` events (A8 unit)
  - **multi-call response:** two `onFunctionCallArgsDone` for r1 (c1, c2) → two `conversation-item-create` outputs, still exactly one `response-create`
  - **cancelled still proceeds:** `onResponseDone({responseId:'r1', status:'cancelled'})` behaves like completed (R11.3 — barge-in during tool response)
  - **benign-error retry:** after the gated send, `onBenignCreateWhileActiveError()` then `onResponseDone` (gate re-eval, `isResponseActive` false) → a second `response-create` IS sent (reset semantics), and without the benign-error call it would not be (contrast assert)
  - **tool-call line (A10 unit):** drive happy path then `onAudioDelta('r1')` (same responseId — must NOT stamp) then `onAudioDelta('r2')` (new responseId → `tFollowupFirstDelta`): exactly one logged line with `event: 'tool-call'`, `tool`, `callId`, and numeric `mcpMs`/`gateWaitMs`/`secondTtfbMs`/`toolTotalMs`, each equal to `Math.round(x*10)/10` of itself (1-decimal rounding), and `toolTotalMs >= mcpMs`; loop state cleared afterwards (a subsequent `onAudioDelta('r3')` logs nothing)
  - **dispose (A11 unit):** `onFunctionCallArgsDone` with a never-resolving-then-late-resolving fake `callTool`; call `dispose()`; resolve the tool promise; assert gwSend was never called after dispose, no line logged, and the test process reports no unhandled rejection
- [ ] Run `npx tsx --test src/tool-loop.test.ts` — expect FAIL (ToolLoop not exported yet).
- [ ] Implement `ToolLoop` in `src/tools.ts` per Spec 07 R10–R14. Load-bearing details: all stamps via `performance.now()` (never `Date.now()`); `arguments` handled as JSON string via `runTool`; include `name` in the function-call-output item; `tryReleaseGate()` checks all four conditions (a)–(d) and is invoked from output-sent and every `onResponseDone` (deferral is event-driven, NEVER a timer); on send stamp `tResponseCreateSent` on every pending timing and set `followupCreateSent = true`, `awaitingFollowup = true`; the `tool-call` line message is `` `tool ${name} round trip` ``, level `'info'`, flat top-level numeric fields rounded to 1 decimal, one line per tool call, emitted at `tFollowupFirstDelta`, with `autoResponseIntervened: true` when a VAD response intervened; never log per `function-call-arguments-delta`; `dispose()` sets a `disposed` latch consulted before every `gwSend`/`log` in async continuations.
- [ ] Run `npx tsx --test src/tool-loop.test.ts` — expect PASS.
- [ ] Run `npm test` and `npm run typecheck` — expect both exit 0.
- [ ] Commit with message:
  `feat(tools): ToolLoop double-gated tool-call state machine with timing instrumentation`
  including the line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges the unit-verifiable portions of Spec 07 **A8** (single `response-create` per tool-bearing response incl. race/idempotence), **A10** (flat numeric line shape), **A11** (dispose: no send after teardown, no unhandled rejection). Live/deployed halves — A6 (`toolTotalMs < 1500` on a real call), A8's live barge-in race, A9's audible apology, A10's Railway Log Explorer query (S33) — are executed by T05 wiring + T10 M3 procedures. S11/S12 spikes stay open: the create-while-active matcher is message-class-based until S11 pins exact `code` strings.

## Completion Report

```
Task: T07.4 — ToolLoop state machine
Status: [complete | blocked: reason]
Files changed: [list]
Commands run: [command → outcome, one line each]
Spec A-numbers verified: [A8/A10/A11 unit portions + evidence pointer]
Deviations from plan: [none | list; MUST note if ToolTiming was defined locally instead of imported from latency.ts]
New interfaces exposed: ToolLoop, ToolLoopDeps, PendingToolCall in src/tools.ts (methods: onFunctionCallArgsDone, onResponseDone, onAudioDelta, onBenignCreateWhileActiveError, dispose)
Notes for ledger: [gate semantics notes for T05 wiring; anything surprising]
```

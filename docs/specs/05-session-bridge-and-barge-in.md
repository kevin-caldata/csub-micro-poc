---
# Spec 05 — Session Bridge, Event Loop & Corrected Barge-in State Machine
Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Draft for review
Depends on: 01 (scaffold/config/logger), 02 (/twiml + pendingCalls + drain seam), 03 (Twilio leg: WS route, token check, Session registry), 04 (gateway leg: getToken/connect/send helpers) — and consumes the contracts of 06 (DSP for AUDIO_MODE=transcode), 07 (ToolLoop), 08 (TurnRecorder) · Enables: 07 (MCP tool loop live), 08 (instrumentation hooks), 09 (FR-7 fallback seam)
Findings referenced: findings/04 (all: V1–V13, D1–D6, G1–G10, O1–O7), findings/02 (vendored protocol §Client/Server unions, corrections 1–11, gotchas 6–8), findings/03 (claims 4–8, 16, Impl D, gotchas 3–7), findings/06 (C11, §Wiring, gotcha 3–4), findings/08 (V9, V12–V14, §shutdown, §backpressure, §error/close matrix, gotchas 2, 9–11), findings/09 (V5, V7–V8, §2 turn timestamps, §5 log design, gotchas 6–10), findings/10 (C2, C3, C4, C8, C9, C18, T2, T3, T4, T7, G4, S-list)
---

## Objective

When this spec is done, `src/session.ts` + `src/bargein.ts` implement the per-call `Session` object that bridges one Twilio Media Streams WebSocket to one gateway WebSocket: full-duplex media flow, the complete normalized-event dispatch loop, the turn lifecycle state machine, and the **corrected** barge-in sequence (fixing the reference implementation's stale-epoch bug C2, the post-clear mark-echo bug C4, and omitting the redundant `response-cancel` C3). It also implements the idempotent teardown matrix so that no failure mode leaves the caller in dead air (FR-7 clean-hangup default). This is the component that makes FR-2 (barge-in < 500 ms), FR-3 (isolated concurrent sessions), and the FR-6 timestamp hooks possible.

## Deliverables

- `src/session.ts` — `Session` class/factory, Twilio-message handler, gateway-event dispatch loop, turn lifecycle, teardown. (The `sessions` registry itself is Spec 03's `src/sessions.ts`, re-exporting Spec 02's `src/state.ts` map — ONE instance process-wide; this spec adds no second map.)
- `src/bargein.ts` — `bargeIn(session)` pure-logic module (exported separately for unit testing) plus the mark-registry helpers (`pushMark`, `onMarkEcho`).
- `test/bargein.test.ts` — vitest (node environment, never jsdom [findings/10 G6]) unit tests against fake sockets covering A7–A12 below.
- Modifies: `src/server.ts` only insofar as the `/twilio-media` route handler constructs a `Session` (route itself is Spec 03's deliverable).

## Requirements

### R1 — Session state shape (extends BRD §5.8 per findings/04 D3, findings/09 §2, findings/10 T3/T4)

```ts
// src/session.ts
interface Session {
  twilioWs: WebSocket;                  // ws server socket (Spec 03 hands it in)
  gateway: GatewayLeg;                  // Spec 04's leg object (send/appendAudio/isOpen/close) — owns the raw ws client
  streamSid: string;                    // from Twilio 'start'
  callSid: string;                      // from Twilio 'start'

  // ── barge-in / playback-epoch state (authoritative for barge-in decisions) ──
  latestMediaTimestamp: number;         // ms; ← Number(msg.media.timestamp) on EVERY inbound media frame [findings/03 claim 4: field is a string]
  responseStartTimestamp: number | null;// latestMediaTimestamp at FIRST audio-delta of the CURRENT response; null = disarmed
  currentResponseId: string | null;     // ← audio-delta.responseId / response-created.responseId
  lastAssistantItemId: string | null;   // ← audio-delta.itemId (also on output-item-added.itemId)
  responseActive: boolean;              // response-created seen, response-done not yet
  markQueue: string[];                  // mark names sent, not yet echoed (length>0 ⇒ audio buffered/playing at Twilio)
  markSeq: number;                      // per-session monotonic counter for unique mark names
  firstMarkNameOfResponse: string | null; // the mark sent after the first delta of the current response (R6 instrumentation)

  // ── DSP (Spec 06's Transcoder; Path A = zero-copy no-op internally) ──
  transcoder: Transcoder;               // per-call instance from Spec 06 createTranscoder(config.audioMode), NEVER shared [findings/06 §Wiring]

  // ── tool state (consumed by Spec 07; owned here because the gate lives in the event loop) ──
  pendingToolCalls: Map<string, ToolTiming>;      // key = callId; entry removed once its output item is sent
  toolResponseCreatePending: boolean;             // outputs sent, waiting for responseActive === false (R8)

  // ── turn lifecycle / instrumentation (findings/09 §2 — stamps happen HERE, analysis in Spec 08) ──
  turnPhase: 'idle' | 'user-speaking' | 'awaiting-response' | 'responding';
  currentTurn: TurnRecord | null;       // shape per findings/09 §2 verbatim
  turns: TurnRecord[];
  tStreamStartPerf: number;             // performance.now() at 'start' (anchors media clock [findings/09 §1])

  // ── teardown ──
  tornDown: boolean;                    // idempotency latch (R10)
  heartbeat?: NodeJS.Timeout;           // optional gateway ping — Spec 04 R12 owns it (GATEWAY_PING_SECONDS, default 0 = off) [findings/10 T2]
  mcpClient?: Client;                   // per-call MCP client; closed in teardown [findings/10 T7]
}
```

This interface EXTENDS Spec 03's `src/sessions.ts` `Session` (which pre-declares these fields as extension points) — do not declare a competing shape. Concurrency = the single process-wide `sessions` Map keyed by `streamSid` (Spec 03's registry, re-exporting Spec 02's `src/state.ts` instance — master plan R-2); zero module-level mutable state beyond this map (FR-3 falls out structurally, BRD §5.8). All timestamps stamped with `performance.now()` (monotonic), never `Date.now()` deltas [findings/09 V9].

### R2 — Gateway event receive loop (protocol per findings/02 vendored union)

The raw gateway socket is owned by Spec 04's `openGatewayLeg` (R4–R6 there): it attaches `'message'`/`'error'`/`'close'`/`'unexpected-response'` listeners synchronously, runs `rt.parseServerEvent`, handles single-event AND array frames [findings/02 claim 4; S13], and delivers every normalized event to `callbacks.onEvent(ev)`. This spec implements `dispatch(session, ev)` as the body of that `onEvent` callback — no second parse/listener layer here.

`dispatch` is a single `switch (ev.type)` over the **complete 23-member server union** [findings/02 §Server events]. Behavior table (exact normalized names):

| Event | Action |
|---|---|
| `session-created` | log once (`sessionId`, `.raw`) |
| `session-updated` | log `.raw` verbatim once (applied audio format — M1 evidence) |
| `speech-started` | turn phase → `user-speaking`; run `bargeIn(session)` (R5) |
| `speech-stopped` | close dangling turn, open `TurnRecord` (`tSpeechStopped = now()`), phase → `awaiting-response`; log with `latestMediaTimestamp` (vadGapMs cross-check needs `.raw` — S5/S34) |
| `audio-committed` | ignore (server-vad commits; never send `input-audio-commit` [BRD §5.3, findings/04 V6]) |
| `response-created` | R4 epoch reset + `responseActive = true`; attach `responseId` to `currentTurn` or pending `ToolTiming` [findings/09 §2 step 2] |
| `audio-delta` | R3 outbound flow (forward immediately) + R4 re-arm + R6 mark |
| `audio-done` / `content-part-added` / `content-part-done` / `output-item-done` / `conversation-item-added` / `text-delta` / `text-done` / `function-call-arguments-delta` | consciously ignore — no warn, no log [findings/10 C9; findings/02 gotcha 7] |
| `output-item-added` | `lastAssistantItemId = ev.itemId` (backup source; audio-delta also carries it) |
| `audio-transcript-delta` | accumulate into current turn (no log per delta) |
| `audio-transcript-done` | log `output-transcript` line |
| `input-transcription-completed` | log `input-transcript` line (`{itemId, transcript}` — itemId is required [findings/02 correction 2]) |
| `response-done` | `responseActive = false`; stamp `tResponseDone`; phase → `idle`; emit consolidated `turn` line; run tool gate (R8). `status === 'cancelled'` after barge-in is normal (`.raw.response.status_details.reason 'turn_detected'` — log it; S12) |
| `function-call-arguments-done` | hand `{callId, name, arguments, responseId, itemId}` to Spec 07's tool loop; record `ToolTiming.tArgsDone` |
| `error` | R9 benign-error whitelist, else FR-7 path |
| `custom` | R7 fallback matcher + rate-limited logging |

### R3 — Media flow, both directions

**Inbound (Twilio → gateway), per `media` message:**
1. `session.latestMediaTimestamp = Number(msg.media.timestamp)` — always, even if the gateway leg is down (the clock must keep advancing) [findings/03 claim 4, gotcha 4].
2. If `session.gateway.isOpen`: `session.gateway.appendAudio(audio)` where `audio = session.transcoder.twilioToGateway(msg.media.payload)` — Spec 06's Transcoder: identity/zero-copy when `AUDIO_MODE=pcmu`, μ-law→PCM16@24k when `AUDIO_MODE=transcode`.
3. **One `input-audio-append` per Twilio frame — never batch, never buffer** (BRD §5 sequence diagram; per-frame append is the design contract). All client events go through Spec 04's `GatewayLeg.send()` (`gwSend(s, e)` below is shorthand for `s.gateway.send(e)`; it awaits `rt.serializeClientEvent` internally [findings/02 claim 5 — await is a no-op today, keep it]).
4. Never log per frame (Railway 500 lines/s cap, BRD §5.9).

**Outbound (gateway → Twilio), per `audio-delta`:**
1. Forward **immediately — never wait for `audio-done`, never batch, never pace** (BRD §5.3; Twilio buffers and plays in order, any payload size, no re-framing [findings/06 C11, findings/03 claim 7]).
2. Payload: `session.transcoder.gatewayToTwilio(ev.delta)` — identity/zero-copy in `pcmu` mode, PCM16@24k→μ-law in `transcode` mode (Spec 06 R3/R4/R9).
3. Backpressure guard before every forward [findings/08 §backpressure]: if `twilioWs.bufferedAmount > 1_000_000` → log warn + `twilioWs.close(1011, 'backpressure')` (teardown follows via the close handler); else `twilioWs.send(mediaJson)`.
4. Then send the mark (R6). Guard all Twilio sends with `twilioWs.readyState === WebSocket.OPEN`.
5. First delta of a response additionally stamps `tFirstAudioDelta`/`tFirstTwilioSend` and emits the `first-audio-delta`/`first-twilio-send` log events with `ttfbMs`/`bridgeMs` [findings/09 §2 step 3]. **No logging for subsequent deltas.**

### R4 — Response-epoch management (the C2 fix — this is the load-bearing correction over BRD §5.6)

`responseStartTimestamp` is reset/re-armed in exactly **four** places. Implementing only the BRD's step-4 reset reproduces the reference implementation's stale-epoch truncate bug (truncate errors on every barge-in after the first non-interrupted turn) [findings/04 G1; findings/10 C2]:

1. **On `response-created`:** `responseStartTimestamp = null; currentResponseId = ev.responseId; responseActive = true; firstMarkNameOfResponse = null;` and `session.transcoder.resetOutbound()` (safe unconditionally — no-op in pcmu mode; in transcode mode audio is discontinuous across responses — 47 samples of the previous response's tail otherwise color the next one) [findings/06 gotcha 3, R11; findings/10 T4]. **Never reset the inbound upsampler mid-call** (caller audio is continuous; Spec 06's `Upsampler3x` has no reset method by design).
2. **On every `audio-delta` (re-arm keyed by responseId):**
   ```ts
   if (session.responseStartTimestamp == null || ev.responseId !== session.currentResponseId) {
     session.responseStartTimestamp = session.latestMediaTimestamp;
     session.currentResponseId = ev.responseId;
   }
   session.lastAssistantItemId = ev.itemId;
   ```
   [findings/04 D4]. The `!==` clause covers the S16 ordering risk (delta arriving before its `response-created`) — the epoch attaches lazily from the delta itself.
3. **On mark-queue drain to 0** (inside `onMarkEcho`, R6): `responseStartTimestamp = null` — playback finished, truncate math disarmed [findings/04 G1 fix b].
4. **Inside `bargeIn()`** (R5 step 4).

### R5 — Barge-in sequence (`src/bargein.ts`) — corrected BRD §5.6

Trigger: normalized `speech-started`, OR the fallback `custom` matcher (R7). Sequence, in order:

```ts
export function bargeIn(s: Session): void {
  // Guard: nothing audible AND nothing in flight → no-op. Fires on every user utterance,
  // incl. turn 1 and the tool gap — the no-op path is normal, not an error [findings/04 G4].
  if (s.markQueue.length === 0 && !s.responseActive) return;

  // 1. Stop playback NOW — the caller-audible action goes first. clear on an empty
  //    Twilio buffer is harmless, so send it whenever a response is active even if no
  //    marks are outstanding (covers deltas in flight before the first mark echo)
  //    [findings/04 G4 extension, sanctioned there; findings/03 claim 5 clear semantics].
  if (s.twilioWs.readyState === WebSocket.OPEN)
    s.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: s.streamSid }));

  // 2. Align model memory — ONLY when the epoch is armed and we have an item id.
  //    Truncating an already-completed item is the NORMAL case, not an error
  //    (audio generates faster than realtime) [findings/04 V3].
  if (s.responseStartTimestamp != null && s.lastAssistantItemId != null) {
    const audioEndMs = Math.max(0, s.latestMediaTimestamp - s.responseStartTimestamp);
    gwSend(s, { type: 'conversation-item-truncate',
                itemId: s.lastAssistantItemId, contentIndex: 0, audioEndMs });
    log('info', 'barge-in', { callSid: s.callSid, event: 'barge-in', audioEndMs,
        responseId: s.currentResponseId, msSinceFirstSend: /* now - tFirstTwilioSend */ });
  }

  // 3. NO response-cancel — DECIDED (see Decisions). Server-vad interrupt_response
  //    defaults to true and is not overridable via the normalized config; the server
  //    already cancelled, and a client cancel typically returns an error event
  //    [findings/04 V4, V5, G3; findings/10 C3]. The reference impl omits it too.

  // 4. Flush + disarm. markQueue = [] is safe ONLY because echoes are removed
  //    by-name (R6) — post-clear echo storms cannot corrupt the next response's queue.
  s.markQueue.length = 0;
  s.firstMarkNameOfResponse = null;
  s.responseStartTimestamp = null;
  s.lastAssistantItemId = null;
  s.currentResponseId = null;
  s.transcoder.resetOutbound();                // no-op in pcmu mode [findings/06 gotcha 3, R11; findings/10 T4]
  if (s.currentTurn && !s.currentTurn.tResponseDone) s.currentTurn.bargedIn = true;
}
```

Ordering note: `clear` (Twilio socket) and `truncate` (gateway socket) go to different sockets — no cross-ordering exists; `clear` first minimizes perceived latency [findings/04 D4 ordering note]. Within the gateway socket, truncate is sent before any later `response-create` (in-order application).

**Edge cases (all must behave as specified, tested in A7–A12):**
- **speech-started with no active response** (turn 1, post-playback, tool gap): guard no-ops. [findings/04 G4]
- **Barge-in before first delta** (model still thinking): `responseActive` true, epoch unarmed → `clear` sent (harmless), **no truncate**, server auto-cancels. [findings/04 G4]
- **Truncate `audioEndMs` out-of-range race** (mark echo in flight / final-20 ms window): server returns an `error` event → benign per R9; playback already stopped by `clear`; never crash, never retry. `audioEndMs: 0` is legal. [findings/04 G6]
- **Multiple barge-ins per response:** after the first, state is disarmed → subsequent `speech-started` no-op until the next response's first delta re-arms. Self-healing given R4 [findings/04 G5]. Expect rapid `speech-started → speech-stopped → committed → response-created` cascades; no special casing.
- **Greeting barge-in:** the greeting is an ordinary response (bridge-sent `response-create` after `session-update` [findings/04 D5 variant 1 — Spec 04 owns the send]); the same machinery applies with zero special casing. Caller interrupting the greeting mid-sentence must pass FR-2.

### R6 — Unified mark registry (findings/10 T3 — decision made here)

**One namespace, decided:** every outbound `audio-delta` is followed by one mark named
`` `r${ev.responseId}:${s.markSeq++}` `` — unique per response AND per session [findings/04 D4, G2]. Rules:

1. `pushMark(s, name)`: send `{event:'mark', streamSid, mark:{name}}` **after** the corresponding `media` send; `markQueue.push(name)`. If this is the response's first delta, also `firstMarkNameOfResponse = name`.
2. `onMarkEcho(s, name)` (Twilio `mark` message): **remove-by-name only — never bare `shift()`**:
   ```ts
   const i = s.markQueue.indexOf(name);
   if (i !== -1) s.markQueue.splice(i, 1);          // unknown/stale names: silently ignore
   if (name === s.firstMarkNameOfResponse) { stamp tFirstMarkEcho; log playbackConfirmMs; }
   if (s.markQueue.length === 0) s.responseStartTimestamp = null;   // R4 rule 3
   ```
   Post-`clear` echo storms (Twilio echoes ALL pending marks on `clear` — they mean "flushed", not "played" [findings/03 claim 16.3; findings/10 C4]) hit the flushed queue, find no match, and are ignored — this is the C4/G2 fix.
3. **First mark echo doubles as `tFirstMarkEcho`** — no separate `t<turn>-first` mark exists (unifies findings/04 D4 with findings/09 §2 step 4 per T3's stated resolution). Never log non-first echoes [findings/09 §5].
4. Mark-per-delta granularity is provisional: revisit only after S17 (delta cadence) shows tiny/very frequent deltas; if so, mark every Nth delta — accounting stays exact because removal is by-name.

### R7 — `custom` event handling (fallback matcher + logging)

```ts
case 'custom':
  if (ev.rawType === 'input_audio_buffer.speech_started') { bargeIn(session); break; } // S4 fallback — GA wire name ONLY [findings/04 G10]
  if (ev.rawType === 'conversation.item.truncated')
    log('info', 'truncate ack', { event:'custom', rawType: ev.rawType, raw: safeRaw(ev.raw) }); // M2/S9 acceptance signal [findings/04 G8]
  else if (ev.rawType === 'rate_limits.updated') { /* debug-level, rate-limited — never per-event info logs [findings/04 G8] */ }
  else log('info', 'custom event', { event:'custom', rawType: ev.rawType, raw: safeRaw(ev.raw) });
```

Never warn-loop on unmapped events; expected `custom` arrivals include `conversation.item.truncated`, `input_audio_buffer.timeout_triggered`, `conversation.item.done`, `input_audio_buffer.cleared`, transcription deltas [findings/04 V9]. `safeRaw` = try/catch JSON.stringify with `String(err)` fallback [findings/09 §6 note]. Do not match beta wire names (`response.audio.delta`, `conversation.item.created`) anywhere [findings/04 G10].

### R8 — Tool-flow response-create gate (state owned here; execution in Spec 07)

On `function-call-arguments-done`: record in `pendingToolCalls`, delegate execution to Spec 07. When Spec 07 has sent the `conversation-item-create {type:'function-call-output', callId, name, output}` for **all** pending callIds (include `name` — harmless for OpenAI, required for provider-neutrality [findings/02 gotcha 5]), set `toolResponseCreatePending = true`. Send exactly **one** `response-create` when BOTH: (a) `toolResponseCreatePending === true`, (b) `responseActive === false` — checked at output-send time AND re-checked on every `response-done` [BRD §5.7 gate + findings/04 G7: the BRD gate alone is insufficient because server-vad `create_response:true` can spawn a competing response]. If a VAD-created response is active, defer to the next `response-done`.

### R9 — In-band `error` event handling with benign whitelist

```ts
function isBenignError(ev: { message: string; code?: string }): boolean {
  // Exact code strings unknown until S11/O5 pins them — until then match defensively
  // on both code and message for the two barge-in-adjacent classes:
  const t = `${ev.code ?? ''} ${ev.message}`.toLowerCase();
  return /truncat/.test(t)                       // truncate out-of-range / already-truncated (G6)
      || /cancel/.test(t)                        // cancel-with-no-active-response (G3 — defensive; we don't send cancel)
      || /already has an active response/.test(t); // create-while-active (G7 race)
}
```
Benign → single `warn` line with `.raw`, session continues. Non-benign → log `error` with `.raw` and invoke the FR-7 path (R10 gateway-failure row). Every `error` event logs `.raw` verbatim at M1/M2 so S11 can replace the regexes with exact codes.

### R10 — Turn lifecycle state machine

`turnPhase` is **advisory** (drives turn correlation and logging); the barge-in decision variables of R1 are the authority — the enum never gates `bargeIn()`. Transitions:

| From | Event | To | Side effects |
|---|---|---|---|
| any | `speech-started` (or S4 fallback) | `user-speaking` | `bargeIn()` runs (R5) |
| `user-speaking` | `speech-stopped` | `awaiting-response` | close dangling turn as incomplete; open `TurnRecord{turn: n++, tSpeechStopped, tools: [], bargedIn: false}` [findings/09 §2 step 1] |
| `awaiting-response` | `response-created` | `awaiting-response` | attach `responseId` + `tResponseCreated` to `currentTurn` — unless this response was bridge-initiated after tool output, in which case attach to the pending `ToolTiming` (the bridge sent that `response-create` itself, so it knows) [findings/09 §2 step 2] |
| `awaiting-response` | first `audio-delta` of attached responseId | `responding` | stamp `tFirstAudioDelta`/`tFirstTwilioSend` |
| `responding` / `awaiting-response` | `response-done` | `idle` | stamp, compute derived (`ttfbMs`, `bridgeMs`, `turnMs`), push to `turns`, emit one consolidated `turn` log line, clear `currentTurn` [findings/09 §2 step 6] |

Correlation is always by `responseId`, never "next delta I see" [findings/09 gotcha 9]. A turn with no audio (straight to function call) leaves `ttfbMs` absent — the caller-perceived number is the tool follow-up's first delta [findings/09 §2 edge cases]. The greeting is not a VAD turn: it gets the separate `greeting` record (Specs 04/08), but its response flows through this same machine with `turn: 0`.

### R11 — Teardown matrix (idempotent, no dead air — FR-7)

One function, one latch:

```ts
function teardown(s: Session, reason: string, opts?: { twilioCloseCode?: number }): void {
  if (s.tornDown) return;                     // idempotency latch — every path funnels here
  s.tornDown = true;
  clearInterval(s.heartbeat);
  void s.mcpClient?.close();                  // per-call MCP client [findings/10 T7]
  s.gateway.close(1000, 'call ended');        // Spec 04 R5: internally guarded no-op if already closed/failed
  if (s.twilioWs.readyState === WebSocket.OPEN)
    s.twilioWs.close(opts?.twilioCloseCode ?? 1000);   // closing the Twilio WS ENDS THE CALL [findings/03 claim 1]
  emitStreamStopSummary(s, reason);           // durationS, turns, bargeIns, p50/p95 (Spec 08 shape)
  sessions.delete(s.streamSid);               // mandatory — SIGTERM drain polls sessions.size [findings/08 §shutdown]
}
```

This function is the implementation behind Spec 03's `teardownSession` / `Session.teardown(reason)` seam — ONE teardown implementation process-wide, not two.

| Trigger | Who observes | Action |
|---|---|---|
| Twilio `stop` message | Twilio message handler | `teardown(s, 'caller-hangup')` — normal path |
| Twilio WS `close` (any code, no prior `stop`) | Twilio `'close'` handler | `teardown(s, 'twilio-close-abnormal')`; flag abnormal in summary |
| Twilio WS `error` | Twilio `'error'` handler | **log only** — `'close'` always follows; teardown lives in `'close'` (single path) [findings/08 §matrix rule] |
| Gateway WS `close` mid-call | Spec 04's `onClose` callback | log `code` + `reason` **verbatim** (Spec 04 R11 decodes the Buffer [findings/08 gotcha 9]; close-code vocabulary is S14 evidence); `teardown(s, 'gateway-close')` → Twilio leg closes → **clean hangup within one event-loop turn — this is the FR-7 default**. The spoken-fallback alternative (canned μ-law apology before close, G4/S23a) is Spec 09's decision; this spec exposes the hook: `onGatewayFailure(s)` is called before the Twilio close and defaults to no-op. |
| Gateway WS `error` / `unexpected-response` | handled inside Spec 04's `gateway.ts` | surfaces here only as `onOpenFailed` (status code — concurrency/expired-token rejections [findings/08 V12]) or the eventual `onClose` → teardown there |
| Backpressure trip (R3.3) | outbound forward path | `twilioWs.close(1011)` → Twilio `'close'` → teardown |
| SIGTERM drain (Spec 02 owns the server side) | drain loop | drain gate stops new sessions; the loop polls `sessions.size`; stragglers past the 55 s deadline get `teardown(s, 'shutdown', { twilioCloseCode: 1001 })` (1001 = going away). Never call `fastify.close()` while sessions exist — the plugin's default `preClose` severs all live WS in ~2 ms [findings/08 V9; findings/10 C18]. |
| Bad `<Parameter>` token in `start` | Spec 03's route | never constructs a Session; `socket.close(1008)` — listed for completeness |

Invariants: (1) `teardown` is safe to call from any handler any number of times; (2) every socket's `'close'` handler calls `teardown` — each leg's teardown closes the other leg, so no path leaves the Twilio socket open without a gateway (no dead air); (3) `sessions.delete` runs on every path or the SIGTERM drain never completes.

### R12 — Gateway heartbeat (optional insurance, per findings/10 T2)

Owned by Spec 04 R12: `GATEWAY_PING_SECONDS` (default `0` = **off**), diagnostics-only, timer started on `'open'` and cleared on close/teardown. This spec adds nothing beyond clearing `s.heartbeat` in `teardown`; the Session must never *rely* on pings to hold an audio-silent session open — whether WS-protocol pings count against the gateway's 5-min idle timer is S23.

## Acceptance criteria

- **A1 (FR-2, M2):** Live call — interrupting the model mid-sentence stops audible playback in < 500 ms; log shows `barge-in` event with computed `audioEndMs`; subsequent `custom rawType:'conversation.item.truncated'` line appears (S9 probe: ask "what did you just say?" → model recalls only the heard portion).
- **A2 (C2 regression — the critical one):** Live call — let turn 1 play to completion, converse one more full turn, then barge in on turn 3. The truncate must succeed (no `error` event, truncated ack arrives) with `audioEndMs` < that response's real duration. A literal BRD §5.6 implementation fails this.
- **A3 (FR-6):** Every completed turn emits exactly one `turn` line with `ttfbMs`, `bridgeMs`, `turnMs`, `playbackConfirmMs`, `bargedIn`, `responseId`; no per-frame or per-delta logs anywhere (grep of a call's logs shows zero `media`/`audio-delta` lines beyond first-of-response).
- **A4 (FR-3, M4):** 3 parallel calls — `sessions` map holds 3 entries; transcripts show zero cross-talk; killing one call's gateway leg tears down only that session.
- **A5 (FR-7):** Kill test — terminate the gateway WS mid-call: caller hears the call end cleanly (no dead air > ~2 s), log shows `gateway-close` with verbatim code/reason then `stream-stop` summary; `sessions.size` returns to 0.
- **A6 (FR-7/SIGTERM):** Deploy (SIGTERM) during an active call with the drain gate up: active call continues to completion (≤ 55 s) or is closed with 1001; process exits without `fastify.close()` severing a live call.
- **A7 (unit, stale-epoch):** Simulated sequence `response-created(r1) → deltas → all marks echoed (queue drains) → response-created(r2) → delta(r2) → speech-started` yields truncate with `audioEndMs` computed from r2's first-delta epoch, not r1's.
- **A8 (unit, mark storm):** After `bargeIn()` flushes the queue, replayed echoes of the flushed names leave `markQueue` empty and do not decrement marks pushed for the next response; a barge-in on that next response still fires.
- **A9 (unit, no-op guard):** `speech-started` with `markQueue.length === 0 && !responseActive` sends nothing on either socket.
- **A10 (unit, pre-delta barge-in):** `response-created` then `speech-started` before any delta → `clear` sent, **no** truncate sent.
- **A11 (unit, multiple barge-ins):** second `speech-started` after a barge-in (same response, no new delta) is a no-op; after the next response's first delta, barge-in fires again.
- **A12 (unit, teardown idempotency):** calling `teardown` twice, and triggering it from both legs' close handlers in the same tick, closes each socket at most once, closes the MCP client, clears the heartbeat, and deletes the map entry exactly once.
- **A13 (transcode mode):** `transcoder.resetOutbound()` is invoked on every `response-created` and inside every effective `bargeIn()` (exactly the two Spec 06 R11 call sites); the inbound upsampler is never reset mid-call (assert via spy in unit test).
- **A14:** No `response-cancel` is ever sent (grep source + wire log); any in-band `error` matching the R9 whitelist logs `warn` and the call continues.

## Out of scope

- `/twiml` webhook, TwiML generation, per-call token mint (Spec 02); the `/twilio-media` route registration and `start`-message auth gate (Spec 03).
- Gateway `getToken`/`getWebSocketConfig`/connect sequence, `session-update` config content, greeting `response-create` content, VAD tuning values (Spec 04; barge-in treats the greeting as an ordinary response).
- DSP internals — μ-law tables, `Upsampler3x`/`Downsampler3x` implementations (Spec 06; this spec only defines when `resetOutbound()` is called and which direction never resets).
- MCP server, MCP client construction, `listTools` mapping, `callTool` execution and `isError` handling (Spec 07; this spec owns only `pendingToolCalls` state and the R8 gate).
- Logger implementation, percentile math, `stream-stop` summary field list, Railway query cookbook (Spec 08; this spec stamps the timestamps and emits the events).
- SIGTERM handler and drain gate hook (Spec 02); `railway.json` (Specs 01/09). This spec guarantees `sessions.delete` and 1001-close cooperation.
- The spoken-fallback (canned μ-law apology) design for FR-7 — clean hangup is the default here; the `onGatewayFailure` hook is where Spec 09's G4 decision plugs in.

## Open items deferred to runtime spikes (findings/10 S-numbers)

- **S4** — `speech-started` normalized vs `custom` through the gateway; R7's fallback matcher covers both, remove the dead branch after M1.
- **S9** — truncate forwarded faithfully + `conversation.item.truncated` ack as `custom`; A1's "what did you just say?" probe is the test.
- **S11** — exact `error` code strings (truncate-out-of-range, create-while-active, cancel-no-active); replace R9's regexes with exact codes at M1/M2.
- **S12** — actual `response-done.status` values and `turn_detected` reachability in `.raw.response.status_details` (barge-in log enrichment).
- **S13** — whether the gateway ever sends a JSON array per frame; R2 handles both regardless.
- **S14** — gateway WS close-code vocabulary (25-min cap, idle, concurrency); R11 logs code/reason verbatim to populate it.
- **S16** — `response-created`-before-first-delta ordering; R4 rule 2's lazy attach is the fallback either way.
- **S17** — `audio-delta` chunk cadence; decides whether R6 stays mark-per-delta or moves to every-Nth.
- **S5 / S34** — `.raw` passthrough of OpenAI `audio_end_ms` (enables the `vadGapMs` cross-check logged at `speech-stopped`).
- **S23** — (a) canned-clip playback before close (feeds the Spec 09 G4 decision behind `onGatewayFailure`); (b) whether WS pings count against the 5-min idle timer (bounds what R12's heartbeat can be trusted for).

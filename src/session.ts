// T05.2 — Gateway event dispatch loop, response-epoch management & media flow (Spec 05 R2-R4,
// R7, R9; Spec 03 R3 inbound steps 2-4).
//
// `dispatch(session, ev)` is the BODY of Spec 04's `GatewayLeg` `callbacks.onEvent` — there is no
// second parse/listener layer here (Spec 05 R2 preamble). `gateway.ts` (Spec 04, already built)
// performs its own module-level logging for `session-created`/`session-updated`/`error`/`custom`
// BEFORE forwarding every event to this dispatcher; where this file's own behavior would
// duplicate that logging with zero added information (the two session-level no-op cases below),
// it deliberately does nothing. Where Spec 05 mandates session-owned state changes AND its own
// log lines (the epoch/mark machinery, the error/custom policy, the barge-in trigger), this file
// implements them per the spec text even though a few of those lines are a second, differently-
// shaped log line alongside gateway.ts's generic one for the same wire event — that overlap is a
// pre-existing artifact of Specs 04 R9/R10 and 05 R2/R7/R9 each mandating their own logging, not
// something this task introduces or is chartered to resolve.
//
// `handleTwilioMedia(session, payloadB64)` is Spec 05 R3's inbound steps 2-4: `latestMediaTimestamp`
// is already set by Spec 03's `media` case (never set it twice — R3 step 1 stays there).
//
// T05.3 reconciliation (review findings on T05.2's dispatch): `TurnRecorder` (`s.recorder`) is now
// the SOLE source of truth for turn records — this file no longer maintains a parallel
// `s.currentTurn`/`s.turns` bookkeeping of its own (that was write-only dead state once the
// recorder's own internal state machine is what stream-stop summaries/percentiles actually read).
// `s.turnPhase` survives as advisory state-gating only (Spec 05 R10: "the enum never gates
// bargeIn()") — dispatch still walks it through idle/user-speaking/awaiting-response/responding
// for readability and any future gating need, but no turn DATA (timestamps/derived metrics) lives
// on the Session any more; `bargein.ts`'s own `s.currentTurn` read (T05.1, untouched here, its own
// passing test suite) simply never fires in the live path now that dispatch never populates the
// field — harmless, and out of this task's scope to change.
//
// T05.3 also collapses the audio-delta path to ONE emission per instrumented event: `s.recorder`
// (once wired) is the only thing that logs `first-audio-delta`/`first-twilio-send` — the direct
// `s.log(...)` calls T05.2 left alongside `s.recorder?.onAudioDelta(...)` were a double-emit once
// a recorder is attached (T05.2 review finding). `onFirstTwilioSend` is added as the missing call
// site so the recorder can actually compute `bridgeMs`/emit that second line itself.

import type { Experimental_RealtimeModelV4ServerEvent as ServerEvent } from '@ai-sdk/provider';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Session } from './sessions.js';
import { teardownSession } from './sessions.js';
import { bargeIn, pushMark } from './bargein.js';
import { sendMedia, nextMarkName } from './twilio-media.js';
import type { PendingCall } from './twiml.js';
import {
  isBenignGatewayError,
  openGatewayLeg as realOpenGatewayLeg,
  type GatewayLegCallbacks,
} from './gateway.js';
import { createTranscoder, audioFormatsFor } from './dsp.js';
import { createMcpClient as realCreateMcpClient, closeMcpClient, fetchToolDefs as realFetchToolDefs, ToolLoop, type RealtimeToolDef } from './tools.js';
import type { ToolLoopDeps } from './tools.js';
import { TurnRecorder } from './latency.js';
import { loadConfig, type AppConfig } from './config.js';
import { safeRaw } from './logger.js';

/**
 * Single `switch (ev.type)` over the complete 23-member normalized server-event union (Spec 05
 * R2 behavior table, Spec 04 R9 — exact normalized names, exhaustive). Implements the four-point
 * `responseStartTimestamp` epoch (R4: points 1 and 2 live here, point 3 lives in bargein.ts's
 * `onMarkEcho`, point 4 in `bargeIn()` — both already built by T05.1), full-duplex outbound media
 * flow (R3), the `custom`/`error` policies (R7/R9), and the turn-lifecycle phase gating (R10,
 * advisory only — see the T05.3 note above; the turn DATA lives entirely in `s.recorder`).
 */
export function dispatch(s: Session, ev: ServerEvent): void {
  switch (ev.type) {
    // R9 #1-2: already logged (and, for session-updated, acted upon — firing the deferred
    // greeting) at the gateway module level (Spec 04 R9/R10, built in T04.4). Nothing left for
    // the session to do — a second log line here would duplicate gateway.ts's exactly, so this
    // is a deliberate no-op rather than an omission.
    case 'session-created':
    case 'session-updated':
      break;

    case 'speech-started': {
      s.turnPhase = 'user-speaking';
      bargeIn(s); // Spec 05 R5 (T05.1) — the corrected sequence, including its own no-op guard.
      s.recorder?.onSpeechStarted();
      break;
    }

    case 'speech-stopped': {
      // Turn-open bookkeeping (Spec 05 R10 "close dangling turn, open TurnRecord") lives wholly
      // inside `s.recorder.onSpeechStopped` now (T05.3 — see the file-header note); this case
      // only advances the advisory phase enum.
      s.turnPhase = 'awaiting-response';
      s.recorder?.onSpeechStopped({ latestMediaTimestamp: s.latestMediaTimestamp });
      break;
    }

    case 'response-created': {
      // R4 point 1 — the C2 epoch-reset fix: disarm on EVERY response-created, not only inside
      // bargeIn(). Reproducing only the barge-in-time reset is exactly the reference
      // implementation's stale-epoch bug (findings/04 G1; findings/10 C2) — see the A7 test.
      s.responseStartTimestamp = null;
      s.currentResponseId = ev.responseId;
      s.responseActive = true;
      s.firstMarkNameOfResponse = null;
      s.transcoder?.resetOutbound(); // no-op in pcmu mode (Spec 06 R11 call site 1 of 2)

      // R10 row 3 (responseId attribution) is entirely `s.recorder`'s job now — it owns the
      // only `currentTurn`/pending-followup/greeting-window state that decides where a
      // `responseId` attaches (T05.3 — see file-header note).
      s.recorder?.onResponseCreated(ev.responseId);
      break;
    }

    case 'audio-delta': {
      // R4 point 2 — re-arm keyed by responseId (verbatim code block: the `!==` clause covers
      // the S16 ordering risk of a delta arriving before its response-created; the epoch
      // attaches lazily from the delta itself). This condition is ALSO exactly "first delta of
      // this response": response-created (above) nulls responseStartTimestamp, so the first
      // delta of a freshly-created response always re-arms; the second delta of the same
      // response never does (responseStartTimestamp is non-null and responseId unchanged).
      const isFirstDelta = s.responseStartTimestamp == null || ev.responseId !== s.currentResponseId;
      if (isFirstDelta) {
        s.responseStartTimestamp = s.latestMediaTimestamp;
        s.currentResponseId = ev.responseId;
      }
      s.lastAssistantItemId = ev.itemId;

      // Advisory phase gate only (R10 row 4) — turn DATA (tFirstAudioDelta/ttfbMs) is stamped
      // exclusively by `s.recorder.onAudioDelta` below (T05.3 — single source of truth).
      if (isFirstDelta) {
        s.turnPhase = 'responding';
      }

      // T05.3 single-emission fix: `s.recorder.onAudioDelta` is the ONLY place the
      // `first-audio-delta` line is emitted (Spec 08 R6.3/R11) — it decides "first" itself
      // (idempotent per responseId, correlation by responseId per findings/09 gotcha 9), so it
      // is called on every delta, not just when the session's OWN epoch math says "first".
      // `s.toolLoop.onAudioDelta` is the separate, ToolLoop-owned lazy follow-up attach (Spec 07
      // R11.4) that emits its own `tool-call` line — the two never overlap (recorder tracks VAD
      // turns/greeting only; ToolLoop owns the entire tool round trip per the established rule
      // that TurnRecorder's tool hooks are not wired from here).
      s.recorder?.onAudioDelta(ev.responseId);
      s.toolLoop?.onAudioDelta(ev.responseId);

      // R3 outbound flow: forward immediately, never wait for audio-done, never batch. Payload
      // is the Transcoder's zero-copy passthrough (pcmu) or PCM16@24k->mu-law (transcode).
      const payload = s.transcoder ? s.transcoder.gatewayToTwilio(ev.delta) : ev.delta;
      sendMedia(s, payload); // Spec 03 R6 backpressure guard lives inside sendMedia itself.

      // Then the mark (R6): mint the unique r<responseId>:<seq> name and push it — pushMark
      // (bargein.ts) is the SOLE writer of `firstMarkNameOfResponse` (T05.2 review fix).
      pushMark(s, nextMarkName(s, ev.responseId));

      // T05.3: the missing call site for Spec 08 R8 — stamps tFirstTwilioSend and emits the
      // `first-twilio-send` line (bridgeMs) exactly once per turn, entirely inside the recorder.
      s.recorder?.onFirstTwilioSend(ev.responseId);
      break;
    }

    case 'output-item-added':
      // Backup source for lastAssistantItemId — audio-delta also carries itemId (R2 row).
      s.lastAssistantItemId = ev.itemId;
      break;

    case 'audio-transcript-done':
      s.log('info', 'output-transcript', { event: 'output-transcript', transcript: ev.transcript, responseId: ev.responseId });
      break;

    case 'input-transcription-completed':
      s.log('info', 'input-transcript', { event: 'input-transcript', transcript: ev.transcript, itemId: ev.itemId });
      break;

    case 'function-call-arguments-done':
      // Hand off wholly to Spec 07's ToolLoop (its own runAndSend/tryReleaseGate state machine
      // and 'tool-call' log line, T07 already built) — never re-implemented here. Absent-safe:
      // toolLoop is instantiated by the session-assembly task, same optional-chaining idiom as
      // `s.recorder`/`s.gateway`/`s.transcoder`.
      s.toolLoop?.onFunctionCallArgsDone({
        responseId: ev.responseId,
        itemId: ev.itemId,
        callId: ev.callId,
        name: ev.name,
        arguments: ev.arguments,
      });
      break;

    case 'response-done': {
      // T05.3 mandated order (Spec 05 R8/R10): (1) responseActive=false so the double gate's
      // condition (c) is correct the instant it's checked below, (2) notify the recorder (turn
      // close — the ONLY place turn data/derived metrics/the 'turn' line are computed now), (3)
      // notify ToolLoop (its deferred-retry re-check of the gate — Spec 07 R12), (4) advance the
      // advisory phase enum last.
      s.responseActive = false;
      s.recorder?.onResponseDone(ev.responseId, ev.status);
      // R8 tool-flow gate: ToolLoop's own onResponseDone re-checks the double gate (Spec 07
      // R12) — nothing more for the session to do; it never sends response-create itself.
      s.toolLoop?.onResponseDone({ responseId: ev.responseId, status: ev.status });
      s.turnPhase = 'idle';
      break;
    }

    case 'error': {
      // R9 benign-error whitelist (imported from gateway.ts per this task's Consumes contract —
      // never a second divergent copy). Benign -> one warn with .raw, session continues;
      // non-benign -> error log with .raw + the FR-7 teardown escape (A14 runtime half).
      const fields = { event: 'error', code: ev.code, raw: safeRaw(ev.raw) };
      if (isBenignGatewayError(ev)) {
        s.log('warn', ev.message, fields);
      } else {
        s.log('error', ev.message, fields);
        s.teardown('gateway-error');
      }
      break;
    }

    case 'custom': {
      // R7 fallback matcher (verbatim code block from Spec 05 R7; findings/04 D4/G10 — GA wire
      // names only).
      if (ev.rawType === 'input_audio_buffer.speech_started') {
        bargeIn(s);
        break;
      }
      if (ev.rawType === 'conversation.item.truncated') {
        s.log('info', 'truncate ack', { event: 'custom', rawType: ev.rawType, raw: safeRaw(ev.raw) });
      } else if (ev.rawType === 'rate_limits.updated') {
        // Debug-level, rate-limited — never a per-event info line here (findings/04 G8); the
        // gateway module level (Spec 04 R10) already logs a rate-limited 'gateway-custom' line
        // for every rawType, this one included.
      } else {
        s.log('info', 'custom event', { event: 'custom', rawType: ev.rawType, raw: safeRaw(ev.raw) });
      }
      break;
    }

    // R9 consciously-ignored set — no throw, no log (findings/10 C9; findings/02 gotcha 7).
    case 'audio-committed':
    case 'conversation-item-added':
    case 'output-item-done':
    case 'content-part-added':
    case 'content-part-done':
    case 'audio-done':
    case 'audio-transcript-delta': // accumulate-with-no-per-delta-log is a no-op today (R2 row) —
    // TurnRecord has no transcript-accumulation field yet; nothing to stamp, nothing to log.
    case 'text-delta':
    case 'text-done':
    case 'function-call-arguments-delta':
      break;

    default: {
      // Defensive default: the switch above is exhaustive over the typed 23-member union, so
      // `ev` narrows to `never` here at compile time — but see gateway.ts's identical comment:
      // the wire belongs to the gateway, not us.
      const _never: never = ev;
      const wireType = (_never as unknown as { type: string }).type;
      s.log('error', 'session dispatch unknown event', { event: 'dispatch-unknown-event', type: wireType });
    }
  }
}

/**
 * Spec 05 R3 inbound steps 2-4. Step 1 (`session.latestMediaTimestamp = Number(msg.media.timestamp)`)
 * is already done by Spec 03's route `media` case BEFORE this hook fires (`session.onTwilioMedia`)
 * — never set it twice here. One `input-audio-append` per Twilio frame, never batched, never
 * logged (Railway 500 lines/s cap; BRD §5.9).
 */
export function handleTwilioMedia(s: Session, payloadB64: string): void {
  if (!s.gateway?.isOpen) return;
  const audio = s.transcoder ? s.transcoder.twilioToGateway(payloadB64) : payloadB64;
  void s.gateway.appendAudio(audio);
}

// ── T05.4 — call-start orchestration, teardown funnel additions, onGatewayFailure seam ─────
// (Spec 05 R1/R11, Spec 03 R4 step 4 `deps.onSessionStart`, Spec 04 R5/R8, Spec 06 R2/R3,
// Spec 07 R7/R8/R10, Spec 08 R6/R7.) This is Spec 03's `deps.onSessionStart` implementation:
// mint await -> transcoder -> MCP client/tools -> TurnRecorder/ToolLoop -> openGatewayLeg ->
// hook installation. The ONE teardown implementation stays Spec 03's `teardownSession`/
// `Session.teardown(reason)` funnel (sessions.ts) — this task's additions (heartbeat clearing,
// ToolLoop disposal, MCP client close, gateway leg close, the recorder's stream-stop summary)
// run via `session.onTeardown`, which that funnel already calls before `sessions.delete` and
// before closing the Twilio socket. No second, parallel teardown function is introduced.
//
// Deviation-by-design (recorded in the T05.4 completion report, same idiom as
// `mintRealtimeToken(cfg, ...)`/`registerTwimlRoutes(app, config, deps?)` elsewhere in this
// repo): the Produces-listed signature `startSessionBridge(session, pendingCall)` is preserved
// as the two-argument call Spec 03's route site uses, but a third, optional, additive `deps`
// parameter is exposed so tests can fake `openGatewayLeg`/`createMcpClient`/`fetchToolDefs`
// without a real WS connection or a real MCP HTTP round trip. `config` defaults to a fresh
// `loadConfig()` call (never a module-level singleton, per Spec 01 R5) when not overridden.

/** Injectable dependency surface for `startSessionBridge` (test seam; production omits it). */
export interface SessionBridgeDeps {
  config: AppConfig;
  openGatewayLeg: typeof realOpenGatewayLeg;
  createMcpClient: typeof realCreateMcpClient;
  fetchToolDefs: typeof realFetchToolDefs;
}

function resolveDeps(overrides: Partial<SessionBridgeDeps>): SessionBridgeDeps {
  return {
    config: overrides.config ?? loadConfig(),
    openGatewayLeg: overrides.openGatewayLeg ?? realOpenGatewayLeg,
    createMcpClient: overrides.createMcpClient ?? realCreateMcpClient,
    fetchToolDefs: overrides.fetchToolDefs ?? realFetchToolDefs,
  };
}

/**
 * Module-level seam, default no-op (Spec 05 R11's `onGatewayFailure(s)` hook). Invoked from the
 * gateway-close teardown row BEFORE the Twilio close — this IS the Spec 05<->09 merge point:
 * `playFallbackAndClose` from `src/fallback.ts` plugs in here at the Wave D orchestrator merge,
 * gated on spike S23. This task deliberately does NOT wire any fallback — the default stays a
 * no-op so the FR-7 clean-hangup path is exactly what fires until that merge happens.
 */
let onGatewayFailure: (s: Session) => void | Promise<void> = () => {};

export function setOnGatewayFailure(fn: (s: Session) => void | Promise<void>): void {
  onGatewayFailure = fn;
}

/**
 * Spec 03's `deps.onSessionStart` implementation (Spec 05 R1 + the References). Runs once per
 * call, right after the Twilio `start` auth gate succeeds and the Session is registered in
 * `sessions`. Never throws/rejects out to its caller — Spec 03's route site calls this
 * fire-and-forget (`void deps.onSessionStart(...)`), so every failure path below is caught and
 * funneled into `teardownSession` instead of becoming an unhandled rejection.
 */
export async function startSessionBridge(
  session: Session,
  pendingCall: PendingCall,
  overrides: Partial<SessionBridgeDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const { config } = deps;

  // TurnRecorder exists for the life of the call regardless of what happens below — even a
  // mint failure gets its (empty) stream-stop summary line via the teardown funnel.
  session.recorder = new TurnRecorder({ callSid: session.callSid, streamSid: session.streamSid });
  session.recorder.onWsStart();

  // The teardown funnel additions (Spec 05 R11's teardown() body, minus the fields Spec 03's
  // `teardownSession` already owns — `tornDown` latch, `sessions.delete`, `startTimer` clear,
  // the Twilio close itself). `session.heartbeat` does not exist on the Session shape by
  // design (see sessions.ts's T05.4 comment) — the optional gateway ping (Spec 04 R12) clears
  // its own timer inside `openGatewayLeg`'s `'close'` handler with no Session-level state to
  // reconcile here.
  //
  // Installed HERE, immediately after the recorder exists and BEFORE the mint await below, not
  // at the end of this function's happy path: every reference in the body (`toolLoop`,
  // `mcpClient`, `gateway`, `recorder`) is optional-chained/`if`-guarded against the Session
  // fields they close over, so the closure is safe to install before any of those fields are
  // ever assigned. That makes it safe to install unconditionally up front, which is exactly what
  // Spec 08 R12 needs: EVERY failure path below — mint-rejected, gateway-open-failed, and any
  // future early exit — must reach `session.recorder?.onStreamStop()` via `teardownSession`,
  // never just the happy path (findings review: the mint-rejection catch at (1) used to
  // `return` before this assignment ever ran, so a mint failure silently skipped the
  // stream-stop percentile summary the file-header comment above claims it gets).
  session.onTeardown = () => {
    session.toolLoop?.dispose();
    if (session.mcpClient) void closeMcpClient(session.mcpClient);
    session.gateway?.close(1000, 'call ended'); // internally guarded no-op if already closed/failed
    session.recorder?.onStreamStop(); // idempotent; Spec 08 R12 percentile summary
  };

  // (1) Await the mint kicked off at webhook time (Spec 02 R5.3) — never re-mint here. A
  // rejection is the FR-7 mint-failure trigger: log + teardown (clean hangup), no gateway leg
  // ever opened, and — because this whole function is one async body under a caller that never
  // awaits it — this catch is what stands between a rejected `gatewayAuth` and an
  // unhandledRejection that could take down the process (findings/08 gotcha 10 class of bug).
  // `pendingCall.gatewayAuth`'s declared type (Spec 02 R5.2, widened in twiml.ts to match what
  // the real mint() call actually resolves with) makes `getTokenMs` optional, not the required
  // field gateway.ts's `MintResult` names — real production mints always include it, but the
  // `SessionBridgeDeps` test seam's injected mints legitimately omit it (findings review: the
  // previous `as MintResult` cast fabricated a required field the source type never promised,
  // which is statically unsound regardless of what any given caller happens to provide). Consume
  // it as possibly-undefined below; never cast it into existence.
  let mint: Awaited<PendingCall['gatewayAuth']>;
  try {
    mint = await pendingCall.gatewayAuth;
  } catch (err) {
    session.log('error', 'mint failed', { event: 'mint-failed', err: String(err) });
    teardownSession(session, 'mint-failed');
    return;
  }

  session.recorder.seedGreeting({
    getTokenMs: mint.getTokenMs,
    tokenExpiresAt: mint.expiresAt !== undefined ? String(mint.expiresAt) : undefined,
  });

  // (2) Transcoder — per-call, never shared (Spec 06 R3/R11).
  session.transcoder = createTranscoder(config.audioMode);

  // (3) Per-call MCP client + tool defs (Spec 07 R7/R8), before session-update. Two independent
  // failure points, each degrading gracefully rather than killing the call (FR-7): a client that
  // never connects leaves `session.mcpClient`/`session.toolLoop` unset (dispatch's
  // `s.toolLoop?.` optional-chaining already no-ops on every function-call-arguments-done); a
  // client that connects but whose `listTools()` fails still gets closed at teardown, just with
  // an empty tool set.
  let mcpClient: Client | undefined;
  try {
    mcpClient = await deps.createMcpClient(config.port);
  } catch (err) {
    session.log('error', 'mcp client create failed', { event: 'mcp-client-failed', err: String(err) });
  }
  session.mcpClient = mcpClient;

  let tools: RealtimeToolDef[] = [];
  if (mcpClient) {
    try {
      tools = await deps.fetchToolDefs(mcpClient);
    } catch (err) {
      session.log('error', 'fetch tool defs failed', { event: 'tool-defs-failed', err: String(err) });
      tools = [];
    }
  }

  // (4) ToolLoop — one per call (Spec 07 R10), constructed only when an MCP client exists (no
  // client, no tool loop; dispatch()'s `s.toolLoop?.` already handles the absence). The injected
  // `log` dep is the session-assembled wrapper Spec 08 R11 anticipates (tools.ts's own
  // `ToolLoopDeps.log` doc comment: "Session injects a wrapper adding callSid/streamSid/turn
  // fields") — `session.log` already stamps callSid/streamSid (Spec 03 R9's bound logger), so
  // this wrapper's only job is adding `turn` from the recorder's best-effort current-turn
  // number. TurnRecorder's OWN tool hooks (`onToolArgsDone` et al.) stay UNWIRED here by
  // design — ToolLoop is the sole owner of tool-call instrumentation end to end (ledger T07.4
  // note: "wire one, not both — double-log risk").
  if (mcpClient) {
    const toolLog: ToolLoopDeps['log'] = (fields) => {
      const { level, message, ...rest } = fields;
      session.log(level, message, { ...rest, turn: session.recorder?.currentTurnNumber });
    };
    session.toolLoop = new ToolLoop({
      client: mcpClient,
      gwSend: (ev) => (session.gateway ? session.gateway.send(ev) : Promise.resolve()),
      isResponseActive: () => session.responseActive,
      log: toolLog,
    });
  }

  // (6) Hook installation (Spec 03 R9's declared extension points): `onTwilioMedia` forwards to
  // this module's own inbound handler; `onFirstMarkEcho` forwards the first-mark-of-response
  // echo to the recorder (Spec 08 R6.4 — this hook was declared on Session since T03.3 but never
  // had a writer until this task assembles the real call). `onPlaybackDrained` is left unset:
  // bargein.ts's `onMarkEcho` already performs the epoch reset unconditionally, so nothing
  // currently needs the notification.
  session.onTwilioMedia = (payloadB64) => handleTwilioMedia(session, payloadB64);
  session.onFirstMarkEcho = (name) => {
    session.recorder?.onMarkEcho(name);
  };

  // (5) The gateway leg itself (Spec 04 R5/R8) — `formats`/`tools` injected per Spec 06 R2/Spec
  // 07 R8 (gateway.ts never hand-builds either). `callbacks.onEvent` IS `dispatch` — no second
  // parse/listener layer (Spec 05 R2 preamble).
  const callbacks: GatewayLegCallbacks = {
    onOpen: () => {
      // Spec 04 owns the session-update + greeting sends; this side only observes the open for
      // instrumentation. The rest of Spec 08 R7's greeting decomposition (onSessionUpdateSent/
      // onSessionUpdated/onGreetingCreateSent below) is wired via the follow-up optional
      // callbacks gateway.ts now exposes from the exact points its closure already handles them.
      session.recorder?.onGatewayOpen();
      session.log('info', 'gateway leg open', { event: 'gateway-leg-open' });
    },
    onOpenFailed: (info) => {
      // FR-7 at handshake: never bridged, so a clean hangup (default 1000) is correct.
      session.log('error', 'gateway open failed', {
        event: 'gateway-open-failed',
        statusCode: info.statusCode,
        err: info.message,
      });
      teardownSession(session, 'gateway-open-failed');
    },
    onEvent: (ev) => dispatch(session, ev),
    // Follow-up (Spec 08 R7/A7): the greeting line's remaining segments. Straight pass-through
    // to the matching TurnRecorder hooks — gateway.ts fires each at the exact point it already
    // handles the corresponding step (session-update sent, first session-updated, greeting
    // response-create sent on both the immediate and WAIT_FOR_SESSION_UPDATED-deferred paths).
    onSessionUpdateSent: () => {
      session.recorder?.onSessionUpdateSent();
    },
    onSessionUpdated: () => {
      session.recorder?.onSessionUpdated();
    },
    onGreetingCreateSent: () => {
      session.recorder?.onGreetingCreateSent();
    },
    onClose: (info) => {
      // Spec 05 R11's gateway-close row: log verbatim (this line is additive alongside
      // gateway.ts's own `gateway-close` line — the same "overlap is a pre-existing artifact of
      // two specs each mandating their own logging" idiom this file's header already documents
      // for dispatch()), THEN the onGatewayFailure seam BEFORE the Twilio close, THEN teardown —
      // clean hangup within one event-loop turn, the FR-7 default with no dead air. Awaiting
      // onGatewayFailure (default no-op, resolves instantly) is what makes "before the Twilio
      // close" a real ordering guarantee once T09's async `playFallbackAndClose` plugs in here,
      // not just an accident of no-op timing.
      void (async () => {
        session.log('info', 'gateway-close', { event: 'gateway-close', code: info.code, reason: info.reason });
        await onGatewayFailure(session);
        teardownSession(session, 'gateway-close');
      })();
    },
  };

  session.gateway = deps.openGatewayLeg({
    // `openGatewayLeg` only ever reads `mint.token`/`mint.url` (verified in gateway.ts — it never
    // touches `getTokenMs`), so the `?? 0` below is a type-satisfying placeholder for
    // `MintResult`'s required field, never a real duration; the actual (possibly-undefined for
    // injected test mints) value is what `seedGreeting` above genuinely consumes. This is a
    // default, not a cast — no property is asserted into existence that the source type doesn't
    // already declare.
    mint: { ...mint, getTokenMs: mint.getTokenMs ?? 0 },
    callSid: session.callSid,
    tools,
    formats: audioFormatsFor(config.audioMode),
    config,
    callbacks,
  });
}

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

import type { Experimental_RealtimeModelV4ServerEvent as ServerEvent } from '@ai-sdk/provider';
import type { Session } from './sessions.js';
import { bargeIn, pushMark } from './bargein.js';
import { sendMedia, nextMarkName } from './twilio-media.js';
import { isBenignGatewayError } from './gateway.js';
import { now, ms, safeRaw } from './logger.js';

/** Pushes a still-open (no `tResponseDone` yet) turn into `turns[]` as incomplete, matching
 *  Spec 05 R10's "close any dangling turn as incomplete" transition on `speech-stopped`. */
function closeDanglingTurn(s: Session): void {
  if (s.currentTurn && s.currentTurn.tResponseDone === undefined) {
    s.turns.push(s.currentTurn);
  }
  s.currentTurn = null;
}

/**
 * Single `switch (ev.type)` over the complete 23-member normalized server-event union (Spec 05
 * R2 behavior table, Spec 04 R9 — exact normalized names, exhaustive). Implements the four-point
 * `responseStartTimestamp` epoch (R4: points 1 and 2 live here, point 3 lives in bargein.ts's
 * `onMarkEcho`, point 4 in `bargeIn()` — both already built by T05.1), full-duplex outbound media
 * flow (R3), the `custom`/`error` policies (R7/R9), and the turn-lifecycle bookkeeping (R10) that
 * `bargeIn()` reads (`s.currentTurn.bargedIn`/`.tResponseDone`).
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
      closeDanglingTurn(s);
      s.currentTurn = { turn: s.turns.length + 1, tSpeechStopped: now(), tools: [], bargedIn: false };
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

      if (s.currentTurn && s.currentTurn.responseId === undefined) {
        s.currentTurn.responseId = ev.responseId;
        s.currentTurn.tResponseCreated = now();
      }
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

      if (isFirstDelta && s.currentTurn && s.currentTurn.responseId === undefined) {
        s.currentTurn.responseId = ev.responseId; // S16 lazy attach into the session's own turn record
      }

      let ttfbMs: number | undefined;
      if (isFirstDelta) {
        const tFirstAudioDelta = now();
        s.turnPhase = 'responding';
        if (s.currentTurn && s.currentTurn.responseId === ev.responseId) {
          s.currentTurn.tFirstAudioDelta = tFirstAudioDelta;
          if (s.currentTurn.tSpeechStopped !== undefined) {
            ttfbMs = ms(s.currentTurn.tSpeechStopped, tFirstAudioDelta);
            s.currentTurn.ttfbMs = ttfbMs;
          }
        }
        s.log('info', 'first-audio-delta', { event: 'first-audio-delta', responseId: ev.responseId, ttfbMs });
      }

      s.recorder?.onAudioDelta(ev.responseId);
      s.toolLoop?.onAudioDelta(ev.responseId);

      // R3 outbound flow: forward immediately, never wait for audio-done, never batch. Payload
      // is the Transcoder's zero-copy passthrough (pcmu) or PCM16@24k->mu-law (transcode).
      const payload = s.transcoder ? s.transcoder.gatewayToTwilio(ev.delta) : ev.delta;
      sendMedia(s, payload); // Spec 03 R6 backpressure guard lives inside sendMedia itself.

      // Then the mark (R6): mint the unique r<responseId>:<seq> name and push it — pushMark
      // (bargein.ts) is the SOLE writer of `firstMarkNameOfResponse` (T05.2 review fix).
      pushMark(s, nextMarkName(s, ev.responseId));

      if (isFirstDelta) {
        const tFirstTwilioSend = now();
        let bridgeMs: number | undefined;
        if (s.currentTurn && s.currentTurn.responseId === ev.responseId && s.currentTurn.tFirstAudioDelta !== undefined) {
          s.currentTurn.tFirstTwilioSend = tFirstTwilioSend;
          bridgeMs = ms(s.currentTurn.tFirstAudioDelta, tFirstTwilioSend);
          s.currentTurn.bridgeMs = bridgeMs;
        }
        s.log('info', 'first-twilio-send', { event: 'first-twilio-send', responseId: ev.responseId, bridgeMs });
      }
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
      s.responseActive = false;
      s.turnPhase = 'idle';
      if (s.currentTurn && (s.currentTurn.responseId === undefined || s.currentTurn.responseId === ev.responseId)) {
        s.currentTurn.responseId ??= ev.responseId;
        s.currentTurn.tResponseDone = now();
        s.turns.push(s.currentTurn);
        s.currentTurn = null;
      }
      s.recorder?.onResponseDone(ev.responseId, ev.status);
      // R8 tool-flow gate: ToolLoop's own onResponseDone re-checks the double gate (Spec 07
      // R12) — nothing more for the session to do; it never sends response-create itself.
      s.toolLoop?.onResponseDone({ responseId: ev.responseId, status: ev.status });
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

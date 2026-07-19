// src/reconnect.ts — per-call stream end-reason registry (FR-R reconnect-on-abnormal-drop).
//
// docs/findings/18: Railway's edge proxy intermittently kills live Twilio media-stream
// WebSockets (Twilio error 31924, abnormal close 1006). With `<Connect action="/twiml-action">`
// on the TwiML (src/twiml.ts), Twilio POSTs /twiml-action on the STILL-LIVE call whenever the
// stream ends — but the action callback itself does not say WHY the stream ended. This registry
// is the bridge's own record of that "why", keyed by CallSid, written at every point the bridge
// observes (or causes) a stream end:
//
//   'abnormal'  — the infrastructure killed the stream out from under a live caller
//                 (Twilio stream-error callback, or a WS close with a non-1000 code that no
//                 deliberate-close path claimed first). /twiml-action answers with a fresh
//                 <Connect><Stream> so the SAME call reconnects instead of hanging up
//                 (product-owner directive: a caller must never be hung up on by an
//                 infrastructure drop).
//   'expected'  — someone MEANT the call to end (caller hangup, fallback.ts's deliberate
//                 close, server-shutdown drain, any teardownSession-initiated close).
//                 /twiml-action answers with an empty <Response/> — the call ends, exactly
//                 the pre-reconnect behavior.
//
// Precedence: an 'expected' mark is never overwritten by a later 'abnormal' observation for the
// same CallSid (a deliberate close often ALSO surfaces as a non-1000 close code — e.g.
// fallback.ts's code-less close() reads back as 1005/1006). The reverse IS allowed: a stream
// that dropped abnormally and was reconnected can later end deliberately, and that final
// 'expected' must win so /twiml-action stops reconnecting.
//
// No timers — sweep-on-access with a TTL, same pattern as twiml.ts's pendingCalls/
// sweepPendingCalls (repo rule: no cleanup timers).

export type StreamEndReason = 'abnormal' | 'expected';

export interface CallEnding {
  endReason: StreamEndReason;
  /** Reconnects already granted for this CallSid — incremented by /twiml-action, capped by
   *  config.streamReconnectMax. Survives endReason flips (the cap is per CALL, not per drop). */
  attempts: number;
  updatedAt: number; // Date.now() of the last write — the TTL clock
}

/** Keyed by CallSid. Exported for tests (same idiom as twiml.ts's `pendingCalls`). */
export const callEndings = new Map<string, CallEnding>();

/** 5 min: comfortably longer than any Twilio action-callback latency, short enough that a
 *  CallSid reused across demo days can never see a stale entry. */
export const CALL_ENDING_TTL_MS = 300_000;

/** Deletes entries not touched within CALL_ENDING_TTL_MS. Invoked on every access (no timers). */
export function sweepCallEndings(now: number = Date.now()): void {
  for (const [callSid, entry] of callEndings) {
    if (entry.updatedAt < now - CALL_ENDING_TTL_MS) {
      callEndings.delete(callSid);
    }
  }
}

function mark(callSid: string, reason: StreamEndReason): void {
  if (!callSid) return; // pre-`start` closes have no CallSid — nothing to key on
  sweepCallEndings();
  const existing = callEndings.get(callSid);
  if (!existing) {
    callEndings.set(callSid, { endReason: reason, attempts: 0, updatedAt: Date.now() });
    return;
  }
  // Precedence (see file header): 'expected' is sticky against later 'abnormal' observations.
  if (reason === 'abnormal' && existing.endReason === 'expected') return;
  existing.endReason = reason;
  existing.updatedAt = Date.now();
}

/**
 * The infrastructure killed the stream (Twilio stream-error callback, or an abnormal WS close
 * that no deliberate-close path claimed first). No-op if an 'expected' mark already exists.
 */
export function markAbnormalEnd(callSid: string): void {
  mark(callSid, 'abnormal');
}

/**
 * A deliberate end (caller hangup, fallback close, shutdown drain, teardown-initiated close).
 * Always wins — including over an earlier 'abnormal' from a previous drop of the same call.
 */
export function markExpectedEnd(callSid: string): void {
  mark(callSid, 'expected');
}

/** Sweeping lookup for /twiml-action. Returns the live entry (mutable — the caller increments
 *  `attempts` in place when granting a reconnect) or undefined. */
export function getCallEnding(callSid: string): CallEnding | undefined {
  sweepCallEndings();
  return callEndings.get(callSid);
}

// T05.1 — Corrected barge-in sequence + unified mark registry (Spec 05 R5/R6).
//
// This module fixes the reference implementation's three barge-in bugs (findings/10 C2/C3/C4):
//   C2 — stale-epoch truncate math (fixed structurally: `bargeIn()` always disarms the epoch on
//        every effective run; `onMarkEcho`'s drain-to-zero also disarms it; response-created's
//        re-arm is Spec 05 R4 rule 1, owned by session.ts/T05.2, out of this module's scope).
//   C3 — no `response-cancel` is ever sent (server-vad's `interrupt_response` already cancelled
//        the in-flight response; a client cancel would typically just return a benign error).
//   C4 — mark-echo storms after `clear` are tolerated: `markQueue`/`firstMarkNameOfResponse` are
//        flushed at barge-in, and `onMarkEcho` removes by name (never a bare `shift()`), so late
//        echoes of already-flushed names are silently ignored instead of corrupting the queue
//        for the NEXT response's marks.
//
// `pushMark`/`onMarkEcho` are the SOLE remove-by-name implementation process-wide (Spec 05 R6
// note / master plan single-seam rule) — `src/twilio-media.ts`'s inbound `mark` case delegates
// to `onMarkEcho` rather than re-implementing the splice (see that file's `mark` case comment).

import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';
import { sendMark, sendClear } from './twilio-media.js';
import type { Session } from './sessions.js';

/**
 * Sends the mark for an outbound `audio-delta` (composes Spec 03's `sendMark` — reuses the wire
 * format, never re-implements it) and arms `firstMarkNameOfResponse` the first time it's called
 * for the current response (Spec 05 R6.1). `firstMarkNameOfResponse` is reset to `null` by
 * `bargeIn()` on every effective barge-in and (per Spec 05 R4 rule 1, session.ts's job) on every
 * `response-created` — so "first call since it was last null" is exactly "first mark of the
 * current response", with no separate responseId bookkeeping needed here.
 */
export function pushMark(s: Session, name: string): void {
  sendMark(s, name);
  if (s.firstMarkNameOfResponse == null) {
    s.firstMarkNameOfResponse = name;
  }
}

/**
 * Handles a Twilio `mark` echo (Spec 05 R6.2): remove-by-name ONLY (never a bare `shift()` —
 * findings/04 G2/findings/10 C4), tolerant of unknown/late names (a post-`clear` echo storm
 * means "flushed", not "played" — findings/03 claim 16.3). Fires `onFirstMarkEcho` exactly once
 * per response (when `name` matches the response's first mark) and, when the queue drains to
 * zero, fires `onPlaybackDrained` and disarms the truncate epoch (Spec 05 R4 rule 3 — the C2
 * fix's second half).
 */
export function onMarkEcho(s: Session, name: string): void {
  const i = s.markQueue.indexOf(name);
  if (i !== -1) s.markQueue.splice(i, 1);

  if (name === s.firstMarkNameOfResponse) {
    s.onFirstMarkEcho?.(name);
  }

  if (s.markQueue.length === 0) {
    s.onPlaybackDrained?.();
    s.responseStartTimestamp = null;
  }
}

/**
 * The corrected barge-in sequence (Spec 05 R5 — the code block there is normative). Trigger:
 * normalized `speech-started`, or the R7 `custom` fallback matcher (both land here identically
 * from session.ts's dispatch loop, out of this module's scope).
 */
export function bargeIn(s: Session): void {
  // Guard: nothing audible AND nothing in flight -> no-op. Fires on every user utterance,
  // including turn 1 and the tool gap — the no-op path is normal, not an error [findings/04 G4].
  if (s.markQueue.length === 0 && !s.responseActive) return;

  // 1. Stop playback NOW — the caller-audible action goes first. `clear` on an empty Twilio
  //    buffer is harmless, so send it whenever a response is active even if no marks are
  //    outstanding (covers deltas in flight before the first mark echo) [findings/04 G4
  //    extension; findings/03 claim 5 clear semantics]. `sendClear` (Spec 03 R5) owns the
  //    `readyState === OPEN` guard — reused here, not re-implemented.
  sendClear(s);

  // 2. Align model memory — ONLY when the epoch is armed and we have an item id. Truncating an
  //    already-completed item is the NORMAL case, not an error (audio generates faster than
  //    realtime) [findings/04 V3].
  if (s.responseStartTimestamp != null && s.lastAssistantItemId != null) {
    const audioEndMs = Math.max(0, s.latestMediaTimestamp - s.responseStartTimestamp);
    const truncate: ClientEvent = {
      type: 'conversation-item-truncate',
      itemId: s.lastAssistantItemId,
      contentIndex: 0,
      audioEndMs,
    };
    void s.gateway?.send(truncate);
    s.log('info', 'barge-in', {
      event: 'barge-in',
      audioEndMs,
      responseId: s.currentResponseId,
    });
  }

  // 3. NO response-cancel — DECIDED (findings/10 C3; findings/04 V4/V5/G3). Server-vad
  //    `interrupt_response` defaults to true and is not overridable via the normalized config;
  //    the server already cancelled, and a client cancel typically returns a benign error event.
  //    The reference implementation omits it too.

  // 4. Flush + disarm. `markQueue = []` is safe ONLY because echoes are removed by-name (R6) —
  //    post-clear echo storms cannot corrupt the next response's queue.
  s.markQueue.length = 0;
  s.firstMarkNameOfResponse = null;
  s.responseStartTimestamp = null;
  s.lastAssistantItemId = null;
  s.currentResponseId = null;
  s.transcoder?.resetOutbound(); // no-op in pcmu mode [findings/06 gotcha 3, R11; findings/10 T4]
  if (s.currentTurn && s.currentTurn.tResponseDone === undefined) {
    s.currentTurn.bargedIn = true;
  }
}

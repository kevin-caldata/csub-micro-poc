// Per-call turn/latency recorder (Spec 08 R5/R6/R8/R11/R12). Implements the FR-6 timestamp
// schema and the per-turn state machine keyed by responseId. All timestamps come from now()
// (performance.now()) and all logged deltas from ms() — the wall clock is never used for
// metric math here (Spec 08 A4).

import { logEvent, ms, now, type LogFields } from './logger.js';

// ── FR-6 record types (Spec 08 R5, field names verbatim) ──────────────────────────────────

export interface TurnRecord {
  turn: number; // 1-based
  responseId?: string;
  // performance.now() timestamps
  tSpeechStopped?: number; // arrival of normalized 'speech-stopped'
  tResponseCreated?: number; // 'response-created' (server-vad auto-creates)
  tFirstAudioDelta?: number; // first 'audio-delta' with this responseId
  tFirstTwilioSend?: number; // after twilioWs.send() of the first media frame
  tFirstTwilioFlush?: number; // stamped in the send callback (R8)
  tFirstMarkEcho?: number; // echo of the mark queued after the first media frame
  tResponseDone?: number;
  tools: ToolTiming[]; // may repeat if multiple calls in one turn (hooks land in T08.3)
  bargedIn: boolean; // speech-started arrived before response-done
  // derived at turn close, logged in the 'turn' line
  ttfbMs?: number; // tFirstAudioDelta - tSpeechStopped  -> model+gateway TTFB
  bridgeMs?: number; // tFirstTwilioSend - tFirstAudioDelta -> decode+transcode+send
  turnMs?: number; // tFirstTwilioSend - tSpeechStopped  -> server-observable core
  playbackConfirmMs?: number; // tFirstMarkEcho - tFirstTwilioSend -> Twilio buffer/WS proxy
}

export interface ToolTiming {
  callId: string;
  name: string;
  tArgsDone: number; // 'function-call-arguments-done' arrival
  tToolResolved?: number; // MCP client.callTool() promise resolved
  tOutputSent?: number; // conversation-item-create (function-call-output) sent
  tResponseCreateSent?: number; // the gated follow-up 'response-create' sent
  tFollowupFirstDelta?: number; // first audio-delta of the follow-up responseId
  // derived: mcpMs, gateWaitMs, secondTtfbMs, toolTotalMs (R10) — computed by T08.3, not stored here
}

// ── Nearest-rank percentile helper (Spec 08 R12, verbatim) ─────────────────────────────────

export function pct(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

// ── TurnRecorder ────────────────────────────────────────────────────────────────────────────

export type EmitFn = (fields: LogFields) => void;

/** T3 mark namespace: `r<responseId>:<seq>` — parses the responseId back out. */
const MARK_NAME_RE = /^r(.+):(\d+)$/;

export class TurnRecorder {
  private readonly callSid: string;
  private readonly streamSid: string;
  private readonly emit: EmitFn;
  private turnSeq = 0;
  private currentTurn: TurnRecord | null = null;

  /** Closed turns, readable by T08.3's stream-stop summary (R12). */
  public readonly turns: TurnRecord[] = [];

  constructor(ids: { callSid: string; streamSid: string }, emit: EmitFn = logEvent) {
    this.callSid = ids.callSid;
    this.streamSid = ids.streamSid;
    this.emit = emit;
  }

  private emitLine(event: string, message: string, extra: Record<string, unknown> = {}): void {
    this.emit({
      level: 'info',
      message,
      event,
      callSid: this.callSid,
      streamSid: this.streamSid,
      ...extra,
    });
  }

  /** Pushes any still-open (not yet response-done'd) turn into `turns` as incomplete. */
  private closeDanglingTurn(): void {
    if (this.currentTurn && this.currentTurn.tResponseDone === undefined) {
      this.turns.push(this.currentTurn);
    }
    this.currentTurn = null;
  }

  // R6.5 (half): speech-started tags the in-flight turn as barged, whether or not audio
  // has started yet (both edge cases — barge-in before/after first delta — land here).
  onSpeechStarted(): void {
    if (this.currentTurn) this.currentTurn.bargedIn = true;
    this.emitLine('speech-started', 'speech-started');
  }

  // R6.1: close any dangling turn (mark incomplete), open the next TurnRecord.
  onSpeechStopped(info?: { latestMediaTimestamp?: number; rawAudioEndMs?: number }): void {
    this.closeDanglingTurn();
    this.currentTurn = {
      turn: ++this.turnSeq,
      tSpeechStopped: now(),
      tools: [],
      bargedIn: false,
    };
    // vadGapMs cross-check (S5/S34): only computable if the gateway passed OpenAI's
    // audio_end_ms through in .raw; absent-safe by design.
    const vadGapMs =
      info?.latestMediaTimestamp !== undefined && info?.rawAudioEndMs !== undefined
        ? ms(info.rawAudioEndMs, info.latestMediaTimestamp)
        : undefined;
    this.emitLine('speech-stopped', 'speech-stopped', {
      latestMediaTimestamp: info?.latestMediaTimestamp,
      vadGapMs,
    });
  }

  // R6.2: attach responseId + stamp tResponseCreated. No dedicated log line exists for this
  // event in the R11 vocabulary — it is silent bookkeeping. Ignores responseIds it cannot
  // attribute (no open turn, or the turn is already attached — e.g. greeting / tool follow-up
  // response-create sent by the bridge itself). SEAM for T08.3: route those cases to the
  // matching pending ToolTiming instead of dropping them.
  onResponseCreated(responseId: string): void {
    const turn = this.currentTurn;
    if (!turn || turn.responseId !== undefined) return;
    turn.responseId = responseId;
    turn.tResponseCreated = now();
  }

  // R6.3: first tracked delta of a response stamps tFirstAudioDelta and emits
  // 'first-audio-delta'. Returns true exactly once per response. Implements the S16 lazy
  // responseId-attach fallback: if response-created hasn't arrived yet, the first delta
  // attaches responseId itself.
  onAudioDelta(responseId: string): boolean {
    const turn = this.currentTurn;
    if (!turn) return false;

    if (turn.responseId === undefined) {
      // S16 fallback: response-created ordering through the gateway is unverified.
      turn.responseId = responseId;
    } else if (turn.responseId !== responseId) {
      // Foreign/untracked responseId (gotcha 9) — e.g. a tool follow-up or greeting response
      // this recorder isn't tracking yet (T08.3 territory). Never attribute audio to the
      // wrong turn.
      return false;
    }

    if (turn.tFirstAudioDelta !== undefined) return false; // not the first delta

    turn.tFirstAudioDelta = now();
    if (turn.tSpeechStopped !== undefined) {
      turn.ttfbMs = ms(turn.tSpeechStopped, turn.tFirstAudioDelta);
    }
    this.emitLine('first-audio-delta', 'first audio delta', { responseId, ttfbMs: turn.ttfbMs });
    return true;
  }

  // R8: stamp after the enqueueing send() call. Emits 'first-twilio-send' with bridgeMs and,
  // in the rare case the flush callback already landed, flushLagMs too (otherwise flushLagMs
  // surfaces on the consolidated 'turn' line instead).
  onFirstTwilioSend(responseId: string): void {
    const turn = this.currentTurn;
    if (!turn || turn.responseId !== responseId) return;
    if (turn.tFirstTwilioSend !== undefined) return; // idempotent — first send only

    turn.tFirstTwilioSend = now();
    if (turn.tFirstAudioDelta !== undefined) {
      turn.bridgeMs = ms(turn.tFirstAudioDelta, turn.tFirstTwilioSend);
    }
    const fields: Record<string, unknown> = { responseId, bridgeMs: turn.bridgeMs };
    if (turn.tFirstTwilioFlush !== undefined) {
      fields.flushLagMs = ms(turn.tFirstTwilioSend, turn.tFirstTwilioFlush);
    }
    this.emitLine('first-twilio-send', 'first twilio send', fields);
  }

  // R8: stamp in the send callback. No dedicated log line — folded into 'first-twilio-send'
  // (if already known) or the consolidated 'turn' line's flushLagMs.
  onFirstTwilioFlush(responseId: string): void {
    const turn = this.currentTurn;
    if (!turn || turn.responseId !== responseId) return;
    if (turn.tFirstTwilioFlush !== undefined) return; // idempotent
    turn.tFirstTwilioFlush = now();
  }

  // R6.4 / C4: the first mark of the known response stamps tFirstMarkEcho. Every other echo
  // (unknown name, duplicate, stale/post-clear storm member) is silently ignored — never
  // throws, never restamps.
  onMarkEcho(name: string): void {
    const turn = this.currentTurn;
    if (!turn || turn.responseId === undefined) return;
    if (turn.tFirstMarkEcho !== undefined) return; // only the first mark counts

    const match = MARK_NAME_RE.exec(name);
    if (!match) return; // malformed/unknown name
    const [, markResponseId] = match;
    if (markResponseId !== turn.responseId) return; // not this turn's response

    turn.tFirstMarkEcho = now();
  }

  // R6.5 (other half): Spec 05's bargeIn() calls this once it has actually acted (cleared
  // playback / truncated). Emits one 'barge-in' line with msSinceFirstSend + passthrough
  // fields.
  onBargeIn(info?: { audioEndMs?: number; itemId?: string }): void {
    const turn = this.currentTurn;
    const msSinceFirstSend =
      turn?.tFirstTwilioSend !== undefined ? ms(turn.tFirstTwilioSend, now()) : undefined;
    this.emitLine('barge-in', 'barge-in', {
      responseId: turn?.responseId,
      msSinceFirstSend,
      ...info,
    });
  }

  // R6.6: stamp, compute derived fields, push to turns[], emit ONE consolidated 'turn' line,
  // clear currentTurn.
  onResponseDone(responseId: string, status: string): void {
    const turn = this.currentTurn;
    if (!turn) return; // stray response-done with nothing tracked (T08.3 seam: follow-ups/greeting)
    if (turn.responseId !== undefined && turn.responseId !== responseId) return; // not this turn
    if (turn.responseId === undefined) turn.responseId = responseId; // final lazy-attach safety net

    turn.tResponseDone = now();

    if (turn.tFirstTwilioSend !== undefined && turn.tSpeechStopped !== undefined) {
      turn.turnMs = ms(turn.tSpeechStopped, turn.tFirstTwilioSend);
    }
    if (turn.tFirstMarkEcho !== undefined && turn.tFirstTwilioSend !== undefined) {
      turn.playbackConfirmMs = ms(turn.tFirstTwilioSend, turn.tFirstMarkEcho);
    }

    // Edge case 1 (turn with no audio -> tool follow-up produced the audible response).
    // Dormant until T08.3 populates tools[]; the seam is fully wired here.
    let perceivedMs: number | undefined;
    if (turn.ttfbMs === undefined && turn.tools.length > 0) {
      const lastTool = turn.tools[turn.tools.length - 1];
      if (lastTool?.tFollowupFirstDelta !== undefined && turn.tSpeechStopped !== undefined) {
        perceivedMs = ms(turn.tSpeechStopped, lastTool.tFollowupFirstDelta);
      }
    }

    const flushLagMs =
      turn.tFirstTwilioSend !== undefined && turn.tFirstTwilioFlush !== undefined
        ? ms(turn.tFirstTwilioSend, turn.tFirstTwilioFlush)
        : undefined;

    this.turns.push(turn);
    this.currentTurn = null;

    this.emitLine('turn', `turn ${turn.turn} complete`, {
      turn: turn.turn,
      responseId: turn.responseId,
      ttfbMs: turn.ttfbMs,
      bridgeMs: turn.bridgeMs,
      turnMs: turn.turnMs,
      playbackConfirmMs: turn.playbackConfirmMs,
      perceivedMs,
      flushLagMs,
      bargedIn: turn.bargedIn,
      toolCalls: turn.tools.length,
      status,
    });
  }
}

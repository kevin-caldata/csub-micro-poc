// Per-call turn/latency recorder (Spec 08 R5/R6/R7/R8/R10/R11/R12). Implements the FR-6
// timestamp schema, the per-turn state machine keyed by responseId, the greeting decomposition
// (FR-1), the tool round-trip decomposition (M3), and the stream-stop call summary with the
// event-loop-delay guard. All timestamps come from now() (performance.now()) and all logged
// deltas from ms() — the wall clock is never used for metric math here (Spec 08 A4).

import { monitorEventLoopDelay } from 'node:perf_hooks';
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
  tools: ToolTiming[]; // may repeat if multiple calls in one turn
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
  // derived: mcpMs, gateWaitMs, secondTtfbMs, toolTotalMs (R10) — computed at emission, not stored
  isError?: boolean; // T08.3 addition: onToolResolved(callId, true) — drives R10/R11 isError
}

/** FR-1 greeting timestamp chain (Spec 08 R7): webhook -> pickup -> gateway -> greeting audio. */
export interface GreetingRecord {
  tTwimlPost?: number; // webhook handler entry (seeded — minted before the recorder exists)
  tWsStart?: number; // Twilio 'start' message — closest observable proxy for pickup
  tGatewayOpen?: number;
  tSessionUpdateSent?: number;
  tSessionUpdated?: number; // ack
  tGreetingCreateSent?: number; // 'response-create' for the greeting
  tFirstAudioDelta?: number;
  tFirstTwilioSend?: number;
  tFirstMarkEcho?: number;
  getTokenMs?: number; // seeded — stamped around getToken() at webhook time (S15)
  tokenExpiresAt?: string; // seeded — the returned expiresAt
}

// ── Nearest-rank percentile helper (Spec 08 R12, verbatim) ─────────────────────────────────

export function pct(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

// ── Event-loop lag guard (Spec 08 R12 / findings/09 §8, verbatim) ──────────────────────────
// One process-wide histogram is sufficient (calls share the loop); never reset between calls
// for the PoC. `server.ts` (T05, Wave D merge) owns the ONE boot call site — this module only
// exposes the function per the master plan's task split.

let loopHistogram: ReturnType<typeof monitorEventLoopDelay> | undefined;

export function startLoopMonitor(): void {
  if (loopHistogram) return; // idempotent — the boot call site invokes this exactly once
  loopHistogram = monitorEventLoopDelay({ resolution: 20 });
  loopHistogram.enable();
}

export function loopP99Ms(): number | undefined {
  if (!loopHistogram) return undefined;
  return Math.round((loopHistogram.percentile(99) / 1e6) * 10) / 10;
}

// ── TurnRecorder ────────────────────────────────────────────────────────────────────────────

export type EmitFn = (fields: LogFields) => void;

/** T3 mark namespace: `r<responseId>:<seq>` — parses the responseId back out. */
const MARK_NAME_RE = /^r(.+):(\d+)$/;

/** A tool call awaiting attribution of its follow-up response-created/first-delta (R6.2). */
interface ToolFollowupEntry {
  tool: ToolTiming;
  turnNumber: number;
}

/** A turn line deferred past response-done because its outcome depends on a tool follow-up
 * that hasn't resolved yet (R6 edge case 1) — finalized once the follow-up (or the stream)
 * resolves, so the line is never permanently lost. */
interface PendingTurnLine {
  status: string;
  flushLagMs: number | undefined;
}

export class TurnRecorder {
  private readonly callSid: string;
  private readonly streamSid: string;
  private readonly emit: EmitFn;
  private turnSeq = 0;
  private currentTurn: TurnRecord | null = null;

  /** Closed turns, readable by the stream-stop summary (R12). Never contains the greeting. */
  public readonly turns: TurnRecord[] = [];

  // Greeting state (R7) — the greeting is not a VAD turn; it lives entirely outside turns[].
  private readonly greeting: GreetingRecord = {};
  private greetingResponseId: string | undefined;
  private awaitingGreetingResponse = false;
  private greetingEmitted = false;

  // Anchor for R4 media-clock math / call duration (Twilio 'start').
  private tStreamStartPerf: number | undefined;

  // Tool round-trip state (R10).
  private readonly toolsByCallId = new Map<string, ToolFollowupEntry>();
  private readonly pendingFollowups: ToolFollowupEntry[] = [];
  private readonly followupResponseIds = new Map<string, ToolFollowupEntry>();
  private readonly emittedTools = new WeakSet<ToolTiming>();
  private readonly pendingTurnLines = new Map<TurnRecord, PendingTurnLine>();

  private streamStopEmitted = false;

  constructor(ids: { callSid: string; streamSid: string }, emit: EmitFn = logEvent) {
    this.callSid = ids.callSid;
    this.streamSid = ids.streamSid;
    this.emit = emit;
  }

  /** T05.4 addition: best-effort current-turn number for cross-module log enrichment (e.g.
   *  Spec 07's ToolLoop 'tool-call' line, via the session-assembly task's log wrapper — Spec
   *  08 R11's `turn` field / tools.ts's ToolLoopDeps.log doc comment). Prefers the still-open
   *  turn; falls back to the most recently closed one, which is the common case for a tool
   *  round trip (its turn's response-done already closed it by the time the follow-up's first
   *  delta fires the 'tool-call' line). TurnRecorder's OWN tool hooks (onToolArgsDone et al.)
   *  remain unwired by design — ToolLoop owns tool-call instrumentation end to end; this getter
   *  is read-only bookkeeping, not a second writer. */
  get currentTurnNumber(): number | undefined {
    return this.currentTurn?.turn ?? this.turns.at(-1)?.turn;
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

  // ── Greeting (R7) ──────────────────────────────────────────────────────────────────────

  /** Seeds webhook-time values the recorder didn't observe itself (Spec 02 mints the token and
   * the /twiml handler timestamp; the pendingCalls claim hands them to the Session as a seed). */
  seedGreeting(seed: { tTwimlPost?: number; getTokenMs?: number; tokenExpiresAt?: string }): void {
    if (seed.tTwimlPost !== undefined) this.greeting.tTwimlPost = seed.tTwimlPost;
    if (seed.getTokenMs !== undefined) this.greeting.getTokenMs = seed.getTokenMs;
    if (seed.tokenExpiresAt !== undefined) this.greeting.tokenExpiresAt = seed.tokenExpiresAt;
  }

  /** Twilio 'start' — also anchors tStreamStartPerf for R4 media-clock math / call duration. */
  onWsStart(): void {
    const t = now();
    this.greeting.tWsStart = t;
    this.tStreamStartPerf = t;
  }

  onGatewayOpen(): void {
    this.greeting.tGatewayOpen = now();
  }

  onSessionUpdateSent(): void {
    this.greeting.tSessionUpdateSent = now();
  }

  onSessionUpdated(): void {
    this.greeting.tSessionUpdated = now();
  }

  onGreetingCreateSent(): void {
    this.greeting.tGreetingCreateSent = now();
    this.awaitingGreetingResponse = true;
  }

  /** Attaches (or lazily attaches) a responseId to the greeting, iff the greeting attribution
   * window is open (R7 edge case 3 / A9: "before any onSpeechStopped"). */
  private isGreetingResponse(responseId: string): boolean {
    if (this.greetingResponseId !== undefined) return this.greetingResponseId === responseId;
    if (!this.awaitingGreetingResponse) return false;
    this.greetingResponseId = responseId;
    return true;
  }

  private emitGreetingLine(): void {
    if (this.greetingEmitted) return;
    this.greetingEmitted = true;
    const g = this.greeting;
    const webhookToStartMs =
      g.tTwimlPost !== undefined && g.tWsStart !== undefined ? ms(g.tTwimlPost, g.tWsStart) : undefined;
    const gatewayOpenMs =
      g.tWsStart !== undefined && g.tGatewayOpen !== undefined ? ms(g.tWsStart, g.tGatewayOpen) : undefined;
    const sessionUpdateAckMs =
      g.tSessionUpdateSent !== undefined && g.tSessionUpdated !== undefined
        ? ms(g.tSessionUpdateSent, g.tSessionUpdated)
        : undefined;
    const greetingTtfbMs =
      g.tGreetingCreateSent !== undefined && g.tFirstAudioDelta !== undefined
        ? ms(g.tGreetingCreateSent, g.tFirstAudioDelta)
        : undefined;
    const greetingBridgeMs =
      g.tFirstAudioDelta !== undefined && g.tFirstTwilioSend !== undefined
        ? ms(g.tFirstAudioDelta, g.tFirstTwilioSend)
        : undefined;
    const greetingPlaybackConfirmMs =
      g.tFirstTwilioSend !== undefined && g.tFirstMarkEcho !== undefined
        ? ms(g.tFirstTwilioSend, g.tFirstMarkEcho)
        : undefined;
    const greetingTotalMs =
      g.tWsStart !== undefined && g.tFirstTwilioSend !== undefined ? ms(g.tWsStart, g.tFirstTwilioSend) : undefined;

    this.emitLine('greeting', 'greeting sent', {
      webhookToStartMs,
      gatewayOpenMs,
      sessionUpdateAckMs,
      greetingTtfbMs,
      greetingBridgeMs,
      greetingPlaybackConfirmMs,
      greetingTotalMs,
      getTokenMs: g.getTokenMs,
      tokenExpiresAt: g.tokenExpiresAt,
    });
  }

  // ── Turn state machine (R6) ────────────────────────────────────────────────────────────

  // R6.5 (half): speech-started tags the in-flight turn as barged, whether or not audio
  // has started yet (both edge cases — barge-in before/after first delta — land here).
  onSpeechStarted(): void {
    if (this.currentTurn) this.currentTurn.bargedIn = true;
    this.emitLine('speech-started', 'speech-started');
  }

  // R6.1: close any dangling turn (mark incomplete), open the next TurnRecord. The greeting
  // attribution window (R7 edge case 3) closes here too — a stray greeting response-created
  // arriving after real turns have started must never mis-attach.
  onSpeechStopped(info?: { latestMediaTimestamp?: number; rawAudioEndMs?: number }): void {
    this.awaitingGreetingResponse = false;
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
  // event in the R11 vocabulary — it is silent bookkeeping. If there is no open turn, this
  // response-created belongs to a tool follow-up (R6.2: "the bridge sent that response-create
  // itself, so it knows") or the greeting (R7) — routed instead of dropped.
  onResponseCreated(responseId: string): void {
    const turn = this.currentTurn;
    if (turn) {
      if (turn.responseId === undefined) {
        turn.responseId = responseId;
        turn.tResponseCreated = now();
      }
      return;
    }
    if (this.resolveFollowup(responseId)) return;
    this.isGreetingResponse(responseId);
  }

  /** Dequeues the oldest pending tool follow-up onto `responseId` the first time it's seen,
   * then returns it on every subsequent lookup for that same responseId (R6.2). */
  private resolveFollowup(responseId: string): ToolFollowupEntry | undefined {
    const known = this.followupResponseIds.get(responseId);
    if (known) return known;
    if (this.pendingFollowups.length > 0) {
      const entry = this.pendingFollowups.shift()!;
      this.followupResponseIds.set(responseId, entry);
      return entry;
    }
    return undefined;
  }

  // R6.3: first tracked delta of a response stamps tFirstAudioDelta and emits
  // 'first-audio-delta'. Returns true exactly once per response. Implements the S16 lazy
  // responseId-attach fallback: if response-created hasn't arrived yet, the first delta
  // attaches responseId itself. If there is no open turn, the delta is attributed to a tool
  // follow-up or the greeting instead of being dropped (T08.2's marked seam).
  onAudioDelta(responseId: string): boolean {
    const turn = this.currentTurn;
    if (turn) {
      if (turn.responseId === undefined) {
        // S16 fallback: response-created ordering through the gateway is unverified.
        turn.responseId = responseId;
      } else if (turn.responseId !== responseId) {
        // Foreign/untracked responseId (gotcha 9) — never attribute audio to the wrong turn.
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

    const followupEntry = this.resolveFollowup(responseId);
    if (followupEntry) {
      if (followupEntry.tool.tFollowupFirstDelta !== undefined) return false; // not the first
      followupEntry.tool.tFollowupFirstDelta = now();
      this.emitToolCallLine(followupEntry.tool, followupEntry.turnNumber);
      this.finalizePendingTurnLine(followupEntry.tool);
      return true;
    }

    if (this.isGreetingResponse(responseId)) {
      if (this.greeting.tFirstAudioDelta !== undefined) return false; // not the first
      this.greeting.tFirstAudioDelta = now();
      return true;
    }

    return false;
  }

  // R8: stamp after the enqueueing send() call. Emits 'first-twilio-send' with bridgeMs and,
  // in the rare case the flush callback already landed, flushLagMs too (otherwise flushLagMs
  // surfaces on the consolidated 'turn' line instead). Greeting audio folds tFirstTwilioSend
  // into the ONE greeting line (no separate log line); tool follow-up sends have no dedicated
  // field in R10/R11 and safely no-op.
  onFirstTwilioSend(responseId: string): void {
    const turn = this.currentTurn;
    if (turn && turn.responseId === responseId) {
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
      return;
    }

    if (this.greetingResponseId === responseId && this.greeting.tFirstTwilioSend === undefined) {
      this.greeting.tFirstTwilioSend = now();
    }
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
  // throws, never restamps. The greeting's first mark echo is the R7 emission trigger for
  // the ONE greeting line.
  onMarkEcho(name: string): void {
    const match = MARK_NAME_RE.exec(name);
    if (!match) return; // malformed/unknown name
    const [, markResponseId] = match;

    const turn = this.currentTurn;
    if (turn && turn.responseId !== undefined && markResponseId === turn.responseId) {
      if (turn.tFirstMarkEcho === undefined) turn.tFirstMarkEcho = now();
      return;
    }

    if (
      this.greetingResponseId !== undefined &&
      markResponseId === this.greetingResponseId &&
      this.greeting.tFirstMarkEcho === undefined
    ) {
      this.greeting.tFirstMarkEcho = now();
      this.emitGreetingLine();
    }
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

  // R6.6: stamp, compute derived fields, push to turns[], emit ONE consolidated 'turn' line
  // (or defer it — R6 edge case 1), clear currentTurn.
  onResponseDone(responseId: string, status: string): void {
    const turn = this.currentTurn;
    if (!turn) {
      // Stray response-done with no open turn: the greeting's fallback-emit trigger (R7
      // emission rule — "the line must never be lost" — if no mark echo arrived). A tool
      // follow-up's response-done needs no action: success is finalized at its first delta,
      // failure was already finalized at the tool-bearing turn's close, below.
      if (responseId === this.greetingResponseId && !this.greetingEmitted) {
        this.emitGreetingLine();
      }
      return;
    }
    if (turn.responseId !== undefined && turn.responseId !== responseId) return; // not this turn
    if (turn.responseId === undefined) turn.responseId = responseId; // final lazy-attach safety net

    turn.tResponseDone = now();

    if (turn.tFirstTwilioSend !== undefined && turn.tSpeechStopped !== undefined) {
      turn.turnMs = ms(turn.tSpeechStopped, turn.tFirstTwilioSend);
    }
    if (turn.tFirstMarkEcho !== undefined && turn.tFirstTwilioSend !== undefined) {
      turn.playbackConfirmMs = ms(turn.tFirstTwilioSend, turn.tFirstMarkEcho);
    }
    const flushLagMs =
      turn.tFirstTwilioSend !== undefined && turn.tFirstTwilioFlush !== undefined
        ? ms(turn.tFirstTwilioSend, turn.tFirstTwilioFlush)
        : undefined;

    this.turns.push(turn);
    this.currentTurn = null;

    // Tool failure with no follow-up audio: emit the tool-call line now, at turn close, with
    // whatever deltas are available (R10/R11 — isError:true, no secondTtfbMs/toolTotalMs).
    for (const tool of turn.tools) {
      if (tool.isError && tool.tFollowupFirstDelta === undefined) {
        this.emitToolCallLine(tool, turn.turn);
      }
    }

    // Edge case 1 (no-audio turn -> function call): if a tool call is still awaiting its
    // follow-up's outcome, the caller-perceived number doesn't exist yet — defer the 'turn'
    // line until the follow-up resolves (success at its first delta; the stream-stop summary
    // flushes it too, so it is never permanently lost) rather than emit it perceivedMs-less.
    const stillPending = turn.tools.some((t) => !t.isError && t.tFollowupFirstDelta === undefined);
    if (turn.ttfbMs === undefined && stillPending) {
      this.pendingTurnLines.set(turn, { status, flushLagMs });
      return;
    }

    this.emitTurnLine(turn, status, flushLagMs);
  }

  /** If `tool`'s owning turn was deferred (R6 edge case 1), finalize and emit its 'turn' line
   * now that the follow-up's outcome (this first delta) is known. */
  private finalizePendingTurnLine(tool: ToolTiming): void {
    for (const [pendingTurn, meta] of this.pendingTurnLines) {
      if (pendingTurn.tools.includes(tool)) {
        this.pendingTurnLines.delete(pendingTurn);
        this.emitTurnLine(pendingTurn, meta.status, meta.flushLagMs);
        return;
      }
    }
  }

  private emitTurnLine(turn: TurnRecord, status: string, flushLagMs: number | undefined): void {
    // Edge case 1 (R6): the honest caller-perceived number when the model went straight to a
    // function call — no audio in this response — but the follow-up produced audio.
    let perceivedMs: number | undefined;
    if (turn.ttfbMs === undefined && turn.tools.length > 0) {
      const lastTool = turn.tools[turn.tools.length - 1];
      if (lastTool?.tFollowupFirstDelta !== undefined && turn.tSpeechStopped !== undefined) {
        perceivedMs = ms(turn.tSpeechStopped, lastTool.tFollowupFirstDelta);
      }
    }

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

  // ── Tool round trip (R10) ──────────────────────────────────────────────────────────────

  onToolArgsDone(callId: string, name: string): void {
    const turn = this.currentTurn;
    if (!turn) return;
    const tool: ToolTiming = { callId, name, tArgsDone: now() };
    turn.tools.push(tool);
    this.toolsByCallId.set(callId, { tool, turnNumber: turn.turn });
  }

  onToolResolved(callId: string, isError?: boolean): void {
    const entry = this.toolsByCallId.get(callId);
    if (!entry) return;
    entry.tool.tToolResolved = now();
    if (isError) entry.tool.isError = true;
  }

  onToolOutputSent(callId: string): void {
    const entry = this.toolsByCallId.get(callId);
    if (!entry) return;
    entry.tool.tOutputSent = now();
  }

  /** Marks the NEXT response-created/first-delta as this tool's follow-up (R6.2). */
  onToolResponseCreateSent(callId: string): void {
    const entry = this.toolsByCallId.get(callId);
    if (!entry) return;
    entry.tool.tResponseCreateSent = now();
    this.pendingFollowups.push(entry);
  }

  private emitToolCallLine(tool: ToolTiming, turnNumber: number): void {
    if (this.emittedTools.has(tool)) return;
    this.emittedTools.add(tool);

    const mcpMs = tool.tToolResolved !== undefined ? ms(tool.tArgsDone, tool.tToolResolved) : undefined;
    const gateWaitMs =
      tool.tOutputSent !== undefined && tool.tResponseCreateSent !== undefined
        ? ms(tool.tOutputSent, tool.tResponseCreateSent)
        : undefined;
    const secondTtfbMs =
      tool.tResponseCreateSent !== undefined && tool.tFollowupFirstDelta !== undefined
        ? ms(tool.tResponseCreateSent, tool.tFollowupFirstDelta)
        : undefined;
    const toolTotalMs =
      tool.tFollowupFirstDelta !== undefined ? ms(tool.tArgsDone, tool.tFollowupFirstDelta) : undefined;

    this.emitLine('tool-call', `tool ${tool.name} round trip`, {
      turn: turnNumber,
      tool: tool.name,
      callId: tool.callId,
      mcpMs,
      gateWaitMs,
      secondTtfbMs,
      toolTotalMs,
      isError: tool.isError,
    });
  }

  // ── Call summary (R12) ─────────────────────────────────────────────────────────────────

  /** Emits the 'stream-stop' call summary. Idempotent — a second call no-ops. */
  onStreamStop(): void {
    if (this.streamStopEmitted) return;
    this.streamStopEmitted = true;

    // Safety net: flush any turn lines still deferred behind an unresolved tool follow-up
    // (R7-style "never lost" rule) — the summary's counts are unaffected either way since
    // they read from `turns[]`/`tools[]` directly, not from emitted lines.
    for (const [pendingTurn, meta] of this.pendingTurnLines) {
      this.emitTurnLine(pendingTurn, meta.status, meta.flushLagMs);
    }
    this.pendingTurnLines.clear();

    const durationS =
      this.tStreamStartPerf !== undefined
        ? Math.round((ms(this.tStreamStartPerf, now()) / 1000) * 10) / 10
        : 0;

    // n = complete turns (response-done fired) excluding those barged before first audio
    // (R12 / R6 edge cases). The greeting is never in turns[], so it's excluded by construction.
    const eligible = this.turns.filter(
      (t) => t.tResponseDone !== undefined && !(t.bargedIn && t.tFirstAudioDelta === undefined),
    );
    const bargeIns = this.turns.filter((t) => t.bargedIn).length;

    const numeric = (values: Array<number | undefined>): number[] =>
      values.filter((v): v is number => typeof v === 'number');

    const ttfbValues = numeric(eligible.map((t) => t.ttfbMs));
    const bridgeValues = numeric(eligible.map((t) => t.bridgeMs));
    const turnValues = numeric(eligible.map((t) => t.turnMs));

    const allTools = this.turns.flatMap((t) => t.tools);
    const toolTotalValues = numeric(
      allTools.map((tool) =>
        tool.tFollowupFirstDelta !== undefined ? ms(tool.tArgsDone, tool.tFollowupFirstDelta) : undefined,
      ),
    );

    this.emitLine('stream-stop', 'call summary', {
      durationS,
      turns: this.turns.length,
      n: eligible.length,
      bargeIns,
      ttfbP50: pct(ttfbValues, 50),
      ttfbP95: pct(ttfbValues, 95),
      ttfbMax: ttfbValues.length > 0 ? Math.max(...ttfbValues) : undefined,
      bridgeP50: pct(bridgeValues, 50),
      bridgeP95: pct(bridgeValues, 95),
      turnP50: pct(turnValues, 50),
      turnP95: pct(turnValues, 95),
      turnMax: turnValues.length > 0 ? Math.max(...turnValues) : undefined,
      toolCalls: allTools.length,
      toolTotalP50: pct(toolTotalValues, 50),
      loopP99Ms: loopP99Ms(),
    });
  }
}

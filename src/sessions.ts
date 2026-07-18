// Session interface, shared registry re-export, and idempotent teardown (Spec 03 R7/R9).
//
// `sessions` here MUST be Spec 02's `src/state.ts` map instance — never a second `new Map()`
// (master plan §6 R-2: two instances would break the SIGTERM drain loop, which only ever
// polls `state.ts`'s map). Per-call isolation is structural: no module-level state other than
// this one re-exported map; every handler closes over its own `Session` object.

import WebSocket from 'ws';
import { sessions as stateSessions } from './state.js';
import type { LogLevel } from './logger.js';
import type { GatewayLeg } from './gateway.js';
import type { Transcoder } from './dsp.js';
import type { TurnRecord, TurnRecorder } from './latency.js';
import type { ToolLoop } from './tools.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface Session {
  // owned by this spec (Twilio leg)
  twilioWs: WebSocket;
  streamSid: string;
  callSid: string;
  latestMediaTimestamp: number; // ms; ← every inbound media.timestamp (Number()ed)
  markQueue: string[]; // mark names sent, not yet echoed; length>0 ⇒ audio buffered/playing at Twilio
  markSeq: number; // monotonic; unique mark names r<responseId>:<seq>
  tornDown: boolean;
  log: (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;
  // wrapper over the shared logger (Spec 01 R12 / Spec 08 R1) with { callSid, streamSid }
  // pre-bound — Fastify runs logger:false, so req.log is a no-op and MUST NOT be used for
  // structured events.

  /** Implements Spec 02's SessionHandle: delegates to teardownSession(this, reason). */
  teardown(reason: string): void;

  // extension points — installed by later specs, typed here as optional callbacks
  onTwilioMedia?: (payloadB64: string) => void; // spec 05 (gateway append / DSP)
  onPlaybackDrained?: () => void; // spec 05 (barge-in epoch reset)
  onFirstMarkEcho?: (name: string) => void; // spec 08 (tFirstMarkEcho)
  onTeardown?: () => void; // specs 05/07 (close gateway leg, MCP client)

  // fields OWNED by specs 04/05/07/08 but declared here so the object shape is stable
  responseStartTimestamp: number | null;
  currentResponseId: string | null;
  lastAssistantItemId: string | null;
  responseActive: boolean;
  pendingToolCalls: Map<string, unknown>;
  timestamps: Record<string, number>;
  dspState?: unknown;

  // internal, this-spec-only (not a cross-spec contract): holds the R4 5 s start-timeout
  // handle so teardown can clear it.
  startTimer?: ReturnType<typeof setTimeout>;

  // internal, this-spec-only (not a cross-spec contract): T03.3's mark-naming rule (Spec 03
  // R5) tracks the first mark name minted per responseId here — per-session state, never
  // module-level (R9 isolation) — so `isFirstMarkOfResponse` can flag `tFirstMarkEcho` without
  // any global map.
  firstMarkByResponse: Map<string, string>;

  // ── T05.1 additive fields (Spec 05 R1) ──────────────────────────────────────────────────
  // `firstMarkNameOfResponse` is bargein.ts's OWN "first mark of the current response"
  // tracker (R6.1/R6.2) — distinct from the `firstMarkByResponse` map above (T03's per-
  // responseId history, kept for `isFirstMarkOfResponse`/T03's existing tests). Always
  // present, defaulted to null in `createSession` (mirrors `responseStartTimestamp` et al.).
  firstMarkNameOfResponse: string | null;
  // `gateway`/`transcoder`/`currentTurn` are Spec 04/06/08 objects `bargeIn()` (Spec 05 R5)
  // needs on the Session shape but that no task before T05.2 (the full session-assembly
  // wiring) actually constructs alongside `createSession()` — optional here, following the
  // same "installed by later specs" idiom as `onTwilioMedia`/`dspState` above, so this
  // additive edit never breaks T03's existing `createSession()` call sites or tests.
  gateway?: GatewayLeg;
  transcoder?: Transcoder;
  currentTurn?: TurnRecord | null;

  // ── T05.2 additive fields (Spec 05 R1) ──────────────────────────────────────────────────
  // `turnPhase`/`turns`/`tStreamStartPerf` complete the R1 shape session.ts's dispatch loop
  // needs; `currentTurn` above is the field it mutates turn-to-turn. `recorder`/`toolLoop` are
  // OPTIONAL — dispatch() calls them via `s.recorder?.<hook>`/`s.toolLoop?.<hook>` (Spec 08 R6 /
  // Spec 07 R10-R14 names) so this file's own `createSession()` (which predates both modules)
  // never needs to construct them; T05.3/T07's session-assembly task instantiates and assigns
  // them once wired into the real /twilio-media route.
  turnPhase: 'idle' | 'user-speaking' | 'awaiting-response' | 'responding';
  turns: TurnRecord[];
  tStreamStartPerf: number; // performance.now() at 'start' (anchors the media clock, findings/09 §1)
  recorder?: TurnRecorder;
  toolLoop?: ToolLoop;

  // ── T05.4 additive field (Spec 05 R1) ───────────────────────────────────────────────────
  // Per-call MCP client (Spec 07 R7) — created in `startSessionBridge`, closed in the
  // teardown funnel via `session.onTeardown`. Deliberately NOT declaring a `heartbeat` field
  // here even though Spec 05 R1 lists one: the optional gateway ping (Spec 04 R12) owns its
  // timer entirely inside `openGatewayLeg`'s closure and already clears it on the gateway
  // leg's own `'close'` handler — there is no Session-level handle to clear, so adding an
  // always-undefined field here would be dead weight, not a real integration seam.
  mcpClient?: Client;
}

// ONE process-wide map: re-exports Spec 02's src/state.ts `sessions` instance verbatim (master
// plan R-2 — two Map instances would break the SIGTERM drain). Session structurally implements
// SessionHandle, so the type assertion below is safe.
export const sessions = stateSessions as unknown as Map<string, Session>;

/**
 * Initializes a fresh per-call Session. Does NOT insert into `sessions` — the `/twilio-media`
 * route's `start` handler does that (Spec 03 R4 step 4), after the token auth gate succeeds.
 */
export function createSession(init: {
  twilioWs: WebSocket;
  streamSid: string;
  callSid: string;
  log: Session['log'];
}): Session {
  const session: Session = {
    twilioWs: init.twilioWs,
    streamSid: init.streamSid,
    callSid: init.callSid,
    log: init.log,
    latestMediaTimestamp: 0,
    markQueue: [],
    markSeq: 0,
    tornDown: false,
    responseStartTimestamp: null,
    currentResponseId: null,
    lastAssistantItemId: null,
    responseActive: false,
    pendingToolCalls: new Map<string, unknown>(),
    timestamps: {},
    firstMarkByResponse: new Map<string, string>(),
    firstMarkNameOfResponse: null,
    turnPhase: 'idle',
    turns: [],
    tStreamStartPerf: performance.now(), // createSession() runs at Twilio 'start' (Spec 03 R4 step 4)
    teardown(reason: string) {
      teardownSession(session, reason, { twilioCloseCode: 1001 });
      // 1001 ("going away") because the only external caller of Session.teardown is Spec 02's
      // drain loop, whose contract (Spec 02 R2 doc comment) is "Twilio leg with close(1001, …)".
    },
  };
  return session;
}

/**
 * Idempotent teardown (Spec 03 R7). The single exported entry point for tearing down a
 * Session — Spec 05 later becomes the one process-wide teardown implementation behind this
 * seam (the "teardown matrix"), so keeping this the sole entry point keeps that swap local.
 */
export function teardownSession(
  s: Session,
  reason?: string,
  opts?: { twilioCloseCode?: number },
): void {
  if (s.tornDown) return;
  s.tornDown = true;

  if (s.startTimer !== undefined) clearTimeout(s.startTimer);

  try {
    s.onTeardown?.();
  } catch (err) {
    // An onTeardown throw must not skip the mandatory delete/close steps below.
    s.log('error', 'onTeardown threw', { err: String(err) });
  }

  // Mandatory on every path — the SIGTERM drain loop (Spec 02 R8) polls `sessions.size` and
  // never completes if a torn-down session lingers in the map.
  sessions.delete(s.streamSid);

  if (s.twilioWs.readyState === WebSocket.OPEN || s.twilioWs.readyState === WebSocket.CONNECTING) {
    s.twilioWs.close(opts?.twilioCloseCode ?? 1000, reason ?? 'bye');
  }
}

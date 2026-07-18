// GET /twilio-media — Twilio bidirectional Media Streams WebSocket leg (Spec 03 R1-R4, R7-R9).
//
// T03.2 scope: route registration (v11 `(socket, req)` handler API), `connected`/`start`
// handling, the `claimPendingCall` token auth gate, the 5 s start-timeout, and synchronous
// close/error wiring with the `stream-stop` summary line. `media`/`mark`/`stop`/`dtmf` are
// left as stubs for T03.4; outbound send helpers (`sendMedia`/`sendMark`/`sendClear`/`hangup`)
// and the backpressure guard are T03.3's job (Spec 03 R5/R6).

import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws'; // default-export namespace; used here only for the OPEN readyState constant
import twilio from 'twilio'; // default-import + destructure: safe under both ESM and CJS emit (twilio is a CJS package)
const { validateRequest } = twilio;
import type { AppConfig } from './config.js';
import { logEvent } from './logger.js';
import { createSession, teardownSession, sessions, type Session } from './sessions.js';

// --- Vendored inbound message types (Spec 03 R3 — exact wire schemas). All numeric-looking
// fields (`sequenceNumber`, `media.chunk`, `media.timestamp`) are STRINGS on the wire — never
// `number` here; convert with `Number(...)` at the point of use [findings/03 claim 4, gotcha 4].

export interface TwilioConnectedMessage {
  event: 'connected';
  protocol: string;
  version: string;
}

export interface TwilioMediaFormat {
  encoding: string;
  sampleRate: number;
  channels: number;
}

export interface TwilioStartMessage {
  event: 'start';
  sequenceNumber: string;
  streamSid: string;
  start: {
    accountSid: string;
    streamSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: TwilioMediaFormat;
    customParameters?: Record<string, string>;
  };
}

export interface TwilioMediaMessage {
  event: 'media';
  sequenceNumber: string;
  streamSid: string;
  media: {
    track: string;
    chunk: string; // string on the wire
    timestamp: string; // string on the wire
    payload: string; // base64 raw mu-law, no header bytes
  };
}

export interface TwilioMarkMessage {
  event: 'mark';
  sequenceNumber: string;
  streamSid: string;
  mark: { name: string };
}

export interface TwilioStopMessage {
  event: 'stop';
  sequenceNumber: string;
  streamSid: string;
  stop: { accountSid: string; callSid: string };
}

export interface TwilioDtmfMessage {
  event: 'dtmf';
  streamSid: string;
  sequenceNumber: string;
  dtmf: { track: string; digit: string };
}

export type TwilioInboundMessage =
  | TwilioConnectedMessage
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioMarkMessage
  | TwilioStopMessage
  | TwilioDtmfMessage;

/**
 * Dependencies injected by `server.ts` (Spec 02 R6 marked section). `twilioValidateUpgrade` is
 * typed optional-boolean here rather than required (the config key itself lands in T03.5's
 * `src/config.ts` change) — declaring it this way lets `Pick<AppConfig, ...>` typecheck against
 * today's `AppConfig` while still accepting tomorrow's field once T03.5 tightens it.
 */
export interface TwilioMediaDeps {
  config: Pick<AppConfig, 'publicHost' | 'twilioAuthToken'> & { twilioValidateUpgrade?: boolean };
  claimPendingCall: (candidate: string) => { callSid: string } | undefined;
  onSessionStart: (session: Session) => void;
  /**
   * Test-only override for the R4 start-timeout (default 5000 ms — see `START_TIMEOUT_MS`
   * below). Deviation-by-design recorded in the T03.2 completion report: `node:test`'s
   * `mock.timers` proved incompatible with `fastify.injectWS`'s fake duplex transport (enabling
   * the mock globally stalls unrelated real timers — e.g. `ws`'s internal close-handshake timer
   * — across the whole test file, cascading into unrelated test failures). This override lets
   * A3 exercise the real timeout path deterministically with a small real delay instead.
   */
  startTimeoutMs?: number;
}

/** R4: no `start` within this many ms of upgrade closes the socket (policy violation). */
const START_TIMEOUT_MS = 5000;

/**
 * Registers `GET /twilio-media` on the already-registered `@fastify/websocket` plugin (Spec 02
 * R3 registers it; this function only declares the route — never re-registers the plugin).
 * Per-call isolation is structural: every handler invocation closes over its own local state
 * (`session`, `callSid`, `streamSid`, `sawStop`, `startTimer`) — no module-level mutable state
 * beyond the shared `sessions` registry itself (Spec 03 R9).
 */
export function registerTwilioMediaRoute(app: FastifyInstance, deps: TwilioMediaDeps): void {
  app.get('/twilio-media', { websocket: true }, (socket, req) => {
    // R8: optional defense-in-depth upgrade-signature validation — log-only, never rejects.
    // Primary auth is the R4 token gate below; this never replaces it.
    const sig = req.headers['x-twilio-signature'] as string | undefined; // Node lowercases headers
    logEvent({
      level: 'info',
      message: 'x-twilio-signature on upgrade',
      event: 'upgrade-signature',
      present: !!sig,
    });
    if (deps.config.twilioValidateUpgrade && sig) {
      const wssUrl = `wss://${deps.config.publicHost}/twilio-media`; // scheme MUST be wss, NOT https
      const ok = validateRequest(deps.config.twilioAuthToken, sig, wssUrl, {}); // upgrade is a GET: params = {}
      logEvent({
        level: 'info',
        message: 'upgrade signature validation (advisory)',
        event: 'upgrade-signature-check',
        ok,
      });
    }

    // Per-connection closure state — never module-level (BRD FR-3 isolation).
    let session: Session | undefined;
    let callSid: string | undefined;
    let streamSid: string | undefined;
    // T03.4 sets this true when a `stop` message arrives; used below to distinguish a normal
    // stop-then-close from an abnormal 1006 network drop in the `stream-stop` summary.
    let sawStop = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      socket.close(1008, 'no start'); // policy violation — no `start` arrived in time
    }, deps.startTimeoutMs ?? START_TIMEOUT_MS);

    // 'error' and 'close' MUST be attached synchronously, before any awaits — an unhandled
    // 'error' event crashes the process and severs every concurrent call [findings/08 gotcha 10].
    // There are no awaits anywhere in this handler, so this ordering requirement is trivially met.
    socket.on('error', (err: Error) => {
      // Log only — 'close' always follows an 'error' and is the single teardown path
      // [findings/08 error/close matrix].
      logEvent({
        level: 'error',
        message: 'twilio ws error',
        event: 'twilio-ws-error',
        callSid,
        streamSid,
        err: err.message,
      });
    });

    socket.on('close', (code: number, reasonBuf: Buffer) => {
      if (startTimer !== undefined) {
        clearTimeout(startTimer);
        startTimer = undefined;
      }
      const reason = reasonBuf.toString(); // reason is a Buffer [findings/08 gotcha 9]
      // 1000/1005 after a `stop` event = normal hangup; 1006 with no `stop` = network drop/abort.
      const abnormal = code === 1006 && !sawStop;
      logEvent({
        level: abnormal ? 'warn' : 'info',
        message: 'stream-stop',
        event: 'stream-stop',
        callSid,
        streamSid,
        code,
        reason,
        abnormal,
        bufferedAmount: socket.bufferedAmount,
      });
      // All teardown lives here — the single, idempotent path (Spec 03 R7).
      if (session) teardownSession(session);
    });

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      // Wrapped in try/catch (findings/03 gotcha 7): exceptions log via logEvent and never
      // throw out of the handler — an unhandled throw here would hang up on the caller.
      try {
        if (isBinary) return; // Twilio sends JSON text frames only [Spec 03 R3]

        let msg: TwilioInboundMessage;
        try {
          msg = JSON.parse(data.toString()) as TwilioInboundMessage;
        } catch {
          logEvent({
            level: 'warn',
            message: 'twilio ws message parse failure',
            event: 'twilio-parse-error',
            callSid,
            streamSid,
          });
          return;
        }

        switch (msg.event) {
          case 'connected':
            // No streamSid yet; send nothing, bridge nothing [Spec 03 R4].
            break;

          case 'start': {
            // The auth gate and session birth [Spec 03 R4].
            if (startTimer !== undefined) {
              clearTimeout(startTimer);
              startTimer = undefined;
            }

            const startStreamSid = msg.start.streamSid;
            const startCallSid = msg.start.callSid;
            const token = msg.start.customParameters?.token ?? '';
            callSid = startCallSid;
            streamSid = startStreamSid;

            // Verify the token BEFORE bridging any audio or attaching the gateway leg. This
            // route never compares tokens itself — claimPendingCall (Spec 02 R5.2) does the
            // single-use, constant-time (timingSafeEqual) check.
            const claimed = deps.claimPendingCall(token);
            if (!claimed) {
              logEvent({
                level: 'warn',
                message: 'auth-fail',
                event: 'auth-fail',
                callSid: startCallSid,
              });
              socket.close(1008, 'bad token'); // 1008 = policy violation
              // Never create a Session; never open/attach the gateway leg.
              return;
            }

            // Bound log wrapper (Spec 03 R9 comment): { callSid, streamSid } pre-merged into
            // every call. Fastify runs logger:false, so req.log is a no-op and MUST NOT be
            // used for structured events — this always goes through the shared logEvent().
            const sessionLog: Session['log'] = (level, message, fields = {}) => {
              logEvent({
                level,
                message,
                event: (fields.event as string | undefined) ?? message,
                callSid: startCallSid,
                streamSid: startStreamSid,
                ...fields,
              });
            };

            session = createSession({
              twilioWs: socket,
              streamSid: startStreamSid,
              callSid: startCallSid,
              log: sessionLog,
            });
            sessions.set(startStreamSid, session);
            logEvent({
              level: 'info',
              message: 'stream-start',
              event: 'stream-start',
              callSid: startCallSid,
              streamSid: startStreamSid,
              mediaFormat: msg.start.mediaFormat,
            });
            deps.onSessionStart(session); // Spec 05 replaces onSessionStart
            break;
          }

          case 'media': // T03.4
          case 'mark': // T03.4
          case 'dtmf': // T03.4
            break;

          case 'stop': // T03.4 (will set sawStop = true and forward to teardown)
            break;

          default: {
            // Unknown event name — log once at debug and ignore (Spec 03 R3).
            logEvent({
              level: 'debug',
              message: 'twilio ws unknown event',
              event: 'twilio-unknown-event',
              callSid,
              streamSid,
              rawEvent: (msg as { event?: unknown }).event,
            });
          }
        }
      } catch (err) {
        logEvent({
          level: 'error',
          message: 'twilio ws message handler threw',
          event: 'twilio-message-handler-error',
          callSid,
          streamSid,
          err: String(err),
        });
      }
    });
  });
}

// --- T03.3: outbound send helpers, mark naming, backpressure guard (Spec 03 R5/R6/R7). ---
//
// Module-level pure functions over `Session` (no closure over route state) so Spec 05 can
// import them directly onto the gateway `audio-delta` path [plan T03.3]. No pacing, no
// re-framing, no timers/chunking/batching anywhere below — Twilio is the pacer, forward
// immediately [Spec 03 R5; findings/03 claims 5/7; findings/06 C11].

/** ~1 MB ≈ 25 s of mu-law queued locally — call unrecoverable [Spec 03 R6 verbatim]. */
const MAX_BUFFERED_BYTES = 1_000_000;

/**
 * media — raw mu-law/8000 base64, NO file/WAV header bytes [Spec 03 R5; findings/03 claim 5,
 * gotcha 5]. Backpressure is checked FIRST: a stalled Twilio socket must never queue audio
 * unboundedly in process memory [Spec 03 R6]. No outbound pacing or re-framing — forward each
 * gateway `audio-delta` payload as one `media` message the instant it arrives [Spec 03 R5].
 */
export function sendMedia(session: Session, payloadB64: string): void {
  const socket = session.twilioWs;
  if (socket.readyState !== WebSocket.OPEN) return; // no-op without throwing [Spec 03 R5 preamble]

  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    session.log('warn', 'twilio leg backpressure — dropping call', { buffered: socket.bufferedAmount });
    socket.close(1011, 'backpressure'); // 'close' handler performs teardown [Spec 03 R6]
    return;
  }

  socket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: payloadB64 } }));
}

/**
 * mark — UNIQUE per-response names; see `nextMarkName` for the `r<responseId>:<seq>` minting
 * rule [Spec 03 R5]. Pushes onto `session.markQueue` (remove-by-name accounting owned by
 * T03.4's inbound `mark` echo handler).
 */
export function sendMark(session: Session, name: string): void {
  const socket = session.twilioWs;
  if (socket.readyState !== WebSocket.OPEN) return;

  socket.send(JSON.stringify({ event: 'mark', streamSid: session.streamSid, mark: { name } }));
  session.markQueue.push(name);
}

/**
 * clear — flush Twilio's playback buffer (barge-in step 1); triggers the mark-echo storm
 * handled by T03.4's `mark` handler (post-clear echoes mean "flushed", not "played")
 * [Spec 03 R5; findings/03 claim 16.3, gotcha 3].
 */
export function sendClear(session: Session): void {
  const socket = session.twilioWs;
  if (socket.readyState !== WebSocket.OPEN) return;

  socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
}

/**
 * Clean-hangup mechanism (normative for FR-7): with the PoC TwiML (nothing after
 * `</Connect>`), closing this WS makes `<Connect>` finish and the call end [Spec 03 R7;
 * findings/03 claim 1]. Codes: 1000 deliberate, 1001 SIGTERM shutdown, 1008 auth failure, 1011
 * backpressure/internal fault.
 */
export function hangup(session: Session, code = 1000, reason = 'bye'): void {
  const socket = session.twilioWs;
  if (socket.readyState !== WebSocket.OPEN) return;

  socket.close(code, reason);
}

/**
 * Mints the next outbound mark name in the `r<responseId>:<seq>` namespace, `markSeq` being a
 * per-session monotonically increasing counter (NOT per-response) [Spec 03 R5 mark-naming
 * rule; findings/10 T3]. On the first mint for a given `responseId`, records that name as the
 * response's first mark — this doubles as the `tFirstMarkEcho` instrumentation point once
 * T03.4's mark-echo handler calls `isFirstMarkOfResponse` [Spec 03 R5].
 */
export function nextMarkName(session: Session, responseId: string): string {
  session.markSeq += 1;
  const name = `r${responseId}:${session.markSeq}`;
  if (!session.firstMarkByResponse.has(responseId)) {
    session.firstMarkByResponse.set(responseId, name);
  }
  return name;
}

/**
 * True iff `name` is the first mark name minted for whichever response it belongs to (per the
 * `firstMarkByResponse` bookkeeping `nextMarkName` maintains). Consumed by T03.4's inbound
 * `mark` echo handler to fire `session.onFirstMarkEcho` exactly once per response [Spec 03 R4,
 * R5]. Exported (rather than module-private) so it is directly testable and importable by
 * T03.4 without reaching into this module's closure.
 */
export function isFirstMarkOfResponse(session: Session, name: string): boolean {
  for (const firstName of session.firstMarkByResponse.values()) {
    if (firstName === name) return true;
  }
  return false;
}

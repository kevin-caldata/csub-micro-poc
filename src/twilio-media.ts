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
import type { PendingCall } from './twiml.js';
// T05.1 reconciliation: the inbound `mark` case below delegates wholly to bargein.ts's
// `onMarkEcho` (Spec 05 R6 note) rather than re-implementing the remove-by-name splice. This is
// a deliberate reverse import (Spec 05 depends on Spec 03, not vice versa) — safe under ESM
// because both modules only call into each other from inside function bodies, never at
// top-level module-evaluation time.
import { onMarkEcho } from './bargein.js';
import { markAbnormalEnd, markExpectedEnd } from './reconnect.js';

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
 * Dependencies injected by `server.ts` (Spec 02 R6 marked section). `config` is tightened to the
 * exact fields this route reads — `twilioValidateUpgrade` lands in `src/config.ts`'s `AppConfig`
 * as of T03.5 (Spec 03 R8).
 */
export interface TwilioMediaDeps {
  config: Pick<AppConfig, 'publicHost' | 'twilioAuthToken' | 'twilioValidateUpgrade' | 'twilioPingSeconds'>;
  claimPendingCall: (candidate: string) => PendingCall | undefined;
  /**
   * T05.4 widening (Spec 03 R4 step 4 already holds the claimed `PendingCall` at this call
   * site — it was simply not threaded through until now): the real implementation this points
   * at (`startSessionBridge`, Spec 05) needs `pendingCall.gatewayAuth` to await the mint. The
   * narrower `(session) => void` signature this deviated from is additively widened, not
   * replaced — existing stub `onSessionStart`s that ignore the second parameter (all of T03's
   * own tests) keep working unchanged; JS simply drops the extra argument they never declared.
   */
  onSessionStart: (session: Session, pendingCall: PendingCall) => void | Promise<void>;
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
        url: wssUrl, // A11: machine-checkable that the wss scheme (never the http(s) upgrade scheme) was used
      });
    }

    // Per-connection closure state — never module-level (BRD FR-3 isolation).
    let session: Session | undefined;
    let callSid: string | undefined;
    let streamSid: string | undefined;
    // T03.4 sets this true when a `stop` message arrives; used below to distinguish a normal
    // stop-then-close from an abnormal 1006 network drop in the `stream-stop` summary.
    let sawStop = false;
    // T03.4: fires once, on the first inbound `media` frame, for the S22 cadence log line.
    // Never set again — no per-frame logging (Railway 500 lines/s cap) [Spec 03 R3 last para,
    // findings/09 rules].
    let loggedMediaCadence = false;
    // findings/18 addendum (claim 21): started once the session exists (in the `start` case
    // below); cleared here, in the single `close` listener, which fires on every close path
    // (graceful or abnormal) — the same choke point `stream-stop`'s summary line already uses.
    let heartbeat: TwilioHeartbeatHandle | undefined;
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
      heartbeat?.stop(); // findings/18 addendum claim 22: emits the one twilio-heartbeat summary line
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
      // findings/18 reconnect: a non-1000 close that no deliberate-close path claimed first is
      // an infrastructure drop — record it so /twiml-action reconnects this call. Every
      // deliberate close (caller-hangup stop, fallback, shutdown drain, teardownSession) marks
      // 'expected' BEFORE closing, and markAbnormalEnd never overwrites that mark — so this
      // blanket "any non-1000 code" write only ever sticks for genuinely abnormal ends (1006
      // network drops chief among them). Marked BEFORE teardownSession below so the registry is
      // settled before Twilio's /twiml-action request can arrive.
      if (callSid && code !== 1000) markAbnormalEnd(callSid);
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
              markExpectedEnd(startCallSid); // deliberate close — never a reconnect trigger
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
            // findings/18 addendum (claim 21): per-session Twilio-leg heartbeat, started the
            // instant the session exists (mirrors gateway.ts's gateway-leg keepalive starting on
            // 'open'); no-ops entirely when deps.config.twilioPingSeconds is 0.
            heartbeat = startTwilioHeartbeat(session, deps.config.twilioPingSeconds);
            logEvent({
              level: 'info',
              message: 'stream-start',
              event: 'stream-start',
              callSid: startCallSid,
              streamSid: startStreamSid,
              mediaFormat: msg.start.mediaFormat,
            });
            // Fire-and-forget: startSessionBridge does async bootstrap work (mint await, MCP
            // client, gateway leg) off this synchronous message handler. It must never reject
            // unhandled — Spec 05's own try/catch around the mint await is the guarantee; `void`
            // here documents that this call site deliberately does not await it.
            void deps.onSessionStart(session, claimed);
            break;
          }

          case 'media': {
            // Only `track:"inbound"` ever arrives on a bidirectional stream [Spec 03 R4,
            // findings/03 claim 4]. `media.timestamp` is a wire STRING — Number() it here, once,
            // at the point of use [Spec 03 R3, findings/03 claim 4/gotcha 4].
            if (!session) break;
            session.latestMediaTimestamp = Number(msg.media.timestamp);

            if (!loggedMediaCadence) {
              loggedMediaCadence = true;
              // ONE line per call, on the first frame only — spike S22 evidence (handshake
              // cadence / frame size on this account/region) [Spec 03 R3 last paragraph;
              // findings/03 claim 8, gotcha open question]. Never per-frame after this.
              logEvent({
                level: 'info',
                message: 'media-cadence',
                event: 'media-cadence',
                callSid,
                streamSid,
                timestamp: session.latestMediaTimestamp,
                payloadBytes: Buffer.from(msg.media.payload, 'base64').length,
              });
            }

            session.onTwilioMedia?.(msg.media.payload); // spec 05 hook: input-audio-append / DSP
            break;
          }

          case 'mark': {
            // T05.1 reconciliation (Spec 05 R6 note / master plan single-seam rule): delegates
            // WHOLLY to bargein.ts's `onMarkEcho` — the sole remove-by-name implementation
            // process-wide. `onMarkEcho` performs the same splice-by-indexOf (never a bare
            // shift()), the same drain -> `onPlaybackDrained` + epoch-disarm, and the same
            // first-mark -> `onFirstMarkEcho` firing that used to live inline here [Spec 03 R4
            // verbatim snippet superseded; findings/04 V7/G2; findings/10 C4]. A mark echo
            // arriving after a `clear` means "flushed", not "played" — exactly why unknown/late
            // names are silently ignored rather than corrupt the queue (onMarkEcho's job).
            // Non-first echoes are never logged here [findings/09 rules].
            if (!session) break;
            onMarkEcho(session, msg.mark.name);
            break;
          }

          case 'dtmf':
            // PoC scope: log-only, no other action [Spec 03 R4; findings/03 claim 4].
            session?.log('info', 'dtmf', { event: 'dtmf', digit: msg.dtmf.digit });
            break;

          case 'stop':
            // The call/stream ended from Twilio's side. Set the closure flag the `'close'`
            // listener's `abnormal` computation reads (T03.2), then tear down. The `'close'`
            // event fires regardless (Twilio closes shortly after `stop`, or we do via
            // teardownSession below) and emits the `stream-stop` summary line — nothing extra
            // is logged here [Spec 03 R4/R7; plan T03.4].
            sawStop = true;
            if (session) teardownSession(session, 'caller-hangup');
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
    markExpectedEnd(session.callSid); // deliberate drop (unrecoverable call) — never a reconnect trigger
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
 * Clean-hangup mechanism (normative for FR-7): closing this WS makes `<Connect>` finish; the
 * TwiML's action="/twiml-action" callback (findings/18 reconnect flow, src/twiml.ts) then sees
 * no abnormal-end mark for the call and returns an empty <Response/>, ending the call — same
 * caller experience as the old nothing-after-</Connect> fall-through, one HTTP round trip
 * later. Codes: 1000 deliberate, 1001 SIGTERM shutdown, 1008 auth failure, 1011
 * backpressure/internal fault.
 */
export function hangup(session: Session, code = 1000, reason = 'bye'): void {
  const socket = session.twilioWs;
  if (socket.readyState !== WebSocket.OPEN) return;

  socket.close(code, reason);
}

// --- findings/18 addendum (claims 21-23): Twilio-leg WS ping/pong heartbeat ---------------------
//
// Pure transport-layer instrumentation, deliberately modeled on gateway.ts's gateway-leg keepalive
// ping (gateway.ts:414-419, GATEWAY_PING_SECONDS) — a few lines, no message-schema change, and
// zero risk to call behavior: `ping()`/`pong()` are WS-protocol control frames, invisible to
// Twilio's application-level Media Streams parser, and `ws`-based peers auto-pong per RFC 6455
// 5.5.3 (a pong's payload must echo the ping's verbatim). This directly tests H2' (per-connection
// Railway/Twilio edge transport flakiness, findings/18 addendum): a 31924 preceded by a missed
// pong or an elevated RTT is near-direct confirmation; clean pongs right up to the error refutes
// it (claim 22). Deliberately INSTRUMENTATION ONLY — never acts on a missed pong (no teardown, no
// reconnect; that is separate zombie-teardown work, out of scope here).
//
// Log budget is anomalies-only (Railway line-rate cap, findings/09 rules): a `twilio-pong-missed`
// warn once a ping goes unanswered past 2 intervals, a `twilio-pong-slow` warn on any RTT over
// 1000 ms, and exactly ONE `twilio-heartbeat` info summary line — emitted from `stop()`, i.e. at
// session teardown — carrying pings/pongs/maxRttMs/lastPongAgoMs, the line meant to correlate
// against any live 31924. Never a per-pong info log.

/** Handle returned by `startTwilioHeartbeat`; `stop()` is idempotent. */
export interface TwilioHeartbeatHandle {
  stop(): void;
}

const NOOP_HEARTBEAT: TwilioHeartbeatHandle = { stop(): void {} };

/**
 * Starts a per-session ping/pong heartbeat on the Twilio leg's own socket (findings/18 addendum
 * claim 21), or — if `pingSeconds <= 0` (TWILIO_PING_SECONDS=0) — deliberately does nothing at
 * all: no timer, no `pong` listener, no logging, ever. `pingSeconds` is normally
 * `config.twilioPingSeconds`; passed explicitly (not the whole `AppConfig`) so this stays a pure
 * function of its own inputs, callable from a unit test without an `AppConfig` fixture.
 */
export function startTwilioHeartbeat(session: Session, pingSeconds: number): TwilioHeartbeatHandle {
  if (pingSeconds <= 0) return NOOP_HEARTBEAT;

  const socket = session.twilioWs;
  const intervalMs = pingSeconds * 1000;
  let pingsSent = 0;
  let pongsReceived = 0;
  let maxRttMs = 0;
  let lastPongAt = Date.now(); // baseline for the first missed-pong check, before any real pong
  let missedWarned = false; // one warn per missed episode — cleared the moment a pong lands
  let stopped = false;

  function onPong(data: Buffer): void {
    pongsReceived += 1;
    const receivedAt = Date.now();
    lastPongAt = receivedAt;
    missedWarned = false;
    const sentAt = Number(data.toString());
    const rttMs = Number.isFinite(sentAt) ? Math.max(0, receivedAt - sentAt) : 0;
    if (rttMs > maxRttMs) maxRttMs = rttMs;
    if (rttMs > 1000) {
      session.log('warn', 'twilio-pong-slow', {
        event: 'twilio-pong-slow',
        callSid: session.callSid,
        streamSid: session.streamSid,
        rttMs,
      });
    }
  }
  socket.on('pong', onPong);

  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return; // no-op without throwing (same guard as sendMedia)
    const sinceLastPongMs = Date.now() - lastPongAt;
    if (sinceLastPongMs > 2 * intervalMs && !missedWarned) {
      missedWarned = true;
      session.log('warn', 'twilio-pong-missed', {
        event: 'twilio-pong-missed',
        callSid: session.callSid,
        streamSid: session.streamSid,
        sinceLastPongMs,
      });
    }
    pingsSent += 1;
    socket.ping(Buffer.from(String(Date.now())));
  }, intervalMs);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      socket.off('pong', onPong);
      // The ONE correlator line (findings/18 addendum claim 22): if this call's next event is a
      // Twilio 31924, whatever pingsSent/pongsReceived/maxRttMs/lastPongAgoMs say here is the
      // per-connection liveness evidence.
      session.log('info', 'twilio-heartbeat', {
        event: 'twilio-heartbeat',
        callSid: session.callSid,
        streamSid: session.streamSid,
        pingsSent,
        pongsReceived,
        maxRttMs,
        lastPongAgoMs: Date.now() - lastPongAt,
      });
    },
  };
}

/**
 * Mints the next outbound mark name in the `r<responseId>:<seq>` namespace, `markSeq` being a
 * per-session monotonically increasing counter (NOT per-response) [Spec 03 R5 mark-naming
 * rule; findings/10 T3]. On the first mint for a given `responseId`, records that name in
 * `firstMarkByResponse` (T03's own per-responseId history — see the deprecation note on
 * `isFirstMarkOfResponse` below).
 *
 * T05.2 review fix (single-writer collapse): this function used to ALSO write
 * `session.firstMarkNameOfResponse` here, duplicating bargein.ts's `pushMark` (Spec 05 R6.1),
 * which is the field's real writer (session.ts's dispatch loop mints names via `nextMarkName`
 * and immediately hands them to `pushMark`, never bypassing it). Two writers for one field is
 * exactly the bug class Spec 05 R4/R6 are careful about elsewhere (the epoch/mark accounting) —
 * collapsed to `pushMark` as the SOLE writer; this function no longer touches
 * `firstMarkNameOfResponse` at all.
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
 * @deprecated Superseded by bargein.ts's `firstMarkNameOfResponse` single-value tracker (Spec 05
 * R6.1/R6.2), which is what `onMarkEcho` actually reads to fire `onFirstMarkEcho` — the inbound
 * `mark` case below delegates wholly to `onMarkEcho` and never calls this function (T05.1
 * reconciliation). No production code path calls `isFirstMarkOfResponse` any more; it is kept
 * (rather than deleted) only because T03's own unit tests (`twilio-media.outbound.test.ts` et
 * al.) still exercise it directly against `firstMarkByResponse`'s bookkeeping. Do not add new
 * call sites — use `firstMarkNameOfResponse` via bargein.ts instead.
 */
export function isFirstMarkOfResponse(session: Session, name: string): boolean {
  for (const firstName of session.firstMarkByResponse.values()) {
    if (firstName === name) return true;
  }
  return false;
}

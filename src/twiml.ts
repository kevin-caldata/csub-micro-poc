import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import twilio from 'twilio'; // default-import + destructure: safe under both ESM and CJS emit (twilio is a CJS package)
const { validateRequest } = twilio;
import { mintRealtimeToken } from './gateway.js';
import type { AppConfig } from './config.js';
import { logEvent } from './logger.js';
import { getSessionByStreamSid } from './sessions.js';
import { getCallEnding, markAbnormalEnd } from './reconnect.js';

export interface PendingCall {
  callSid: string;
  createdAt: number; // Date.now()
  // Widened to include gateway.ts's `getTokenMs` (MintResult's shape) as optional, not required:
  // the real mint() call site always resolves with it, but injected test mints (session.ts's
  // `SessionBridgeDeps` seam) legitimately omit it, and session.ts consumes it as
  // possibly-undefined (TurnRecorder.seedGreeting already treats a missing getTokenMs as
  // "nothing to seed" rather than throwing) — see this task's Finding 2 note.
  gatewayAuth: Promise<{ token: string; url: string; expiresAt?: number; getTokenMs?: number }>;
  /** Set (>= 1) only on entries minted by /twiml-action's reconnect flow (findings/18). The seam
   *  session.ts reads to swap the fresh-call greeting for RECONNECT_GREETING_INSTRUCTIONS —
   *  server-side provenance, deliberately not re-derived from the stream's echoed
   *  customParameters (the token and this flag are minted together; the pendingCall entry is
   *  the authoritative record of both). */
  reconnectAttempt?: number;
}

export const pendingCalls = new Map<string, PendingCall>(); // key = per-call token

export const PENDING_TTL_MS = 60_000; // BRD §5.4 / findings/03 claim 11: single-use, ~60 s TTL

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * Single-use, constant-time claim. Sweeps expired entries as it iterates.
 * A direct `Map.get` would be a timing oracle [findings/03 claim 11] — this
 * instead hashes both sides to a fixed-length digest before comparing, so
 * `timingSafeEqual` never sees mismatched-length inputs and the comparison
 * time does not depend on candidate length or content.
 */
export function claimPendingCall(candidate: string): PendingCall | undefined {
  for (const [tok, pc] of pendingCalls) {
    if (Date.now() - pc.createdAt > PENDING_TTL_MS) {
      pendingCalls.delete(tok);
      continue;
    }
    if (timingSafeEqual(sha256(tok), sha256(candidate))) {
      // hash-then-compare: length-independent constant time
      pendingCalls.delete(tok); // single-use
      return pc;
    }
  }
  return undefined;
}

/** Deletes entries with createdAt < now - PENDING_TTL_MS. Called on every /twiml hit (no timers). */
export function sweepPendingCalls(now: number = Date.now()): void {
  for (const [tok, pc] of pendingCalls) {
    if (pc.createdAt < now - PENDING_TTL_MS) {
      pendingCalls.delete(tok);
    }
  }
}

export type MintFn = (
  modelId: string,
  callSid?: string,
) => Promise<{ token: string; url: string; expiresAt?: number }>;

export interface TwimlDeps {
  mint?: MintFn;
}

/**
 * Registers POST /twiml (signature-validated per Spec 02 R5.1, mint kick-off per R5.3, TwiML
 * response per R5.4), POST /twiml-action (the <Connect action> reconnect callback, findings/18 —
 * signature-validated exactly like /twiml, G8), and POST /stream-status. Two-arg-plus-deps form
 * supersedes Spec 02 R6's one-arg illustration — config is injected here, never re-loaded
 * (planned deviation).
 *
 * /stream-status is otherwise log-only (R7), with ONE sanctioned exception (production
 * zombie-socket fix, logs 18:09/18:11 — Twilio's protocol-error stream kills (e.g. 31924) send
 * NO WebSocket close frame, so our Twilio-leg socket sits half-open for up to ~2 min until TCP
 * death, keeping the session/gateway leg alive for a caller who is long gone): on
 * `StreamEvent === 'stream-error'`, look up the live session by StreamSid and `terminate()` its
 * Twilio socket immediately. `terminate()` (not `close()`) is deliberate — the peer is already
 * gone, so there is no point attempting a graceful handshake — and it synchronously fires the
 * socket's existing `'close'` handler (registered in twilio-media.ts), which runs the SAME
 * `teardownSession` path as any other disconnect (gateway leg closed, session reaped). This
 * handler does not itself implement teardown; it only triggers the existing one sooner. Every
 * other route in this file, and the rest of this handler, is untouched (G8 signature gate).
 */
export function registerTwimlRoutes(app: FastifyInstance, config: AppConfig, deps?: TwimlDeps): void {
  // Wave B/C merge point applied: /twiml delegates to Spec 04's mintRealtimeToken
  // (typed errors + getTokenMs logging), adapter form per ledger pre-declared deviation.
  const mint: MintFn =
    deps?.mint ?? ((modelId, callSid) => mintRealtimeToken(config, callSid ?? '', modelId));

  /**
   * The one mint-and-store flow (Spec 02 R5.3), shared verbatim by /twiml (fresh call) and
   * /twiml-action (reconnect — passes `reconnectAttempt`): kicks off the gateway token mint,
   * attaches the mandatory resolve/reject log handlers (an unlogged rejection here becomes an
   * unhandledRejection that can kill the process and all concurrent calls), and stores the
   * single-use pendingCalls entry. Returns the per-call token to embed as a <Parameter>.
   */
  function mintPendingCall(callSid: string, reconnectAttempt?: number): string {
    const callToken = randomUUID(); // 36 chars — far under the 500-char <Parameter> name+value limit
    const t0 = Date.now();
    const gatewayAuth = mint(config.modelId, callSid || undefined);
    gatewayAuth
      .then(({ expiresAt }) => {
        logEvent({
          level: 'info',
          message: 'getToken resolved',
          event: 'getToken-resolved',
          callSid,
          getTokenMs: Date.now() - t0,
          expiresAt,
        });
      })
      .catch((err: unknown) => {
        // Mandatory: without this, a mint failure becomes an unhandledRejection that can kill
        // the process and all concurrent calls [Spec 02 R5.3]. The promise stored in
        // `pendingCalls` still rejects for whoever awaits it later (Spec 05's onSessionStart).
        logEvent({
          level: 'error',
          message: 'getToken failed',
          event: 'getToken-failed',
          callSid,
          err: String(err),
          statusCode: (err as { statusCode?: number } | undefined)?.statusCode,
        });
      });
    pendingCalls.set(callToken, {
      callSid,
      createdAt: Date.now(),
      gatewayAuth,
      ...(reconnectAttempt !== undefined ? { reconnectAttempt } : {}),
    });
    return callToken;
  }

  /**
   * The one <Connect><Stream> TwiML emitter, shared by /twiml and /twiml-action. `action` on
   * <Connect> is the reconnect seam (findings/18): when the stream ends — for ANY reason,
   * including Railway's edge proxy killing it (Twilio error 31924) — Twilio POSTs
   * /twiml-action on the still-live call and executes whatever TwiML it returns.
   * `reconnectAttempt` (set only by /twiml-action) adds the <Parameter name="reconnect">
   * marker alongside the token parameter.
   */
  function buildConnectTwiml(callToken: string, reconnectAttempt?: number): string {
    const host = config.publicHost;
    const vr = new twilio.twiml.VoiceResponse();
    const connect = vr.connect({ action: `https://${host}/twiml-action`, method: 'POST' });
    const stream = connect.stream({
      url: `wss://${host}/twilio-media`, // NO query string — can hard-fail the handshake, error 31920
      statusCallback: `https://${host}/stream-status`, // must be absolute
      statusCallbackMethod: 'POST',
    });
    stream.parameter({ name: 'token', value: callToken });
    if (reconnectAttempt !== undefined) {
      stream.parameter({ name: 'reconnect', value: String(reconnectAttempt) });
    }
    return vr.toString();
  }

  app.post('/twiml', async (req, reply) => {
    sweepPendingCalls();

    const host = config.publicHost; // PUBLIC_HOST ?? RAILWAY_PUBLIC_DOMAIN, resolved in config.ts
    const url = `https://${host}/twiml`; // EXACTLY the URL configured in the Twilio console
    const signature = req.headers['x-twilio-signature'] as string | undefined; // Node lowercases headers
    const params = req.body as Record<string, string>; // complete formbody-parsed POST body — never add/remove keys

    const requestStart = req.headers['x-request-start'];
    const edgeMs = requestStart !== undefined ? Date.now() - Number(requestStart) : undefined;
    logEvent({
      level: 'info',
      message: 'twiml request',
      event: 'twiml-request',
      callSid: params?.CallSid,
      edgeMs,
    });

    if (!signature || !validateRequest(config.twilioAuthToken, signature, url, params)) {
      logEvent({
        level: 'warn',
        message: 'invalid signature',
        event: 'twiml-bad-signature',
        callSid: params?.CallSid,
        // M1 diagnostics (no secrets): distinguishes missing-header vs mismatched-HMAC,
        // and shows exactly which URL string the HMAC was computed over.
        hasSignature: !!signature,
        sigLen: signature?.length,
        urlChecked: url,
        paramCount: params ? Object.keys(params).length : 0,
        tokenLen: config.twilioAuthToken.length,
      });
      return reply.code(403).send('invalid signature');
    }

    const callToken = mintPendingCall(params.CallSid ?? '');
    reply.type('text/xml');
    return buildConnectTwiml(callToken);
    // Reconnect design (supersedes the old G4 "NO verbs after </Connect>, NO action attribute"
    // lock): <Connect> now carries action="/twiml-action". Every stream end — caller hangup,
    // our own deliberate close, or Railway's edge proxy killing the socket (Twilio error 31924,
    // docs/findings/18) — makes Twilio POST /twiml-action on the still-live call. That handler
    // consults the end-reason registry (src/reconnect.ts): abnormal drops get a fresh
    // <Connect><Stream> (product-owner directive: an infrastructure drop must never hang up on
    // a caller), every expected end gets an empty <Response/> — which ends the call, exactly
    // the old fall-through behavior (clean-hangup arm of FR-7 preserved, one HTTP round trip
    // later).
  });

  /**
   * POST /twiml-action — the <Connect action> callback (findings/18 reconnect flow). Twilio
   * requests this when the connected stream ends, with the call still live; whatever TwiML we
   * return executes on that call. Decision table (end-reason registry, src/reconnect.ts):
   * abnormal end + attempts under STREAM_RECONNECT_MAX -> fresh <Connect><Stream> (same call
   * reconnects to a new media stream); anything else (expected end, unknown CallSid, attempts
   * exhausted, reconnect disabled) -> empty <Response/> (the call ends — the pre-reconnect
   * behavior). Signature-validated exactly like /twiml (G8); never throws (defensive wrap like
   * /stream-status — an exception here must degrade to "end the call", never a 500 that leaves
   * Twilio retrying).
   */
  app.post('/twiml-action', async (req, reply) => {
    reply.type('text/xml');
    const emptyResponse = () => new twilio.twiml.VoiceResponse().toString();
    try {
      sweepPendingCalls();
      const host = config.publicHost;
      const url = `https://${host}/twiml-action`; // EXACTLY the URL Twilio signs (the action URL we emit)
      const signature = req.headers['x-twilio-signature'] as string | undefined; // Node lowercases headers
      const params = req.body as Record<string, string>; // complete formbody-parsed POST body — never add/remove keys

      if (!signature || !validateRequest(config.twilioAuthToken, signature, url, params)) {
        logEvent({
          level: 'warn',
          message: 'invalid signature',
          event: 'twiml-action-bad-signature',
          callSid: params?.CallSid,
          hasSignature: !!signature,
          sigLen: signature?.length,
          urlChecked: url,
          paramCount: params ? Object.keys(params).length : 0,
          tokenLen: config.twilioAuthToken.length,
        });
        return reply.code(403).send('invalid signature');
      }

      const callSid = params.CallSid ?? '';
      const ending = getCallEnding(callSid); // sweeps stale registry entries on the way in

      let declineReason: 'expected-end' | 'unknown-call' | 'attempts-exhausted' | 'disabled' | undefined;
      if (!ending) {
        declineReason = 'unknown-call'; // includes every normal 1000-close end: no entry ever written
      } else if (ending.endReason === 'expected') {
        declineReason = 'expected-end';
      } else if (config.streamReconnectMax <= 0) {
        declineReason = 'disabled'; // STREAM_RECONNECT_MAX=0 — pre-reconnect behavior, even for abnormal drops
      } else if (ending.attempts >= config.streamReconnectMax) {
        declineReason = 'attempts-exhausted';
      }

      if (declineReason !== undefined) {
        logEvent({
          level: 'info',
          message: 'stream reconnect declined',
          event: 'stream-reconnect-declined',
          callSid,
          reason: declineReason,
        });
        return emptyResponse(); // empty <Response/> ends the call
      }

      // Abnormal drop, under the cap: reconnect the SAME call to a fresh stream.
      ending!.attempts += 1;
      ending!.updatedAt = Date.now();
      const callToken = mintPendingCall(callSid, ending!.attempts);
      logEvent({
        level: 'warn',
        message: 'stream reconnect',
        event: 'stream-reconnect',
        callSid,
        attempt: ending!.attempts,
        max: config.streamReconnectMax,
      });
      return buildConnectTwiml(callToken, ending!.attempts);
    } catch (err) {
      // Fail safe: end the call rather than 500 (Twilio would play its own error message).
      logEvent({
        level: 'error',
        message: 'twiml-action handler failed',
        event: 'twiml-action-error',
        err: String(err),
      });
      return emptyResponse();
    }
  });

  app.post('/stream-status', async (req, reply) => {
    const b = req.body as Record<string, string>;
    logEvent({
      level: b.StreamEvent === 'stream-error' ? 'error' : 'info',
      message: 'twilio stream status',
      event: 'stream-status',
      callSid: b.CallSid,
      streamSid: b.StreamSid,
      streamEvent: b.StreamEvent,
      streamError: b.StreamError,
      timestamp: b.Timestamp,
    });

    // Proactive teardown on Twilio's stream-error signal (see doc comment above). Wrapped
    // defensively — this handler must never throw and must always still 204, regardless of
    // what the lookup/terminate below does.
    if (b.StreamEvent === 'stream-error') {
      try {
        // findings/18 reconnect: record the abnormal end BEFORE terminate() — terminate()
        // synchronously fires the Twilio socket's 'close' handler (teardown), and Twilio's
        // /twiml-action request can race in right behind it; the registry entry must already
        // say 'abnormal' by then. markAbnormalEnd never overwrites an 'expected' mark, so a
        // deliberate close that Twilio ALSO reported as a stream-error stays expected.
        if (b.CallSid) markAbnormalEnd(b.CallSid);
        const session = b.StreamSid ? getSessionByStreamSid(b.StreamSid) : undefined;
        if (session) {
          logEvent({
            level: 'warn',
            message: 'stream-error teardown',
            event: 'stream-error-teardown',
            callSid: b.CallSid,
            streamSid: b.StreamSid,
            streamErrorCode: b.StreamErrorCode,
          });
          // NOT close() — the peer already sent no close frame and is gone; terminate() drops
          // the TCP connection immediately and synchronously fires the socket's existing
          // 'close' handler (twilio-media.ts), which runs the normal teardownSession path.
          session.twilioWs.terminate();
        }
        // No session found ⇒ already gone (torn down by some other path) — nothing to do
        // beyond the log line above.
      } catch (err) {
        logEvent({
          level: 'error',
          message: 'stream-error teardown failed',
          event: 'stream-error-teardown-failed',
          callSid: b.CallSid,
          streamSid: b.StreamSid,
          err: String(err),
        });
      }
    }

    return reply.code(204).send();
  });
}

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import twilio from 'twilio'; // default-import + destructure: safe under both ESM and CJS emit (twilio is a CJS package)
const { validateRequest } = twilio;
import { mintRealtimeToken } from './gateway.js';
import type { AppConfig } from './config.js';
import { logEvent } from './logger.js';

export interface PendingCall {
  callSid: string;
  createdAt: number; // Date.now()
  // Widened to include gateway.ts's `getTokenMs` (MintResult's shape) as optional, not required:
  // the real mint() call site always resolves with it, but injected test mints (session.ts's
  // `SessionBridgeDeps` seam) legitimately omit it, and session.ts consumes it as
  // possibly-undefined (TurnRecorder.seedGreeting already treats a missing getTokenMs as
  // "nothing to seed" rather than throwing) — see this task's Finding 2 note.
  gatewayAuth: Promise<{ token: string; url: string; expiresAt?: number; getTokenMs?: number }>;
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
 * response per R5.4) and POST /stream-status (log-only, R7). Two-arg-plus-deps form supersedes
 * Spec 02 R6's one-arg illustration — config is injected here, never re-loaded (planned deviation).
 */
export function registerTwimlRoutes(app: FastifyInstance, config: AppConfig, deps?: TwimlDeps): void {
  // Wave B/C merge point applied: /twiml delegates to Spec 04's mintRealtimeToken
  // (typed errors + getTokenMs logging), adapter form per ledger pre-declared deviation.
  const mint: MintFn =
    deps?.mint ?? ((modelId, callSid) => mintRealtimeToken(config, callSid ?? '', modelId));

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

    const callToken = randomUUID(); // 36 chars — far under the 500-char <Parameter> name+value limit
    const t0 = Date.now();
    const gatewayAuth = mint(config.modelId, params.CallSid);
    gatewayAuth
      .then(({ expiresAt }) => {
        logEvent({
          level: 'info',
          message: 'getToken resolved',
          event: 'getToken-resolved',
          callSid: params.CallSid ?? '',
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
          callSid: params.CallSid ?? '',
          err: String(err),
          statusCode: (err as { statusCode?: number } | undefined)?.statusCode,
        });
      });
    pendingCalls.set(callToken, { callSid: params.CallSid ?? '', createdAt: Date.now(), gatewayAuth });

    const vr = new twilio.twiml.VoiceResponse();
    const connect = vr.connect();
    const stream = connect.stream({
      url: `wss://${host}/twilio-media`, // NO query string — can hard-fail the handshake, error 31920
      statusCallback: `https://${host}/stream-status`, // must be absolute
      statusCallbackMethod: 'POST',
    });
    stream.parameter({ name: 'token', value: callToken });
    reply.type('text/xml');
    return vr.toString();
    // Design lock (G4): NO verbs after </Connect>, NO action attribute — the bridge closing the
    // Twilio WS ends the call cleanly (clean-hangup arm of FR-7).
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
    return reply.code(204).send();
  });
}

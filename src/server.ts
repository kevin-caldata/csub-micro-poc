import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyWebsocket from '@fastify/websocket';
import { pathToFileURL } from 'node:url';
import { loadConfig, type AppConfig } from './config.js';
import { logEvent } from './logger.js';
import { registerTwimlRoutes, claimPendingCall, type TwimlDeps } from './twiml.js';
import { mcpRoutes } from './mcp-server.js';
import { registerTwilioMediaRoute } from './twilio-media.js';
import { startSessionBridge, setOnGatewayFailure } from './session.js';
import { playFallbackAndClose } from './fallback.js';
import { startLoopMonitor } from './latency.js';
import { sessions } from './state.js';

export interface ShutdownOpts {
  deadlineMs?: number;
  pollMs?: number;
  exit?: (code: number) => void;
}

/**
 * Deviation-by-design (T10.6, recorded in its completion report — same idiom as
 * `registerTwimlRoutes(app, config, deps?)`/`startSessionBridge(session, pendingCall, deps?)`
 * elsewhere in this repo): `buildApp` never mints a real gateway token itself — that already
 * lives behind `registerTwimlRoutes`'s own `TwimlDeps.mint` seam (Spec 02 T02.3) — but had no way
 * to REACH that seam from outside `src/server.ts`. Spec 10 R10's `GATEWAY_WS_URL` override only
 * bypasses `openGatewayLeg`'s socket construction; a live in-process integration test (T10.6's
 * `test/harness.test.ts`) still needs to avoid the real `mintRealtimeToken`'s network call to the
 * Vercel AI Gateway. This additive, optional third parameter threads a fake `mint` down to
 * `registerTwimlRoutes` with zero effect on any existing 2-arg call site (deps undefined ->
 * `registerTwimlRoutes(app, config, undefined)`, its own pre-existing default-mint fallback).
 */
export interface BuildAppDeps {
  twiml?: TwimlDeps;
}

export async function buildApp(
  config: AppConfig,
  shutdownOpts?: ShutdownOpts,
  deps?: BuildAppDeps,
): Promise<{ app: FastifyInstance; shutdown: (signal: string) => Promise<void> }> {
  const app = Fastify({
    trustProxy: true, // Railway edge terminates TLS [findings/08 §boot]
    logger: false, // hand-rolled logEvent()/log() ONLY (Spec 01 R12 / Spec 08 R1/R3);
    // pino defaults break Railway parsing [findings/09 V10]
  });

  await app.register(formbody); // application/x-www-form-urlencoded → req.body object

  await app.register(fastifyWebsocket, {
    options: {
      perMessageDeflate: false, // server default is already false; explicit = documentation [findings/08 V5, findings/10 C15]
      maxPayload: 1 * 1024 * 1024, // Twilio frames ~400 B JSON; 1 MB closes the pre-auth allocation hole [findings/08 gotcha 14]
    },
    errorHandler: (err, socket, _req, _reply) => {
      logEvent({ level: 'error', message: 'ws handler error', event: 'ws-error', err: String(err) });
      socket.terminate();
    },
  });
  // NOTE: do NOT pass a custom preClose — drain-before-close (R8) makes the default fine.

  app.get('/health', async () => ({ ok: true }));

  registerTwimlRoutes(app, config, deps?.twiml);
  // --- route registration (Specs 03/07) ---
  registerTwilioMediaRoute(app, {
    config,
    claimPendingCall,
    // Spec 05's real onSessionStart implementation. Adapted (not passed bare) so it reuses the
    // config already loaded and validated once at boot above, rather than each call re-parsing
    // process.env via startSessionBridge's own no-singleton default (Spec 05 T05.4).
    onSessionStart: (session, pendingCall) => startSessionBridge(session, pendingCall, { config }),
  });
  // Spec 07 adds: mcpRoutes(app)                  — POST /mcp (+ 405 GET/DELETE)
  await mcpRoutes(app, config);
  // -----------------------------------------

  // Spec 02 R8 — SIGTERM graceful shutdown: drain FIRST, then close (ordering is load-bearing).
  // @fastify/websocket's default preClose closes EVERY tracked WS client the instant
  // fastify.close() runs (~2 ms observed, peers see close code 1005) [findings/08 V9, gotcha 2;
  // findings/10 C18]. Calling app.close() directly on SIGTERM severs all live calls and violates
  // BRD §7.6. Railway's default grace is 0 s; the 60 s window only exists because railway.json
  // sets drainingSeconds: 60 [findings/07 claim 9].
  const deadlineMs = shutdownOpts?.deadlineMs ?? 55_000; // < Railway's 60 s SIGKILL window (tests inject smaller values)
  const pollMs = shutdownOpts?.pollMs ?? 500;
  const exit = shutdownOpts?.exit ?? process.exit;

  let draining = false;
  let shuttingDown = false;

  // Gate new work. Hooks run for WS upgrade requests too (findings/08 V4); a non-hijacked 503
  // reply to an upgrade request yields a non-101 response + socket destroy = clean refusal
  // (findings/08 V11).
  //
  // Behavior contract 4 (S28, accepted risk): the 503-during-drain caller experience — what
  // Twilio does when /twiml 503s — is untested by design. The operating rule is "deploy between
  // test calls" (BRD §7.6); Twilio's retry/fallback-URL behavior is not exercised here.
  app.addHook('onRequest', async (req, reply) => {
    if (!draining) return;
    if (req.url.startsWith('/stream-status')) return; // keep evidence flowing (R7)
    if (req.url.startsWith('/health')) return reply.code(503).send('draining');
    if (req.ws || req.url.startsWith('/twiml')) return reply.code(503).send('draining');
  });

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return; // idempotent — Railway sends exactly one SIGTERM, but be safe
    shuttingDown = true;
    draining = true;
    logEvent({ level: 'info', message: 'draining', event: 'shutdown-start', signal, activeSessions: sessions.size });

    const deadline = Date.now() + deadlineMs;
    while (sessions.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
    }

    // Behavior contract 5 (S25, best-effort caveat): whether the Railway edge keeps routing the
    // established Twilio WS to this SIGTERM'd replica during the drain window is unverified —
    // this drain is best-effort courtesy, not a durability guarantee.
    for (const s of sessions.values()) s.teardown('server shutdown'); // stragglers: Twilio leg gets close(1001)

    await app.close(); // preClose now finds no (or only just-torn-down) clients
    logEvent({ level: 'info', message: 'bye', event: 'shutdown-complete' });
    exit(0);
  }

  return { app, shutdown };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let config: AppConfig;
  try {
    config = loadConfig(); // fail-fast first (Spec 01 R5/R11 invariant)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Orchestrator Wave D merge items (main-guard only, so tests keep the no-op defaults):
  startLoopMonitor(); // Spec 08 R12 — one process-wide event-loop-delay histogram, enabled once at boot
  setOnGatewayFailure(playFallbackAndClose); // Spec 05↔09 fallback seam (FR-7 spoken arm); validated live by the S23 kill test at M1
  const { app, shutdown } = await buildApp(config);

  await app.listen({ port: config.port, host: '0.0.0.0' }); // R3.3 — never any other host

  logEvent({
    level: 'info',
    message: 'boot',
    event: 'boot',
    region: process.env.RAILWAY_REPLICA_REGION,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA,
    port: config.port,
    audioMode: config.audioMode,
    modelId: config.modelId,
  });

  // Spec 02 R8 — main-guard wiring only (never at import time). SIGINT is the local-dev path
  // and the ONLY one exercisable on Windows.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

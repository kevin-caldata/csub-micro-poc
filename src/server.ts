import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyWebsocket from '@fastify/websocket';
import { pathToFileURL } from 'node:url';
import { loadConfig, type AppConfig } from './config.js';
import { logEvent } from './logger.js';

export interface ShutdownOpts {
  deadlineMs?: number;
  pollMs?: number;
  exit?: (code: number) => void;
}

export async function buildApp(
  config: AppConfig,
  shutdownOpts?: ShutdownOpts,
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

  // registerTwimlRoutes(app, config)  — added by T02.3
  // --- route registration (Specs 03/07) ---
  // Spec 03 adds: registerTwilioMediaRoute(app)   — GET /twilio-media { websocket: true }
  // Spec 07 adds: mcpRoutes(app)                  — POST /mcp (+ 405 GET/DELETE)
  // -----------------------------------------

  async function shutdown(_signal: string): Promise<void> {
    // T02.4 implements drain-then-close; this is a stub for T02.1.
    void shutdownOpts;
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

  const { app } = await buildApp(config);

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

  // SIGTERM/SIGINT wiring — added by T02.4
}

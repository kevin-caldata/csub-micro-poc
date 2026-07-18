import Fastify from 'fastify';
import { loadConfig, type AppConfig } from './config.js';
import { logEvent } from './logger.js';

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const app = Fastify({ logger: false, trustProxy: true }); // structured logging is Spec 08's logEvent, not pino transport

app.get('/health', async () => ({ ok: true }));

await app.listen({ port: config.port, host: '0.0.0.0' }); // 0.0.0.0 is mandatory on Railway [findings/07 claim 8]
logEvent({ level: 'info', message: 'boot', event: 'boot', port: config.port, audioMode: config.audioMode, modelId: config.modelId });

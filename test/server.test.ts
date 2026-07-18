import { describe, it, expect } from 'vitest';
// Import side-effect freedom (Spec 02 T02.1 Produces): this import must not throw and
// must not require any env vars — buildApp() is the only thing that touches config, and
// only when called, never at module load. `npm test` runs with an empty environment
// (Spec 01 R4.3), so a throw here would prove a load-time side effect exists.
import { buildApp } from '../src/server.js';
import type { AppConfig } from '../src/config.js';

const fixtureConfig: AppConfig = {
  aiGatewayApiKey: 'vck_test',
  twilioAuthToken: 'tok_test',
  port: 3000,
  publicHost: 'example.ngrok.app',
  modelId: 'openai/gpt-realtime-2.1',
  audioMode: 'transcode',
  voice: 'marin',
};

describe('buildApp', () => {
  it('GET /health resolves 200 {ok:true}', async () => {
    const { app } = await buildApp(fixtureConfig);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('importing ./server.js has no side effects (no env vars required)', () => {
    // The mere fact this test file loaded (see top-level import above) without throwing,
    // in a process where npm test does not load .env, proves the import is side-effect free.
    expect(typeof buildApp).toBe('function');
  });

  it('GET /twilio-media 404s — route not registered until Specs 03/07', async () => {
    const { app } = await buildApp(fixtureConfig);
    const res = await app.inject({ method: 'GET', url: '/twilio-media' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

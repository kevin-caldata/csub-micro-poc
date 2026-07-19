import { z } from 'zod';

const EnvSchema = z.object({
  AI_GATEWAY_API_KEY: z
    .string({
      required_error: 'AI_GATEWAY_API_KEY is required (Vercel dashboard → AI Gateway → API Keys). ' +
        'Without it the SDK silently falls back to Vercel OIDC, which fails late and obscurely off-Vercel.',
    })
    .min(1, 'AI_GATEWAY_API_KEY is required (Vercel dashboard → AI Gateway → API Keys). ' +
      'Without it the SDK silently falls back to Vercel OIDC, which fails late and obscurely off-Vercel.'),
  TWILIO_AUTH_TOKEN: z.string().min(1, 'TWILIO_AUTH_TOKEN is required (Twilio Console dashboard).'),
  PORT: z.coerce.number().int().positive().default(3000),
  RAILWAY_PUBLIC_DOMAIN: z.string().min(1).optional(),
  PUBLIC_HOST: z.string().min(1).optional(),
  MODEL_ID: z.string().min(1).default('openai/gpt-realtime-2.1'),
  AUDIO_MODE: z.enum(['pcmu', 'transcode']).default('transcode'),
  VOICE: z.string().min(1).default('marin'),
  VOICE_FALLBACK: z.string().min(1).default('alloy'),
  VAD_SILENCE_MS: z.coerce.number().int().default(500),
  VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  VAD_PREFIX_PADDING_MS: z.coerce.number().int().default(300),
  // S15 ANSWERED (M1, 2026-07-19): gateway rejects expiresIn > 300 with 400
  // "Invalid request body: expiresIn: Too big: expected number to be <=300".
  // BRD §5.2's expiresAfterSeconds: 600 is wrong for realtime; 300 is the max.
  TOKEN_TTL_SECONDS: z.coerce.number().int().max(300).default(300),
  GATEWAY_HANDSHAKE_TIMEOUT_MS: z.coerce.number().int().default(5000),
  GATEWAY_PING_SECONDS: z.coerce.number().int().default(0),
  WAIT_FOR_SESSION_UPDATED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  GATEWAY_TAGS: z.string().optional(),
  TWILIO_VALIDATE_UPGRADE: z.enum(['true', 'false']).default('false'),
  // Spec 10 R10 (test harness only): when set, src/gateway.ts's openGatewayLeg skips
  // mintRealtimeToken/getWebSocketConfig entirely and opens a bare WS straight at this URL — the
  // seam that lets test/fakes/fake-gateway.ts stand in for the real Vercel AI Gateway with zero
  // network access. No validation beyond "it's a string" (absent = undefined); never set in
  // production. Additive-only per master plan §6 R-2 — no existing key touched.
  GATEWAY_WS_URL: z.string().min(1).optional(),
});

export interface AppConfig {
  aiGatewayApiKey: string;
  twilioAuthToken: string;
  port: number;
  /** Bare hostname (no scheme) used for wss:// and https:// URL construction.
   *  PUBLIC_HOST (local/ngrok) wins over RAILWAY_PUBLIC_DOMAIN (injected by Railway). */
  publicHost: string;
  modelId: string;
  audioMode: 'pcmu' | 'transcode';
  voice: string;
  voiceFallback: string;
  vadSilenceMs: number;
  vadThreshold: number;
  vadPrefixPaddingMs: number;
  tokenTtlSeconds: number;
  gatewayHandshakeTimeoutMs: number;
  gatewayPingSeconds: number;
  waitForSessionUpdated: boolean;
  gatewayTags: string[] | undefined;
  twilioValidateUpgrade: boolean;
  /** Spec 10 R10 (test harness only) — see EnvSchema.GATEWAY_WS_URL doc comment above. */
  gatewayWsUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const publicHost = e.PUBLIC_HOST ?? e.RAILWAY_PUBLIC_DOMAIN;
  if (!publicHost) {
    throw new Error(
      'Invalid environment configuration:\n  - set PUBLIC_HOST (local dev, e.g. your ngrok host) ' +
      'or run on Railway where RAILWAY_PUBLIC_DOMAIN is injected after Generate Domain.');
  }
  // Findings review (Minor — prod guard): GATEWAY_WS_URL (Spec 10 R10) is a TEST-HARNESS-ONLY
  // seam that skips mintRealtimeToken/getWebSocketConfig entirely and opens a bare, unauthenticated
  // WS straight at whatever URL it names — it must never reach a real deployment. RAILWAY_PUBLIC_DOMAIN
  // is injected by Railway itself (never hand-set), so its presence is a reliable production
  // signal; refuse to boot rather than silently bridge every call through a test double.
  if (e.GATEWAY_WS_URL && e.RAILWAY_PUBLIC_DOMAIN) {
    throw new Error(
      'Invalid environment configuration:\n  - GATEWAY_WS_URL must never be set when RAILWAY_PUBLIC_DOMAIN ' +
      'is present (Spec 10 R10 test harness override reaching production) — unset GATEWAY_WS_URL.');
  }
  const gatewayTags = e.GATEWAY_TAGS
    ? e.GATEWAY_TAGS.split(',').map(t => t.trim()).filter(t => t.length > 0)
    : undefined;
  return {
    aiGatewayApiKey: e.AI_GATEWAY_API_KEY,
    twilioAuthToken: e.TWILIO_AUTH_TOKEN,
    port: e.PORT,
    publicHost,
    modelId: e.MODEL_ID,
    audioMode: e.AUDIO_MODE,
    voice: e.VOICE,
    voiceFallback: e.VOICE_FALLBACK,
    vadSilenceMs: e.VAD_SILENCE_MS,
    vadThreshold: e.VAD_THRESHOLD,
    vadPrefixPaddingMs: e.VAD_PREFIX_PADDING_MS,
    tokenTtlSeconds: e.TOKEN_TTL_SECONDS,
    gatewayHandshakeTimeoutMs: e.GATEWAY_HANDSHAKE_TIMEOUT_MS,
    gatewayPingSeconds: e.GATEWAY_PING_SECONDS,
    waitForSessionUpdated: e.WAIT_FOR_SESSION_UPDATED,
    gatewayTags: gatewayTags && gatewayTags.length > 0 ? gatewayTags : undefined,
    twilioValidateUpgrade: e.TWILIO_VALIDATE_UPGRADE === 'true',
    gatewayWsUrl: e.GATEWAY_WS_URL,
  };
}

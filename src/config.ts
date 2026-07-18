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
  return {
    aiGatewayApiKey: e.AI_GATEWAY_API_KEY,
    twilioAuthToken: e.TWILIO_AUTH_TOKEN,
    port: e.PORT,
    publicHost,
    modelId: e.MODEL_ID,
    audioMode: e.AUDIO_MODE,
    voice: e.VOICE,
  };
}

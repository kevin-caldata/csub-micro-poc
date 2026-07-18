import {
  gateway,
  GatewayError,
  GatewayAuthenticationError,
  GatewayInvalidRequestError,
  GatewayRateLimitError,
  GatewayModelNotFoundError,
  GatewayInternalServerError,
  GatewayFailedDependencyError,
  GatewayForbiddenError,
} from '@ai-sdk/gateway';
import type { AppConfig } from './config.js';
import { logEvent } from './logger.js';

/**
 * Result of a successful `mintRealtimeToken` call.
 * Verbatim shape from Spec 04 R3.
 */
export interface MintResult {
  token: string; // 'vcst_...' single-use client secret — never cache/reuse across sessions
  url: string; // computed server-side by getToken; model id is percent-encoded — never build by hand
  expiresAt?: number; // unix seconds
  getTokenMs: number; // wall-clock duration of the mint call
}

/** `GatewayMintError.errorType` maps 1:1 to the SDK class / body `error.type` (Spec 04 R3, findings/01 §9). */
export type GatewayMintErrorType =
  | 'authentication_error'
  | 'invalid_request_error'
  | 'rate_limit_exceeded'
  | 'model_not_found'
  | 'internal_server_error'
  | 'failed_dependency'
  | 'forbidden'
  | 'unknown';

export class GatewayMintError extends Error {
  constructor(
    public readonly errorType: GatewayMintErrorType,
    public readonly statusCode: number | undefined,
    public readonly getTokenMs: number,
    cause: unknown,
  ) {
    super(`gateway mint failed: ${errorType}`, { cause });
  }
}

/**
 * Classification rules (Spec 04 R3): instanceof checks on the exported classes first,
 * else read `GatewayError.statusCode`, else 'unknown'.
 */
function classifyMintError(err: unknown): { errorType: GatewayMintErrorType; statusCode: number | undefined } {
  if (err instanceof GatewayAuthenticationError) return { errorType: 'authentication_error', statusCode: err.statusCode };
  if (err instanceof GatewayInvalidRequestError) return { errorType: 'invalid_request_error', statusCode: err.statusCode };
  if (err instanceof GatewayRateLimitError) return { errorType: 'rate_limit_exceeded', statusCode: err.statusCode };
  if (err instanceof GatewayModelNotFoundError) return { errorType: 'model_not_found', statusCode: err.statusCode };
  if (err instanceof GatewayInternalServerError) return { errorType: 'internal_server_error', statusCode: err.statusCode };
  if (err instanceof GatewayFailedDependencyError) return { errorType: 'failed_dependency', statusCode: err.statusCode };
  if (err instanceof GatewayForbiddenError) return { errorType: 'forbidden', statusCode: err.statusCode };
  if (err instanceof GatewayError) return { errorType: 'unknown', statusCode: err.statusCode };
  return { errorType: 'unknown', statusCode: undefined };
}

/**
 * Mints a per-call gateway realtime token at webhook time via the factory-form API
 * (`gateway.experimental_realtime.getToken`) — never a model-instance method (BRD §5.2 bug,
 * findings/01 C1: calling getToken on the model instance throws a TypeError).
 *
 * Signature deviation-by-design (recorded in the T04.2 completion report): the Spec 04 R3
 * snippet reads `config.modelId` and `callSid` from ambient scope. Spec 01 R5 forbids a
 * config singleton (pure `loadConfig`, no import-time side effects), so `cfg` and `callSid`
 * are explicit parameters here; `modelId` defaults to `cfg.modelId`.
 */
export async function mintRealtimeToken(
  cfg: AppConfig,
  callSid: string,
  modelId: string = cfg.modelId,
): Promise<MintResult> {
  const t0 = performance.now();
  try {
    const { token, url, expiresAt } = await gateway.experimental_realtime.getToken({
      model: modelId, // required
      expiresAfterSeconds: cfg.tokenTtlSeconds, // renamed to `expiresIn` on the wire (SDK-internal)
    });
    const getTokenMs = Math.round(performance.now() - t0);
    logEvent({ level: 'info', message: 'get-token', event: 'get-token', callSid, getTokenMs, expiresAt });
    return { token, url, expiresAt, getTokenMs };
  } catch (cause) {
    const getTokenMs = Math.round(performance.now() - t0);
    const { errorType, statusCode } = classifyMintError(cause);
    logEvent({
      level: 'error',
      message: 'get-token-failed',
      event: 'get-token-failed',
      callSid,
      errorType,
      statusCode,
      getTokenMs,
    });
    if (errorType === 'model_not_found') {
      logEvent({
        level: 'error',
        message: `model not found for ${modelId}; set MODEL_ID=openai/gpt-realtime-2`,
        event: 'get-token-failed-model-not-found',
        callSid,
        modelId,
      });
    }
    throw new GatewayMintError(errorType, statusCode, getTokenMs, cause);
  }
}

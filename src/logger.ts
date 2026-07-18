// Hand-rolled Railway-parseable logger (Spec 08 R1). NOT pino: pino's defaults emit numeric
// level and a `msg` key, both incompatible with Railway's parser, and at ~30 lines/s total
// there is no throughput argument for pulling in the dependency.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  level: LogLevel;
  message: string;          // required by Railway's structured-log contract
  event: string;            // machine-readable event name (e.g. 'boot', 'stream-start')
  callSid?: string;         // ALWAYS top-level when present — @callSid: filtering [findings/07 claim 12]
  streamSid?: string;
  [key: string]: unknown;   // additional flat attributes; keep values scalar, never nest
}

const MIN: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Single-line minified JSON to stdout only — never stderr, which Railway forces to
 * level:error regardless of content [findings/09 V1, gotcha 3]. `message`/`level` are
 * Railway's two special fields; everything else in `fields` is a flat, queryable attribute.
 */
export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (RANK[level] < RANK[MIN]) return;
  process.stdout.write(
    JSON.stringify({ message, level, ts: new Date().toISOString(), ...fields }) + '\n',
  );
}

export const ms = (a: number, b: number): number => Math.round((b - a) * 10) / 10;
export const now = (): number => performance.now(); // monotonic; global in Node >=16

/**
 * The ONE place `.raw` gateway payloads are serialized (Spec 08 R1 note; A12). A
 * circular/hostile `.raw` must never crash a handler, so this guards with try/catch.
 */
export function safeRaw(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(err);
  }
}

// Spec 01 R12 boundary — MUST keep exporting logEvent (and LogFields/LogLevel types) so every
// module written against the stub keeps compiling (master plan R-2). Thin wrapper over log():
export function logEvent(fields: LogFields): void {
  const { level, message, ...rest } = fields;
  log(level, message, rest);
}

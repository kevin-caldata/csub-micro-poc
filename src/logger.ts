export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  level: LogLevel;
  message: string;          // required by Railway's structured-log contract
  event: string;            // machine-readable event name (e.g. 'boot', 'stream-start')
  callSid?: string;         // ALWAYS top-level when present — @callSid: filtering [findings/07 claim 12]
  streamSid?: string;
  [key: string]: unknown;   // additional flat attributes; keep values scalar, never nest
}

/** One minified JSON object per line to stdout. Never call per media frame (500 lines/s/replica cap). */
export function logEvent(fields: LogFields): void {
  process.stdout.write(JSON.stringify(fields) + '\n');
}

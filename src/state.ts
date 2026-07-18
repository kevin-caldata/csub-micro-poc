// Shared process-wide session registry (Spec 02 R2).
//
// This is the ONE process-wide `sessions` map. Spec 03's `src/sessions.ts` must
// re-export this exact map instance (or BE it) — never create a second Map — or
// the SIGTERM drain loop (Spec 02 R8) will only ever see half the live calls
// (master plan risk R-2).

export interface SessionHandle {
  /** Idempotent. Closes both WS legs (Twilio leg with close(1001, reason)),
   *  logs the call summary, and MUST delete itself from `sessions`. */
  teardown(reason: string): void;
}

// keyed by streamSid
export const sessions = new Map<string, SessionHandle>();

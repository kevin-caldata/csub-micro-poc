import { createHash, timingSafeEqual } from 'node:crypto';

export interface PendingCall {
  callSid: string;
  createdAt: number; // Date.now()
  gatewayAuth: Promise<{ token: string; url: string; expiresAt?: number }>;
}

export const pendingCalls = new Map<string, PendingCall>(); // key = per-call token

export const PENDING_TTL_MS = 60_000; // BRD §5.4 / findings/03 claim 11: single-use, ~60 s TTL

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * Single-use, constant-time claim. Sweeps expired entries as it iterates.
 * A direct `Map.get` would be a timing oracle [findings/03 claim 11] — this
 * instead hashes both sides to a fixed-length digest before comparing, so
 * `timingSafeEqual` never sees mismatched-length inputs and the comparison
 * time does not depend on candidate length or content.
 */
export function claimPendingCall(candidate: string): PendingCall | undefined {
  for (const [tok, pc] of pendingCalls) {
    if (Date.now() - pc.createdAt > PENDING_TTL_MS) {
      pendingCalls.delete(tok);
      continue;
    }
    if (timingSafeEqual(sha256(tok), sha256(candidate))) {
      // hash-then-compare: length-independent constant time
      pendingCalls.delete(tok); // single-use
      return pc;
    }
  }
  return undefined;
}

/** Deletes entries with createdAt < now - PENDING_TTL_MS. Called on every /twiml hit (no timers). */
export function sweepPendingCalls(now: number = Date.now()): void {
  for (const [tok, pc] of pendingCalls) {
    if (pc.createdAt < now - PENDING_TTL_MS) {
      pendingCalls.delete(tok);
    }
  }
}

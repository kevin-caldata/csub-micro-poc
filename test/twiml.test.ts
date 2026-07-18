import { describe, it, beforeEach, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  pendingCalls,
  claimPendingCall,
  sweepPendingCalls,
  PENDING_TTL_MS,
  type PendingCall,
} from '../src/twiml.js';

function makePendingCall(overrides: Partial<PendingCall> = {}): PendingCall {
  return {
    callSid: 'CA_test',
    createdAt: Date.now(),
    gatewayAuth: Promise.resolve({ token: 'tok', url: 'https://example.test' }),
    ...overrides,
  };
}

beforeEach(() => {
  pendingCalls.clear();
});

describe('claimPendingCall', () => {
  it('claim happy path: returns the exact entry and removes it from the map', () => {
    const token = randomUUID();
    const entry = makePendingCall({ createdAt: Date.now() });
    pendingCalls.set(token, entry);

    const claimed = claimPendingCall(token);

    expect(claimed).toBe(entry);
    expect(pendingCalls.has(token)).toBe(false);
  });

  it('single-use: a second claim of the same token returns undefined', () => {
    const token = randomUUID();
    pendingCalls.set(token, makePendingCall());

    const first = claimPendingCall(token);
    const second = claimPendingCall(token);

    expect(first).not.toBe(undefined);
    expect(second).toBe(undefined);
  });

  it('unknown token: returns undefined and leaves the live entry present', () => {
    const token = randomUUID();
    const entry = makePendingCall();
    pendingCalls.set(token, entry);

    const claimed = claimPendingCall('not-the-token');

    expect(claimed).toBe(undefined);
    expect(pendingCalls.get(token)).toBe(entry);
  });

  it('TTL expiry: an entry older than PENDING_TTL_MS is unclaimable and is swept during iteration', () => {
    const token = randomUUID();
    pendingCalls.set(token, makePendingCall({ createdAt: Date.now() - PENDING_TTL_MS - 1000 }));

    const claimed = claimPendingCall(token);

    expect(claimed).toBe(undefined);
    expect(pendingCalls.has(token)).toBe(false);
  });

  it('constant-time compare shape: a wildly different length candidate neither throws nor matches', () => {
    const token = randomUUID();
    pendingCalls.set(token, makePendingCall());

    expect(() => {
      const claimed = claimPendingCall('x');
      expect(claimed).toBe(undefined);
    }).not.toThrow();
    // entry must still be there (candidate never matched)
    expect(pendingCalls.has(token)).toBe(true);
  });
});

describe('sweepPendingCalls', () => {
  it('deletes only the entry aged past the TTL', () => {
    const freshToken = randomUUID();
    const agedToken = randomUUID();
    pendingCalls.set(freshToken, makePendingCall({ createdAt: Date.now() }));
    pendingCalls.set(agedToken, makePendingCall({ createdAt: Date.now() - PENDING_TTL_MS - 1000 }));

    sweepPendingCalls();

    expect(pendingCalls.has(freshToken)).toBe(true);
    expect(pendingCalls.has(agedToken)).toBe(false);
  });
});

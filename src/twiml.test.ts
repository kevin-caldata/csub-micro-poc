import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  pendingCalls,
  claimPendingCall,
  sweepPendingCalls,
  PENDING_TTL_MS,
  type PendingCall,
} from './twiml.js';

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

    assert.equal(claimed, entry);
    assert.equal(pendingCalls.has(token), false);
  });

  it('single-use: a second claim of the same token returns undefined', () => {
    const token = randomUUID();
    pendingCalls.set(token, makePendingCall());

    const first = claimPendingCall(token);
    const second = claimPendingCall(token);

    assert.notEqual(first, undefined);
    assert.equal(second, undefined);
  });

  it('unknown token: returns undefined and leaves the live entry present', () => {
    const token = randomUUID();
    const entry = makePendingCall();
    pendingCalls.set(token, entry);

    const claimed = claimPendingCall('not-the-token');

    assert.equal(claimed, undefined);
    assert.equal(pendingCalls.get(token), entry);
  });

  it('TTL expiry: an entry older than PENDING_TTL_MS is unclaimable and is swept during iteration', () => {
    const token = randomUUID();
    pendingCalls.set(token, makePendingCall({ createdAt: Date.now() - PENDING_TTL_MS - 1000 }));

    const claimed = claimPendingCall(token);

    assert.equal(claimed, undefined);
    assert.equal(pendingCalls.has(token), false);
  });

  it('constant-time compare shape: a wildly different length candidate neither throws nor matches', () => {
    const token = randomUUID();
    pendingCalls.set(token, makePendingCall());

    assert.doesNotThrow(() => {
      const claimed = claimPendingCall('x');
      assert.equal(claimed, undefined);
    });
    // entry must still be there (candidate never matched)
    assert.equal(pendingCalls.has(token), true);
  });
});

describe('sweepPendingCalls', () => {
  it('deletes only the entry aged past the TTL', () => {
    const freshToken = randomUUID();
    const agedToken = randomUUID();
    pendingCalls.set(freshToken, makePendingCall({ createdAt: Date.now() }));
    pendingCalls.set(agedToken, makePendingCall({ createdAt: Date.now() - PENDING_TTL_MS - 1000 }));

    sweepPendingCalls();

    assert.equal(pendingCalls.has(freshToken), true);
    assert.equal(pendingCalls.has(agedToken), false);
  });
});

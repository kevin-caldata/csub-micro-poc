# T02.2 — pendingCalls store: single-use, constant-time claim with 60 s TTL

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Create `src/twiml.ts` containing the per-call token store (`PendingCall`, `pendingCalls`), the constant-time single-use `claimPendingCall()`, and the TTL sweep helper — fully unit-tested, with no routes yet (routes are T02.3).

**Wave:** B · **Depends on:** T01 · **Blocks:** T02.3, T03

**References:**
- `docs/specs/02-http-server-and-twiml-webhook.md` — R5.2 (the authority: verbatim `PendingCall`/`pendingCalls`/`claimPendingCall` snippets live there); acceptance A5
- `docs/specs/01-scaffolding-and-toolchain.md` — R1 (`.js` import extensions), R7 (test conventions: `node:test` via tsx, `src/<name>.test.ts`, `node:assert/strict`)
- `docs/findings/03-twilio-media-streams.md` — claims 3, 11 (why: `<Parameter>` 500-char limit; single-use ~60 s TTL token; `Map.get` would be a timing oracle)
- `docs/specs/03-twilio-media-ws-leg.md` — acceptance A2 only (the downstream consumer of `claimPendingCall`; read to see the reuse/expiry expectations, implement nothing from it)

## Interfaces

**Consumes:** nothing beyond Node built-ins (`node:crypto`: `createHash`, `timingSafeEqual`, `randomUUID`). Deliberately no import of `config.ts`/`logger.ts` in this task — the store is pure state + crypto.

**Produces** (in `src/twiml.ts`; exact names — Spec 03 and T02.3 import these):
- `export interface PendingCall { callSid: string; createdAt: number; gatewayAuth: Promise<{ token: string; url: string; expiresAt?: number }> }`
- `export const pendingCalls: Map<string, PendingCall>` — key = the minted per-call token (a `randomUUID()` string)
- `export const PENDING_TTL_MS = 60_000`
- `export function claimPendingCall(candidate: string): PendingCall | undefined` — sha256-then-`timingSafeEqual` compare, deletes expired entries as it iterates, deletes the matched entry (single-use), per the Spec 02 R5.2 snippet verbatim
- `export function sweepPendingCalls(now?: number): void` — deletes entries with `createdAt < now - PENDING_TTL_MS` (default `now = Date.now()`); T02.3 calls this on every `/twiml` hit per R5.2 ("sweep on every hit, no timers")

## Steps

- [ ] Read every file in References (for Spec 03, only its A2 acceptance bullet).
- [ ] Write failing test `src/twiml.test.ts` (`node:test` + `node:assert/strict`). No fake timers needed — control time by writing `createdAt` values directly into `pendingCalls`. Reset the map (`pendingCalls.clear()`) in `beforeEach`. Cases:
  1. **Claim happy path:** insert an entry keyed by a `randomUUID()` token with `createdAt: Date.now()`; `claimPendingCall(token)` returns that exact entry (identity), and the map no longer holds the key.
  2. **Single-use:** immediate second `claimPendingCall(token)` → `undefined` (Spec 02 A5).
  3. **Unknown token:** map holds one live entry; `claimPendingCall('not-the-token')` → `undefined`; the live entry is still present.
  4. **TTL expiry:** entry with `createdAt: Date.now() - PENDING_TTL_MS - 1000`; `claimPendingCall(itsToken)` → `undefined` AND the entry was deleted (swept during iteration).
  5. **Sweep:** two entries, one fresh, one aged past TTL; `sweepPendingCalls()` deletes only the aged one.
  6. **Constant-time compare shape:** claiming with a candidate of a wildly different length (e.g. 1 char) neither throws nor matches — proves the hash-then-compare path is length-independent (`timingSafeEqual` on raw strings would throw `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`).
  Run: `npx tsx --test src/twiml.test.ts` → expect FAIL (module missing).
- [ ] Implement `src/twiml.ts` per Spec 02 R5.2 — copy the spec's verified snippets for the interface, map, TTL const, sha256 helper, and `claimPendingCall`; add `sweepPendingCalls` as specified in Produces. No routes, no config, no logging in this task.
- [ ] Run `npx tsx --test src/twiml.test.ts` → expect PASS (6/6).
- [ ] Code-inspection step (Spec 02 A5 second half): confirm the ONLY comparison of candidate tokens is `timingSafeEqual(sha256(tok), sha256(candidate))` — no `Map.get(candidate)`, no `===` on tokens anywhere in the claim path. Note the confirmation in the Completion Report.
- [ ] Run `npm run typecheck` → clean; `npm test` → all suites PASS.
- [ ] Commit:
  ```
  feat(twiml): per-call token store with single-use constant-time claim and TTL sweep

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Acceptance

Discharges Spec 02 **A5** in full (single-use claim, 60 s TTL sweep, `timingSafeEqual` compare path).

## Completion Report

```
Task: T02.2 — pendingCalls store
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <cmd → outcome, one line each>
Spec 02 acceptance verified: A5 <pass/fail + evidence line>
timingSafeEqual inspection: <confirmed | issue found>
Deviations from plan: <none | list>
New interfaces exposed: PendingCall, pendingCalls, PENDING_TTL_MS, claimPendingCall, sweepPendingCalls (src/twiml.ts)
Notes for ledger: <≤3 lines>
```

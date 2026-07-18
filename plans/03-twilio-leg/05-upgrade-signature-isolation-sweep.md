# T03.5 — Upgrade-signature validation (log-only), `TWILIO_VALIDATE_UPGRADE` config, isolation test & acceptance sweep

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Add the R8 advisory `x-twilio-signature` check behind new config key `TWILIO_VALIDATE_UPGRADE` (default false), prove two-session isolation (FR-3), and run the full Spec 03 static/grep acceptance sweep.

**Wave:** C · **Depends on:** T03.4 · **Blocks:** T05 (T03 complete gate)

**References:**
- `docs/specs/03-twilio-media-ws-leg.md` — R8 (verbatim implementation incl. `wss://` scheme rewrite, `{}` params, lowercase header, log-only rule), R10 (event names `upgrade-signature`, `upgrade-signature-check`), A10–A12, §Open items S21
- `docs/specs/01-scaffolding-and-toolchain.md` — R5/R6 (zod `EnvSchema` + `AppConfig` shape in `src/config.ts`; `publicHost` is bare hostname; config test conventions in `src/config.test.ts`), `.env.example` layout
- `docs/findings/03-twilio-media-streams.md` — claim 10 + Impl C (scheme-rewrite root cause), gotchas 8, 13
- `docs/findings/10-gap-analysis-and-contradictions.md` — C5 (log-only decision)
- Plan interfaces: `plans/03-twilio-leg/02-ws-route-auth-gate.md` (`TwilioMediaDeps.config` pick to tighten)
- Existing code: `src/config.ts`, `src/config.test.ts`, `.env.example`, `src/twilio-media.ts`, `src/server.ts`

## Interfaces

**Consumes:** T03.2's `TwilioMediaDeps`; T01's `src/config.ts` zod schema; `twilio@6.0.2`'s `validateRequest` (default-import + destructure per Spec 03 R8 — twilio is CJS).

**Produces:**
- `src/config.ts` (ADDITIVE edits only — merge-point file, master plan R-2): schema key `TWILIO_VALIDATE_UPGRADE: z.enum(['true','false']).default('false')`; `AppConfig` field `twilioValidateUpgrade: boolean`; return-object mapping `twilioValidateUpgrade: e.TWILIO_VALIDATE_UPGRADE === 'true'`. Do not reorder or reformat existing keys.
- `.env.example` (additive): `TWILIO_VALIDATE_UPGRADE=false` with a one-line comment "advisory upgrade-signature check, log-only (Spec 03 R8, spike S21)".
- `src/twilio-media.ts`: WS-handler-entry block exactly per Spec 03 R8 — always log `upgrade-signature` with `present: !!sig`; when `config.twilioValidateUpgrade && sig`, call `validateRequest(config.twilioAuthToken, sig, wssUrl, {})` with `wssUrl = 'wss://' + config.publicHost + '/twilio-media'` and log `upgrade-signature-check` with fields `ok` AND `url: wssUrl` (the `url` field is required so A11's "logged URL used" clause is machine-checkable). NEVER close/reject on mismatch. Tighten `TwilioMediaDeps.config` to `Pick<AppConfig, 'publicHost' | 'twilioAuthToken' | 'twilioValidateUpgrade'>`.

## Steps

- [ ] Read all References; read the current `TwilioMediaDeps` and handler-entry code.
- [ ] Write failing config tests (additive cases in `src/config.test.ts`, same style as existing): default → `twilioValidateUpgrade === false`; `TWILIO_VALIDATE_UPGRADE=true` → `true`; garbage value (`TWILIO_VALIDATE_UPGRADE=yes`) → loadConfig throws (zod enum). Run `npm test` — expect FAIL.
- [ ] Implement the `src/config.ts` + `.env.example` additive edits. Run `npm test` — expect config cases PASS.
- [ ] Write failing route tests (extend the twilio-media suite; stdout-capture pattern from T03.2): (A11 default) upgrade with default config (`twilioValidateUpgrade: false`) and no signature header → one `upgrade-signature` line with `present: false`, zero `upgrade-signature-check` lines; (A11 enabled) `twilioValidateUpgrade: true` + header `x-twilio-signature: bogus` passed via `injectWS` upgrade headers → connection still completes the `connected`/`start` flow normally, one `upgrade-signature-check` line with `ok: false` and `url === 'wss://<the test publicHost>/twilio-media'`; (A10) two concurrent injected connections with distinct tokens/streamSids → two entries in `sessions`; `media` sent on one updates only that session's `latestMediaTimestamp`; marks on one never touch the other's `markQueue`; closing one leaves the other in `sessions` and functional.
- [ ] Run `npm test` — expect FAIL, then implement the R8 block in `src/twilio-media.ts` per Produces, re-run — expect PASS.
- [ ] Acceptance sweep (Spec 03 A12 + strays), run from repo root and record outputs — all must return no matches:
  - `git grep -n "connection.socket" -- src` (v11 API regression)
  - `git grep -n "markQueue.shift" -- src`
  - `git grep -n "req.hostname\|req.protocol" -- src/twilio-media.ts` (URL must come from `config.publicHost`)
  - confirm `https://` does NOT appear in the R8 url construction (`git grep -n "https://" -- src/twilio-media.ts`)
- [ ] Full gate: `npm test` (all suites), `npm run typecheck`, `npm run build` — all green. Boot smoke unchanged (`/health` 200).
- [ ] Commit 1: `feat(config): TWILIO_VALIDATE_UPGRADE flag (additive)` — config.ts/.env.example/config.test.ts only. Commit 2: `feat(twilio-media): advisory upgrade-signature validation and isolation tests` — remainder. Both with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 03 **A10**, **A11**, **A12** (full), and closes the T03 build scope. **A13 is a live-call criterion** executed at milestone M1 (Spec 10 procedures) — out of scope here; note it as "deferred to M1" in the report. Spikes S19/S21/S22/S23 remain runtime items; S21's data collector (the `upgrade-signature` line) is now in place.

## Completion Report

```
Task: T03.5 — upgrade signature, config flag, sweep
Status: <done | blocked (why)>
Files changed: <list>
Commands run: npm test → <counts>; typecheck/build → <exit>; each grep → <no matches?>
Spec A-numbers verified: A10, A11, A12 (A13 deferred to M1)
Deviations from plan: <none | list>
New interfaces exposed: config.twilioValidateUpgrade; upgrade-signature/-check log events
Notes for ledger: T03 COMPLETE pending M1 live check; sessions.ts/twilio-media.ts interfaces frozen for T05
```

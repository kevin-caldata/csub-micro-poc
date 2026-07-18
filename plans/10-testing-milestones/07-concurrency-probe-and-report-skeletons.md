# T10.7 — Concurrency probe (S24) & README spike/report skeletons

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Ship `scripts/concurrency-probe.ts` (the S24 gateway-session ramp) and add the README `## Spike Results` section (R14 format, M1-01…M1-12 stubs) plus the `## Findings Report (M5)` skeleton with the pre-classified 35-row spike table.

**Wave:** E · **Depends on:** T10.1, T04 · **Blocks:** T10.8

**References:**
- `docs/specs/10-testing-spikes-and-milestones.md` — R20 (probe algorithm — implement verbatim), R14 (per-item README format), R15 (M1-01…M1-12 table → stub headings), R26 (M5 skeleton — copy the fenced markdown verbatim), R27 (spike classification for pre-filling table rows)
- `docs/specs/00-master-build-plan.md` — §7 spike register (S1–S35 short descriptions for the table's "Question (short)" column)
- `docs/findings/01-vercel-ai-gateway-realtime.md` — claim 2 / Impl 9 (factory-form `getToken`, `GatewayError` class + `statusCode`), gotcha 6
- `docs/specs/04-gateway-realtime-leg.md` — R1 (import surface), R3 (`getToken({ model, expiresAfterSeconds })` factory call shape), R4 (`getWebSocketConfig`, ws client options `perMessageDeflate:false`, `handshakeTimeout:5000`)
- `docs/findings/10-gap-analysis-and-contradictions.md` — C1 (never `rt.getToken`)

## Interfaces

**Consumes:**
- `@ai-sdk/gateway` — `gateway.experimental_realtime(model)` factory + `gateway.experimental_realtime.getToken(...)`; `GatewayError`.
- `ws` client. (The probe imports packages directly, NOT `src/gateway.ts` — it must not depend on bridge wiring; mirror Spec 04 R4's connect constants.)
- npm script `probe:concurrency` (already added by T10.1).

**Produces:**
- `scripts/concurrency-probe.ts` — CLI: env `AI_GATEWAY_API_KEY` + optional `MODEL_ID` (default `openai/gpt-realtime-2.1`); ramp `i = 1..15` then steps of 5 to max 30; per connection: mint (record `GatewayError` class + `statusCode` on throw) → WS open with `{ perMessageDeflate: false, handshakeTimeout: 5000 }` → immediately send `session-update` `{config:{instructions:'probe', turnDetection: null}}` → hold open; stop at first rejection; close ALL sockets in a `finally`; print a `connection # → result` table (result ∈ `open` | `unexpected-response <status> <body>` | `close <code> <reason>` | `mint-failed <class> <statusCode>`).
- `README.md` — `## Spike Results` section: the R14 per-item template once as a comment/example, then twelve stub headings `### M1-01 · S15 — getToken smoke` … `### M1-12 · S32 S10 — gateway tags / providerOptions` (S-numbers per the R15 table's "Answers" column), each with the empty R14 field list.
- `README.md` — `## Findings Report (M5)` section: the R26 fenced skeleton copied verbatim (headers are normative), and section 6's table pre-filled with all 35 rows: `S#`, short question (from master plan §7), empty Answer/Evidence, and accepted-risk rows (S23 ping-half, S28) pre-annotated per R27.

## Steps

- [ ] Read the References; copy connect constants from Spec 04 R4 (do not invent options).
- [ ] Write `scripts/concurrency-probe.ts` per R20 verbatim (see Produces). Grep gate: file contains `experimental_realtime.getToken` and zero occurrences of `rt.getToken`.
- [ ] Typecheck: `npm run typecheck` — expect PASS.
- [ ] Offline dry-run: `npm run probe:concurrency` WITHOUT `AI_GATEWAY_API_KEY` — expect a clean, single-line refusal naming the missing variable (no stack-trace spew, no hang). This is the only run this task performs; the live ramp is T10.8/M4.
- [ ] Edit `README.md`: add both sections per Produces. Keep every existing README section untouched (T06's M1 checklist stub and T10.1's dependency-table row must survive).
- [ ] Verify: `npm test` — expect PASS (README edits can't break tests; this is the regression tripwire before commit).
- [ ] Commit: `feat(probe): S24 concurrency ramp script and README spike/M5 report skeletons` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Delivers the R20 script and the R14/R26/R27 README scaffolding that **A7** and **A11** are recorded into (discharged at T10.8); probe output format directly feeds **A10**'s "S24 ceiling + locus recorded".

## Completion Report

```
Task: T10.7 — Status: DONE | BLOCKED(<why>)
Files changed: <list>
Commands run: npm run typecheck → <result>; npm run probe:concurrency (no key) → <observed refusal line>; npm test → <n passed>
Spec A-numbers verified: (scaffolds A7/A10/A11)
Deviations from plan: <none | list>
New interfaces exposed: scripts/concurrency-probe.ts CLI (env AI_GATEWAY_API_KEY, MODEL_ID)
Notes for ledger: <1-2 lines>
```

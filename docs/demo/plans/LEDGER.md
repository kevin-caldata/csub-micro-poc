# Execution Ledger — CSUB-RIO Demo Build (RIO)

Single source of truth for demo-build state. **Only the main (orchestrator) conversation edits this file. Executors never touch it.**
Companion protocol: `docs/demo/plans/README.md`. Wave structure: master demo plan `docs/demo/specs/00-master-demo-plan.md` §6. Base build state (read-only to this build): `plans/LEDGER.md` — the base ledger carries the single cross-reference row per master plan R2.3; the ONLY other base-ledger edits ever made by demo work are the S1/S8 spike answers (README §8).

---

## Current state

<!-- Orchestrator rewrites ONLY this block each session. Keep it under 10 lines. -->

- Wave: M-B DEPLOYED 2026-07-19 (RIO live, commit 0502775 incl. DEV-02 hotfix); H1 first calls made — features all passed, 2 hangup bugs found: truncate-overshoot FIXED+deployed, Twilio 31924 instrumented (findings/18); re-test pending
- Last updated: 2026-07-19
- Next dispatchable tasks: after re-test confirms hangups resolved → DC1 (measurement runbook, human H2) ∥ DC2.1 (MCP deep-dive doc)
- Suite on main: 434 tests green, typecheck clean (baseline 356 + 78 demo tests)
- Open blockers: none. Human needed later: H1 at M-B (first live call), H2 in Wave DC (measurement sessions), H3 in Wave DD (email inputs + send)

---

## Legend & update protocol

Status codes: `-` pending · `D` dispatched · `OK` done (accepted AND merged to main) · `BLK` blocked · `PART` partial (human-gated tasks only).

Per-event edits (make ONLY these; do not reformat tables):

1. **Dispatch**: set Status `-` → `D`.
2. **Completion report received**: verify commit exists (`git log --oneline -1 <hash>` in the task branch), run the plan's cheap verify (targeted test file + `npx tsc --noEmit`), merge the branch to main (README §3), then set Status → `OK`, fill Commit (short merged hash), fill Note with ONE line distilled from the report (deviations/interface amendments/actual test count; "clean" if none).
3. **Blocked**: set Status → `BLK`, add a row to the Deviations log, leave Commit empty, Note = deviation ID.
4. **Wave complete**: all rows `OK` → run the wave's merge-point checks (under each table; full definitions master plan §6 + README §7), update Current state (Wave, Next dispatchable, actual test count).
5. **Merge point / human item reached**: fill the gate line under the wave table and any Demo Spike Register rows answered; H-item results go in the gate line's Note.

Never delete rows. Never re-order. Append-only in Deviations.

---

## Wave DA — offline foundations (DA1 ∥ DA2 chain ∥ DA3; DA2.1→.2→.3 strictly sequential)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| DA1 | 04-corpus/01-corpus-file-and-loader.md | — | OK | 212feae | review NEEDS_FIXES→fixed (fabricated §9 sentence removed + 6 en-dash ranges, ffc1382); post-merge CRLF break → .gitattributes LF pin (e31daef); corpus 33,450 B; 7/7 + allowlist zero violations |
| DA2.1 | 02-static-tools/01-identity-flow-tools.md | — | OK | 5130f61 | review APPROVED; 368/368 + typecheck clean; Minor (final-review triage): reset_password description quoting style inconsistent with sibling |
| DA2.2 | 02-static-tools/02-routing-and-escalation-tools.md | DA2.1 (dispatch with README N4 read-down) | OK | 317ad87 | review APPROVED; 387/387 in lane, 31/31 static-tools on main; G3/PD-03 spot check PASSED all 4 numbers byte-identical mcp-server vs corpus |
| DA2.3 | 02-static-tools/03-sms-time-and-hello-removal.md | DA2.1, DA2.2 | OK | e565da6 | review APPROVED + doc-comment fix (738b2f8); tools.test.ts count-13 was plan arithmetic slip (verified vs merge-base); A9 grep gate clean |
| DA3 | 05-performance/01-aggregator-knowledge-extension.md | — | OK | 915bb1d | review NEEDS_FIXES→fixed (EXPERIMENTS.md intro R3 72h sentence, 7592cde); D2 grep gate 0; smoke outputs byte-matched |

**Merge point M-A** (all five rows OK + merged): full `npx vitest run` green (KF-1 rule below); record actual count in Current state; run the deferred G3 crisis-number spot check `src/mcp-server.ts` vs `assets/csub-corpus.md` if DA2.2's report flagged it (PD-03). File sets disjoint — no manual merge. DA2.* landed against the zero-arg `buildMcpServer()` (D3).

M-A gate: Status `OK` · Date `2026-07-19` · Note `406/406 + typecheck clean on main, no KF-1 flake; G3/PD-03 spot check passed at DA2.2 accept`

## Wave DB — knowledge tool + persona (DB1 chain ∥ DB2; requires M-A except DB1.1)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| DB1.1 | 03-knowledge/01-config-keys-and-dependency.md | — (early-dispatch allowed: file set disjoint from every DA task, README §2; needs npm registry access, PD-07) | OK | ce81116 | review APPROVED zero findings; ai@7.0.31 one-package add verified (npm ls); 362/362 in lane; 21/21 config tests on main post-merge |
| DB1.2 | 03-knowledge/02-knowledge-tool-handler.md | DB1.1, M-A (DA1 `CSUB_CORPUS` + DA2.1–.3 mcp-server body) | OK | 4fa8717 | review APPROVED; error path traced to SDK backstop + exercised live; 424/424 in lane, 18 new tests |
| DB2 | 01-persona/01-instructions-and-greeting.md | M-A (DA2.1–.3 merged — tool names live) | OK | be585b8 | review APPROVED zero real findings; R3 unwrap independently re-derived 0 diffs; INSTRUCTIONS 5031 chars; D15 verified; 410/410 in lane |

**Merge point M-B — the deploy gate** (all rows OK + merged): (1) full suite + `npm run typecheck` green; (2) grep gates Spec 03 A3 (no fallback in `src/`), Spec 04 A5 (corpus read only in `src/corpus.ts`), Spec 02 A9 (no live `'hello'`); (3) G3 crisis-number byte-identity across `src/gateway.ts`, `src/mcp-server.ts`, `assets/csub-corpus.md`; (4) R8.5 diff audit — G4 preamble assertions (`test/gateway.session-config.test.ts:100-102`, `:124-128`) and voice-default assertion (`:103`) unmodified; (5) push `main` → Railway auto-deploy → live. Then **H1 (human)**: watch deploy, first RIO call, Spec 01 A8 checks (a)–(e).

M-B gate: Status `OK — deployed` · Date `2026-07-19` · Note `428/428 at gate; grep gates clean; G3 byte-identity OK (D15); G4 audit zero deletions; deployed 498f8fd then hotfix 0502775 (434/434)` · H1: Status `PART` · Note `A8 features (a)-(e) all observed correct live; 2 hangup bugs (DEV-02): truncate fix deployed, 31924 under instrumentation; re-test call pending`

## Wave DC — live measurement + docs drafting (DC1 ∥ DC2.1; requires M-B deployed)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| DC1 | 05-performance/02-baseline-and-experiments-runbook.md | M-B deployed + DA3 (`--knowledge` mode); human H2 in the loop; Spec 05 R11 order: R2 baseline → E3 → E4+E5 → E1/E2 → E6 | - | | |
| DC2.1 | 06-docs-launch/01-mcp-deep-dive.md | M-B (shipped `src/mcp-server.ts`, `src/knowledge.ts`, `src/corpus.ts`, `src/gateway.ts`; plan hard-stops if dispatched earlier, PD-15) | - | | |

**Merge point M-C** (email-release gate): E4 row = **PASS** in `docs/measurements/EXPERIMENTS.md` (Spec 05 R11.3/A7); E6 evaluated (900 ms default gate — human may re-baseline, README N9); every FAIL row reverted same day (G7); S1/S8 answers in BOTH ledgers (README §8 item 2) and DS-1…DS-5 rows below filled; log extraction within 72 h of every session (hard rule).

M-C gate: Status ` - ` · Date ` ` · Note ` ` · H2 sessions: Status ` - ` · Note ` `

## Wave DD — launch (sequential; requires M-C; human H3)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| DD1 | 06-docs-launch/02-architecture-doc.md | DC2.1, M-C (E4 PASS + E6 rows with dated session dirs in EXPERIMENTS.md — plan halts BLOCKED if absent) | - | | |
| DD2 | 06-docs-launch/03-email-finalization-and-launch.md | DD1, DC2.1, M-C; human H3 supplies R20 inputs, smoke call, the send (plan-internal label "D06.3", README N3) | - | | |

**Build done** when: email sent by the human (never an agent), T0 recorded, deploy freeze in force (windows per human decision — README N9), LAUNCH-CHECKLIST §1–§2 fully checked, first pilot extraction scheduled within 72 h, and Current state above reads **LAUNCHED**.

H3: Status ` - ` · T0 ` ` · Note ` `

---

## Demo Spike Register (DS-1…DS-5)

Fill Answer during Wave DC (DC1 sessions). Full definitions: master plan §7. DS-1/DS-2 are the base spikes S8/S1 — their answers ALSO go into the base `plans/LEDGER.md` Spike Answer Register rows S8/S1 (README §8 item 2, the only sanctioned base-ledger data edit).

| DS# | Question (short) | = base spike | Answered at | Answer |
|---|---|---|---|---|
| DS-1 | `marin` valid/applied voice for gpt-realtime-2.1 via gateway? (E3) | S8 | Wave DC, before E4 | |
| DS-2 | Gateway honors `audio/pcmu` end-to-end, no `rate` key? (E1) | S1 | Wave DC | |
| DS-3 | `thinkingLevel:'minimal'` actually passes through to Google? (E4 latency distribution + reasoningTokens ≈ 0) | — | Wave DC (E4) | |
| DS-4 | Knowledge latency baseline — `knowledgeMs` p50/p95, `toolTotalMs` p50 over ≥20 live questions (locks preamble length, releases email) | — | Wave DC → gates Wave DD | |
| DS-5 | Implicit caching bites? (`cachedInputTokens` ≥ 50% on repeats — non-blocking cost fact) | — | Wave DC (piggybacks E4) | |

---

## Test rules (binding at every accept and merge point)

- **Baseline 356** pre-demo tests (verified 2026-07-19: 354 passed + 2 known-flaky, see KF-1). Expected additions: DA1 ≥ 7, DA2.* ≥ 12, DB1.* ≥ 13 (incl. the D4 exact-seven pin), DB2 ≥ 4 — final count strictly > 356; record actuals in row Notes and Current state (README N6).
- **KF-1 (known flake):** the two `test/harness.test.ts` barge-in tests ("clear precedes conversation-item-truncate", "truncate carries a valid audioEndMs") are timing-flaky under full-suite load and pass in isolation. A merge-point run failing ONLY those two gets one targeted re-run `npx vitest run test/harness.test.ts`; green in isolation = the gate passes (note it here). Any other failure, or a KF-1 failure persisting in isolation, is a real regression and blocks the merge. Only DA2.3's R10.4 migration may touch those two tests and must leave them passing in isolation (master plan §8 R8.2).
- No test deletions, zero skips introduced; `hello` tests are migrated, not removed (R8.4). G4 preamble + voice-default assertions unmodified in every wave diff audit (R8.5).

---

## Deviations log (append-only)

Format: `| DEV-NN | date | task | what deviated / why | resolution (respin / plan amended / accepted) |`

| ID | Date | Task | Deviation | Resolution |
|---|---|---|---|---|
| DEV-01 | 2026-07-19 | pre-dispatch | Cross-plan review NEEDS_HUMAN: master A5 required operator (661) 654-2782 in src/gateway.ts; Spec 01 Safety backup deliberately carries only the three crisis numbers | Human decided: Spec 01 governs. Master plan amended (D15, G3, A5 — byte-identity where-present). Human reaffirmed SIMULATION-ONLY: numbers are spoken information, never transfer targets; no task may add forwarding |
| DEV-02 | 2026-07-19 | H1 live | Two hangup bugs in first live RIO calls: (a) barge-in truncate overshoot (audioEndMs 13160 > item audio 10950) → gateway invalid_value error treated FATAL → call closed 1001 "gateway-error" (S11 benign-code tuning needed); (b) Twilio "Stream - Websocket - Protocol Error" (31924-class) killed 2 of 4 calls ~6 s after long outbound audio, close 1006 | RESOLVED (a): benign classification + tightened pattern, reviewed APPROVED, merged+deployed (434/434). (b): findings/18 H1=unpaced-burst (medium conf) — pacing change HELD; outbound-burst instrumentation deployed instead; awaiting recurrence evidence + Twilio debugger detail. H1 otherwise PASSED: greeting/persona/knowledge (knowledgeMs 2243 ms cold)/crisis/identity all correct live |

<!-- append DEV rows above this line as they occur; never edit or delete existing rows -->

### Pre-declared deviations (from planning — executors are expected to confirm these in completion reports; log a DEV row only if execution DIVERGES)

| ID | Task | Pre-declared deviation | Standing resolution |
|---|---|---|---|
| PD-01 | DA1 / DD2 | Corpus §12 RIO self-description may drift from the email once Spec 06 finalizes it (email wins, Spec 04 R4.12) | PRE-DECLARED — re-check scheduled inside DD2; a mismatch there is a DD2 in-scope corpus §12 edit, not a failure |
| PD-02 | DA2.1 | Adding two tools breaks two base assertions (`test/mcp-server.test.ts:40` exact-list toEqual; `test/tools.test.ts:35` length===2); DA2.1 applies minimal intermediate migrations (containment of 4 names incl. `hello`; length ≥ 4) | PRE-DECLARED — final R10.1/R10.2 forms (six names, not-hello, ≥ 6) land with DA2.3, not earlier |
| PD-03 | DA2.2 | G3 crisis-number byte-identity vs `assets/csub-corpus.md` may be unverifiable at execution time (DA1 is a parallel lane) | PRE-DECLARED — completion report records which case occurred; orchestrator runs the spot check at M-A (and again at M-B) |
| PD-04 | DA2.2 / DA2.3 | Exact full-suite counts unknowable at plan-write time; phrased as baseline 356 + predecessors' additions (+19 for DA2.2), strictly > 356 | PRE-DECLARED — actual counts recorded in row Notes (README N6) |
| PD-05 | DA2.3 | Plan gates on DA2.1/DA2.2 outputs (shared `test/static-tools.test.ts` harness + capture helper, `VERIFICATION_TOKEN_REGEX`) and reports BLOCKED if absent | PRE-DECLARED — expected to pass given sequential merge discipline; if it trips, re-review the mis-accepted predecessor (README N5) |
| PD-06 | DA3 | File set includes `docs/measurements/EXPERIMENTS.md` R12 scaffold beyond master §6's script+README; output heading `## knowledge-call metrics` is plan-chosen (mirrors existing `## tool-call metrics`) | PRE-DECLARED — accepted; no other DA/DB task touches EXPERIMENTS.md; DC1 consumes the scaffold |
| PD-07 | DB1.1 | `npm install --save-exact ai@7.0.31` needs registry access; if offline at dispatch, the dependency half blocks while the config half can land as its own commit | PRE-DECLARED — split-commit acceptable; row stays `D` until both halves land or `BLK` with a DEV row |
| PD-08 | DB1.1 | Lockfile verify showing any `@ai-sdk` pin drift (`gateway@4.0.23` / `provider@4.0.3` / `provider-utils@5.0.11`) or new transitive deps → revert + BLOCKED | PRE-DECLARED — human adjudication under G1; never an implementer fix |
| PD-09 | DB1.2 | Spec 03 R9 `deps.corpus` vs R10 module-scope SYSTEM prompt tension resolved via reference-equality dispatch (`deps.corpus === CSUB_CORPUS` → module SYSTEM, else rebuild) | PRE-DECLARED — accepted (G5-compliant, no mutable memo); revisit only if a merge check disproves it |
| PD-10 | DB1.2 | D4 exact-seven `tools/list` assertion placed in `test/knowledge.test.ts` | PRE-DECLARED — accepted; no sibling claims it, no dedupe needed |
| PD-11 | DB2 | Spec 01 R3 fenced text is hard-wrapped in the spec; implementer joins wrapped lines with single spaces (R1-sanctioned) so test-asserted substrings stay contiguous | PRE-DECLARED — accepted; copying the wraps literally is the failure mode to watch in review |
| PD-12 | DC1 | S1/S8 answers recorded in `plans/LEDGER.md` Spike Answer Register rows (operational surface with Answer column, S15 precedent) — master R2.3's cite of `docs/specs/00-master-build-plan.md` §7 points at an owner table with no answer column | PRE-DECLARED — register rows are the surface of record; annotating the spec-file table is optional and NOT required for M-C |
| PD-13 | DC1 | No `--greeting` aggregator mode exists; pooled greeting percentiles computed by a node one-liner reimplementing the script's nearest-rank pct over pooled raw values | PRE-DECLARED — accepted pragmatic reading of Spec 05 R3 (pooling preserved, no percentile-of-percentiles) |
| PD-14 | DC1 | E1 blind-A/B blinding is operationally loose (listeners judge 3 pre-flip vs 3 post-flip calls, mode undisclosed) | PRE-DECLARED — human may substitute a stricter protocol at session time; record whatever actually ran in EXPERIMENTS.md |
| PD-15 | DC2.1 | Spec 06 line anchors into DA2/DB1/DB2-rewritten files are pre-demo; writer re-derives from as-built code (stable G9-file anchors pre-verified); plan hard-stops if dispatched before M-B | PRE-DECLARED — accepted; the hard-stop is correct behavior, not a failure |
| PD-16 | DD1 | E4/E6 dated measurement dir names resolvable only from EXPERIMENTS.md rows at execution; barge-in annotation may be qualitative-only (Spec 06 R5.6); `mmdc` may be unavailable offline → GitHub-preview rendering is the A1 fallback evidence | PRE-DECLARED — all three accepted |
| PD-17 | DD2 | E4-PASS gated via `EXPERIMENTS.md` Precondition (BLOCKED if absent/FAIL); without the three relayed R20 human inputs the task legitimately ends READY-EXCEPT-HUMAN-INPUTS (Spec 06 A5 pending); freeze/batching defaults (24 h / ≤1 per day) are human-adjustable — the human's answer must land as a DEV/decision row here before the send | PRE-DECLARED — accepted; READY-EXCEPT-HUMAN-INPUTS is a valid terminal report, ledger flip to LAUNCHED is the orchestrator's after H3 confirms the send |

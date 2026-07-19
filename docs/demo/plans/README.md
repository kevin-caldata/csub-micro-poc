# Orchestrator Execution Protocol — CSUB-RIO Demo Build (RIO)

You are the MAIN conversation running the demo build. This file is your operating procedure — the demo-build counterpart of the base `plans/README.md` (same protocol, adapted). State lives in `docs/demo/plans/LEDGER.md` (the **demo ledger** — never the base `plans/LEDGER.md`, see §8). Requirements live in `docs/demo/specs/`; the master plan is `docs/demo/specs/00-master-demo-plan.md` and it OVERRIDES child specs wherever its §5 adjudications (D1–D14) or §9 dispositions speak. **All Global Constraints in docs/demo/specs/00-master-demo-plan.md §3 (G1–G14) bind every task dispatched from this folder.** Each plan file under `docs/demo/plans/<spec-dir>/` is self-contained for its executor.

## 1. The delegation rule (absolute)

**NEVER implement in this conversation.** Every task is executed by a dispatched sub-agent, one sub-agent per plan file. Prompt template (the plan file carries everything else — do not paste specs or context into the prompt):

> Execute the plan at docs/demo/plans/&lt;dir&gt;/&lt;file&gt;.md in repo root D:\projects-linean\CSUB-RIO-POC, working in the isolated worktree at &lt;worktree-path&gt; on branch &lt;branch&gt;

Plan files live in per-spec subdirectories (`01-persona/`, `02-static-tools/`, `03-knowledge/`, `04-corpus/`, `05-performance/`, `06-docs-launch/`) — always use the full subdirectory path in the dispatch prompt (protocol note N1; this supersedes the flat `<task-id>-<slug>.md` naming shown in master plan §2). Do not read plan files yourself except to amend one after a failure (§6). Do not read spec files except to adjudicate a conflict. Your context is the scarcest resource in this build.

## 2. Dispatch & parallelism rules

- Dispatch only tasks whose every `Depends on` entry in the demo ledger is `OK` **and merged to main** (§3), and whose required merge point (M-A/M-B/M-C, §7) has passed. **The ledger's Depends-on column is authoritative** — several plan files' internal `dependsOn` lines cite sibling filenames assumed before those siblings existed (protocol note N2).
- Tasks in the same wave with **disjoint file sets** may run concurrently. Chains are strictly sequential — never parallelize two tasks that write the same file:
  - **DA2.1 → DA2.2 → DA2.3** — all three edit `src/mcp-server.ts` and APPEND to the shared `test/static-tools.test.ts` (append-only; each sibling reuses DA2.1's Fastify port-0 harness + stdout-capture helper).
  - **DB1.1 → DB1.2** — the 03-knowledge chain.
  - **DD1 → DD2** — DD2 consumes DD1's committed ARCHITECTURE.md.
  - **Cross-wave sequential (D3):** `src/mcp-server.ts`, `test/mcp-server.test.ts`, `test/tools.test.ts` are edited by DA2.* (Wave DA, against the zero-arg `buildMcpServer()`) and then by DB1.2 (Wave DB, which owns the `(cfg, deps?)` signature change and ALL call-site updates). Never concurrent.
- Safe max parallelism per wave: **DA = 3 lanes** (DA1 ∥ DA2 chain ∥ DA3), **DB = 2 lanes** (DB1 chain ∥ DB2), **DC = 2 lanes** (DC1 human-in-the-loop ∥ DC2.1), **DD = 1 lane** (sequential).
- **Early-dispatch allowance:** DB1.1 (`src/config.ts`, `.env.example`, `package.json`, `package-lock.json`, `test/config.test.ts`) has a file set disjoint from every Wave DA task and may be dispatched during any idle Wave DA slot. DB1.2 still hard-requires merge point M-A (it needs DA1's `CSUB_CORPUS` and DA2's finished mcp-server body).
- **G14 (exclusive file ownership):** verify every completion commit touches only the plan's declared files. DA3's declared file set includes `docs/measurements/EXPERIMENTS.md` (scaffold) in addition to master plan §6's script + README — accepted, no other DA/DB task touches it (PD-06).

## 3. Worktree isolation & merge discipline (DEV-03, promoted to protocol)

The base build proved concurrent lanes cannot share one working tree (base ledger DEV-03: repo-wide test/typecheck see half-written files; git index races). Therefore:

1. **Every implementer runs in an isolated git worktree** on its own branch cut from current `main`, with `npm ci` run in that worktree. Never two lanes in one tree; never an implementer in the orchestrator's tree.
2. **Task review, then merge:** on accepting a completion report (§4), the ORCHESTRATOR — never a sub-agent — merges that task's branch to `main`. File sets are disjoint by design, so a merge conflict is itself a protocol breach → treat as a failure (§6).
3. The next task in a chain is dispatched only after its predecessor is merged to `main` and the merged tree is green (targeted verify minimum; full suite at chain ends and merge points).
4. Remove the worktree after merge. Do not push to the remote until merge point M-B — **pushing `main` triggers the Railway auto-deploy of the live line** (master plan §6); Waves DA/DB accumulate locally, M-B is the deploy gate.

## 4. Review gate (per completion report)

On receiving a completion report:
1. `git log --oneline -1 <claimed-hash>` in the task branch — the commit(s) must exist and touch only the plan's declared files.
2. Run the cheap verifies: the plan's targeted test command and `npx tsc --noEmit`. Run full `npx vitest run` at chain ends and merge points (expected counts per master plan §8; KF-1 flake rule — a run failing ONLY the two `test/harness.test.ts` barge-in tests gets one targeted re-run `npx vitest run test/harness.test.ts`; green in isolation passes, note it in the ledger; anything else blocks).
3. Scan the report for deviations. If it diverges from the ledger's PRE-DECLARED list, log a DEV row (§5 step 3).
4. Optional deeper review (two-stage per `superpowers:subagent-driven-development`): use for the integration-heavy tasks — DA2.3 (test migrations across four files), DB1.2 (signature change + call sites), DD2 (the send gate) — skip for leaf tasks.
5. Confirm the report's recorded actual test count and write it into the row Note (counts are phrased in plans as "baseline 356 + earlier additions" because siblings were unwritten at plan time — protocol note N6).

## 5. Ledger update procedure (exact edits, nothing else)

Identical to base `plans/README.md` §4, applied to `docs/demo/plans/LEDGER.md`:

- On dispatch: flip that row's Status to `D`.
- On accept + merge to main: Status → `OK`, Commit → short hash (the merged commit), Note → one line from the report ("clean" if nothing notable; include the actual full-suite count when the report ran it).
- On block: Status → `BLK`, append a `DEV-NN` row to the Deviations log, put the DEV id in the Note.
- On wave completion: run that wave's merge-point checks (listed under the wave table), then rewrite the **Current state** block (Wave, Last updated, Next dispatchable tasks, Open blockers). Keep it under 10 lines.
- On human-queue items (H1/H2/H3) and spikes (DS-1…DS-5): fill the register rows when answered.
- Never reformat, reorder, or delete ledger rows. Deviations log is append-only.

## 6. Failure protocol

Blocked or failed task:
1. Append a Deviations row (what, why, evidence pointer).
2. Choose ONE: (a) **respin** — re-dispatch the same plan file with an amended prompt naming the failure and the fix constraint; or (b) **amend the plan file** (you may read/edit it for this) then re-dispatch clean.
3. If the failure exposes a spec conflict: adjudicate via master plan §5/§9 (this plan wins where it speaks; otherwise the owning spec wins in its scope); record the ruling in Deviations; **never let a sub-agent re-litigate D1–D14 or the approved decisions in master plan Non-goals** (single model no fallback G2, whole-corpus no-RAG G11, `send_sms` stays D8, crisis simulated-only G3, etc.).
4. Pre-flagged escalation points: DB1.1's lockfile verify — any `@ai-sdk` pin drift or new transitive dep → the plan mandates revert + BLOCKED; that is a **human adjudication (G1), never an implementer fix** (PD-08). DA2.2/DA2.3 precondition gates may trip on sibling-assumption mismatches — resolve per protocol notes N4/N5 before treating as failure.

## 7. Wave gates M-A / M-B / M-C and the human queue (STOP points)

Full definitions: master plan §6. At each merge point: stop dispatching, run the checks, record results in the ledger, then proceed.

- **M-A** (end of Wave DA: DA1, DA2.1–DA2.3, DA3 all OK + merged): full `npx vitest run` green per master §8 (KF-1 rule); record the actual count in Current state. Run the deferred G3 crisis-number spot check `src/mcp-server.ts` vs `assets/csub-corpus.md` if DA2.2's report flagged it as unverifiable at execution time (PD-03). No manual file merge — DA file sets are disjoint.
- **M-B** (end of Wave DB — **the deploy gate**): (1) full suite + `npm run typecheck` green; (2) grep gates: Spec 03 A3 (no fallback-model anywhere in `src/`), Spec 04 A5 (corpus file read only in `src/corpus.ts`), Spec 02 A9 (no live `'hello'` references); (3) G3 crisis-number byte-identity across `src/gateway.ts`, `src/mcp-server.ts`, `assets/csub-corpus.md`; (4) R8.5 diff audit — the two G4 preamble assertions (`test/gateway.session-config.test.ts:100-102`, `:124-128`) and the voice-default assertion (`:103`) appear UNMODIFIED in the whole-wave diff; (5) push to `main` → Railway auto-deploy (~2 min) → the demo build is live. Then **H1 (human):** watch the deploy, place the first RIO call, run Spec 01 A8's live checks (a)–(e); record in the ledger.
- **M-C** (Wave DC complete): E4 row reads **PASS** in `docs/measurements/EXPERIMENTS.md` — this is what releases the email (Spec 05 R11.3/A7); E6 evaluated; every FAIL row has a same-day revert (G7); S1/S8 answers recorded in BOTH ledgers (§8); demo ledger current. **H2 (human)** spans Wave DC: all measurement sessions per Spec 05 R11 order; log extraction within 72 h of every session (hard rule).
- **Launch done** (Wave DD): email sent by the human (**H3** — the three R20 inputs, the 9-item smoke call, the send, any freeze-exception decision), deploy freeze in force, LAUNCH-CHECKLIST §1–§2 fully checked, demo ledger Current state reads **LAUNCHED**, first pilot extraction scheduled within 72 h.

## 8. Base-build boundary (demo work never edits base plans)

The base build's `plans/` tree and ledger are **read-only to this build**, with exactly two orchestrator-applied exceptions (master plan R2.3):

1. **Once, before the first Wave DA dispatch:** append exactly one row to the base `plans/LEDGER.md` Deviations/notes area reading `Demo build in progress — state in docs/demo/plans/LEDGER.md`. Nothing else in that file is ever touched by demo work.
2. **At DC1 acceptance:** the S1 (pcmu) and S8 (marin) answers are recorded in BOTH ledgers — the demo ledger's DS-2/DS-1 rows AND the base `plans/LEDGER.md` Spike Answer Register rows S1/S8 (currently `plans/LEDGER.md:142` and `:149`; locate by row label if lines shifted).

No demo task edits `docs/specs/01–10`, base plan files, or the G8/G9 untouchable modules (`src/twiml.ts`, `src/session.ts`, `src/tools.ts`, `src/dsp.ts`, `src/bargein.ts`, `src/fallback.ts`, `src/latency.ts` — sole sanctioned exception: DB1.2's one-line `src/server.ts:75` change).

## 9. Session-resume procedure

On starting a new session: read **only** `docs/demo/plans/LEDGER.md`'s Current state block and the table of the wave named there. Do NOT read the whole ledger, the plans tree, the specs, or the base ledger. Resume dispatching from "Next dispatchable tasks". Read anything else only when a rule above explicitly requires it (merge check, failure, adjudication, the two §8 base-ledger edits).

## 10. Protocol notes (binding rulings on planner-raised procedural issues)

- **N1 — Subdirectory paths.** Plans live under per-spec subdirectories, not master §2's flat naming. Dispatch prompts always use the full `docs/demo/plans/<dir>/<file>.md` path. Accepted deviation from master §2; the ledger's Plan-file column is the canonical path list.
- **N2 — Ledger dependencies govern.** Several plans' `dependsOn` lines name assumed/wildcard sibling filenames (e.g. `02-static-tools/01-*.md`, `05-performance/01-aggregator-knowledge-mode.md`) written before siblings existed. The demo ledger's Depends-on column is the reconciled truth; ignore in-plan filename mismatches, honor the semantic gate (merge points M-A/M-B/M-C) stated in the plan body.
- **N3 — Task-ID mapping.** Ledger IDs govern. Plan-internal labels map as: `D06.3` (in `06-docs-launch/03-*.md`) = ledger **DD2**; specs' monolithic "DA2" = ledger **DA2.1–DA2.3**; "DB1" = **DB1.1–DB1.2**; master §6's "DC2" docs-drafting scope is split: deep-dive = **DC2.1**, email finalization + LAUNCH-CHECKLIST = **DD2** (see N7).
- **N4 — DA2.2 precondition read-down.** The DA2.2 plan was written assuming plan 01 delivered the `rio-demo` rename, `hello` retirement, and four tools; in the actual split, DA2.1 delivers only `verify_identity`/`reset_password` (+ regex + harness) and **DA2.3 owns the rename, `hello` retirement, `send_sms`, `get_current_time`, and the final R10.1/R10.2 assertion forms**. The DA2.2 dispatch prompt MUST state this read-down: its Preconditions are satisfied by DA2.1's actual outputs (`VERIFICATION_TOKEN_REGEX` export, the two identity tools, `test/static-tools.test.ts` harness + capture helper, `// FR-5:` still last in the tool block); rename/hello/other-two-tools checks defer to DA2.3. If the gate still trips, respin per §6 — do not amend DA2.3's scope.
- **N5 — Static-tools shared test file.** `test/static-tools.test.ts` is append-only across DA2.1→.2→.3; the chain is strictly sequential (per base `plans/README.md` §2 within-spec rule). DA2.3 reports BLOCKED if the harness or `VERIFICATION_TOKEN_REGEX` is absent — that means a predecessor was mis-accepted; re-review it, don't patch forward.
- **N6 — Test counts.** Plans state expected counts as "baseline 356 + earlier waves' additions" (master §8/D14) because sibling additions were unknown at plan time. The DA1 plan's concrete `356 → 363` holds only if DA1 merges first. Record the ACTUAL full-suite count in the row Note at each accept that ran the full suite, and in Current state at each wave end. Count never shrinks (R8.4).
- **N7 — DC2 scope consolidation.** Email R17–R21 finalization and LAUNCH-CHECKLIST R22–R26 are consolidated into **DD2** rather than a separate DC2.2 drafting lane. Nothing is lost: the email remains gated on M-C's E4 PASS (Spec 05 A7), which DD2 enforces as a hard Precondition via `EXPERIMENTS.md`. Corpus §12's RIO self-description is re-checked against the finalized email during DD2 (email wins — Spec 04 R4.12, PD-01).
- **N8 — Stale line anchors.** Plan-cited `src/`/`test/` line anchors are pre-wave positions; every plan already instructs locating by quoted content (the `// FR-5:` comment text, `mcpRoutes(app` occurrences, etc.). Anchor drift alone is never a deviation — do not log it.
- **N9 — Human-decision registers.** Two master-plan §9 items are HUMAN-adjustable defaults that must land as ledger rows when decided: issue 17 (E6 `ttfbMs` 900 ms gate — asked at the DC1 baseline review) and issue 22 (T0+24 h freeze + ≤1/day batching — asked at DD2 before send). Relay the human's three R20 email inputs (`[SENDER NAME/TITLE]`, `[FEEDBACK CHANNEL]`, `[PILOT END DATE]`) in the DD2 dispatch prompt if already known; otherwise DD2 legitimately ends READY-EXCEPT-HUMAN-INPUTS (PD-17).

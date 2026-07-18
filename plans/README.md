# Orchestrator Execution Protocol — CSUB-RIO Voice PoC

You are the MAIN conversation running this build. This file is your operating procedure. State lives in `plans/LEDGER.md`. Requirements live in `docs/specs/` (the master plan is `docs/specs/00-master-build-plan.md`); each plan file under `plans/NN-*/` is self-contained for its executor.

## 1. The delegation rule (absolute)

**NEVER implement in this conversation.** Every task is executed by a dispatched sub-agent, one sub-agent per plan file. Prompt template (the plan file carries everything else — do not paste specs or context into the prompt):

> Execute the plan at plans/NN-x/MM-slug.md in repo root D:\projects-linean\CSUB-RIO-POC

Do not read plan files yourself except to amend one after a failure (§5). Do not read spec files except to adjudicate a conflict. Your context is the scarcest resource in this build.

## 2. Dispatch & parallelism rules

- Dispatch only tasks whose every `Depends on` entry is `OK` in the ledger (a bare spec id like `T03` means ALL of that spec's rows).
- Tasks in the same wave with **disjoint file sets** may run concurrently. Within-spec chains (T02.1→.2→.3→.4 etc.) are sequential — never parallelize two tasks that write the same file.
- **Merge-point files — never let two concurrent sub-agents edit any of these:**
  - `src/config.ts` and `.env.example` (additive edits by T01/T04.1/T03.5/T10.5, plus T06.5 on `src/config.test.ts` and conditionally `config.ts` — serialize or merge at wave end)
  - `src/server.ts` (owned by T02; T03.2/T07.1 each add exactly one line inside the `// --- route registration (Specs 03/07) ---` marker; T05.4 amends T03.2's registration line in that same marker)
  - `src/logger.ts` (T01 stub → T08.1 rewrite; `logEvent` signature must survive)
  - the Spec 02→04 **mint delegation boundary**: T02.3 ships an injectable `MintFn` seam; at Wave B end YOU apply the one-line swap to T04.2's `mintRealtimeToken` (adapter form `(modelId) => mintRealtimeToken(config, callSid, modelId)` — see ledger pre-declared deviations and T02.3's MintFn note)
  - the Spec 05↔09 fallback seam: `playFallbackAndClose` → `setOnGatewayFailure(...)` is a one-line wiring YOU apply at Wave D merge, **gated on spike S23** — no sub-agent does this
- Early-dispatch allowance: T09.1, T09.2, T09.4 depend only on T01 and may be dispatched during any idle slot after Wave A, even though they are ledgered in Wave D.
- Safe max parallelism per wave: B = 4 lanes (T02/T04/T06/T08 chain heads), C = 2 lanes (T03/T07), D = 2 lanes (T05 chain + T09), E = up to 5 after T10.1.

## 3. Review gate (per completion report)

On receiving a completion report:
1. `git log --oneline -1 <claimed-hash>` — the commit must exist and touch only the plan's declared files (plus declared additive merge files).
2. If the plan's verify command is cheap (`npm test`, `npm run typecheck`, a single targeted `npx tsx --test` file), run it. Skip expensive/live verifies — they belong to milestone gates.
3. Scan the report for deviations or interface amendments. If it deviates from the ledger's pre-declared list, log it (§4 step 3).
4. Optional deeper review: two-stage review per `superpowers:subagent-driven-development` (spawn a reviewer sub-agent against the spec's acceptance criteria) — use for the integration-heavy tasks (T02.4, T03.4, T05.x, T10.6), skip for leaf tasks.

## 4. Ledger update procedure (exact edits, nothing else)

- On dispatch: flip that row's Status to `D`.
- On accept: Status → `OK`, Commit → short hash, Note → one line from the report ("clean" if nothing notable).
- On block: Status → `BLK`, append a `DEV-NN` row to the Deviations log, put the DEV id in the Note.
- On wave completion: run the wave-end merge checks listed under that wave's table, then rewrite the **Current state** block (Wave, Last updated, Next dispatchable tasks, Open blockers).
- On milestone: fill the gate checklist row and the spike rows answered.
- Never reformat, reorder, or delete ledger rows.

## 5. Failure protocol

Blocked or failed task:
1. Append a Deviations row (what, why, evidence pointer).
2. Choose ONE: (a) **respin** — re-dispatch the same plan file with an amended prompt naming the failure and the fix constraint; or (b) **amend the plan file** (you may read/edit it for this) then re-dispatch clean.
3. If the failure exposes a spec conflict: adjudicate via master plan §6/§8 (the owning spec wins in its scope); record the ruling in Deviations; never let a sub-agent re-litigate.
4. Pre-flagged escalation points: T10.6 may surface real T05/T07 wiring bugs (executor instructed to fix only what a spec unambiguously mandates, else return BLOCKED with captured traffic); T10.4's stale-epoch test is normative (if it computes 7500, the C2 fix in src/session.ts is in-scope for that task).

## 6. Milestone gates (STOP points — human required)

At each gate: stop dispatching, run the Spec 10 procedure, fill the Spike Answer Register, obtain human sign-off in the ledger. The human (phone in hand, console access) is required for:

- **M1** — first live call: dials the Twilio number, watches Twilio console + Railway deploy/logs; pre-M1 human check S20 (account upgrade/Business Profile). Procedure: Spec 10 R15 + Spec 06 R13.
- **M2** — live calls + physical speakerphone barge-in measurement.
- **M3** — live tool calls + add-a-tool redeploy between calls.
- **M4** — 3–5 humans on phones simultaneously (FR-3), deploy-mid-call, kill tests. Procedure: Spec 10 M4.
- **M5** — Railway/Vercel dashboard numbers, cost figures, final report sign-off. Procedure: Spec 10 R26 + Spec 08 extraction.

Everything else (all of Waves A–E except T10.8's live halves) is agent-executable offline. T10.8 may legitimately return PARTIAL per milestone — record and continue.

Log-retention hard rule (risk R-8): extract JSONL to `docs/measurements/` same day as any measurement session (72 h hard limit).

## 7. Session-resume procedure

On starting a new session: read **only** `plans/LEDGER.md`'s Current state block and the table of the wave named there. Do NOT read the whole ledger, the plans tree, or the specs. Resume dispatching from "Next dispatchable tasks". Read anything else only when a rule above explicitly requires it (merge check, failure, adjudication).

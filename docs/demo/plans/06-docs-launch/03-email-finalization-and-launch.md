# D06.3 — Email finalization + LAUNCH-CHECKLIST + ready-to-send launch package

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Finalize `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` **in place** (Spec 06 R17 with the master plan's D5 wording correction, R18, R19 + finalization log, R20 declared inputs, R21 honesty invariants), create `docs/demo/LAUNCH-CHECKLIST.md` (Spec 06 R22–R26), verify the send gate (E4 PASS + the three human inputs), and hand the human a ready-to-send package. **The human sends the email — this task never sends anything** (master plan Non-goals; Spec 06 Non-goals).

All Global Constraints in docs/demo/specs/00-master-demo-plan.md §G bind every step of this plan (that is §3, G1–G14; most load-bearing here: G3 crisis-number byte-identity, G12 phone allowlist, G13 no placeholders, G14 exclusive file ownership).

**Wave:** DD (last task) · **Depends on:** M-C reached (E4 row = PASS in `docs/measurements/EXPERIMENTS.md` — Spec 05 R11.3 / A7; this releases the email), DD1 complete (`docs/demo/ARCHITECTURE.md` committed), `docs/demo/MCP-SERVER-DEEP-DIVE.md` committed · **Blocks:** the send itself (human action H3) and the ledger's `LAUNCHED` state.

**References (read BEFORE editing):**
- `docs/demo/specs/00-master-demo-plan.md` — §3 (G3, G4, G12, G13), §5 **D5** (the R17 wording correction — binding), §6 Wave DD + H3, §8 (test rules, KF-1), §9 issue 22 (freeze windows are HUMAN-adjustable), Acceptance A7
- `docs/demo/specs/06-docs-and-launch.md` — R17–R21 (email), R22–R26 (checklist), A2, A5–A10
- `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` — current text (anchors below are pre-edit line numbers)
- `docs/measurements/README.md` — extraction procedure + 7-day-retention rule reused by checklist §5 (`docs/measurements/README.md:11,:42-52`)
- `docs/demo/CORPUS-UPDATE-GUIDE.md` — referenced (never duplicated) by checklist §6
- Shipped build to verify against (post M-B state): `src/mcp-server.ts` (seven registrations, `ROUTE_DIRECTORY`, `VERIFICATION_TOKEN_REGEX`), `src/gateway.ts` (`INSTRUCTIONS` incl. Duo-refusal and Safety copy), `assets/csub-corpus.md` line 1 banner, `test/gateway.session-config.test.ts:101,:126` (the G4 preamble assertions — never touched by this task)

## Files

- **Modify:** `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` (in place — no new file, no rename; the artifact keeps its history per Spec 06 Deliverables)
- **Create:** `docs/demo/LAUNCH-CHECKLIST.md`
- **Test:** none added (docs-only task). Verification = grep battery below + unchanged full suite. `git diff --stat` for this task's commits must show ONLY these two files (Spec 06 Non-goals: "Any code changes" are out of scope).

## Interfaces

**Consumes:**
- E4 measured results: the PASS row in `docs/measurements/EXPERIMENTS.md` + the dated dir `docs/measurements/<YYYY-MM-DD>-<label>/` it cites (D12) — checklist §1 gate 3 quotes the measured knowledge p50 `toolTotalMs`.
- Shipped values (documented, not defined, here): demo number `+1 (661) 490-9364`; tool names `escalate_to_human`, `route_call`, `verify_identity`, `reset_password`, `send_sms`, `get_current_time`, `ask_campus_knowledge(question, topic?)`; envelope `{status:'ok'|'not_found'|'error', response_text}`; crisis numbers per G3: Counseling Center **(661) 654-3366**, **988**, UPD **(661) 654-2111**, operator **(661) 654-2782**; log events `tool-call`, `knowledge-call`, `barge-in`, `stream-start`, `stream-stop`, `fallback-played`, `mint-failed`.
- Execution-time human inputs (R20 — NEVER invented by the implementer): `[SENDER NAME/TITLE]`, `[FEEDBACK CHANNEL]`, `[PILOT END DATE]`.
- Issue-22 disposition: 24 h freeze + ≤1/day batching are the defaults, human-adjustable at DD2.

**Produces:**
- Finalized `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` (the honesty layer of record).
- `docs/demo/LAUNCH-CHECKLIST.md` — the go/no-go send gate: email may be sent only when its §1–§2 are fully checked.
- The **ready-to-send package** (Handoff section below) — the terminal state of this plan. Sending, T0 recording, and the ledger flip to `LAUNCHED` are H3/orchestrator actions after this plan ends.

## Preconditions (check first; on failure return BLOCKED, do not proceed)

- [ ] `docs/measurements/EXPERIMENTS.md` contains an E4 row whose gate result reads PASS (knowledge `knowledgeMs` p95 ≤ 3000 ms, pooled `toolTotalMs` p50 < 1500 ms, error/timeout share < 10% — G6). If E4 is absent or FAIL: **BLOCKED** — the email is not releasable (master plan DS-4).
- [ ] `docs/demo/ARCHITECTURE.md` and `docs/demo/MCP-SERVER-DEEP-DIVE.md` exist and pass Spec 06 A2's placeholder grep (checklist §1 gate 4 will re-assert this).
- [ ] Working tree clean; no other Wave DD task is editing these two files (G14).

## Steps

### Phase 1 — email finalization (agent-only, no human input needed)

- [ ] Read every file in References. Record the pre-edit content of the four honesty invariants (the four-bullet "honest part" block, the crisis "don't role-play distress" paragraph with the 988 pointer, the logging disclosure bullet, the AI-self-identification bullet) so R21/A8 can be diff-checked at the end.
- [ ] **R17 body edit.** In `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` §1 "What to try", replace item 6's body (currently line 47, `**Ask "what time is it?"** — a deceptively small question. How it answers tells you something real…`) with the replacement text given verbatim in Spec 06 R17's blockquote, **as amended by master plan D5**: the clause `and reads back the server's clock` becomes `and reads back the real current time on the Bakersfield campus (Pacific Time), straight from the server's clock`; every other word of the R17 blockquote is used character-for-character. (Spec 06's blockquote already carries the D5 wording — copy it from there, not from memory.)
- [ ] **R17 rationale edit.** Rewrite §2 claim **R5** (currently line 94): the beat is now "the smallest possible demonstration of the tool loop" — RIO's preamble → `get_current_time` call → spoken real Pacific time; keep the honest-limits framing only as "a language model has no clock". Delete the sentence claiming `No clock tool exists in the PoC` (contradicted by the shipped registration — Spec 06 R17). Update R5's findings citation to the tool-call wow-moment source it now rests on (`docs/findings/14:94-97`, already cited by R4).
- [ ] **R18 edit.** In §1 "Under the hood" (currently line 69), replace the single sentence `When RIO "looks something up," it's calling tools on an in-process MCP (Model Context Protocol) server that returns the fake demo data.` with the two-tier replacement text given verbatim in Spec 06 R18's blockquote (Gemini Flash-Lite, same AI gateway, simulated campus reference document, "fake on purpose"). The surrounding sentences of the paragraph are untouched.
- [ ] **R19 table re-verification.** Check each of the 8 rows of "What this simulates vs. what's real" (currently lines 56–65) against the shipped build, editing wording only where the build moved:
  | Row | Check against | Required action |
  |---|---|---|
  | 1 routing | `ROUTE_DIRECTORY` in `src/mcp-server.ts` (Spec 02 R4); Spanish via persona (Spec 01) | verify; expect unchanged |
  | 2 24/7 | `ask_campus_knowledge` + `assets/csub-corpus.md` (Specs 03/04) | **reword per R19.1**: keep status `LIVE (knowledge simulated)`; mechanism wording must not imply canned per-topic lookups — it is a corpus-backed delegated model |
  | 3 crisis | `escalate_to_human` canned payload + Spec 01 Safety copy; G3 numbers byte-identical | verify; expect unchanged |
  | 4 transfers | `route_call` narration; no `<Dial>` (`src/twiml.ts` untouched — G8/G9) | verify; expect unchanged |
  | 5 recording | transcripts in logs (base Spec 08); no audio capture | verify; expect unchanged |
  | 6 KPI | measurement live (`scripts/aggregate-latency.mjs`); no dashboard | verify; expect unchanged |
  | 7 verification | `verify_identity` → `reset_password` `SIM-V-` token theater (Spec 02 R5/R6; D13); Duo refusal in `INSTRUCTIONS` | verify; expect unchanged |
  | 8 SMS | `send_sms` is now a registered static tool (Spec 02 R7; D8) | **reword per R19.2**: status stays `FUTURE`; narration is tool-backed theater; the words "no text will ever arrive" (or R19.2's "no message is ever sent") MUST remain |
- [ ] **R19 constants + item-5 check.** Verify unchanged: demo number `+1 (661) 490-9364` (twice: CTA + subject option 2); ~25-minute session cap (source claim: `docs/demo/RIO-DEMO-CONCEPT.md:239`); real operator line `(661) 654-CSUB` in Practical notes (allowlisted, G12); the deploy-severs-calls small print; the crisis paragraph (unchanged — escalation stays static-fake, 988 real). Verify the item-5 parenthetical (always-succeeds verification, Duo-code refusal) matches shipped `src/mcp-server.ts` behavior and the Spec 01 persona text.
- [ ] **R19 finalization log.** Append to the email's §2 a subsection headed exactly `### Finalization log (Spec 06 R19)` with one line per table row (all 8): `row N → checked against <file path or "live call YYYY-MM-DD"> → changed/unchanged (+ one-clause reason when changed)`. Rows 2 and 8 will read "changed".
- [ ] **R20 declaration.** Update the email header's "Placeholders to fill before sending" line (currently line 6) to declare the three tokens as *execution-time human inputs, substituted at LAUNCH-CHECKLIST §1 gate 6* — do NOT invent values, do NOT substitute yet. Update the `Status:` header line from `Draft for review` to `Finalized (Spec 06) — awaiting R20 inputs + send gate`.
- [ ] **R21 invariant diff.** `git diff docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` — confirm the four recorded honesty invariants are byte-identical to pre-edit (A8) and that every crisis/real number still matches G3/G12 formatting exactly. No new phone numbers introduced anywhere in the diff.
- [ ] **Email grep battery** (A6 partial; A5 completes in Phase 3):
  - `grep -c "tells you something real about what a language model does" docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` → `0`
  - `grep -c "No clock tool exists" docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` → `0`
  - `grep -n "get_current_time" docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` → hits in item 6
  - `grep -n "\[SIMULATED\]" docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` → still present (honesty tags survive)
  - `grep -n "no text will ever arrive\|no message is ever sent" docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` → ≥ 1 hit

### Phase 2 — LAUNCH-CHECKLIST.md (agent-only)

- [ ] Create `docs/demo/LAUNCH-CHECKLIST.md` with exactly the R22 gate structure — numbered sections in execution order §1→§8, every gate a checkbox line with an owner tag (`HUMAN` or `AGENT`) and a pass condition. Content per requirement (the spec carries the full wording — implement each section from its requirement; do not thin it):
  - **§1 Pre-send build gates** — the seven gates of Spec 06 R23, verbatim conditions: (1) full vitest suite green, count ≥ the pre-demo baseline of 356 with new tool/corpus tests included (actual count from `docs/demo/plans/LEDGER.md`); (2) all demo-spec acceptance signed off, no failed experiment left deployed (G7); (3) knowledge-tool measured p50 `toolTotalMs < 1500` ms from E4 data — write the actual measured number and its `docs/measurements/<dir>` path into the gate line; (4) ARCHITECTURE.md + MCP-SERVER-DEEP-DIVE.md committed, placeholder grep clean; (5) configured voice confirmed applied via a `session-updated.raw` log line (`marin`, or `alloy` if the Spec 05 R7 fallback flip was taken — read which from the demo ledger's E3 row); (6) the three R20 inputs supplied by the human and substituted; (7) email finalization log present.
  - **§2 Smoke-test call script** — the 9 items of Spec 06 R24 transcribed in full (each: scripted utterance → expected behavior → post-call log check), against `+1 (661) 490-9364`, within 24 h before send, after the final deploy. Include R24's pass rule verbatim (all nine on a single call; two calls permitted if the first exceeds ~5 min; any failure blocks the send → fix → redeploy → rerun the full script). Item 2's log check is `tool-call` for `ask_campus_knowledge` with `toolTotalMs < 1500`; item 5 expects spoken **Pacific campus time** (D5); item 8 expects `status:'not_found'`; item 9 expects one `stream-stop`, zero `@level:error`, one `tool-call` line per exercised tool. Owner: call = HUMAN, log checks = AGENT.
  - **§3 Send** — HUMAN sends the email (outside this repo); record `T0` on the labeled fill-in line, written exactly as: `T0 (send timestamp, ISO 8601 with offset): ____________` — a labeled blank line, NOT a bracket token (Spec 06 A2/R22; the checklist's only permitted blank, G13).
  - **§4 Deploy freeze** — Spec 06 R25 §4 in full: T0 → T0+24 h no push to `main`, no Railway variable change (either redeploys; every redeploy severs in-flight calls); sole exception safety-critical defects (crisis-path misbehavior, call-killing bug, credential exposure) — fix immediately, note in checklist; after 24 h deploys batched ≤ 1/day, low-traffic hours, after confirming no call in flight (Railway logs: no `stream-start` in the last 30 min without a matching `stream-stop`). Include the master plan §9 issue-22 human question as a checkbox: `HUMAN — "Keep the T0+24 h hard freeze and ≤ 1/day batching, or set different windows?" — answer recorded as a demo-ledger row; if changed, this section is edited before the send.`
  - **§5 Log-extraction cadence** — Spec 06 R25 §5: extract at least every **72 h** while the pilot line is up (Railway Hobby retains 7 days — `docs/measurements/README.md:11`); destination `docs/measurements/<YYYY-MM-DD>-pilot/`; run `node scripts/aggregate-latency.mjs` over each extract and `node scripts/aggregate-latency.mjs --knowledge` over the knowledge lines; queries: the Spec 08 R14 set plus `@event:tool-call`, `@event:knowledge-call` (→ `knowledge.jsonl`, D2), and `@level:error OR @event:gateway-close`.
  - **§6 Corpus updates** — reference `docs/demo/CORPUS-UPDATE-GUIDE.md`, never duplicate it: edit `assets/csub-corpus.md` → push → Railway auto-deploy (~2 min) → live next call; corpus pushes follow the §4 batching rule; the SIMULATED-DATA banner and 12-section structure must never be altered from the checklist path (Spec 04 ownership).
  - **§7 Rollback** — Spec 06 R26's two levers in order: (1) Railway dashboard → service → Deployments → redeploy the previous successful deployment (immediate; a deploy failing its healthcheck never takes traffic); (2) `git revert` the offending commit on `main` and push — **never leave `main` ahead of the deployment you rolled back to**.
  - **§8 Incident triggers** (any → execute §7): RIO answers campus facts from memory / breaks the fake-data seal; crisis path fails to speak the real resource numbers; repeated call-killing errors (`fallback-played` or `mint-failed` spikes); knowledge-tool p95 `toolTotalMs` regressing past the Spec 05 gate on live traffic.
  - **Appendix — smoke-script honesty mapping (A10):** a 9-row table `item → tool/feature exercised → source file` proving every scripted utterance maps to a registered tool or shipped behavior (e.g. item 2 → `ask_campus_knowledge` → `src/mcp-server.ts` + `src/knowledge.ts`; item 5 → `get_current_time` → `src/mcp-server.ts`; item 3 → barge-in → `src/bargein.ts`). Dry-run this mapping against the shipped registrations before writing it down.
- [ ] **Checklist grep battery** (A2): `grep -nE 'TBD|TODO|XXX|\[[A-Z][A-Z /]+\]' docs/demo/LAUNCH-CHECKLIST.md` → no output. Crisis-number spot check: any G3 number appearing in the checklist matches byte-exactly.
- [ ] Pre-check §1 gates the agent can already discharge and tick them (gates 1–5, 7 — evidence noted inline per gate); leave gate 6 and all of §2–§3 unchecked for the human.
- [ ] **Commit 1:**
  ```
  docs(demo): finalize RIO announcement email (R17/D5, R18, R19, R21) and add LAUNCH-CHECKLIST

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```
  Confirm `git show --stat HEAD` lists only `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` and `docs/demo/LAUNCH-CHECKLIST.md`.

### Phase 3 — R20 inputs (human-gated; NEVER invent values)

- [ ] If the dispatch prompt (or a ledger note from the orchestrator) already carries the human-supplied values for `[SENDER NAME/TITLE]`, `[FEEDBACK CHANNEL]`, `[PILOT END DATE]`: substitute all three into the email body AND rewrite the header "Placeholders" line so no bracketed form of the three tokens survives anywhere in the file (the header line currently repeats them — A5's grep scans the whole file). Tick §1 gate 6. Otherwise: **skip substitution entirely**, leave the three tokens bracketed (permitted by G13 until supplied), and report status `READY-EXCEPT-HUMAN-INPUTS`.
- [ ] After substitution only — **A5 grep:** `grep -nE '\[(SENDER NAME/TITLE|FEEDBACK CHANNEL|PILOT END DATE)\]' docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` → no output; `grep -n '\[NAME\]' docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` → still present (mail-merge field); `[SIMULATED]` tags still present. The only bracketed tokens remaining in §1 are `[NAME]` and `[SIMULATED]` (R20).
- [ ] After substitution only — **Commit 2:**
  ```
  docs(demo): substitute R20 launch inputs (human-supplied) — email ready to send

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Verify (run before reporting, regardless of phase reached)

- [ ] `npx vitest run` → full suite green, zero skips introduced, count strictly > 356 and equal to the count recorded in `docs/demo/plans/LEDGER.md` (this task adds no tests). KF-1 rule (master plan §8.2): if the ONLY failures are the two `test/harness.test.ts` barge-in tests, run `npx vitest run test/harness.test.ts` — green in isolation passes the gate; note it in the report. Any other failure blocks completion.
- [ ] `npx tsc --noEmit` → clean (docs-only task; any error means the tree was dirty — stop and report).
- [ ] Targeted checks for this task = the two grep batteries above (email + checklist) rerun clean, plus: `git log --stat` for this task's commit(s) touches only the two declared files.

## Handoff — the ready-to-send package (terminal state of this plan)

The plan ends when the completion report hands the human (H3) this package; **the human sends the email**:

1. `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` — finalized; §1 is the send text (subject option 1 recommended per its §2 R2). If Phase 3 ran: fully substituted; else: the three values the human must supply, listed verbatim.
2. `docs/demo/LAUNCH-CHECKLIST.md` — §1 gates 1–5, 7 pre-checked with evidence; remaining human actions in order: supply/confirm R20 inputs (gate 6) → answer the §4 freeze-window question → run the §2 smoke-test call within 24 h before send → send → record `T0` on the §3 line → freeze per §4 → first pilot extraction scheduled within 72 h (§5).
3. Pointer: after the send, the orchestrator flips the demo ledger's Current state to `LAUNCHED` (master plan §6 Wave DD; not this task's edit).

## Acceptance

Discharges Spec 06 **A2 (checklist half), A5, A6, A7, A8, A9, A10** and master plan **A7** up to the human-action boundary. Leaves for the human/orchestrator: the smoke-test call, the send, T0, the freeze decision, the ledger `LAUNCHED` flip.

## Completion Report

```
Task: D06.3 — email finalization + LAUNCH-CHECKLIST + launch package
Status: <complete | READY-EXCEPT-HUMAN-INPUTS | blocked: reason>
E4 gate: PASS row cited from docs/measurements/EXPERIMENTS.md (<dir>, measured knowledge p50 = <n> ms)
Files changed: docs/demo/RIO-ANNOUNCEMENT-EMAIL.md, docs/demo/LAUNCH-CHECKLIST.md
Commands run: <cmd → outcome, one line each — include both grep batteries>
Spec 06 acceptance: A2 <p/f>, A5 <p | pending inputs>, A6 <p/f>, A7 <p/f>, A8 <p/f>, A9 <p/f>, A10 <p/f>
R19 finalization log: 8/8 rows recorded; rows changed: <list>
Honesty invariants (R21/A8): unweakened — diff reviewed
Outstanding human actions (H3): <ordered list from the Handoff section>
Deviations from plan: <none | list>
Notes for ledger: <≤3 lines>
```

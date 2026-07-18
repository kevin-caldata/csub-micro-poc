# T09.5 — `docs/RUNBOOK.md` operational runbook

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Write the complete operational runbook — human console setup (Railway + Twilio), the deploy-between-calls rule, Log Explorer usage, the 7-day extraction rule, incident quick-reference, local-dev/ngrok loop, and the cost-tracking procedure — so every human/console step of this project is executable from one document.

**Wave:** D · **Depends on:** T01, T02, T08, T09.3, T09.4 · **Blocks:** T10 (M1–M5 all execute console/live steps via this runbook)

**References:**
- `docs/specs/09-deployment-and-operations.md` — R2 (Railpack facts to restate as operator constraints: R2.3 Dockerfile ban, R2.6 PORT rule, R2.8 boot-log region proof, R2.10 no sleepApplication), R3 (sealed variables R3.1–R3.4), R4 (GitHub auto-deploy sequence + R4.1 no watchPatterns), R5 (deploy lifecycle + R5.2 operating rule + R5.5 WS-idle non-issue), R6.5/R6.6 (fallback triggers + S23 gate, for the incident section), R7 (Twilio console checklist incl. C16/S20 qualifier and statusCallback/31920 note), R8 (.env summary + host-resolution rule R8.3), R9 (ngrok loop + G5 smoke test + R9.4 latency validity), R10 (cost procedure), R11 (the five mandatory sections — the content authority), A2/A3/A6/A7/A8/A9
- `docs/findings/07-railway-deployment.md` — §12 (Log Explorer syntax + 500 lines/s), §14 (sealed vars), §Implementation "Deploy pipeline" and "Structured log line contract", gotchas 1–14
- `docs/findings/03-twilio-media-streams.md` — claim 14 / §Impl E (statusCallback + error 31920), gotcha 10 (trial restrictions), gotcha 13 (ngrok signature caveat)
- `docs/specs/02-http-server-and-twiml-webhook.md` — Deliverables (`/stream-status` route, drain behavior the checklists reference), A6 (stream-status log shape)
- `docs/specs/08-logging-and-latency-instrumentation.md` — event vocabulary the Log Explorer cheat-sheet cites (`stream-start`, `stream-stop`, `turn`, `fallback-played`) and `docs/measurements/` extraction target
- `plans/09-deployment-ops/03-fallback-helper.md` §Interfaces (fallback behavior for the incident section) · `plans/09-deployment-ops/04-check-credits.md` §Interfaces (script invocation for the cost section)

## Interfaces

**Consumes:** interfaces of T09.3 (`playFallbackAndClose` behavior + `fallback-played` event) and T09.4 (check-credits invocation line); Spec 02's `/stream-status` route; Spec 08's log event names.

**Produces:**
- `docs/RUNBOOK.md` — the document T10's M1–M5 procedures and every human operator execute from. No code interfaces.

## Steps

- [ ] Write `docs/RUNBOOK.md` with exactly these top-level sections, sourcing content from the cited spec requirements (do not invent platform facts — every operational claim in the runbook must trace to Spec 09 or findings/07/03; carry the S-number wherever a claim is a spike):
  1. **One-time setup checklist (executable order — Spec 09 R11.5):** Twilio account upgrade + Business Profile check (R7.1 with the C16/S20 qualifier verbatim-in-substance) → buy US local number (R7.2) → record `TWILIO_AUTH_TOKEN` to password manager (R7.3) → push repo to GitHub → Railway New Project → Deploy from GitHub repo, branch `main`, PR-envs/Wait-for-CI off (R4 steps 1–3) → Generate Domain (R4.4) → set + SEAL variables (R3: full variable list, seal-is-irreversible warning, password-manager-first rule, sealed-vars-unavailable-to-`railway run`/`railway variables` so local dev uses `.env` — R3.1/R3.2) → first deploy + boot-log check (`region: us-east4-eqdc4a`, commit SHA, deploymentId — R2.8) → Twilio number Voice webhook `https://<RAILWAY_PUBLIC_DOMAIN>/twiml` POST (R7.4) → M1 smoke call. Include the standing prohibitions as a "never do" box: no Dockerfile (R2.3), no manual PORT variable (R2.6), no watchPatterns (R4.1), no sleepApplication (R2.10), no WS keepalives-for-Railway (R5.5 — WS is exempt from all idle limits, C6).
  2. **Deploy-between-calls checklist (R11.3):** the five numbered steps exactly as in Spec 09 R11.3, plus the R5.1 lifecycle summary (overlap 10 s → SIGTERM → 60 s drain → SIGKILL; default grace 0 s), the R5.2 operating rule stated as absolute ("every deploy and every variable change is call-fatal"), and the S25/S28 caveats.
  3. **Reading Log Explorer (R11.1):** structured-line contract (one minified JSON/line, `message` + string `level`, flat top-level keys), filter cheat-sheet verbatim from R11.1 (`@callSid:CAxxxx`, `@level:error`, `@event:first-audio-delta AND @callSid:CAxxxx`, `-@event:media`, `replica:<id>`), 500 lines/s/replica cap + per-event-never-per-frame rule, and the S33 first-deployed-build verification step (verify `@callSid:`/`@event:` filters return results BEFORE any measurement session counts) with a fill-in result line.
  4. **The 7-day extraction rule (R11.2):** Hobby retention 7 days; same-day (hard 72 h) extraction of milestone log lines into `docs/measurements/` per Spec 08's procedure; state plainly that data left only in Railway WILL be lost (R-8).
  5. **Incident quick-reference (R11.4):** the three rows from Spec 09 R11.4 (gateway death → apology + `fallback-played`, gated on S23 with clean-hangup degradation per R6.6; webhook 403 → `PUBLIC_HOST`/`RAILWAY_PUBLIC_DOMAIN` vs console URL, R8.3; stream never starts → `/stream-status` logs, error 31920, S19). Add the R6.5 trigger list so operators know which failures route to the fallback.
  6. **Local dev loop (R8/R9):** `.env` summary block from R8.1 (marked as non-normative copy — Spec 01 R8 owns `.env.example`), the `tsx watch --env-file=.env` loader note (R8.2), the ngrok flow (R9.1), the mandatory 10-minute G5 WS smoke test with pass/fail fill-in and Railway-only fallback (R9.2), the ngrok-signature note (R9.3), and the rule "latency numbers are only valid from Railway" (R9.4).
  7. **Cost tracking (R10):** before/after each test batch run `npx tsx --env-file=.env scripts/check-credits.ts` and record the delta (R10.1/R10.2, T09.4's contract); first-billed-call dashboard inspection resolving S30/S31 (+ optional S32 tag note, R10.4); Railway usage check at M4 vs ~$3/mo prediction (S27, R10.3); `/v1/report` is 403 on Hobby — credits-delta is the fallback proof.
  8. **Spike/verification ledger:** a short fill-in table for the spikes this runbook's procedures resolve — S19, S20, S23, S25, S27, S30, S31, S32, S33 — columns: spike, procedure section, result (blank), date (blank). T10 fills it during milestones.
- [ ] Verify required content is present — run:
  `node -e "const t=require('fs').readFileSync('docs/RUNBOOK.md','utf8');const req=['@callSid:','@event:','7 day','Seal','railway run','deploy between','us-east4-eqdc4a','stream-status','31920','500','Business Profile','ngrok','check-credits','Dockerfile','watchPatterns','sleepApplication','overlapSeconds','drainingSeconds','fallback-played','S23','S25','S33','docs/measurements'];const m=req.filter(s=>!t.includes(s));if(m.length){console.error('MISSING:',m);process.exit(1)}console.log('RUNBOOK OK')"`
  — expect `RUNBOOK OK`, exit 0. (Adjust casing in the RUNBOOK, not the check, if a literal is missing.)
- [ ] Cross-check every S-number and R-number cited in the runbook against `docs/specs/09-deployment-and-operations.md` (no invented references), and confirm no requirement text contradicts Spec 09 (Spec 09 is authority; the runbook paraphrases, it never overrides).
- [ ] Commit with message:
  `docs(ops): operational runbook - setup, deploy rule, log explorer, extraction, incidents, costs (Spec 09 R11)`
  including trailer line `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

- Spec 09 **A9** — document half: all five R11 sections present (the live S33 filter verification is executed at first deploy via section 3's checklist and recorded in the ledger).
- Spec 09 **A2, A3, A6, A7, A8** — procedure halves: the runbook contains the executable console/live procedures that T10 (and the human operator) run to discharge these at M1/M4/M5; this task delivers the procedures, not the live results.

## Completion Report

```
Task: T09.5 — operational runbook
Status: <done | blocked: reason>
Files changed: docs/RUNBOOK.md
Commands run: content-check node one-liner → <RUNBOOK OK | missing list>
Spec acceptance verified: 09-A9 (doc half); procedures for A2/A3/A6/A7/A8 delivered
Deviations from plan: <none | ...>
New interfaces exposed: none (document; spike ledger table for T10 to fill)
Ledger notes: <1-2 lines>
```

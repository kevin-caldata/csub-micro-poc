# T10.8 — Milestone execution M1–M5 (HUMAN-IN-THE-LOOP)

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Execute the ordered M1–M5 procedures against the DEPLOYED Railway service — live calls by a human operator, agent-driven scripts/log-extraction/README recording — filling the Spike Results and M5 Findings Report to Spec 10 A7–A12.

**Wave:** E (terminal) · **Depends on:** T10.1, T10.2, T10.3, T10.4, T10.5, T10.6, T10.7, T09 · **Blocks:** none (project sign-off)

**⚠ This task cannot run unattended.** It requires: the service deployed on Railway (T09), a configured Twilio number, a human with a phone + Twilio/Vercel/Railway console access, and 3–5 human callers for one M4 session. The agent's role: run scripts, watch/extract logs, compute aggregates, and record every result in README in R14 format. Pause and ask the operator at every step marked **[HUMAN]**.

**References:**
- `docs/specs/10-testing-spikes-and-milestones.md` — R13 (preconditions), R14 (recording format), R15 (M1-01…M1-12 — execute top to bottom), R16 (M2), R17 (M3), R18–R24 (M4), R25–R27 (M5) — **this spec section list IS the procedure; do not paraphrase it, open it and follow it**
- `docs/specs/00-master-build-plan.md` — §5 milestone mapping, §7 spike register
- `docs/RUNBOOK.md` (T09) — deploy-between-calls rule, Log Explorer cheat-sheet, extraction rule
- `docs/measurements/README.md` (T08) — extraction procedure + `docs/measurements/<YYYY-MM-DD>-<label>/` naming convention (Spec 08 R14)
- `docs/specs/08-logging-and-latency-instrumentation.md` — aggregation usage
- `docs/specs/06-audio-dsp-transcoding.md` — R13 Path A/B decision procedure (M1 verdict)

## Interfaces

**Consumes:** deployed service URL (`RAILWAY_PUBLIC_DOMAIN`); `scripts/concurrency-probe.ts` (T10.7); `scripts/check-credits.ts` (T09); `scripts/aggregate-latency.mjs` (T08); README skeletons (T10.7).

**Produces:**
- `README.md` — `## Spike Results` entries (R14 format) for every executed item; `## Findings Report (M5)` fully filled per R26 incl. the 35-row table per R27.
- `docs/measurements/<YYYY-MM-DD>-<label>/*.jsonl` — raw extracted `@event:turn` + `@event:stream-stop` lines per milestone session (A12).
- Possible env-only config changes on Railway (`AUDIO_MODE`, `VOICE`, `MODEL_ID` fallbacks) — recorded, not committed as code; the one code change M3 makes is the FR-5 add-a-tool commit to `src/mcp-server.ts` only.

## Steps

- [ ] **[HUMAN] Preconditions (R13):** confirm Twilio account upgraded/non-trial with approved Business Profile (**S20**), number webhook → `https://<domain>/twiml`, `statusCallback` → `/stream-status`, and the deployed build logs the R13 verbatim list (`session-updated.raw`, `error.raw`, `custom.rawType`, close codes both legs, `unexpected-response`, `getTokenMs`/`expiresAt`). Record S20 in README.
- [ ] **M1 (R15, items M1-01 → M1-12, in order):** run each item's procedure, capture the named evidence, and write its R14-format entry into `## Spike Results` immediately (not batched). Items needing calls are **[HUMAN]**; M1-01 (getToken smoke), M1-08 close-code probes (b)/(c), and log inspection are agent-runnable. Apply the M1-03 fallback ladder one variable at a time via Railway env only. After M1-02, update `test/fakes/fake-gateway.ts`'s `session-updated.raw` fixture to the observed shape (Spec 10 §Open items, S5) and commit.
- [ ] **M1 exit gate:** README records at minimum S1, S4, S7, S8; flip `AUDIO_MODE` on Railway to the winning path per Spec 06 R13. Extract logs → `docs/measurements/<date>-m1/`. Commit: `docs(measurements): M1 spike results and log extracts`.
- [ ] **[HUMAN] M2 (R16.1–R16.6):** ≥2 calls with ≥3 barge-ins each incl. one on turn ≥3 (live stale-epoch check); "what did you just say?" probe (S9); FR-2 two-layer evidence (server Δ<50 ms from logs; speakerphone waveform <500 ms measured by the operator in Audacity); verify transcripts + `turn` lines; run the three S33 Log Explorer queries and record results; same-day extraction → `docs/measurements/<date>-m2/`. Commit.
- [ ] **M3 (R17.1–R17.4):** [HUMAN] tool calls ("what time is it" ×≥5 across 2 calls, p50 of `toolTotalMs` < 1500); FR-5 add-a-tool: agent adds one `registerTool` block (`get_fun_fact`) to `src/mcp-server.ts` ONLY, commits `feat(mcp): add get_fun_fact tool (FR-5 diff test)`, pushes, records push→live minutes (feeds R24/FR-8); [HUMAN] verifies on next call; tool-failure resilience via temporary `always_fails` (add, test, remove, each a commit); harvest S11/S12 error strings into the README whitelist notes. Extraction → `docs/measurements/<date>-m3/`. Commit.
- [ ] **M4 (R18–R24):** agent runs `npm run probe:concurrency` against the live gateway → record S24 number + locus + rejection code (also file with Vercel support per R20); **[HUMAN]** 3–5 parallel callers with keyword script (R18 Option A; Option B via twilio CLI if staffing fails) → agent greps extracted logs for R19 cross-talk assertion; **[HUMAN]** FR-7 rejection call while probe holds the limit (R21); **[HUMAN]** deploy-mid-call probe (R22, S25); agent compares `loopP99Ms`/`bridgeMs` vs M2 baseline (R23, S26) + Railway usage snapshot (S27); record FR-8 timing (R24). Extraction → `docs/measurements/<date>-m4/`. Commit.
- [ ] **M5 (R25–R27):** agent runs `npm run aggregate -- docs/measurements/**/*.jsonl` (offline only — never percentile-of-percentiles) and fills every R26 section: headline table, honest voice-to-voice estimate (R26 §2 phrasing), Path A/B verdict with `session-updated.raw` excerpts, concurrency section, cost section from `scripts/check-credits.ts` before/after deltas (S30) → $/call-minute, and the complete 35-row spike table with R27 classification honored (accepted-risk rows say why). Cross-check: every must-answer S-number per R27 has a non-empty Answer + Evidence cell.
- [ ] Final verify: `npm test` green; README sections complete; every milestone has a `docs/measurements/` extract. Commit: `docs(report): M5 findings report, spike answer table, and measurement extracts` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (use the same trailer on every commit above).

## Acceptance

Discharges Spec 10 **A7** (M1 + Spike Results entries + AUDIO_MODE verdict), **A8** (M2/FR-2 both layers + S9 + S33), **A9** (M3/FR-4/FR-5), **A10** (M4/FR-3/FR-7/FR-8 + S24/S25/S26), **A11** (M5 report + 35-row table + $/call-minute), **A12** (per-session log extraction committed under `docs/measurements/`).

## Completion Report

```
Task: T10.8 — Status: DONE | PARTIAL(<milestones done>) | BLOCKED(<why>)
Milestones executed: M1[ ] M2[ ] M3[ ] M4[ ] M5[ ]
Files changed: <list>
Key numbers: ttfb p50/p95=<>, toolTotal p50=<>, S24 ceiling=<>, $/call-min=<>
AUDIO_MODE verdict: <pcmu | transcode>; fallbacks applied: <model/voice/none>
Spec A-numbers verified: <subset of A7–A12>
Deviations from plan: <none | list>
Notes for ledger: <1-2 lines>
```

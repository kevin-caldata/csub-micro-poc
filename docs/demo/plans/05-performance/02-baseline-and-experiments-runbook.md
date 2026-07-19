# DC1 — Baseline session + experiments E1–E6 runbook (Demo Spec 05)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Execute Demo Spec 05 end-to-end against the live demo line **+1 (661) 490-9364**: pre-register experiments E1–E6 in `docs/measurements/EXPERIMENTS.md`, run the R2 baseline session, then each experiment in the R11 order, evaluate every numeric gate, record every verdict (EXPERIMENTS.md row + demo ledger; S1/S8 spike answers in BOTH ledgers), and revert every FAIL same-day — so that at freeze time the configuration of record is derivable from the ledger alone and the E4 PASS row has released the announcement email.

All Global Constraints in `docs/demo/specs/00-master-demo-plan.md` §G bind every step of this plan. Restated where they bite here: **G2** single model, no fallback — a latency FAIL is never fixed by a model swap; **G6** latency gates (`toolTotalMs` p50 < 1500 incl. `ask_campus_knowledge`); **G7** experiment revert rule — the live line never regresses; one flipped variable at a time; **G9/A11** this task changes **zero** `src/` or `test/` files — every commit touches only `docs/measurements/**`, `docs/demo/plans/LEDGER.md`, and the base `plans/LEDGER.md` spike rows; **G4** `test/gateway.session-config.test.ts:100-102,:124-128` (preamble assertions) are untouched.

**THIS IS A HUMAN-IN-THE-LOOP RUNBOOK, not a code task.** Each step is tagged:
- **[HUMAN]** — phone in hand, Railway/Vercel dashboard access (queue item H2, master plan §6). An agent CANNOT do these.
- **[AGENT]** — file edits, aggregation commands, gate arithmetic, commits. Runnable by a dispatched sub-agent between human sessions.
- **[HUMAN+AGENT]** — human produces the raw material (calls, exported logs, dashboard numbers); agent lands, aggregates, and records.

**Wave:** DC (task DC1) · **Depends on:** merge point **M-B** (Wave DB deployed + H1 first-call check recorded in the demo ledger) and the DA3 aggregator `--knowledge` mode · **Blocks:** M-C → Wave DD (the email cannot be sent before the E4 row reads PASS — Spec 05 A7, master plan A6)

**References (read before starting):**
- `docs/demo/specs/05-performance-optimization.md` — R1–R12, A1–A11 (the requirement authority for every gate number, procedure, and revert value in this plan)
- `docs/demo/specs/00-master-demo-plan.md` — §3 G6/G7, §6 Wave DC + H2, §7 spikes DS-1…DS-5, §9 items 17/18
- `docs/measurements/README.md` — Extraction procedure steps 1–3; S33 checklist (lines 84–101); Honest accounting + mandatory phrasing (lines 117–141); n<20 p95 caveat
- `scripts/aggregate-latency.mjs` — usage `:13-14`, metric lists `:26-27`, `wantEvent` selection `:119` (post-DA3 the file also has `KNOWLEDGE_METRICS` and `--knowledge`; line numbers may have shifted — DA3's plan/commit is authoritative)
- `src/config.ts:16-19` — `AUDIO_MODE` (default `transcode`), `VOICE` (default `marin`), `VOICE_FALLBACK` (default `alloy`), `VAD_SILENCE_MS` (default `500`)
- `plans/LEDGER.md:136` — base Spike Answer Register; row S1 at `:142`, row S8 at `:149` (fill the Answer column only, never reformat — `plans/README.md` §4)

## Files

**Create:**
- `docs/measurements/<YYYY-MM-DD>-demo-baseline/` — 7 JSONL exports + `notes.md` (R2/A2)
- `docs/measurements/<YYYY-MM-DD>-e4-knowledge/` — E4+E5 session (R8/R9/A6/A8)
- `docs/measurements/<YYYY-MM-DD>-e1-pcmu/` — E1 session (R5/A3)
- `docs/measurements/<YYYY-MM-DD>-e2-vad400/` — E2 session (R6/A4)
- `docs/measurements/<YYYY-MM-DD>-pre-freeze/` — final E6 read-out, ONLY if the last experiment session cannot double as it (R10/R11.5/A9)

**Modify:**
- `docs/measurements/EXPERIMENTS.md` — the experiment ledger (Spec 05 R12). DA3 created the scaffold (title, intro, empty R12 run table — pre-declared deviation PD-06); this task APPENDS the E1–E6 pre-registration subsections and every run-table row. Never recreate or rewrite the scaffold.
- `docs/demo/plans/LEDGER.md` — experiment-verdict lines appended under the Wave DC table (one line per E1–E6 verdict, plus the E4 `knowledgeMs` p50/p95 pair marked "consumed by Spec 01 preamble"); DS-1…DS-5 answers; never reformat existing rows
- `plans/LEDGER.md` — Answer column of Spike Answer Register rows **S1** (`:142`, from E1) and **S8** (`:149`, from E3) ONLY — master plan R2.3's "both ledgers" rule; touch nothing else in the base ledger

**Test files:** none. This task ships no code. Verification is command-based (Verify tail).

E3 needs no directory of its own: its evidence (`session-updated.raw`) comes out of the baseline extraction's `session-config.jsonl` (R7 needs one call's worth).

## Interfaces

**Consumes:**
- `scripts/aggregate-latency.mjs` `--knowledge` flag + `KNOWLEDGE_METRICS = ['knowledgeMs']`, event filter `'knowledge-call'` (DA3, Spec 05 R4, master plan D2); existing `--tools` and default turn modes
- `knowledge-call` log line fields from Spec 03 R12: `status`, `topic?`, `knowledgeMs`, `inputTokens?`, `outputTokens?`, `cachedInputTokens?`, `reasoningTokens?`, `modelId`, `errName?` (master plan §4 Log events, D11)
- Existing log events/fields per Spec 05 R3a: `turn` (`ttfbMs`, `bridgeMs`, `turnMs`, `playbackConfirmMs`, `bargedIn`), `tool-call` (`mcpMs`, `gateWaitMs`, `secondTtfbMs`, `toolTotalMs`, `isError`), `greeting` (7 fields), `session-updated` (`.raw`)
- Railway env keys: `AUDIO_MODE`, `VAD_SILENCE_MS`, `VOICE`, `VOICE_FALLBACK` (`src/config.ts:16-19`); Spec 03 keys `MCP_MODEL_ID=google/gemini-3.1-flash-lite`, `MCP_MODEL_MAX_TOKENS=150`, `MCP_TOOL_TIMEOUT_MS=3500`
- The live line +1 (661) 490-9364; Railway Log Explorer; Vercel AI Gateway usage dashboard (E5 evidence class 1)

**Produces:**
- `docs/measurements/EXPERIMENTS.md` — R12 ledger; configuration of record derivable from it alone
- E4 `knowledgeMs` p50/p95 pair → Demo Spec 01 (preamble length) and Demo Spec 06 (email release gate, M-C)
- S1 answer (E1) and S8 answer (E3) → demo ledger + base `plans/LEDGER.md` Spike Answer Register (= spikes DS-2/DS-1); DS-3/DS-4/DS-5 answers → demo ledger
- E6 numbers → Demo Spec 06 (any latency claim in email/docs must match these)

## Steps

### Phase 0 — preflight (no calls yet)

- [ ] **[AGENT]** Confirm M-B in `docs/demo/plans/LEDGER.md`: Wave DB rows `OK`, deploy noted, H1 (first live call, Spec 01 A8 checks) recorded. If H1 is missing, STOP and return blocked — no measurement session before H1.
- [ ] **[AGENT]** Confirm the S33 Log Explorer checklist in `docs/measurements/README.md` (lines 90–96) is dated. Per README: "No M2+ measurement session is valid before this checklist is dated." If any item is undated, queue it into the baseline session's first call (the human dates it there) — items 1–7 take ~5 minutes against live logs.
- [ ] **[AGENT]** Smoke the DA3 aggregator extension: write a 4-line fixture (three lines of the form `{"event":"knowledge-call","knowledgeMs":<n>}` with n = 100, 200, 300, plus one line `not json`) to a scratch file and run `node scripts/aggregate-latency.mjs --knowledge <scratch-file>`. Expected: `Skipped: 1 non-JSON line(s).` and a markdown table with a `knowledgeMs` row, p50 = 200, n = 3 (Spec 05 A1). Also run `node scripts/aggregate-latency.mjs --tools --knowledge <scratch-file>` → usage line, exit code 1. If either fails, STOP: DA3 is broken; return blocked naming the failing command.
- [ ] **[HUMAN]** Railway dashboard → service → Variables: confirm the R2 defaults are the live config — `AUDIO_MODE=transcode`, `VAD_SILENCE_MS=500`, `VOICE=marin`, `MCP_MODEL_ID=google/gemini-3.1-flash-lite`, `MCP_MODEL_MAX_TOKENS=150`, `MCP_TOOL_TIMEOUT_MS=3500` (unset variable = code default from `src/config.ts` / Spec 03, which is equivalent — note which in the baseline `notes.md`). Record the deploy SHA (`RAILWAY_GIT_COMMIT_SHA` from the boot log or dashboard).

### Phase 1 — pre-register the experiments (Spec 05 R1: written BEFORE anything runs)

- [ ] **[AGENT]** Extend `docs/measurements/EXPERIMENTS.md` (the DA3 scaffold — do not recreate the file; append below the scaffold's intro):
  - Confirm the DA3 scaffold is present as left (title `# EXPERIMENTS — CSUB-RIO Demo Performance Ledger`, intro citing R1/R1a/R1c/R11/R12, the empty R12 run table, the verdict-vocabulary line). If the scaffold is missing, STOP and return blocked — DA3 was mis-accepted (README N5 pattern).
  - One `##` subsection per experiment **E1–E6**, each with exactly the five R1 parts (Hypothesis / Config change / Measurement / Pass gate / Revert rule) — content sourced from Spec 05 **R5, R6, R7, R8, R9, R10** respectively. Copy the gate numbers and revert values exactly as the spec states them (e.g. E1 revert `AUDIO_MODE=transcode`; E2 revert `VAD_SILENCE_MS=500`; E4 gate `toolTotalMs` p50 < 1500 AND `knowledgeMs` p95 ≤ 3000 AND error/timeout share < 10%; E6's three budgets `greetingTotalMs` p50 < 2000, `ttfbMs` p50 ≤ 900, `toolTotalMs` p50 < 1500). Do not paraphrase numbers. E1/E2's subjective gates name procedure and judge count per R1a. E3's Config-change line states "none — verification, not a flip"; E4/E5's state "none — measurement of deployed Spec 03 defaults".
  - The **run table** (R12) already exists header-only in the DA3 scaffold (`date | experiment | variable=value | measurement dir | gate | result (numbers) | verdict | notes`; verdict vocabulary PASS / FAIL+REVERTED / BLOCKED) — leave it empty here; rows are appended as sessions complete in Phases 2–7.
  - The R11 ordering list (baseline → E3 → E4+E5 → E1/E2 one-at-a-time → E6 → freeze) so the ledger itself proves ordering (master plan A6).
- [ ] **[AGENT]** Targeted check (adjust EXPERIMENTS.md, not the check, if a literal is missing):
  `node -e "const t=require('fs').readFileSync('docs/measurements/EXPERIMENTS.md','utf8');const req=['E1','E2','E3','E4','E5','E6','AUDIO_MODE=pcmu','AUDIO_MODE=transcode','VAD_SILENCE_MS=400','VAD_SILENCE_MS=500','marin','knowledge-call','knowledgeMs','toolTotalMs','greetingTotalMs','1500','3000','2000','900','S1','S8','Hypothesis','Revert','FAIL+REVERTED'];const m=req.filter(s=>!t.includes(s));if(m.length){console.error('MISSING:',m);process.exit(1)}console.log('EXPERIMENTS OK')"` → `EXPERIMENTS OK`.
- [ ] **[AGENT]** Commit: `docs(measurements): pre-register experiments E1-E6 in EXPERIMENTS.md (Demo Spec 05 R1/R12)` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

### Phase 2 — R2 baseline session (nothing flips before this exists)

- [ ] **[HUMAN]** Call +1 (661) 490-9364 for the baseline session: **≥ 5 calls, ≥ 25 non-barged turns total, ≥ 10 `ask_campus_knowledge` invocations** (Spec 05 R2). Suggested shape — 5 calls × 6–7 turns each: per call, 2 knowledge questions from Appendix A (cover different sections each call), 1–2 static-tool beats (ask for a transfer/routing, ask the time), and 2–3 plain conversational turns (no tool). Speak naturally; let RIO finish (barged turns lack `ttfbMs` and don't count toward the 25). Note per-call anything anomalous. Record the session's start/end clock time (needed to scope the Log Explorer window and to prove non-overlap, A10).
- [ ] **[HUMAN]** Extract per `docs/measurements/README.md` Extraction procedure step 1, scoped to the session window — the six standard queries **plus the demo-build seventh** (Spec 05 R3, master plan D2):
  - `@event:turn` → `turns.jsonl`
  - `@event:stream-stop` → `summaries.jsonl`
  - `@event:tool-call` → `tools.jsonl`
  - `@event:greeting` → `greetings.jsonl`
  - `@event:session-updated` → `session-config.jsonl`
  - `@level:error OR @event:custom OR @event:gateway-close` → `anomalies.jsonl`
  - **`@event:knowledge-call` → `knowledge.jsonl`**
  Timing: same-day target, **72 h hard deadline** (Railway Hobby retains 7 days; the repo is the durable store).
- [ ] **[HUMAN+AGENT]** Land the seven files in `docs/measurements/<YYYY-MM-DD>-demo-baseline/` (session date) plus `notes.md` with: who called, call count, `AUDIO_MODE`, deploy SHA, anomalies (README step 2) — and the config-of-record variable list from Phase 0.
- [ ] **[AGENT]** Aggregate (pooled raw values only — never percentile-of-percentiles):
  - `node scripts/aggregate-latency.mjs docs/measurements/<dir>/turns.jsonl` → `ttfbMs`/`bridgeMs`/`turnMs`/`playbackConfirmMs` incl. the `bargedIn:false` and `has-ttfbMs` partitions
  - `node scripts/aggregate-latency.mjs --tools docs/measurements/<dir>/tools.jsonl`
  - `node scripts/aggregate-latency.mjs --knowledge docs/measurements/<dir>/knowledge.jsonl`
  - Greeting fields (the aggregator has no greeting mode; this one-liner reimplements its nearest-rank `pct`, `scripts/aggregate-latency.mjs:20-24`, over pooled raw values — same statistical rule). Run with Bash:
    ```
    node -e 'const fs=require("fs");const M=["webhookToStartMs","gatewayOpenMs","sessionUpdateAckMs","greetingTtfbMs","greetingBridgeMs","greetingPlaybackConfirmMs","greetingTotalMs"];const recs=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).flatMap(l=>{try{const o=JSON.parse(l);return o.event==="greeting"?[o]:[]}catch{return[]}});const pct=(v,p)=>{if(!v.length)return;const s=[...v].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.max(0,Math.ceil(p/100*s.length)-1))]};for(const m of M){const v=recs.map(r=>r[m]).filter(x=>typeof x==="number"&&Number.isFinite(x));console.log(m,"p50",pct(v,50),"p95",pct(v,95),"max",v.length?Math.max(...v):undefined,"n",v.length)}' docs/measurements/<dir>/greetings.jsonl
    ```
  Paste all four outputs into `notes.md` with p50/p95/max/n for every R3a metric. Wherever n < 20, state "p95 is effectively the max at this n" and report max + n alongside (README Honest accounting).
- [ ] **[AGENT]** First E6 evaluation, on the baseline (Spec 05 R10): state in `notes.md` — `greetingTotalMs` p50 vs **< 2000 ms** (plus the decomposition fields so a miss is attributable); `ttfbMs` p50 over `bargedIn:false`/`has-ttfbMs` turns vs **≤ 900 ms**, using the mandatory README phrasing ("measured server-side turn core X ms; estimated caller-perceived ≈ X + ~500 ms (VAD window) + ~200–450 ms (PSTN/network legs, unmeasured)"); `toolTotalMs` p50 vs **< 1500 ms** (pooled, incl. knowledge calls). A miss here is not a revert — it opens a named follow-up experiment row or a documented exception (R10 miss handling); the email does not go out with an undocumented E6 miss.
- [ ] **[HUMAN]** Decision point (master plan §9 item 17, non-blocking): *"Given the measured baseline ttfbMs p50, keep 900 ms or re-baseline E6's simple-turn gate to <value>?"* Record the answer as a demo-ledger row; if changed, update the E6 subsection in EXPERIMENTS.md citing that row.
- [ ] **[AGENT]** Add the baseline row to the EXPERIMENTS.md run table (experiment = "R2 baseline", variable = "defaults, no flip", verdict = "n/a — configuration of record"). Commit: `docs(measurements): demo baseline session (Demo Spec 05 R2/A2)` + trailer.

### Phase 3 — E3 voice verification (spike S8 / DS-1) — EARLY, before E4

- [ ] **[HUMAN+AGENT]** No flip (marin is the default). Evidence per Spec 05 R7: read one call's `session-updated` `.raw` from the baseline `session-config.jsonl`; quote the applied-voice fragment in the E3 ledger row. **[HUMAN]**: confirm the call audio was audibly the marin voice, not a silent substitution (one fresh confirmation call is fine if memory is unsure).
- [ ] **[HUMAN if FAIL]** If marin was rejected/substituted: Railway → Variables → set `VOICE=alloy` → Deploy (~2 min; flip only when no call is active — R1b). File the change against Demo Spec 01 as a demo-ledger deviation row (persona copy naming the voice must say alloy). Verdict FAIL+REVERTED-equivalent per R7 ("revert" here is the fallback flip).
- [ ] **[AGENT]** Record the **S8 answer in BOTH ledgers** (master plan R2.3): (a) E3 row in EXPERIMENTS.md + demo-ledger line; (b) base `plans/LEDGER.md:149` S8 Answer column — one sentence with date, applied-voice value quoted from `.raw`, YES/NO. Commit: `docs(measurements): E3 voice verification - S8 answer (Demo Spec 05 R7)` + trailer (base-ledger edit included in this commit).

### Phase 4 — E4 knowledge-latency baseline + piggybacked E5 (DS-3/DS-4/DS-5) — MUST PASS BEFORE THE EMAIL

- [ ] **[HUMAN]** E4 session, no flip (measures deployed Spec 03 defaults): **≥ 20 live `ask_campus_knowledge` questions across ≥ 5 calls**, spanning **≥ 8 of the 12 corpus sections** plus **≥ 3 out-of-corpus questions** (the `not_found` path). Use Appendix A: Q1–Q20 tagged by section, Q21–Q23 out-of-corpus — 4–5 questions per call. **E5 piggyback:** within the same session, re-ask **Q2, Q5, Q9, Q16, Q18** a few minutes after their first ask (≥ 5 repeats, close together — implicit-cache window). Record session start/end times.
- [ ] **[HUMAN+AGENT]** Extract (same seven queries, 72 h hard deadline) into `docs/measurements/<YYYY-MM-DD>-e4-knowledge/` + `notes.md` (README step 2 fields).
- [ ] **[AGENT]** Aggregate and paste into `notes.md` (Spec 05 A6 requires both outputs pasted):
  - `node scripts/aggregate-latency.mjs --tools docs/measurements/<dir>/tools.jsonl`
  - `node scripts/aggregate-latency.mjs --knowledge docs/measurements/<dir>/knowledge.jsonl`
  - Error/timeout share:
    ```
    node -e 'const fs=require("fs");const f=p=>fs.readFileSync(p,"utf8").split("\n").filter(Boolean).flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}});const t=f(process.argv[1]).filter(o=>o.event==="tool-call");const k=f(process.argv[2]).filter(o=>o.event==="knowledge-call");console.log("tool-call n="+t.length+" isError="+t.filter(o=>o.isError===true).length);console.log("knowledge n="+k.length+" statusCounts="+JSON.stringify(k.reduce((a,o)=>(a[o.status]=(a[o.status]||0)+1,a),{})))' docs/measurements/<dir>/tools.jsonl docs/measurements/<dir>/knowledge.jsonl
    ```
  Record p50/p95/max/n for `knowledgeMs`, `toolTotalMs`, `secondTtfbMs`, and the `isError:true`/timeout counts (Spec 05 R8 Measurement).
- [ ] **[AGENT]** Evaluate the E4 gate — ALL of (Spec 05 R8, G6):
  1. `toolTotalMs` p50 **< 1500 ms** (pooled tool-call population, knowledge included — the M3 gate)
  2. `knowledgeMs` p95 **≤ 3000 ms** (500 ms headroom under the 3500 ms abort)
  3. error/timeout share **< 10%** (errors+timeouts ÷ knowledge calls)
  Plus the **DS-3 thinking-passthrough decision rule**, stated in one sentence in `notes.md` (A6): `knowledgeMs` p50 < 1500 ms with < 10% timeouts → "p50 = X ms → passthrough confirmed"; timeout share ≥ 50% or p50 pinned at the 3500 ms ceiling → passthrough NOT working. Secondary corroboration: `reasoningTokens` ≈ 0 on `knowledge-call` lines (D11).
- [ ] **[AGENT] On PASS:** write the E4 row (verdict PASS, the measured numbers) in EXPERIMENTS.md; add the demo-ledger line with the `knowledgeMs` p50/p95 pair marked **"consumed by Spec 01 preamble"** (A6) and the DS-3/DS-4 answers. **This row releases the announcement email (M-C / Spec 05 A7).** Nothing to revert — no flip.
- [ ] **On FAIL:** nothing to revert (no flip). Verdict **BLOCKED** in EXPERIMENTS.md + demo ledger; **the email send is blocked** until Spec 03 is fixed and E4 re-passes. If the DS-3 rule says passthrough is broken: **[AGENT]** return this task blocked, reporting "fix Demo Spec 03 R11 `providerOptions.google.thinkingConfig` syntax (findings/15 claim 12), redeploy, re-run Phase 4" — the code fix belongs to a Spec 03 respin (this task changes no `src/`), then Phase 4 repeats as a new dated session.
- [ ] **[HUMAN+AGENT]** E5 evaluation (non-blocking, Spec 05 R9). Either evidence class suffices:
  1. **[HUMAN]** Vercel dashboard → AI Gateway → usage/observability for `google/gemini-3.1-flash-lite`, session window: nonzero cached-input-token (cache-read) line items → screenshot/numbers into `notes.md`.
  2. **[AGENT]** logged tokens: `cachedInputTokens` ≥ 50% of `inputTokens` on the repeat questions —
     ```
     node -e 'const fs=require("fs");const k=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).flatMap(l=>{try{const o=JSON.parse(l);return o.event==="knowledge-call"?[o]:[]}catch{return[]}});for(const o of k){if(typeof o.inputTokens==="number")console.log("in="+o.inputTokens+" cached="+(o.cachedInputTokens??0)+" share="+(((o.cachedInputTokens??0)/o.inputTokens)*100).toFixed(1)+"% reasoning="+(o.reasoningTokens??0)+" topic="+(o.topic??""))}' docs/measurements/<dir>/knowledge.jsonl
     ```
  PASS → cite the evidence class in the E5 row (A8). FAIL → **no revert, does not block the email**: record FAIL-accepted with the uncached cost fact ~$0.0005/question (DS-5: "record as cost fact, never reverts").
- [ ] **[AGENT]** Commit: `docs(measurements): E4 knowledge latency baseline + E5 cache evidence (Demo Spec 05 R8/R9)` + trailer (includes ledger updates).

*(From here the email may be sent by Wave DD at any time; E1/E2 may run between baseline and freeze — Spec 05 R11.4 — but once the email is out, Phase 7's freeze ends all flipping. Running E1/E2 now, before the send, is the recommended window.)*

### Phase 5 — E1: `AUDIO_MODE=pcmu` (spike S1 / DS-2) — one flip, one session

- [ ] **[HUMAN]** Immediately before the flip, make 3 reference calls in transcode mode (the A/B "A" legs; baseline listening, no logs needed beyond what auto-emits). Then flip: Railway → service → Variables → `AUDIO_MODE=pcmu` → deploy staged change (~2 min redeploy; **flip only when no call is active** — a deploy severs in-flight calls, R1b). Env-only flip leaves `RAILWAY_GIT_COMMIT_SHA` unchanged — record the **deploy ID** in `notes.md` instead (R1b).
- [ ] **[HUMAN]** E1 session in pcmu mode: ≥ 5 calls / ≥ 25 non-barged turns, including the 3 "B" legs for the blind A/B — procedure to record in the ledger row (R1a): **2 listeners, A/B over 3 call pairs, blind to mode** (listeners on speakerphone are not told which calls are which mode; they flag any call that sounds degraded — static, robotic artifacts, level shifts). Record session times.
- [ ] **[HUMAN+AGENT]** Extract (seven queries, 72 h) → `docs/measurements/<YYYY-MM-DD>-e1-pcmu/` + `notes.md`. **Mandatory S1 evidence:** quote in `notes.md` the pcmu-call `session-updated.raw` fragment from `session-config.jsonl`, showing whether `inputAudioFormat`/`outputAudioFormat` echo `{type:'audio/pcmu'}` with **structurally NO `rate` key** (Spec 05 R5; A3).
- [ ] **[AGENT]** Aggregate `node scripts/aggregate-latency.mjs docs/measurements/<dir>/turns.jsonl`; compare pooled `ttfbMs`, `bridgeMs`, `playbackConfirmMs` (`has-ttfbMs` partition) against the R2 baseline. Gate — ALL of (R5): (a) `.raw` confirms pcmu applied; (b) blind A/B reports no degradation; (c) `ttfbMs` p50 ≤ baseline p50 + 50 ms; (d) `bridgeMs` p50 ≤ baseline p50 — (d) missing while (a)–(c) hold is still PASS with a noted null result.
- [ ] **[HUMAN] On any gate FAIL (or gateway rejects/substitutes the format → S1 = NO, Path A dead):** revert **same day**: Railway → Variables → `AUDIO_MODE=transcode` → deploy. Verdict FAIL+REVERTED. **On PASS:** `AUDIO_MODE=pcmu` becomes the configuration of record and the new comparison baseline (R1c); re-evaluate E6 on this session's numbers (R10).
- [ ] **[AGENT]** Record the **S1 answer in BOTH ledgers**: EXPERIMENTS.md E1 row + demo-ledger line, AND base `plans/LEDGER.md:142` S1 Answer column (date, YES/NO, one-line `.raw` evidence). Commit: `docs(measurements): E1 pcmu session - S1 answer (Demo Spec 05 R5)` + trailer.

### Phase 6 — E2: `VAD_SILENCE_MS` 500 → 400 — one flip, one session (never overlapping E1's window)

- [ ] **[HUMAN]** Only after E1's variable is settled at its configuration-of-record value (one flipped variable at a time, R1c/A10). Flip: Railway → Variables → `VAD_SILENCE_MS=400` → deploy (no active call; record deploy ID).
- [ ] **[HUMAN]** E2 session: **≥ 10 calls / ≥ 40 caller turns**, deliberately including pause-heavy speech (R6). Scripts to use verbatim on several turns:
  - Phone number with mid-string pauses: "My callback number is six six one… [2-second pause] …four nine zero… [2-second pause] …nine three six four."
  - Think-aloud: "I wanted to ask about… [pause] …hmm, I think it's called… [pause] …Runner Rundown, the orientation thing."
  Note per call in `notes.md` whether ANY caller turn was clipped (RIO answered before the caller finished / caller had to repeat) — the judge is the caller themself (R1a).
- [ ] **[HUMAN+AGENT]** Extract (72 h) → `docs/measurements/<YYYY-MM-DD>-e2-vad400/`. **[AGENT]** aggregate turns; compute `bargedIn` share vs baseline:
  ```
  node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).flatMap(l=>{try{const o=JSON.parse(l);return o.event==="turn"?[o]:[]}catch{return[]}});const b=t.filter(o=>o.bargedIn===true).length;console.log("turns="+t.length+" bargedIn="+b+" share="+(b/t.length*100).toFixed(1)+"%")' docs/measurements/<dir>/turns.jsonl
  ```
  (run once on this session's `turns.jsonl`, once on the baseline's, and put both shares in `notes.md` — A4). Gate — ALL of (R6): zero clipped caller turns; `bargedIn` share ≤ baseline share + 10 percentage points; `ttfbMs` p50 within ±50 ms of baseline (sanity — the win is invisible to `ttfbMs` by design).
- [ ] **[HUMAN] On any clipped turn / gate FAIL:** revert same day: `VAD_SILENCE_MS=500`. Verdict FAIL+REVERTED. **On PASS:** 400 becomes configuration of record; re-evaluate E6 (R10).
- [ ] **[AGENT]** EXPERIMENTS.md row + demo-ledger line. Commit: `docs(measurements): E2 vad-400 session (Demo Spec 05 R6/A4)` + trailer.

### Phase 7 — final E6 read-out, never-regress audit, freeze

- [ ] **[HUMAN+AGENT]** Final pre-freeze E6 evaluation (R10/R11.5): use the last experiment session's data if it reflects the final configuration of record; otherwise **[HUMAN]** run one short session (3 calls, mixed turns incl. 2 knowledge questions) → extract → `docs/measurements/<YYYY-MM-DD>-pre-freeze/`. `notes.md` must state all three E6 numbers against their gates (A9): `greetingTotalMs` p50 < 2000, `ttfbMs` p50 ≤ 900 (or the Phase-2 re-baselined value, cite the ledger row) with the mandatory honest-accounting phrasing, `toolTotalMs` p50 < 1500. Any miss → a named follow-up experiment row (R1 shape) or a documented accepted exception in the ledger — before the email, never silently.
- [ ] **[AGENT]** Never-regress audit (A10), recorded at the bottom of EXPERIMENTS.md: (1) every FAIL row has a matching same-day revert; (2) **[HUMAN]** confirms current Railway Variables equal the configuration of record derived from the ledger; (3) no two sessions' recorded time windows overlap; (4) the E4 row reads PASS and predates any email send (A6/A7 ordering proof by dates).
- [ ] **[AGENT]** Update the demo ledger: DC1 verdict lines complete, DS-1…DS-5 answered, "Next" pointing at M-C evaluation. Commit: `docs(measurements): pre-freeze E6 budget + never-regress audit (Demo Spec 05 R10/A9/A10)` + trailer.
- [ ] **[HUMAN]** After Wave DD sends the email (T0): **the deploy freeze is in force** (R11.6, G7, Spec 06): no flips, no experiments, no deploys T0→T0+24 h except safety-critical fixes, then batched ≤ 1/day. Any experiment not finished waits for the post-demo window — record it as a ledger note, not a BLOCKED verdict. This runbook's activity ends at freeze.

## Verify (task completion tail)

- [ ] `npx vitest run` — expected: zero non-KF-1 failures, zero new skips; count ≥ the pre-demo baseline of **356** plus all demo tests recorded in the demo ledger at M-B (master plan §8 R8.3/R8.4). KF-1 rule: if ONLY the two `test/harness.test.ts` barge-in tests fail, re-run `npx vitest run test/harness.test.ts` — 13/13 in isolation = gate passes, note it (§8 R8.2).
- [ ] `npx tsc --noEmit` — clean (nothing compiled changed; this proves it).
- [ ] Targeted: the Phase-1 EXPERIMENTS.md content-check one-liner → `EXPERIMENTS OK`; and `node scripts/aggregate-latency.mjs --knowledge docs/measurements/<latest-knowledge-session>/knowledge.jsonl` → renders the `knowledgeMs` table without error.
- [ ] File-ownership guard (G14/G9): `git show --stat` on every commit from this task shows only `docs/measurements/**`, `docs/demo/plans/LEDGER.md`, `plans/LEDGER.md` — no `src/`, no `test/` (Spec 05 A11).

## Acceptance

Discharges Demo Spec 05 **A2–A10** (A1 was DA3's; this plan re-smokes it in Phase 0) and answers spikes **DS-1…DS-5** (= base S8, S1, thinking-passthrough, knowledge baseline, caching). Leaves for Wave DD: the email send itself, T0 recording, and LAUNCH-CHECKLIST execution (Spec 06 — E4's PASS row is this task's hand-off).

## Completion Report

```
Task: DC1 — baseline + experiments E1-E6
Status: <complete | blocked: reason + phase>
Sessions run: <dir → date → experiment, one line each>
Verdicts: R2 n/a | E3 <PASS/FAIL+flip> | E4 <PASS/BLOCKED + p50/p95> | E5 <PASS/FAIL-accepted> | E1 <PASS/FAIL+REVERTED> | E2 <PASS/FAIL+REVERTED> | E6 <met/exception rows>
Spike answers recorded: S1 <both ledgers y/n>, S8 <both ledgers y/n>, DS-3/DS-4/DS-5 <demo ledger y/n>
Email released (E4 PASS row date): <date | blocked>
Config of record at hand-off: <variable list>
Deviations from plan: <none | list>
Notes for ledger: <≤3 lines>
```

## Appendix A — knowledge question bank (E4 coverage map)

Corpus sections per Demo Spec 04 R4 (twelve sections). Ask questions conversationally; the bracketed section number is the coverage tag for `notes.md`.

| # | Section | Question |
|---|---|---|
| Q1 | 1 directory_hours | "What's the phone number and hours for the Registrar's office?" |
| Q2 | 2 it_help | "What are the ITS help desk's summer hours?" |
| Q3 | 3 it_help | "How do I reset my MyID password?" |
| Q4 | 3 it_help | "I lost the phone I use for Duo — what do I do?" |
| Q5 | 4 financial_aid | "When does fall financial aid disburse?" |
| Q6 | 4 financial_aid | "How do refunds work through BankMobile?" |
| Q7 | 5 registration | "When's the last day to add a class this fall?" |
| Q8 | 5 registration | "When did registration open for transfer students?" |
| Q9 | 6 orientation | "How much does Runner Rundown cost for freshmen?" |
| Q10 | 6 orientation | "How do I sign up for orientation?" |
| Q11 | 7 parking | "How do I buy a parking permit?" |
| Q12 | 7 parking | "How do I appeal a parking ticket?" |
| Q13 | 8 other | "I'm a biology major — how do I find my academic advisor?" |
| Q14 | 9 other | "What counseling services does CSUB offer?" *(informational phrasing — do NOT sound distressed; a distressed read correctly triggers the crisis path instead of the knowledge tool)* |
| Q15 | 10 events | "What events are happening on campus in late summer?" |
| Q16 | 11 events | "Tell me about the NextTech Kern conference." |
| Q17 | 11 events | "How much is early-bird registration for NextTech?" |
| Q18 | 12 other | "Who's the CSUB mascot?" |
| Q19 | 12 other | "What does RIO stand for?" |
| Q20 | 1 directory_hours | "What's the Financial Aid office phone number?" |
| Q21 | out-of-corpus | "What time does the campus pool close today?" |
| Q22 | out-of-corpus | "How much is a meal plan at the dining commons?" |
| Q23 | out-of-corpus | "Is the bookstore doing textbook buyback this week?" |

E4 minimum: 20 of Q1–Q23 across ≥ 5 calls, all three of Q21–Q23 included, ≥ 8 distinct sections covered (Q1–Q20 span all 12). **E5 repeat block:** re-ask Q2, Q5, Q9, Q16, Q18 within a few minutes of their first ask, same session.

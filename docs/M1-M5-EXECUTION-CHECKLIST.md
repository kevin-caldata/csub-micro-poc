# M1–M5 Execution Pre-Flight Checklist (T10.8)

Status: **pre-flight verified, offline half only.** This document is the walk-through the
human operator + orchestrator use to actually run M1–M5 against the deployed Railway
service. It does not replace the procedure documents — it is the ordered, executable
distillation of them, cross-checked against the current as-built repo state on
2026-07-18 (commit `293395c`, suite 345/345 vitest green, `npm ci` clean).

**Authorities (read these, this file only sequences them):**
- `docs/specs/10-testing-spikes-and-milestones.md` R13–R27 — the procedure text itself.
- `docs/RUNBOOK.md` — one-time setup (§1), deploy-between-calls (§2), Log Explorer (§3),
  extraction rule (§4), incident reference (§5), cost tracking (§7), spike ledger (§8).
- `docs/measurements/README.md` — extraction steps, naming convention, aggregation CLI,
  honest-accounting phrasing, S33 checklist.
- `plans/LEDGER.md` — Spike Answer Register (S1–S35) and Milestone gate checklist; the
  orchestrator fills this, not the M1–M5 executor.
- `docs/specs/06-audio-dsp-transcoding.md` R13 — Path A/B decision procedure (also mirrored
  in `README.md` "M1 audio-format spike" section).

**Stale-fact note (found during pre-flight, not fixed here — RUNBOOK.md is not edited by
this task):** `docs/RUNBOOK.md` §8's Spike/verification ledger table and `plans/LEDGER.md`'s
Spike Answer Register both enumerate the S-numbers, but only `plans/LEDGER.md`'s register is
the one the orchestrator updates per the ledger protocol (`plans/LEDGER.md` line 30: "Milestone
reached: fill... Spike Answer Register rows"). Record every spike answer in **both**
`README.md` "## Spike Results" / "## Findings Report (M5)" (executor-owned, per this plan) and
let the orchestrator mirror into `plans/LEDGER.md`'s register — do not let `docs/RUNBOOK.md`
§8's table silently diverge; it is descriptive, not authoritative.

---

## 0. Pre-flight verification performed by this dispatch (offline, done now)

| Check | Result |
|---|---|
| `npm ci` | clean, 235 packages, 0 vulnerabilities |
| `npm test` | **345/345 passing**, 30 test files, node environment (env-guard test present) |
| `scripts/check-credits.ts` (no `AI_GATEWAY_API_KEY`) | exits 0, prints the OIDC-trap guidance message — confirms guard path is live; success path needs a real key (deferred) |
| `scripts/concurrency-probe.ts` (no `AI_GATEWAY_API_KEY`) | same guard behavior confirmed |
| `scripts/aggregate-latency.mjs` against `scripts/fixtures/aggregate/{turns,tools}.jsonl` | produces correct p50/p95/max/n tables, partitioned by `bargedIn`/`has-ttfbMs`; `--tools` mode works; skip-count reporting confirmed |
| `assets/fallback-apology.ulaw` | present, 55,752 bytes = 6.969 s at 8000 B/s (headerless raw μ-law, per `assets/README.md` provenance) |
| `src/config.ts` / `src/gateway.ts` `GATEWAY_WS_URL` test-only override | present (`src/config.ts:33,56,94`; `src/gateway.ts:279-284`); `.env.example:24` carries the "test harness only" comment |
| `railway.json` | RAILPACK builder, `overlapSeconds:10`, `drainingSeconds:60`, `healthcheckPath:/health`, single-region `us-east4-eqdc4a` — conformant with RUNBOOK §1/§2 |
| `README.md` | "## Spike Results" section present with all 12 M1-item stubs (R14 format) in order; "## Findings Report (M5)" skeleton present with all 7 sections incl. the pre-filled 35-row spike table (Answer/Evidence columns empty, classification/notes columns pre-filled per R27) |
| `test/fakes/fake-gateway.ts` | `SESSION_UPDATED_RAW_FIXTURE` carries the required S5-assumption comment (line 83-90) and is the exact jsonc shape from Spec 10 R9 — ready to be updated to the *observed* shape after M1-02 |
| `test/harness.test.ts`, `test/fakes/fake-twilio.ts` | present; harness suite passes offline as part of the 345 |
| `plans/LEDGER.md` dependency state | T10.1–T10.5, T10.7 = `OK`; **T10.6 = `D` (dispatched, not yet marked `OK`)** even though its artifacts (`test/harness.test.ts`, fake gateway/twilio, burst-mode barge-in test) are present and green in this worktree — orchestrator merge/ledger bookkeeping item, not a functional gap |

No code or README content was changed by this dispatch beyond adding this checklist file — there
is no live data to record, so the M1-02 fixture update, `AUDIO_MODE` flip, and Spike Results/Findings
Report fills all remain exactly as scaffolded, per plan (they are the live half).

---

## 1. Preconditions (R13, before any call) — [HUMAN] + [AGENT]

Ordered actions:

1. **[HUMAN]** Twilio console: confirm account is upgraded (non-trial) and Business Profile is
   **approved** (not just submitted). This is **S20** — record Yes/No + date in `README.md` Spike
   Results (there is no dedicated M1-0x stub for S20; add it as a line under the M1-09 entry or a
   new bullet before M1-01, since R13 requires it recorded and R27 marks S20 must-answer).
2. **[HUMAN]** Twilio number → Voice Configuration → "A call comes in" → Webhook →
   `https://<RAILWAY_PUBLIC_DOMAIN>/twiml` → HTTP POST → Save (RUNBOOK §1 step 9).
3. **[HUMAN]** Confirm `<Stream statusCallback>` → `/stream-status` (Spec 02 route; verify in the
   TwiML the deployed `/twiml` route actually emits — `curl -s -X POST https://<domain>/twiml
   -d CallSid=CAxxx -d AccountSid=ACxxx -d From=+15550001 -d To=+15550002` and grep the response for
   `statusCallback="https://<domain>/stream-status"`).
4. **[AGENT]** Tail Railway build logs (or `railway logs` if the CLI is authenticated) across one
   smoke call and confirm the R13 verbatim list appears at least once: `session-updated.raw`,
   `error.raw` (if any), `custom.rawType` (if any), WS `close {code,reason}` both legs,
   `unexpected-response` (if any), `getTokenMs`/`expiresAt`. Log Explorer query:
   `@callSid:<sid>` scoped to the smoke call's time window, scan for these keys.
5. Record S20 in `README.md` Spike Results now (per step 1) before proceeding to M1.

Abort/rollback: if the Business Profile is not approved, M4's FR-3 parallel-call test (3–5 humans
dialing in) may be capped by Twilio-side concurrency — proceed with M1–M3 regardless, flag the M4
risk in the M4 exit notes, do not block M1 on this.

---

## 2. M1 — audio-format spike + first call (R15, items M1-01 → M1-12, strict order)

Run top to bottom. Write each item's R14-format entry into `README.md` "## Spike Results"
**immediately after that item**, not batched at the end.

| # | Who | Ordered human/agent action | S-rows closed → where recorded |
|---|---|---|---|
| **Pre-req** | AGENT | Set Railway env: `AUDIO_MODE=pcmu`, `VOICE=marin`, `MODEL_ID=openai/gpt-realtime-2.1` (per RUNBOOK §1 step 7, sealed vars already set — this only touches the non-secret three). Every var change redeploys — confirm no call is in progress first (RUNBOOK §2 step 1). | — |
| **M1-01** | AGENT | Hit `/twiml` (or a one-off `tsx` script using `mintRealtimeToken`) with the deployed env; no call needed. Read `getTokenMs`, `expiresAt`, token prefix from the log line. | **S15** → `README.md` M1-01 stub |
| **M1-02** | HUMAN | Place first live call. Speak two turns. Capture: gateway WS open (no `unexpected-response`); `session-updated.raw` verbatim; audible greeting in `marin`/pcmu; `speech-started` normalized-vs-`custom` (which fired); `.raw` OpenAI-native fields; `response-created`-before-first-`audio-delta` ordering; any `Array.isArray` frames; `x-twilio-signature` presence on WS upgrade; inbound frame cadence from `media.timestamp` deltas. | **S1,S4,S5,S6,S7,S8,S13,S16,S17,S21,S22** → M1-02 stub |
| **→ AGENT follow-up** | AGENT | Immediately after M1-02: update `test/fakes/fake-gateway.ts`'s `SESSION_UPDATED_RAW_FIXTURE` (line ~83-90) to the shape actually observed in `session-updated.raw`, keep/refresh the "S5 assumption" comment as "observed shape, confirmed <date>", run `npm test`, commit `test(fakes): update session-updated.raw fixture to observed M1-02 shape`. | closes S5's fixture-currency half |
| **M1-03** | HUMAN+AGENT | Fallback ladder — only for items that failed in M1-02, **one variable at a time**, each a separate Railway env change + redeploy + call: `MODEL_ID=openai/gpt-realtime-2` if 2.1 refused; `VOICE=alloy` if `marin` rejected; `AUDIO_MODE=transcode` if pcmu not honored. | closes **S1/S7/S8** → M1-03 stub |
| **M1-04** | HUMAN | One call with `AUDIO_MODE=transcode` regardless of M1-02/03 outcome. Confirm `session-updated.raw` shows `audio/pcm`@24000 both directions; audible quality note; compare `speech-stopped` timing vs the Path A call on the same test phrase. | **S2,S18** → M1-04 stub |
| **M1-05** | HUMAN | Manual sine-sweep-by-ear (200 Hz→3.2 kHz) on both paths; listen for boundary buzz. | (DSP in-vivo, no S-number) → M1-05 stub |
| **M1-06** | HUMAN | Deliberate misconfig once, then revert: send `inputAudioFormat:{type:'audio/pcmu', rate:8000}`; capture `error.raw` or silent-ignore. | **S3** → M1-06 stub |
| **M1-07** | HUMAN | During M1 calls, do one barge-in; log every `error.code`/`.message`/`.raw` and `response-done.status`+`status_details.reason`. | **S11,S12** (finishes at M2) → M1-07 stub |
| **M1-08** | AGENT (b,c) / HUMAN (a) | (a) normal hangup → close code/reason [HUMAN call]; (b) reuse a used `vcst_` token in a bare WS connect → expect `unexpected-response` [AGENT-runnable, needs deployed token + WS lib, no phone]; (c) connect + send nothing for 31 s → close code [AGENT-runnable]; (d) optional 5-min idle off-call. | **S14** → M1-08 stub |
| **M1-09** | HUMAN | (a) TwiML→dead WS path or stopped server → seconds-to-failure + caller experience; check `/stream-status` for `stream-error` + Twilio debugger error 31920; (b) mid-call `railway restart` → seconds until Twilio hangs up, dead-air check. | **S19** → M1-09 stub |
| **M1-10** | HUMAN | Only if G4 spoken-fallback adopted (it is — `playFallbackAndClose` wired per LEDGER Wave D note): bogus `MODEL_ID` for one deploy, verify apology clip plays before close. | **S23** clip half → M1-10 stub |
| **M1-11** | AGENT | `npx tsx --env-file=.env scripts/check-credits.ts` before/after first billed calls; inspect Vercel dashboard → AI Gateway → Requests for session rows/token breakdown; inspect `session-created.raw` for a generation id. | **S30,S31** → M1-11 stub |
| **M1-12** | AGENT | Set `providerOptions:{gateway:{tags:['voice-poc']}}` on one call's `session-update`; check dashboard attribution. | **S32** (+S10 if attempted) → M1-12 stub |

**M1 exit gate:** `README.md` records at minimum S1, S4, S7, S8. Flip `AUDIO_MODE` on Railway to
the winning path (RUNBOOK §1 step 7 non-secret var; every change redeploys — do this between
calls). Extract logs (§4 below) → `docs/measurements/<date>-m1/`. Commit
`docs(measurements): M1 spike results and log extracts`.

**Abort/rollback:** if M1-02 and M1-03's full ladder all fail (no model/voice/audio-mode
combination produces audible correct audio), stop — this blocks every downstream milestone.
Do not proceed to M2 without a working call. If a single Railway env change causes a boot crash,
the previous deploy keeps serving (RUNBOOK §2 step 3) — revert the variable and redeploy.

---

## 3. M2 — conversation quality (R16.1–R16.6) — [HUMAN] primary, [AGENT] extraction

1. **[HUMAN]** ≥2 calls, ≥3 barge-ins each, including one on turn ≥3 after a completed turn (live
   stale-epoch check — `conversation-item-truncate` must not error).
2. **[HUMAN]** After one barge-in ask "what did you just say?" (**S9**); confirm
   `custom{rawType:'conversation.item.truncated'}` ack with `audio_end_ms` in logs.
3. **[HUMAN]** FR-2 two layers: (a) bridge log `barge-in` line Δ(`speech-started`→`clear`) < 50 ms
   [AGENT reads this from logs]; (b) one calibration call on speakerphone + laptop Audacity
   recording, measure the audible stop gap in the waveform, must be < 500 ms.
4. **[AGENT]** Confirm `input-transcript`/`output-transcript` lines present per turn.
5. **[AGENT]** Run the **S33** Log Explorer verification checklist (7 items, `docs/measurements/README.md`
   "Log Explorer verification checklist" section / RUNBOOK §3) against the first deployed build —
   this must be dated before any M2+ session counts (per `docs/measurements/README.md`: "No M2+
   measurement session is valid before this checklist is dated"). Record each of the 7 results +
   dates in that README's checklist AND note completion in `README.md` Spike Results under S33.
6. **[AGENT]** Same-day extraction (§4 below) → `docs/measurements/<date>-m2/`; also produce the
   calibration call's `notes.md` per `docs/measurements/README.md`'s calibration-call-plan format.

**M2 exit gate:** FR-2 both layers recorded; S9 answered; S33 verified; transcripts+turn lines
present. Commit `docs(measurements): M2 conversation quality results and log extracts`.

**Abort/rollback:** if S33 item 4 (numeric filter `@ttfbMs:>800`) fails, use the documented
fallback — export `@event:turn` and let `scripts/aggregate-latency.mjs` do the filtering offline;
this does not block M2, it only changes the extraction mechanics.

---

## 4. M3 — tools acceptance (R17.1–R17.4)

1. **[HUMAN]** "what time is it" ×≥5 across 2 calls; record `tool-call` log lines
   (`mcpMs/gateWaitMs/secondTtfbMs/toolTotalMs`); compute p50 of `toolTotalMs`, must be < 1500.
   Query: `@event:tool-call AND @toolTotalMs:>1500` should return nothing (or each hit explained).
2. **[AGENT]** FR-5 add-a-tool: add exactly one `server.registerTool` block (suggested
   `get_fun_fact`, no args, static string) to `src/mcp-server.ts` **only** — zero other file
   changes. Commit `feat(mcp): add get_fun_fact tool (FR-5 diff test)`. Push to `main`. Record the
   timestamp of the push.
3. **[AGENT]** Watch Railway deploy → Active; record minutes push→live (feeds FR-8/R24 — do not
   duplicate this timing measurement, R17.2 explicitly says "jointly exercised").
4. **[HUMAN]** Next call, ask for a fun fact — verify it works; verify `session-update.tools`
   count grew (log the tool list at call start).
5. **[AGENT]+[HUMAN]** Tool-failure resilience: agent temporarily registers `always_fails`
   (handler throws), commits, pushes; human asks the model to use it; expect `isError:true` →
   apology → call survives; agent removes the tool, commits, pushes. **Three separate commits**
   (add / verified / removed).
6. **[HUMAN]** Gate correctness: speak immediately while a tool call is pending — no
   `conversation_already_has_active_response`-class collision (or it's whitelisted/recovered).
7. **[AGENT]** Harvest any new error strings into the README S11/S12 whitelist notes.
8. **[AGENT]** Extraction → `docs/measurements/<date>-m3/`.

**M3 exit gate:** FR-4+FR-5 pass, R14-format entries in README, tool p50 recorded. Commit
`docs(measurements): M3 tools acceptance results and log extracts`.

**Abort/rollback:** if the add-a-tool diff accidentally touches `src/session.ts` or any bridge
file, the FR-5 pass criterion fails regardless of functional success — revert and redo touching
only `mcp-server.ts`.

---

## 5. M4 — concurrency + platform (R18–R24)

1. **[AGENT]** `npm run probe:concurrency` (needs `AI_GATEWAY_API_KEY` from `.env` against the
   **live** gateway, run from a machine with that key — this is the one M4 step that is
   agent-runnable without a phone). Ramp 1→15 then steps of 5 to 30 or rejection. Record: ceiling
   number, rejection locus (mint vs WS-open), rejection code. This is **S24**, both halves. File
   the number with Vercel support per R20.
2. **[HUMAN]** 3–5 parallel callers (Option A: real phones with the Alpha/Bravo/Charlie/Delta/Echo
   keyword script; Option B: `twilio api:core:calls:create` if staffing fails — note self-call
   `from==to` may be rejected, use a second number as fallback).
3. **[AGENT]** Grep extracted logs for the R19 cross-talk assertion: no callSid A line contains
   callSid B's keyword; independent turn counts per `stream-stop`.
4. **[HUMAN]** FR-7 rejection call: place one real call while the probe holds the ceiling open;
   expect rejection → FR-7 fallback path (spoken apology or clean hangup, never dead air); capture
   `/stream-status` `stream-stopped` callback.
5. **[HUMAN]** Deploy-mid-call probe (**S25**): call live, keep talking, push a trivial commit;
   observe whether audio keeps flowing through overlap/drain, how/when the call dies, whether new
   calls in the window land on the new replica.
6. **[AGENT]** Compare `loopP99Ms`/`bridgeMs` p50/p95 in this session's `stream-stop` lines against
   M2 baseline (**S26**); pass = `loopP99Ms < 50` and `bridgeMs` p95 within 2× baseline. Snapshot
   Railway usage dashboard (**S27**).
7. **[AGENT]** Record FR-8 push→live timing (**R24** — reuse the M3-step-3 measurement if it was
   the same push; otherwise repeat with a visible greeting-text change).
8. **[AGENT]** Extraction → `docs/measurements/<date>-m4/`.

**M4 exit gate:** FR-3/FR-7/FR-8 pass; S24 ceiling+locus, S25, S26, S27 recorded. Commit
`docs(measurements): M4 concurrency results and log extracts`.

**Abort/rollback:** if Twilio rejects self-calling (`from==to`) for Option B and no second number
is available, fall back to Option A (real callers) — do not skip FR-3 cross-talk verification;
it is must-answer (S24 note aside, cross-talk itself has no dedicated S-number but gates M4 sign-off
per A10).

---

## 6. M5 — findings report (R25–R27)

1. **[AGENT]** Confirm every milestone's `docs/measurements/<date>-<label>/` directory exists with
   its `notes.md` (who called, how many calls, `AUDIO_MODE`, deploy SHA, anomalies) per
   `docs/measurements/README.md`'s naming convention.
2. **[AGENT]** Run, once per session directory (never merged across `AUDIO_MODE`s):
   ```
   node scripts/aggregate-latency.mjs docs/measurements/<dir>/turns.jsonl
   node scripts/aggregate-latency.mjs --tools docs/measurements/<dir>/tools.jsonl
   ```
   Paste the resulting tables into `README.md` Findings Report §1. Never average per-call p50s.
3. **[AGENT]** Fill §2 (honest voice-to-voice estimate) using the mandatory phrasing from
   `docs/measurements/README.md` "Honest accounting & calibration": *"measured server-side turn
   core X ms; estimated caller-perceived ≈ X + ~500 ms (VAD window) + ~200–450 ms (PSTN/network
   legs, unmeasured)"* — plus the calibration-call offset from M2.
4. **[AGENT]** Fill §3 (Path A/B verdict) with `session-updated.raw` excerpts from M1-02/M1-04.
5. **[AGENT]** Fill §4 (concurrency) from M4's S24-S27 + FR-3/FR-7/FR-8 results.
6. **[AGENT]** Fill §5 (cost): `scripts/check-credits.ts` before/after deltas across all measured
   batches → total $ / total call-minutes = $/call-minute; Railway usage burn vs $5 Hobby credit.
7. **[AGENT]** Fill §6, the 35-row spike table — every must-answer S-number (S1, S2, S4, S6, S7,
   S8, S11, S12, S14, S15, S19, S20, S9, S33, S24, S25, S26, S30, S35 per R27) must have a
   non-empty Answer + Evidence cell; accepted-risk rows (S23 ping-half, S28) keep their pre-filled
   "accepted-risk: <why>" text; conditional rows (S10, S18, S23 clip-half, S29) get filled only if
   their trigger condition was met.
8. **[AGENT]** Fill §7 (deviations/recommendations).
9. **[AGENT]** Final verify: `npm test` green; every README section non-empty; every milestone has
   a `docs/measurements/` extract.

**M5 exit gate → whole-task completion:** commit
`docs(report): M5 findings report, spike answer table, and measurement extracts` with trailer
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (same trailer on every commit in §§2–6
above).

**Abort/rollback:** if any must-answer S-row is still empty when M5 is reached, that is a
blocking gap per R27 — go back and re-run the owning milestone's procedure for that row rather
than marking the row "accepted-risk" (accepted-risk status is pre-classified in R27, not a
sign-off escape hatch).

---

## 7. Evidence-capture command reference (copy/paste)

```bash
# Cost delta, any time before/after a measured batch
npx tsx --env-file=.env scripts/check-credits.ts

# Concurrency ceiling probe (needs live AI_GATEWAY_API_KEY)
npm run probe:concurrency

# Offline aggregation over an extracted session directory
node scripts/aggregate-latency.mjs docs/measurements/<dir>/turns.jsonl
node scripts/aggregate-latency.mjs --tools docs/measurements/<dir>/tools.jsonl

# Regenerate the fallback clip if ever needed (no ffmpeg on this host — see assets/README.md)
npx tsx scripts/build-fallback-clip.ts <scratch>/apology.wav
```

Railway Log Explorer query cookbook (from `docs/measurements/README.md` / RUNBOOK §3):

```
@callSid:CAxxxxxxxx
@level:error
@event:turn AND @ttfbMs:>800
@event:turn AND @bargedIn:false
@event:stream-stop
@event:tool-call AND @toolTotalMs:>1500
@level:error OR @event:custom
-@event:media
@callSid:CAxxxx AND (@event:first-audio-delta OR @event:barge-in)
```

Extraction destinations, one dated directory per session, per `docs/measurements/README.md`:
`@event:turn`→`turns.jsonl`, `@event:stream-stop`→`summaries.jsonl`, `@event:tool-call`→`tools.jsonl`,
`@event:greeting`→`greetings.jsonl`, `@event:session-updated`→`session-config.jsonl`,
`@level:error OR @event:custom OR @event:gateway-close`→`anomalies.jsonl`. Hard deadline: 72 h from
session end (7-day Railway Hobby retention).

---

## 8. What this dispatch did NOT do (deferred to the live half)

- No live phone calls, no Twilio console changes, no Railway env/variable changes, no deploys.
- No README "## Spike Results" entries filled in (all 12 M1 stubs + S20 remain empty — correctly,
  since no live data exists yet).
- No "## Findings Report (M5)" sections filled in.
- No `docs/measurements/<date>-*/` directories created (nothing to extract yet).
- No `test/fakes/fake-gateway.ts` fixture update (depends on M1-02's observed `session-updated.raw`,
  which requires a live call).
- No `AUDIO_MODE` flip (depends on the M1-02/M1-03 live verdict).
- No `plans/LEDGER.md` edits (executor does not touch the ledger, per this task's contract).

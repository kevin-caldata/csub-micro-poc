# Execution Ledger — CSUB-RIO Voice PoC

Single source of truth for build state. **Only the main (orchestrator) conversation edits this file. Executors never touch it.**
Companion protocol: `plans/README.md`. Wave structure: master plan `docs/specs/00-master-build-plan.md` §4.

---

## Current state

<!-- Orchestrator rewrites ONLY this block each session. Keep it under 10 lines. -->

- Wave: COMPLETE (offline) — awaiting human for M1-M5 live execution
- Last updated: 2026-07-18
- Next dispatchable tasks: NONE agent-executable. Next step: human walks docs/M1-M5-EXECUTION-CHECKLIST.md (M1 first: Twilio console S20, GitHub remote + Railway project, sealed vars, first live call)
- Open blockers: human required (phone, Twilio console, Railway dashboard, real API keys)
- Notes: BUILD OFFLINE-COMPLETE. 356/356 vitest, typecheck+build clean. Final whole-branch review (most capable model): READY FOR M1 confirmed after fix wave (2362aae/e2b265f/fa9b8d5/f1a0db2/53a99f4 — teardown race closed, create-while-active benign+retry wired, clip path cwd-safe, LOG_LEVEL fail-closed, GATEWAY_WS_URL prod guard). M1 watch items: count gateway-array-frame + custom-event log lines (budget), capture gateway-error-event code+raw (S11), session-updated .raw (S1/S8), gateway-open/close pairing + credit deltas after kill tests. Accepted Minors logged in review output. Reviewer's top-3 first-call risks recorded in final-review transcript + checklist

---

## Legend & update protocol

Status codes: `-` pending · `D` dispatched · `OK` done · `BLK` blocked · `PART` partial (milestone tasks only).

Per-event edits (make ONLY these; do not reformat tables):

1. **Dispatch**: set Status `-` → `D`.
2. **Completion report received**: verify commit exists (`git log --oneline -1 <hash>`), optionally run the plan's verify command, then set Status → `OK`, fill Commit (short hash), fill Note with ONE line distilled from the report (deviations/interface amendments only; "clean" if none).
3. **Blocked**: set Status → `BLK`, add a row to the Deviations log, leave Commit empty, Note = deviation ID.
4. **Wave complete**: all rows `OK` → update Current state (Wave, Next dispatchable) and perform the wave's merge-point checks (see plans/README.md).
5. **Milestone reached**: fill the gate checklist row + Spike Answer Register rows owned by that milestone.

Never delete rows. Never re-order. Append-only in Deviations.

---

## Wave A — foundation (strictly sequential)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| T01.1 | 01-scaffolding/01-repo-toolchain.md | — | OK | c1df2f6 | devDeps resolved: typescript@7.0.2, tsx@4.23.1, @types/node@22.20.1, @types/ws@8.18.1 |
| T01.2 | 01-scaffolding/02-config-module.md | T01.1 | OK | eae41ee+61c14ee | DEV-01 (tsconfig types:[node]) + DEV-02 (OIDC required_error) fixed in follow-up; 6/6 tests, typecheck 0 |
| T01.3 | 01-scaffolding/03-logger-stub-and-server.md | T01.2 | OK | 057adc8 | clean; A2/A3/A4 verified incl. both fail-fast cases |
| T01.4 | 01-scaffolding/04-acceptance-sweep.md | T01.1–T01.3 | OK | e0cf553 | 9/9 A-matrix pass, no fixes; dev-watcher negative case exits 9 |

Gate: T01.4 = Wave A→B gate (Spec 01 A1–A9 matrix).

## Wave B — independent modules (T02 ∥ T04 ∥ T06 ∥ T08; chains sequential within each spec)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| T02.1 | 02-http-twiml/01-state-and-server-skeleton.md | T01 | OK | d65d637 | buildApp/main-guard restructure per pre-declared deviation; marker section in place |
| T02.2 | 02-http-twiml/02-pending-calls-store.md | T01 | OK | a9cb9a8 | clean; 12/12 tests; timingSafeEqual-only compare verified |
| T02.3 | 02-http-twiml/03-twiml-and-stream-status-routes.md | T02.1, T02.2 | OK | a0541cb | registerTwimlRoutes(app, config, deps?) per pre-declared deviation; mint merge-marker in twiml.ts ready for Wave B-end swap |
| T02.4 | 02-http-twiml/04-sigterm-drain-shutdown.md | T02.3 | OK | 83cb520 | deep review APPROVED; Minor (final-review triage): straggler teardown loop unguarded — spec-inherited (Spec 02 R8 snippet); POSIX signal smoke deferred to Railway |
| T04.1 | 04-gateway-leg/01-config-keys.md | T01 | OK | 3c81b30 | clean additive config/.env.example edits; merged suite 17/17 |
| T04.2 | 04-gateway-leg/02-token-mint.md | T01, T04.1 | OK | ecf2a3a | mintRealtimeToken(cfg, callSid, modelId?) per pre-declared deviation; factory-form getToken asserted; 7 GatewayError classes mapped |
| T04.3 | 04-gateway-leg/03-ws-client-leg.md | T04.1, T04.2 | OK | da83107 | ws gotcha found+handled: unexpected-response listener suppresses auto abortHandshake — explicit terminate() required (fold into findings/08 if revisited); TAP reporter under-count quirk disproven via fs-markers |
| T04.4 | 04-gateway-leg/04-session-update-greeting.md | T04.3 | OK | c8897a4 | buildCallSessionConfig(cfg,...) explicit-param per no-singleton rule; pendingGreeting closure fires on first session-updated; one pre-existing leg test updated for auto-sent frames |
| T04.5 | 04-gateway-leg/05-dispatch-and-error-policy.md | T04.4 | OK | 20b419f | full 23-event dispatch table; BENIGN_ERROR_CODES exported mutable for S11 tuning; Spec 04 complete |
| T06.1 | 06-audio-dsp/01-mulaw-codec-and-constants.md | T01 | OK | 7da20bf | clean; Int16Array -0 gotcha documented for T06.2/3 test authors |
| T06.2 | 06-audio-dsp/02-polyphase-resamplers.md | T06.1 | OK | 5d24145 | clean; bit-identity + ragged-chunk tests pass; Downsampler3x.reset() verified |
| T06.3 | 06-audio-dsp/03-transcoder-and-formats.md | T06.2 | OK | 6f98598 | clean; A9 (two resetOutbound call sites) is a T05 review contract |
| T06.4 | 06-audio-dsp/04-fidelity-and-perf-guards.md | T06.3 | OK | 218b5e2 | THD+N 83-85dB (2kHz anomalously clean), 18.99us/frame vs 500us budget — record for S26; closes Spec 06 A1 |
| T06.5 | 06-audio-dsp/05-config-verify-and-readme-m1.md | T06.3, T01 | OK | bf30c73 | config.ts no-op confirmed; A2 grep gate was latent-broken by a dsp.ts comment, fixed; README M1 table empty by design |
| T08.1 | 08-logging-latency/01-final-logger.md | T01 | OK | 2f4c1a9 | logEvent boundary preserved (server.ts zero changes); safeRaw is explicit-call, not auto-applied — downstream loggers of .raw must call it |
| T08.2 | 08-logging-latency/02-turn-recorder-core.md | T08.1 | OK | 1f8f453 | clean; unmatched-responseId no-op is the marked T08.3 seam (tool-followup/greeting attribution) |
| T08.3 | 08-logging-latency/03-greeting-tools-summary.md | T08.2 | OK | d236300 | deferred-turn-line mechanism added (timing-impossible otherwise); T05 must call startLoopMonitor() at boot + wire all hooks (Wave D merge item) |
| T08.4 | 08-logging-latency/04-aggregation-script.md | T01 | OK | d0e73f9 | clean; pooling-not-averaging proven on double-file fixture; R16 adjudicated scope (no audio-mode partition) |
| T08.5 | 08-logging-latency/05-measurements-docs.md | T08.4 | OK | 09d5493 | clean; S33 checklist must be dated on first deployed build |

Wave-end merge: additive `config.ts`/`.env.example` edits (T04.1, T06.5); Spec 02→04 mint delegation (T02.3's `MintFn` seam → T04.2 `mintRealtimeToken`, one-line swap); T08.1 must have preserved `logEvent` boundary (full `npm test` green).

## Wave C — routes on the running server (T03 ∥ T07; chains sequential within each spec)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| T03.1 | 03-twilio-leg/01-sessions-registry.md | T01, T02 | OK | ebc54b2 | clean; createSession({twilioWs,streamSid,callSid,log}); teardownSession(s,reason?,{twilioCloseCode?}) |
| T03.2 | 03-twilio-leg/02-ws-route-auth-gate.md | T03.1, T02 | OK | e31f9b6 | marker merge resolved (both route lines); startTimeoutMs deps-injected override (injectWS timer incompat); stop-case stub for T03.4; onSessionStart placeholder for T05 |
| T03.3 | 03-twilio-leg/03-outbound-helpers-backpressure.md | T03.2 | OK | a0ec34c | clean; isFirstMarkOfResponse exported (allowed); firstMarkByResponse Map on Session |
| T03.4 | 03-twilio-leg/04-inbound-state-machine.md | T03.3 | OK | 117e3be+283fcd8 | deep review APPROVED (Important fixed: inert @ts-expect-error moved to src/type-assertions.ts, RED-verified); ENV GOTCHA for T10: one injectWS test per file (node:test v22 Windows silent drop, reviewer-reproduced); Minor for final review: 6x test boilerplate dup; Spec 03 R10 missing media-cadence in event list |
| T03.5 | 03-twilio-leg/05-upgrade-signature-isolation-sweep.md | T03.4, T01 | OK | 913467d+be2308e | clean; TWILIO_VALIDATE_UPGRADE additive; TwilioMediaDeps.config tightened to Pick; T03 complete pending M1 live check |
| T07.1 | 07-mcp-tools/01-mcp-server-routes.md | T01, T02 | OK | 9b4131f | clean; live-verified 200/405/405; stateless reuse guard proven on concurrent POSTs |
| T07.2 | 07-mcp-tools/02-mcp-client-and-tool-defs.md | T07.1 | OK | 4b68af0 | clean; $schema/execution stripping asserted; RealtimeToolDef/createMcpClient/closeMcpClient/fetchToolDefs |
| T07.3 | 07-mcp-tools/03-run-tool-executor.md | T07.2 | OK | 79aef79 | clean; never-throws contract proven incl. transport-failure path |
| T07.4 | 07-mcp-tools/04-tool-loop-state-machine.md | T07.3, T08 | OK | 00e3a96 | Spec 07 complete. T05 MUST reconcile: ToolLoop emits its own tool-call line vs TurnRecorder's parallel hooks — wire one, not both (double-log risk); ToolLoop is one-per-call w/ resetCycle |

Wave-end merge: `server.ts` route-registration marker section — T03.2 and T07.1 each add exactly one line; confirm both lines present, no duplicate `@fastify/websocket` registration.

## Wave D — integration (T05 sequential; T09 parallel with T05)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| T05.1 | 05-session-bridge/01-bargein-and-marks.md | T01, T03, T04, T06 | OK | 91401aa+19b5777 | deep review APPROVED after fixes (A14 grep clean, loud unwired-gateway guard); Minors handed to T05.2: one writer for firstMarkNameOfResponse, barge-in line double-emit vs TurnRecorder, retire dead isFirstMarkOfResponse seam |
| T05.2 | 05-session-bridge/02-dispatch-and-epoch.md | T05.1, T03, T04, T06, T08 | OK | 11df8a3 | deep review APPROVED (A7 mutation-verified); handed to T05.3: dual turn-tracking Session.turns vs TurnRecorder.turns (Important), first-audio-delta double-emit once recorder wired, pushMark-on-closed-socket cosmetic |
| T05.3 | 05-session-bridge/03-turns-and-tool-gate.md | T05.2, T07, T08 | OK | 47522ab | deep review APPROVED; Minor for final review: closed-socket pushMark guard untested; handed to T05.4: ToolLoop log wrapper must add callSid/streamSid/turn (R11), TurnRecord.tools stays empty by design |
| T05.4 | 05-session-bridge/04-orchestration-and-teardown.md | T05.1–T05.3, T02, T03, T04, T06, T07, T08 | OK | 2c2c967+c3b77af+e0e04b3 | deep review APPROVED after fixes (onTeardown move-early RED-verified; PendingCall typing sound); greeting decomposition landed; Minor for final review: webhookToStartMs never seeded |
| T09.1 | 09-deployment-ops/01-railway-config-verify.md | T01 | OK | e8e80d6 | verify-only; railway.json already conformant; invariants locked by new test |
| T09.2 | 09-deployment-ops/02-fallback-clip-assets.md | T01 | OK | 05bee1a | DEV-04 route done: System.Speech + build-fallback-clip.ts (replaces make-fallback-clip.sh); clip 6.97s/55752B; S23 live playback deferred to M1 |
| T09.3 | 09-deployment-ops/03-fallback-helper.md | T01, T03, T08, T09.2 | OK | 1b85286 | clean; playFallbackAndClose + playFallbackAndCloseWith; wiring gated on S23 (orchestrator, Wave D end) |
| T09.4 | 09-deployment-ops/04-check-credits.md | T01 | OK | 29d8c31 | guard+error paths live-verified; success path deferred to M1 (no real key on host) |
| T09.5 | 09-deployment-ops/05-runbook.md | T01, T02, T08, T09.3, T09.4 | OK | f41812f | clean; docs/RUNBOOK.md; T09 lane complete (live halves at M1) |

Wave-end merge (orchestrator-applied, gated on spike S23): one-line wiring `playFallbackAndClose` → T05.4's `setOnGatewayFailure` seam. Also: T05.4 may extend `onSessionStart` signature to `(session, pendingCall)` — record against T03 row's Note. `startLoopMonitor()` boot call site added per T08.3 hand-off.

## Wave E — test layer & milestones (T10.1 first; then .2/.3/.4/.5/.7 parallel; .6 after .5; .8 terminal)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| T10.1 | 10-testing-milestones/01-vitest-scaffold-and-consolidation.md | T01–T08 | OK | 49f422e | R-1 closed: vitest@4.1.10; TRUE count 297 (node:test TAP was silently dropping 18 passing tests); 9 workaround files re-merged; tests now test/**/*.test.ts |
| T10.2 | 10-testing-milestones/02-config-logger-aggregation-suites.md | T10.1, T01, T04, T08 | OK | 9b10a8e | clean; aggregator proven vs hand-computed fixture; 302 tests |
| T10.3 | 10-testing-milestones/03-dsp-and-tool-mapping-suites.md | T10.1, T06, T07 | OK | 0fe47ad | clean; Spec 10 R3.6 prose says floor(n/3), actual (correct) is ceil for non-multiples — spec-text nit, code right |
| T10.4 | 10-testing-milestones/04-bargein-and-marks-suites.md | T10.1, T03, T05 | OK | ff82d96 | clean; R5.1 literal script passed first run (audioEndMs 500, never 7500); R6 mark suites; 332 tests |
| T10.5 | 10-testing-milestones/05-gateway-override-and-fakes.md | T10.1, T02, T03, T04 | OK | b643671+b76147b | clean; GATEWAY_WS_URL bypasses only socket construction — T10.6 must inject fake mint via TwimlDeps.mint (no live network) |
| T10.6 | 10-testing-milestones/06-integration-harness.md | T10.5, T05, T07 | OK | de9bd44+293395c | deep review APPROVED (real-vs-fake boundary verified against production source); Minors for final review: burst audioEndMs<=2000 wall-clock margin, over-promising test title, none blocking |
| T10.7 | 10-testing-milestones/07-concurrency-probe-and-report-skeletons.md | T10.1, T04 | OK | 5f52f46 | clean; probe dry-run verified; README S-table (35 rows) + M1 stubs + M5 skeleton in place, empty pending live data |
| T10.8 | 10-testing-milestones/08-milestone-execution-m1-m5.md | T10.1–T10.7, T09 | PART | 8c80979 | offline pre-flight complete: docs/M1-M5-EXECUTION-CHECKLIST.md written, all preconditions verified; live halves await human (M1-M5); note: RUNBOOK §8 spike table vs LEDGER register — LEDGER is authoritative |

---

## Milestone gate checklist

Stop the build at each gate; run the owning procedure; fill spikes; get sign-off. Human required for anything with a phone/console/dashboard (see plans/README.md §6).

| Gate | Procedure | Needs tasks | Human? | Status | Sign-off (who / date) |
|---|---|---|---|---|---|
| M1 — audio spike + first live call | Spec 10 R15 (12-item checklist) + Spec 06 R13 decision procedure | T01–T06, T08, T09 deployed (T07 not required) | YES — live phone call, Twilio console, Railway deploy | - | |
| M2 — conversation quality | Spec 10 M2 procedure | + T05 | YES — live calls, speakerphone measurement | - | |
| M3 — tools end-to-end | Spec 10 M3 procedure | + T07 wired via T05 | YES — live calls, add-a-tool redeploy | - | |
| M4 — concurrency + pipeline | Spec 10 M4 (FR-3, S24 probe, S25 deploy-mid-call, FR-7 kill, FR-8 push) | + T09, T10 scripts | YES — 3–5 parallel callers, Railway dashboard | - | |
| M5 — findings report | Spec 10 R26 template + Spec 08 extraction procedure | all + extracted logs | YES — dashboard numbers, cost figures | - | |

---

## Spike Answer Register (S1–S35)

Fill Answer during M1/M4/M5 execution (T10.8). Owner = instrumenting task per master plan §7. All 35 rows mandatory in the M5 table.

| S# | Question (short) | Owning task | Answered at | Answer |
|---|---|---|---|---|
| S1 | Gateway honors `audio/pcmu`? (Path A viable) | T06/T04 | M1 | |
| S2 | Default output rate from gateway | T06/T04 | M1 | |
| S3 | `rate` alongside pcmu misconfig probe | T06/T04 | M1 | |
| S4 | speech-started arrives normalized vs custom? | T04 | M1 | |
| S5 | `.raw` event shapes (record `session-updated.raw`) | T04 | M1 | |
| S6 | session-update ordering / `WAIT_FOR_SESSION_UPDATED` needed? | T04 | M1 | |
| S7 | `gpt-realtime-2.1` connects via gateway? | T04/T01 | M1 | |
| S8 | `VOICE=marin` accepted? | T04/T01 | M1 | |
| S9 | truncate forwarded + `conversation.item.truncated` ack? | T04/T05 | M2 | |
| S10 | `providerOptions` passthrough (probe only if needed) | T04 | conditional | |
| S11 | Benign in-band error `code` strings | T04/T05/T07 | M1/M2 | |
| S12 | `response-done.status` value vocabulary | T04/T05/T07 | M1/M2 | |
| S13 | Array frames observed in practice? | T04 | M1+ | |
| S14 | Gateway WS close-code vocabulary | T04 | M1+ | |
| S15 | Token TTL semantics + `getTokenMs` distribution | T02/T04 | M1 | |
| S16 | response-created always before first delta? | T08 | M1 | |
| S17 | Audio-delta cadence (mark granularity) | T03/T08 | M1 | |
| S18 | VAD behavior 8k μ-law vs 24k PCM | T06 | opportunistic | |
| S19 | Caller experience on handshake failure / mid-call drop | T02/T03 | M1 kill test | |
| S20 | Twilio account upgraded + Business Profile? (human console) | T09 | pre-M1 | |
| S21 | Upgrade-signature header present on WS upgrade? | T03 | M1 | |
| S22 | Twilio inbound frame cadence / timeout | T03 | M1 | |
| S23 | Canned clip plays before WS close? (gates G4 wiring) | T09/T03/T04 | M1 probe | |
| S24 | Gateway concurrency limit + rejection locus (mint vs WS-open) | T10/T02/T04 | M4 | |
| S25 | Railway WS routing during overlap/drain (deploy-mid-call) | T09/T02 | M4 | |
| S26 | Shared-vCPU DSP multiplier + loop p99 | T06/T08 | M4 | |
| S27 | Hobby plan usage burn rate | T09 | M4 | |
| S28 | Twilio behavior on `/twiml` 503 during drain (ACCEPTED RISK) | T02 | only if rule relaxed | |
| S29 | `/mcp` DNS-rebinding hardening (not adopted) | T07 | conditional | |
| S30 | Audio-token pricing observed | T09 | M1/M5 | |
| S31 | Generation IDs in usage data | T04 | M1/M5 | |
| S32 | `gateway.tags` cost attribution works? | T04 | M1/M5 | |
| S33 | Log Explorer flat-field filtering checklist passes | T08 | first deployed build | |
| S34 | `audio_end_ms` semantics confirmed | T08 | M1/M5 | |
| S35 | Gateway-hop overhead measured | T08 | M1/M5 | |

---

## Deviations log (append-only)

Format: `| DEV-NN | date | task | what deviated / why | resolution (respin / plan amended / accepted) |`

| ID | Date | Task | Deviation | Resolution |
|---|---|---|---|---|
| DEV-01 | 2026-07-18 | T01.2 | typescript@7.0.2 does not auto-include @types/node under Spec 01 R6 tsconfig — `npm run typecheck` fails TS2503/TS2591 on NodeJS/process | Plan amended: add `"types": ["node"]` to tsconfig compilerOptions (fix committed with T01.2 follow-up) |
| DEV-02 | 2026-07-18 | T01.2 | Spec 01 R5 OIDC-trap message only fires on present-but-empty AI_GATEWAY_API_KEY; zod default "Required" text on absent key breaks A4 wording | Plan amended: add required_error carrying the OIDC message so absent and empty both name the trap; test asserts /OIDC/ |
| DEV-03 | 2026-07-18 | Wave B+ | Concurrent lanes cannot share one working tree (repo-wide test/typecheck see half-written files; git index races) | Process: parallel implementers run in isolated worktrees (npm ci per worktree); orchestrator merges each accepted task branch to main before dispatching the lane's next task |
| DEV-04 | 2026-07-18 | T09.2 | Host has no ffmpeg for the spoken-fallback clip pipeline | Plan amended: generate 8kHz 16-bit mono WAV via Windows System.Speech (PowerShell), encode to mu-law with the repo's own vendored MULAW_ENC (src/dsp.ts) via a one-off script — no new dependencies |

<!-- append rows below; never edit or delete existing rows -->

Pre-declared (from planning, expect executors to confirm in completion reports — log only if they DIVERGE from these):
- node:test via `tsx --test` at `src/*.test.ts` through Waves A–D; vitest only at T10.1 (master plan R-1).
- `buildApp(config, shutdownOpts?)` export + main-guard restructure of server.ts; `registerTwimlRoutes(app, config, deps?)` (Spec 02 plans).
- `mintRealtimeToken(cfg, callSid, modelId?)` takes explicit config, no singleton; `OpenGatewayLegOptions.config` field (Spec 04 plans).
- `playFallbackAndClose(s, reason?)` optional reason param (Spec 09 plans).
- Spec 06 test lives at `src/dsp.test.ts` until T10 migration.

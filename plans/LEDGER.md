# Execution Ledger — CSUB-RIO Voice PoC

Single source of truth for build state. **Only the main (orchestrator) conversation edits this file. Executors never touch it.**
Companion protocol: `plans/README.md`. Wave structure: master plan `docs/specs/00-master-build-plan.md` §4.

---

## Current state

<!-- Orchestrator rewrites ONLY this block each session. Keep it under 10 lines. -->

- Wave: -
- Last updated: -
- Next dispatchable tasks: T01.1
- Open blockers: none
- Notes: build not started; repo not yet a git repo (T01.1 runs `git init -b main`)

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
| T01.1 | 01-scaffolding/01-repo-toolchain.md | — | - | | |
| T01.2 | 01-scaffolding/02-config-module.md | T01.1 | - | | |
| T01.3 | 01-scaffolding/03-logger-stub-and-server.md | T01.2 | - | | |
| T01.4 | 01-scaffolding/04-acceptance-sweep.md | T01.1–T01.3 | - | | |

Gate: T01.4 = Wave A→B gate (Spec 01 A1–A9 matrix).

## Wave B — independent modules (T02 ∥ T04 ∥ T06 ∥ T08; chains sequential within each spec)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| T02.1 | 02-http-twiml/01-state-and-server-skeleton.md | T01 | - | | |
| T02.2 | 02-http-twiml/02-pending-calls-store.md | T01 | - | | |
| T02.3 | 02-http-twiml/03-twiml-and-stream-status-routes.md | T02.1, T02.2 | - | | |
| T02.4 | 02-http-twiml/04-sigterm-drain-shutdown.md | T02.3 | - | | |
| T04.1 | 04-gateway-leg/01-config-keys.md | T01 | - | | |
| T04.2 | 04-gateway-leg/02-token-mint.md | T01, T04.1 | - | | |
| T04.3 | 04-gateway-leg/03-ws-client-leg.md | T04.1, T04.2 | - | | |
| T04.4 | 04-gateway-leg/04-session-update-greeting.md | T04.3 | - | | |
| T04.5 | 04-gateway-leg/05-dispatch-and-error-policy.md | T04.4 | - | | |
| T06.1 | 06-audio-dsp/01-mulaw-codec-and-constants.md | T01 | - | | |
| T06.2 | 06-audio-dsp/02-polyphase-resamplers.md | T06.1 | - | | |
| T06.3 | 06-audio-dsp/03-transcoder-and-formats.md | T06.2 | - | | |
| T06.4 | 06-audio-dsp/04-fidelity-and-perf-guards.md | T06.3 | - | | |
| T06.5 | 06-audio-dsp/05-config-verify-and-readme-m1.md | T06.3, T01 | - | | |
| T08.1 | 08-logging-latency/01-final-logger.md | T01 | - | | |
| T08.2 | 08-logging-latency/02-turn-recorder-core.md | T08.1 | - | | |
| T08.3 | 08-logging-latency/03-greeting-tools-summary.md | T08.2 | - | | |
| T08.4 | 08-logging-latency/04-aggregation-script.md | T01 | - | | |
| T08.5 | 08-logging-latency/05-measurements-docs.md | T08.4 | - | | |

Wave-end merge: additive `config.ts`/`.env.example` edits (T04.1, T06.5); Spec 02→04 mint delegation (T02.3's `MintFn` seam → T04.2 `mintRealtimeToken`, one-line swap); T08.1 must have preserved `logEvent` boundary (full `npm test` green).

## Wave C — routes on the running server (T03 ∥ T07; chains sequential within each spec)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| T03.1 | 03-twilio-leg/01-sessions-registry.md | T01, T02 | - | | |
| T03.2 | 03-twilio-leg/02-ws-route-auth-gate.md | T03.1, T02 | - | | |
| T03.3 | 03-twilio-leg/03-outbound-helpers-backpressure.md | T03.2 | - | | |
| T03.4 | 03-twilio-leg/04-inbound-state-machine.md | T03.3 | - | | |
| T03.5 | 03-twilio-leg/05-upgrade-signature-isolation-sweep.md | T03.4, T01 | - | | |
| T07.1 | 07-mcp-tools/01-mcp-server-routes.md | T01, T02 | - | | |
| T07.2 | 07-mcp-tools/02-mcp-client-and-tool-defs.md | T07.1 | - | | |
| T07.3 | 07-mcp-tools/03-run-tool-executor.md | T07.2 | - | | |
| T07.4 | 07-mcp-tools/04-tool-loop-state-machine.md | T07.3, T08 | - | | |

Wave-end merge: `server.ts` route-registration marker section — T03.2 and T07.1 each add exactly one line; confirm both lines present, no duplicate `@fastify/websocket` registration.

## Wave D — integration (T05 sequential; T09 parallel with T05)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| T05.1 | 05-session-bridge/01-bargein-and-marks.md | T01, T03, T04, T06 | - | | |
| T05.2 | 05-session-bridge/02-dispatch-and-epoch.md | T05.1, T03, T04, T06, T08 | - | | |
| T05.3 | 05-session-bridge/03-turns-and-tool-gate.md | T05.2, T07, T08 | - | | |
| T05.4 | 05-session-bridge/04-orchestration-and-teardown.md | T05.1–T05.3, T02, T03, T04, T06, T07, T08 | - | | |
| T09.1 | 09-deployment-ops/01-railway-config-verify.md | T01 | - | | early-dispatch eligible (any wave after T01) |
| T09.2 | 09-deployment-ops/02-fallback-clip-assets.md | T01 | - | | early-dispatch eligible; needs ffmpeg+TTS on host |
| T09.3 | 09-deployment-ops/03-fallback-helper.md | T01, T03, T08, T09.2 | - | | |
| T09.4 | 09-deployment-ops/04-check-credits.md | T01 | - | | early-dispatch eligible |
| T09.5 | 09-deployment-ops/05-runbook.md | T01, T02, T08, T09.3, T09.4 | - | | |

Wave-end merge (orchestrator-applied, gated on spike S23): one-line wiring `playFallbackAndClose` → T05.4's `setOnGatewayFailure` seam. Also: T05.4 may extend `onSessionStart` signature to `(session, pendingCall)` — record against T03 row's Note. `startLoopMonitor()` boot call site added per T08.3 hand-off.

## Wave E — test layer & milestones (T10.1 first; then .2/.3/.4/.5/.7 parallel; .6 after .5; .8 terminal)

| Task | Plan file | Depends on | Status | Commit | Note |
|---|---|---|---|---|---|
| T10.1 | 10-testing-milestones/01-vitest-scaffold-and-consolidation.md | T01–T08 | - | | |
| T10.2 | 10-testing-milestones/02-config-logger-aggregation-suites.md | T10.1, T01, T04, T08 | - | | |
| T10.3 | 10-testing-milestones/03-dsp-and-tool-mapping-suites.md | T10.1, T06, T07 | - | | |
| T10.4 | 10-testing-milestones/04-bargein-and-marks-suites.md | T10.1, T03, T05 | - | | |
| T10.5 | 10-testing-milestones/05-gateway-override-and-fakes.md | T10.1, T02, T03, T04 | - | | |
| T10.6 | 10-testing-milestones/06-integration-harness.md | T10.5, T05, T07 | - | | |
| T10.7 | 10-testing-milestones/07-concurrency-probe-and-report-skeletons.md | T10.1, T04 | - | | |
| T10.8 | 10-testing-milestones/08-milestone-execution-m1-m5.md | T10.1–T10.7, T09 | - | | HUMAN-IN-THE-LOOP; may return PART per milestone |

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

<!-- append rows below; never edit or delete existing rows -->

Pre-declared (from planning, expect executors to confirm in completion reports — log only if they DIVERGE from these):
- node:test via `tsx --test` at `src/*.test.ts` through Waves A–D; vitest only at T10.1 (master plan R-1).
- `buildApp(config, shutdownOpts?)` export + main-guard restructure of server.ts; `registerTwimlRoutes(app, config, deps?)` (Spec 02 plans).
- `mintRealtimeToken(cfg, callSid, modelId?)` takes explicit config, no singleton; `OpenGatewayLegOptions.config` field (Spec 04 plans).
- `playFallbackAndClose(s, reason?)` optional reason param (Spec 09 plans).
- Spec 06 test lives at `src/dsp.test.ts` until T10 migration.

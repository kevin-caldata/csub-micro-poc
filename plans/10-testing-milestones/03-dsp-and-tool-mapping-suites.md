# T10.3 — DSP suite hardening & tool-mapping suite

> **For agentic workers:** Execute this task standalone. Read the References section files BEFORE writing any code. Steps use checkbox syntax for tracking. When done, produce the Completion Report and return it as your final message — do NOT update the ledger yourself.

**Goal:** Ensure `test/dsp.test.ts` enforces all six Spec 10 R3 assertions under vitest, and write `test/tool-mapping.test.ts` per R4 against `src/tools.ts`.

**Wave:** E · **Depends on:** T10.1, T06, T07 · **Blocks:** T10.8

**References:**
- `docs/specs/10-testing-spikes-and-milestones.md` — R3 (six DSP assertions), R4 (tool-mapping assertions), A2, A5
- `docs/specs/06-audio-dsp-transcoding.md` — R2 (`audioFormatsFor`), R3 (`Transcoder`/`createTranscoder`), R12 (the suite Spec 06 already wrote — reconcile, don't duplicate)
- `docs/findings/06-audio-dsp-transcoding.md` — §Test strategy items 1–4 & 6 (assertion authority), C1 (0x7F→0xFF exception), C6 (chunk-boundary state), C10 (bench numbers), gotcha 4 (phase counter), gotcha 8 (least-squares projection, NEVER naive shifted-reference)
- `docs/specs/07-mcp-server-and-tool-loop.md` — §Deliverables (`fetchToolDefs`, `runTool` exported from `src/tools.ts`; confirm exact signatures in source)
- `docs/findings/05-mcp-sdk-streamable-http.md` — C8 (verbatim `listTools()` fixture incl. `execution` and `$schema` fields), C10 (three isError classes with exact message strings), gotchas 4–6
- `docs/findings/10-gap-analysis-and-contradictions.md` — C11 (explicit field selection, never spread)

## Interfaces

**Consumes:**
- `src/dsp.ts` — `MULAW_ENC`/`MULAW_DEC` tables (or Spec 06's actual exported table names), `Upsampler3x`, `Downsampler3x`, `createTranscoder(mode)`, `audioFormatsFor(mode)`.
- `src/tools.ts` — `fetchToolDefs()` mapping logic and `runTool()` (T07's exports; if the mapping is embedded in `fetchToolDefs` and needs a network-free entry point, test the pure mapping function T07 exported — or extract-and-reexport the minimal pure function, an authorized minimal refactor mirroring Spec 10 R5's seam clause).

**Produces:**
- `test/dsp.test.ts` — final vitest suite enforcing R3.1–R3.6 (supersedes/absorbs Spec 06's R12 suite content).
- `test/tool-mapping.test.ts` — R4.1–R4.4 coverage.
- `test/fixtures/list-tools-response.ts` (or inline const) — the findings/05 C8 verbatim `listTools()` fixture.

## Steps

- [ ] Read the References; open `src/dsp.ts` and the existing `test/dsp.test.ts` (T06's) and diff its coverage against Spec 10 R3's six assertions.
- [ ] Close every R3 gap in `test/dsp.test.ts`, keeping exact parameters from R3: round-trip exception `0x7F → 0xFF` asserted explicitly; ragged chunks `[100, 333, 481, 7, 480, 1000]` bit-identical both directions; 440 Hz/amp-8000 click detector (boundary jumps ≤ within-chunk jumps); tone fidelity at f ∈ {300, 1000, 2000, 3000} Hz via least-squares `A·sin + B·cos` projection over steady state (findings/06 gotcha 8 — the fractional group delay makes shifted-reference wrong), THD+N ≥ 60 dB and |gain| ≤ 1 dB below 3 kHz; bench guard < 500 µs per 20 ms frame; decimator phase counter — total output samples `=== floor(totalInput/3)` across non-divisible-by-3 chunk lengths including odd byte counts through `gatewayToTwilio`.
- [ ] Run `npx vitest run test/dsp.test.ts` — expect PASS (measured margins are huge: 83–99 dB, 21.4 µs). A failure means a real DSP regression or a wrong test — debug against findings/06 §Test strategy before touching `src/dsp.ts`.
- [ ] Write `test/tool-mapping.test.ts`: paste the findings/05 C8 `listTools()` fixture verbatim (keep `"execution": {"taskSupport": "forbidden"}` and `"$schema"`). Assert R4.1 (output keys exactly `type,name,description,parameters`, `type==='function'`, no `execution`/`title`/`annotations`/`_meta`), R4.2 (`$schema` stripped; `additionalProperties`/`properties` preserved), R4.3 (no-args tool's `{"type":"object","properties":{}}` passes through unchanged).
- [ ] Add R4.4 `runTool` tests with a stubbed MCP client object: (a) `isError:true` results for all three findings/05 C10 classes → `JSON.stringify({error: <joined text>})` returned, no throw; (b) thrown transport error → error-JSON string, no throw; (c) `arguments` reaches `callTool` as a parsed object; empty-string and `"{}"` payloads guarded (findings/05 gotchas 5–6). Include the 5 s timeout class only if `runTool`'s timeout is injectable/fake-timer-able (`vi.useFakeTimers()`); otherwise assert the timeout path via a never-resolving stub with a shortened injected timeout, or note it as untestable in the report.
- [ ] Run `npx vitest run test/tool-mapping.test.ts` — expect PASS.
- [ ] Run `npm test` — expect PASS repo-wide; run `npm run typecheck` — expect PASS.
- [ ] Commit: `test(dsp-tools): enforce R3 DSP assertions and R4 tool-mapping/runTool contracts` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Acceptance

Discharges Spec 10 **A2** (all six R3 assertions incl. bit-identical ragged-chunk continuity and ≥60 dB projection THD+N) and **A5** (`$schema`/`execution` never leak; all three isError classes produce error-JSON without throwing).

## Completion Report

```
Task: T10.3 — Status: DONE | BLOCKED(<why>)
Files changed: <list>
Commands run: vitest per-file → <results>; npm test → <n passed>
Spec A-numbers verified: A2, A5
R3 gaps found in T06's suite: <list or none>
Deviations from plan (incl. any authorized pure-function extraction in tools.ts): <none | list>
New interfaces exposed: <fixture path/name>
Notes for ledger: <1-2 lines>
```

# DB2 — RIO persona: `INSTRUCTIONS` + `GREETING_INSTRUCTIONS` rewrite

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Replace the two prompt constants in `src/gateway.ts` — the exported `INSTRUCTIONS` (`src/gateway.ts:241-244`) and the module-private `GREETING_INSTRUCTIONS` (`src/gateway.ts:248`) — with the RIO persona text from Demo Spec 01 (R3 and R11), preserving the test-asserted tool-preamble sentence verbatim, and add the four new acceptance tests (A3–A6) to `test/gateway.session-config.test.ts`. Prompt-text only: no tool code, no config keys, no session mechanics.

**All Global Constraints in docs/demo/specs/00-master-demo-plan.md §G bind every step of this plan.** Directly load-bearing here: **G4** (preamble sentence survives character-exact), **G3** (crisis numbers byte-identical), **G9** (no bridge/session files touched), **G12** (no fabricated phone numbers — the four crisis numbers are the only numbers in the prompt), **G13** (no placeholders), **G14** (this task owns exactly two files).

**Wave:** DB (task DB2) · **Depends on:** Wave DA complete at merge point M-A (specifically DA2 — the tool surface is frozen by master plan §4 regardless) · **Parallel with:** DB1 (knowledge tool) — disjoint files, never touch DB1's files · **Blocks:** M-B deploy gate

**References (read BEFORE writing any code):**
- `docs/demo/specs/00-master-demo-plan.md` — §3 (G1–G14), §4 "Tool surface" (the seven canonical names) and "Magic strings", §5 D8/D9/D10/D14, §8 (test rules incl. KF-1)
- `docs/demo/specs/01-persona-and-realtime-instructions.md` — ALL of it. R3 carries the complete replacement instruction text verbatim (this plan deliberately does not re-paste it); R11 carries the complete greeting string; A3–A8 are the acceptance criteria this plan discharges (A8 is human-run, not yours)
- `src/gateway.ts:236-248` (the two constants and their doc comments), `:259-279` (`buildCallSessionConfig` — read-only, consumes `INSTRUCTIONS` at `:265`), `:590-613` (`sendFirstFrames` — read-only, consumes `GREETING_INSTRUCTIONS` at `:605`)
- `test/gateway.session-config.test.ts` — the whole file; the mock-gateway harness pattern at `:77-122` is the template for the new A5 test; the untouchable assertions are at `:100-102`, `:103`, `:124-128`

## Files

| Action | Path |
|---|---|
| Modify | `src/gateway.ts` (ONLY the `INSTRUCTIONS` initializer at `:241-244`, the `GREETING_INSTRUCTIONS` initializer at `:248`, and their two doc comments at `:236-240` / `:246-247`) |
| Test (modify, additive only) | `test/gateway.session-config.test.ts` |

No file is created. Touching ANY other file — including `src/config.ts`, `src/mcp-server.ts`, `src/knowledge.ts`, `src/tools.ts`, `src/session.ts`, `src/twiml.ts`, `package.json` — fails Spec 01 A7 and G9/G14. `VOICE` default `'marin'` is untouched (Spec 01 R12).

## Interfaces

**Consumes (frozen by master plan §4 — do not re-derive):**
- The seven registered tool names, exactly: `ask_campus_knowledge`, `route_call`, `escalate_to_human`, `verify_identity`, `reset_password`, `send_sms`, `get_current_time` (Spec 01 R5; master §4 tool table).
- `ask_campus_knowledge` envelope statuses `ok` / `not_found` / `error` (Spec 01 R7) and `escalate_to_human` urgency value `"crisis"` (D10).
- The four crisis resources, byte-identical to G3: `(661) 654-3366` (after hours press 2), `988`, `(661) 654-2111` / 911 — these appear in the R3 Safety section only as the tool-failure backup.
- Mock-gateway test harness: `startMockGateway` from `test/gateway.mock.js`, `openGatewayLeg` / `INSTRUCTIONS` exports from `src/gateway.js` (already imported at `test/gateway.session-config.test.ts:4-5`).

**Produces (M-B and Spec 06 rely on these exact facts):**
- `export const INSTRUCTIONS` in `src/gateway.ts` = the Spec 01 R3 text, containing verbatim: the G4 preamble sentence (quoted in Step 4), `NEVER answer campus facts from memory`, the seven tool names, the crisis backup numbers.
- Module-private `const GREETING_INSTRUCTIONS` in `src/gateway.ts` = the Spec 01 R11 text, containing `I'm an AI assistant`, `everything I look up is simulated`, `RIO, the Roadrunner Intelligent Operator`, and the real accented `español`.
- 4 new tests in `test/gateway.session-config.test.ts` (file total 11 → 15); zero existing assertions changed.

## Steps

- [ ] **1. Read the references.** In particular re-read Spec 01 R2 and master G4 until you can state the survival rule from memory: the two assertions at `test/gateway.session-config.test.ts:100-102` and `:124-128` are never edited, weakened, or deleted, and must pass against the NEW text. Also note master §8 R8.5: the `voice === 'marin'` assertion at `:103` must appear unmodified in the diff.

- [ ] **2. Baseline sanity run:** `npx vitest run test/gateway.session-config.test.ts` → expect **11 passed** (current file). If not green, STOP and report BLOCKED — do not fix other tasks' breakage.

- [ ] **3. Write the four new tests** (failing first), appended to `test/gateway.session-config.test.ts` in a new `describe('RIO persona — instruction and greeting content (Demo Spec 01 A3–A6)', ...)` block. Vitest, node environment, no network beyond the local mock gateway (G10). Exact tests:
  1. **A3 content substrings** — `it('INSTRUCTIONS contains the RIO content anchors (A3)')`: assert `INSTRUCTIONS` contains each exact substring (one `expect(INSTRUCTIONS).toContain(...)` per item): `NEVER answer campus facts from memory`, `ask_campus_knowledge`, `route_call`, `escalate_to_human`, `verify_identity`, `reset_password`, `send_sms`, `get_current_time`, `C-S-U-B`, `REE-oh`, `not_found`, `(661) 654-3366`, `988`, `(661) 654-2111`, `Never switch languages based on accent alone`. (15 substrings — the Spec 01 A3 list, verbatim.)
  2. **A4 tool-mention parity** — `it('every snake_case token in INSTRUCTIONS is a registered tool name or not_found (A4)')`: `const allow = new Set(['ask_campus_knowledge','route_call','escalate_to_human','verify_identity','reset_password','send_sms','get_current_time','not_found']);` `const tokens = INSTRUCTIONS.match(/\b[a-z]+(_[a-z]+)+\b/g) ?? [];` assert `tokens.length > 0`; assert every token is in `allow`; assert the seven tool names are each present in `new Set(tokens)` (exact-coverage: all 7 named, nothing else); assert `INSTRUCTIONS` does not contain `hello` and does not contain `lookup_campus_info`.
  3. **A5 greeting content** — `it('greeting response-create instructions carry AI self-ID and simulated disclosure (A5)')`: clone the mock-gateway harness of the existing frame test (`test/gateway.session-config.test.ts:77-122` — same `startMockGateway`/`openGatewayLeg`/`waitUntil`/`finally`-cleanup shape, fresh unique `callSid`), wait for `mock1.frames.length >= 2`, take `frame2.options.instructions` as string, and assert it contains each of: `I'm an AI assistant`, `everything I look up is simulated`, `RIO, the Roadrunner Intelligent Operator`.
  4. **A6 size guard** — `it('INSTRUCTIONS stays under the 6000-character compactness budget (A6)')`: `expect(INSTRUCTIONS.length).toBeLessThan(6000);`

- [ ] **4. Run the targeted suite red:** `npx vitest run test/gateway.session-config.test.ts` → expect **12 passed, 3 failed**. The 3 failures are the new A3, A4, A5 tests (old prompt text lacks the anchors). The new A6 test passes trivially against the short old string — that is expected; it exists to guard the new text. Any OTHER failure means you broke an existing test — revert and redo Step 3.

- [ ] **5. Implement `INSTRUCTIONS`** (content task — the full text lives in the spec, do not compose your own): replace the entire initializer at `src/gateway.ts:241-244` with a single template literal containing exactly the Demo Spec 01 **R3** fenced text (spec lines 34–129), transcribed character-for-character with ONE mechanical transformation, sanctioned by R1's "whitespace-normalized" clause: **unwrap the spec document's hard line-wraps** — within each paragraph and each list item, join the wrapped continuation lines with a single space; keep the `#` section-header lines, blank lines, and `-`-bullet structure intact. This unwrap is mandatory, not stylistic: the spec block wraps mid-sentence, and the tests match contiguous substrings. After unwrapping, each of these MUST be a contiguous single-spaced substring:
  - the G4 preamble sentence, character-exact (opens the Tools section): `Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up').`
  - `NEVER answer campus facts from memory` (capitalized NEVER — Spec 01 R4)
  - `Never switch languages based on accent alone`
  - every A3 substring from Step 3.1.
  Straight ASCII apostrophes and quotes throughout (R1); the R3 text contains no backticks, so the template literal needs no escaping. Update the doc comment at `:236-240` to cite Demo Spec 01 R3 and the G4 survival rule; keep the const exported with the same name. Do not touch `buildCallSessionConfig`.

- [ ] **6. Implement `GREETING_INSTRUCTIONS`**: replace the initializer at `src/gateway.ts:248` with exactly the Demo Spec 01 **R11** one-line string (spec line 150), with the single substitution R11 mandates: write the real accented word `español` (UTF-8) where the spec's fenced block shows ASCII `espanol`. Everything else character-exact, including `Say exactly this greeting, then stop and listen:`, the quoted greeting, `I'm an AI assistant on a demo line - everything I look up is simulated`, and `I can help in English o en español`. The const stays module-private (no `export`). Update the comment at `:246-247` to cite Demo Spec 01 R11. Do not touch `sendFirstFrames` or the `WAIT_FOR_SESSION_UPDATED` mechanics (`:590-613`).

- [ ] **7. Run the targeted suite green:** `npx vitest run test/gateway.session-config.test.ts` → expect **15 passed, 0 failed**. The two G4 preamble assertions (`:100-102`, `:124-128`) now pass against the NEW text — if either fails, your unwrap in Step 5 broke the sentence (check for a stray newline or double space inside it); fix the constant, never the test.

- [ ] **8. Diff audit (Spec 01 A1/A7; master R8.5):** run `git diff test/gateway.session-config.test.ts` and confirm the diff is **purely additive** — no `-` lines except none, and lines 100-103 and 124-128 absent from the diff entirely. Run `git status --short` / `git diff --stat` and confirm exactly two files modified: `src/gateway.ts`, `test/gateway.session-config.test.ts`.

- [ ] **9. Byte-identity + hygiene greps (G3, R5):**
  - `grep -n "654-3366\|654-2111\|654-2782" src/gateway.ts` → the crisis numbers appear formatted exactly `(661) 654-3366` and `(661) 654-2111`; `654-2782` (operator) does NOT appear — it is not part of the R3 Safety backup.
  - `grep -c "hello" src/gateway.ts` → the count is unchanged from before your edit (the prompt adds no `hello`).
  - `grep -n "español" src/gateway.ts` → exactly one hit, in `GREETING_INSTRUCTIONS`.

- [ ] **10. Commit** (exact message):
  ```
  feat(persona): RIO instructions and AI self-ID greeting (Demo Spec 01)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Verify

Run all three; paste outcomes in the completion report:

1. `npx vitest run test/gateway.session-config.test.ts` → **15/15 pass**.
2. `npx vitest run` → zero failures other than the KF-1 pair (master §8 R8.1). Expected total: the M-A count recorded in `docs/demo/plans/LEDGER.md` **+ 4** (this task), which is strictly greater than the 356 pre-demo baseline + 4; if DB1 has already merged its tests, the total is higher still — the binding check is "no test lost, exactly 4 gained by this commit". **KF-1 rule:** if the ONLY failures are the two `test/harness.test.ts` barge-in tests, re-run `npx vitest run test/harness.test.ts`; 13/13 in isolation = pass, note it in the report. Any other failure blocks completion.
3. `npx tsc --noEmit` → clean (equivalently `npm run typecheck`).

## Acceptance

Discharges Demo Spec 01 **A1–A7** (A2's "356 pre-existing" reads per master D14). **A8** (live behavioral checks a–e) is human-run at H1 after M-B — out of scope here; do not attempt live calls.

## Completion Report

```
Task: DB2 — RIO persona (Demo Spec 01)
Status: <complete | blocked: reason>
Files changed: src/gateway.ts, test/gateway.session-config.test.ts
Commands run: <cmd → outcome, one line each, incl. all three Verify commands>
Spec 01 acceptance: A1 <p/f> A2 <p/f> A3 <p/f> A4 <p/f> A5 <p/f> A6 <p/f> A7 <p/f> (A8 deferred to H1)
Preamble assertions :100-102/:124-128 and voice assertion :103 unmodified: <confirmed via git diff>
INSTRUCTIONS.length: <n> (< 6000)
Deviations from plan: <none | list>
Notes for ledger: <≤3 lines>
```

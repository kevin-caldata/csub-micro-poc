# DA1 — CSUB corpus file, module-scope loader, corpus tests, and update guide

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Create the four Spec 04 deliverables — `assets/csub-corpus.md` (the ~30–50 KB simulated CSUB knowledge document), `src/corpus.ts` (module-scope loader exporting `CSUB_CORPUS`), `test/corpus.test.ts` (the seven R8 assertions), and `docs/demo/CORPUS-UPDATE-GUIDE.md` (the five R9 sections) — so Wave DB's `ask_campus_knowledge` tool has its grounding corpus and the maintainer has the edit→push→deploy loop documented.

All Global Constraints in `docs/demo/specs/00-master-demo-plan.md` §G bind every step of this plan. The ones this task directly exercises: **G3** (crisis numbers byte-identical everywhere), **G5** (corpus computed once at module scope — never inside a handler or builder), **G11** (whole-corpus, no RAG; the 4-line SIMULATED-DATA banner is never stripped), **G12** (phone allowlist, repo-wide — no fabricated dialable numbers), **G13** (no placeholders: no `TBD`/`TODO`/`XXX`/`lorem` anywhere), **G14** (this task touches ONLY the four files below).

**Wave:** DA (task DA1) · **Depends on:** nothing (offline; fully parallel with DA2/DA3) · **Blocks:** DB1 (Spec 03 imports `CSUB_CORPUS` per adjudication D1), merge point M-A

**References (read BEFORE writing anything):**
- `docs/demo/specs/00-master-demo-plan.md` — §3 (G3, G5, G11–G14), §4 magic strings (banner line 1, crisis numbers, topic enum), §5 D1, §8 test rules (baseline 356, KF-1), §9 dispositions 13–14 (SEARCH-SNIPPET values kept verbatim; en-dash time ranges confirmed en-dash-exact)
- `docs/demo/specs/04-corpus.md` — the whole spec; R2 (banner), R3 (fabrication rules + phone allowlist table), R4 (the twelve sections, headings byte-exact, per-section content requirements), R5 (prose style), R6 (loader code, given verbatim in the spec), R8 (test assertions), R9 (guide sections), acceptance A1–A9
- `src/fallback.ts:40-44` — the `import.meta.url` → `fileURLToPath` module-scope asset-load precedent (and the cwd-fragility comment at `src/fallback.ts:32-39` explaining WHY a bare relative path is forbidden)
- `src/mcp-server.ts:7-9` — `buildMcpServer()` constructs a fresh `McpServer` per `/mcp` request; this is why the file read must live at module scope, never in a handler (Spec 04 R6; findings/16 C15)
- `test/fallback-asset.test.ts` — the asset-test house style this repo uses (vitest node environment, `describe`/`it`, one assertion concern per `it()`)

## Files

| Action | Path |
|---|---|
| Create | `assets/csub-corpus.md` (sibling of `assets/fallback-apology.ulaw`) |
| Create | `src/corpus.ts` |
| Create | `docs/demo/CORPUS-UPDATE-GUIDE.md` |
| Test (create) | `test/corpus.test.ts` |

**No existing file is modified.** This task is additive-only (Spec 04 A6: "this spec adds files only, no edits to existing `src/` or `test/` files"). Do not touch `src/mcp-server.ts`, `package.json`, or anything under G9's frozen list.

## Interfaces

**Consumes:**
- `src/mcp-server.ts:7-9` per-request `buildMcpServer()` pattern — motivates R6's module-scope read; nothing is imported from it.
- `src/fallback.ts:40-44` — pattern precedent only.

**Produces (exact names — Wave DB and the master-plan §4 interface table rely on these):**
- `export const CSUB_CORPUS: string` from `src/corpus.ts` (import path from `src/` siblings: `./corpus.js`). Banner included; the ONLY export; no default export, no functions, no config reads (Spec 04 R6). Export name is `CSUB_CORPUS`, not `CORPUS` — adjudication D1.
- `assets/csub-corpus.md` — 30,000–51,200 bytes; R2 banner; twelve R4 `##` sections each tagged `<!-- topic: ... -->` from the eight-value vocabulary `directory_hours | financial_aid | registration | orientation | it_help | parking | events | other` (must equal Spec 03's `KNOWLEDGE_TOPICS` — master plan §4 tool table).
- Crisis numbers in corpus §9, byte-identical to G3's list: `(661) 654-3366`, `988`, `(661) 654-2111`, `(661) 654-2782` (plus 911).
- `docs/demo/CORPUS-UPDATE-GUIDE.md` with the five R9 headings.
- `test/corpus.test.ts` — 7 tests (raises the suite from the 356 baseline to 363).

## Steps

- [ ] **Read the References list above in full.** Confirm from Spec 04 R4 the exact twelve headings, their order, and each heading's topic tag; confirm from R3 the complete phone allowlist table (19 rows: 16 paren-form numbers plus `988`, `911`, `838255`); confirm from the master plan §9 items 13–14 that the Runner Rundown fees ($150/$105), the NextTech date (October 28, 2026), and en-dash time ranges are kept exactly as specified.

- [ ] **Write the failing test file `test/corpus.test.ts`** per Spec 04 R8 — vitest, node environment, style of `test/fallback-asset.test.ts`, importing `{ CSUB_CORPUS } from '../src/corpus.js'`. Seven `it()` blocks, one per R8 item:
  1. `Buffer.byteLength(CSUB_CORPUS, 'utf8')` is ≥ 30000 and ≤ 51200.
  2. First line is exactly `# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA` (em dash U+2014, not a hyphen) and the first four lines equal the R2 banner verbatim (copy the four lines character-for-character from Spec 04 R2 — they are the byte-exact contract).
  3. All twelve R4 `##` headings present, in R4 order (ascending `indexOf`), and exactly twelve lines start with `## ` (the banner's lines start `# `, so they don't collide).
  4. Each heading's next non-empty line is its R4 `<!-- topic: ... -->` tag, and every tag value is one of the eight enum values listed under Interfaces above.
  5. Safety spot checks: `(661) 654-3366`, `(661) 654-2111`, `988`, `(661) 654-2782`, and `NEVER share your Duo code` all appear.
  6. Allowlist: every match of `/\(\d{3}\) \d{3}-\d{4}/g` over `CSUB_CORPUS` is a member of the R3 allowlist. Encode the allowlist's 16 paren-form entries in the test (the regex cannot match the short codes `988`/`911`/`838255`, so they are not in the checked set). Copy the numbers from the Spec 04 R3 table — do not retype from memory.
  7. Summer-hours anchors: the strings `7 AM–6 PM` and `closed noon–1 PM` appear (en dash U+2013 in both — master plan §9 item 14 makes these en-dash-exact).

- [ ] **Run the test — expect failure**: `npx vitest run test/corpus.test.ts` → fails at import time (`Cannot find module '../src/corpus.js'` / failed to resolve), 0 tests pass.

- [ ] **Author `assets/csub-corpus.md`** — the content task. The spec carries the complete section-by-section requirements; write the file per, in this order of authority:
  - **R2** — the four banner lines first, byte-exact, nothing above them (no BOM, no blank line, no front matter).
  - **R4** — exactly twelve `##` sections, headings byte-exact and in R4 order, each heading immediately followed on the next line by its `<!-- topic: ... -->` tag. Every bracketed findings/13 fact, every "Fabricate:" directive, the §9 opening marker line (`Note: for a caller in distress, RIO escalates directly; this section is reference information.`), the verbatim Duo warning sentence in §3, and the per-section ~KB targets are all in R4 — follow them section by section. R4's targets sum to ~34.5 KB; aim for roughly 36–42 KB total so the file sits comfortably inside the 30,000–51,200-byte bounds.
  - **R3** — fabrication discipline: VERIFIED facts verbatim; phone numbers ONLY from the allowlist table (fabricated offices point to (661) 654-2782 or an email); SEARCH-SNIPPET/UNVERIFIED specifics get plausible fabricated values stated confidently (no per-fact hedging — the banner is the disclosure); crisis lines only from the verified R3 rule-4 list.
  - **R5** — prose style: short spoken-friendly sentences; bullets allowed, **no markdown tables**; bare URLs only; digit-form phone numbers `(661) 654-3036`; spelled-out dates `August 24, 2026`; en-dash time ranges `8 AM–5 PM`; every section self-contained (no cross-references); warm student-success register; American English.
  - No `TBD`/`TODO`/`XXX`/`lorem` anywhere (G13; Spec 04 A9).
  - Check the size before moving on: `(Get-Item assets/csub-corpus.md).Length` → must print a value in [30000, 51200]. If short, expand the fabricated portions (distractor sections 1, 10, 12 are the designed flex room); if long, tighten prose — never delete a required fact.

- [ ] **Create `src/corpus.ts`** per Spec 04 R6 — the spec gives the module verbatim (imports, `CORPUS_PATH` via `fileURLToPath(new URL('../assets/csub-corpus.md', import.meta.url))`, single `export const CSUB_CORPUS: string = readFileSync(CORPUS_PATH, 'utf8')`, plus the two explanatory comments). Transcribe it from R6; keep the comments (they encode the G5 rationale and the `src/fallback.ts:40-44` precedent). Do NOT add a default export, a trim/strip step, an env read, or an existence guard — a missing file must crash at import (R6 fail-fast policy).

- [ ] **Run the test — expect pass**: `npx vitest run test/corpus.test.ts` → 7 passed, 0 failed. If assertion 1 fails on size or 6 on an unlisted number, fix the corpus, not the test.

- [ ] **Typecheck**: `npx tsc --noEmit` → clean.

- [ ] **Write `docs/demo/CORPUS-UPDATE-GUIDE.md`** per Spec 04 R9 — exactly these five `##` headings, verbatim and in order: `## What this file is`, `## How to update`, `## Style rules for new content`, `## Size ceiling`, `## Never edit these`. Every listed point in R9.1–R9.5 must appear; in particular:
  - R9.2's deploy warning, verbatim in the guide: `Every deploy restarts the process and severs any in-flight calls — push during a quiet window, not while someone is demoing.`
  - R9.3 reproduces the full R3 phone-allowlist table and states the never-invent-a-number rule.
  - R9.4 contains the strings `50 KB` and `100 KB` and describes the deferred `topic` pre-filter seam (handler-only change keyed on the tool's optional `topic` arg + the `<!-- topic: ... -->` tags — documented, NOT implemented, per G11).
  - R9.5 names the four banner lines, the crisis numbers (shared with `escalate_to_human` — the two surfaces must never disagree, G3), and the twelve headings + tags as test-pinned.
  - No placeholders (G13).

- [ ] **Static acceptance sweep** (Spec 04 A1–A5, A7, A9), all from repo root:
  - A1/A2: `(Get-Item assets/csub-corpus.md).Length` in bounds; `Get-Content assets/csub-corpus.md -TotalCount 4` prints the R2 banner byte-exact.
  - A3/A4: covered by the passing tests (headings/order/tags; allowlist subset; crisis strings).
  - A5: grep `csub-corpus` across `src/` → only `src/corpus.ts`; `src/corpus.ts` contains `import.meta.url` and `../assets/csub-corpus.md` and exports `CSUB_CORPUS`; no other file both references `csub-corpus` and calls `readFileSync`.
  - A7: guide has the five R9 headings verbatim, the deploy-warning sentence, the allowlist table, and the strings `50 KB`, `100 KB`, `topic` in the Size ceiling section.
  - A9: grep `assets/csub-corpus.md` and `docs/demo/CORPUS-UPDATE-GUIDE.md` for `TBD`, `TODO`, `XXX`, `lorem` → zero matches.

- [ ] **Boot fail-fast check** (Spec 04 A8): `npm run build`; temporarily rename `assets/csub-corpus.md`; run `node --input-type=module -e "await import('./dist/corpus.js')"` → must exit non-zero with `ENOENT`; **restore the file**; re-run `npx vitest run test/corpus.test.ts` to confirm restoration (7 passed).

- [ ] **Commit** (only the four created files staged — G14):
  ```
  feat(corpus): simulated CSUB knowledge corpus, module-scope loader, tests, and update guide

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Verify

- `npx vitest run test/corpus.test.ts` → 7 passed.
- `npx vitest run` → 363 passed expected (356 baseline + 7 new), **zero skips introduced**. KF-1 rule (master plan §8): if the ONLY failures are the two `test/harness.test.ts` barge-in timing tests, re-run `npx vitest run test/harness.test.ts` — 13/13 in isolation means the gate passes (note it in the completion report); any other failure blocks.
- `npx tsc --noEmit` → clean.

## Acceptance

Discharges Spec 04 **A1–A9** in full. Leaves for later waves: `CSUB_CORPUS` consumption by `src/mcp-server.ts`/`src/knowledge.ts` (Spec 03, Wave DB, per D1 and Spec 04 R7 — this task imports it only from the test file); the M-B crisis-number byte-identity spot check across `src/gateway.ts`/`src/mcp-server.ts`/`assets/csub-corpus.md` (orchestrator, needs DA2+DB2 landed).

## Completion Report

```
Task: DA1 — corpus file, loader, tests, update guide
Status: <complete | blocked: reason>
Files created: <list — must be exactly the four declared files>
Commands run: <cmd → outcome, one line each, incl. full-suite count and any KF-1 isolation re-run>
Spec 04 acceptance verified: A1 <p/f> A2 <p/f> A3 <p/f> A4 <p/f> A5 <p/f> A6 <p/f> A7 <p/f> A8 <p/f> A9 <p/f>
Corpus byte size: <n>
Deviations from plan: <none | list>
New interfaces exposed: CSUB_CORPUS (src/corpus.ts, import as './corpus.js')
Notes for ledger: <≤3 lines>
```

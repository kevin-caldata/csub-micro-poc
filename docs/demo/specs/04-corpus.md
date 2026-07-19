# Demo Spec 04 — CSUB Knowledge Corpus + Update Workflow

Date: 2026-07-19 · Project: CSUB-RIO Self-Serve Demo · Status: Draft for review
Depends on: base PoC Spec 07 (`buildMcpServer()` per-request pattern, `src/mcp-server.ts`) — nothing else; this spec has no runtime dependencies on the other demo specs.
Enables: the `ask_campus_knowledge` delegated-intelligence tool spec (consumes `CSUB_CORPUS`), the persona/instructions spec (three-lane answering policy assumes this corpus is the only source of campus facts), the announcement-email spec (RIO self-description in §12 must match the email copy).
Findings referenced: findings/17 (§1 whole-corpus strategy, §2.4 answering prompt shape, §3 content plan + banner, §5.3 `topic` seam), findings/16 (C15 module-scope load precedent, C16 prompt-stuffing math, C18 why the corpus stays behind the MCP boundary), findings/13 (all vocabulary, numbers, and VERIFIED/SEARCH-SNIPPET/UNVERIFIED flags).

---

## Objective

When this spec is done, the repo contains `assets/csub-corpus.md` — a ~30–50 KB, 12-section, fake-but-authentic CSUB knowledge document with a SIMULATED-DATA banner on top — plus a tiny loader module `src/corpus.ts` that reads it **once at module scope** and exports it as a string const, and `docs/demo/CORPUS-UPDATE-GUIDE.md` documenting the edit → push → auto-deploy update loop. The corpus is pure DATA: the `ask_campus_knowledge` handler prompt-stuffs the whole string into every flash-model call (no retrieval, no chunking, no external fetch) [findings/17 §1.5; findings/16 C16]. Updating campus knowledge is a markdown edit and a git push — zero code changes.

The corpus never enters the realtime context. It is read only by the delegated text model behind the MCP boundary; only the caller's question and a 2–3-sentence answer cross into the realtime session [findings/16 C18].

## Deliverables

- `assets/csub-corpus.md` — the corpus document (new file; sibling of the existing `assets/fallback-apology.ulaw`).
- `src/corpus.ts` — the loader module exporting `CSUB_CORPUS` (new file).
- `test/corpus.test.ts` — loader + content-shape tests (new file; follows the `test/fallback-asset.test.ts` asset-test precedent).
- `docs/demo/CORPUS-UPDATE-GUIDE.md` — the maintainer's update guide (new file).

## Requirements

### The corpus file — `assets/csub-corpus.md`

**R1 (location, format, size).** One markdown file at `assets/csub-corpus.md`, UTF-8, LF or CRLF (loader is agnostic — R8 reads it as `utf8` text). Total size **≥ 30,000 bytes and ≤ 51,200 bytes** (the ~30–50 KB envelope: 12 sections × ~2–6 KB each ≈ 7k–13k tokens, one to two orders of magnitude below every published stuff-vs-retrieve threshold) [findings/17 §1.1–1.5, §3]. Sections use `##` headers with clear delimiting — structure aids long-context recall [findings/17 §1.2].

**R2 (SIMULATED-DATA banner).** The file MUST begin with these four lines, verbatim (they are both an internal marker and a model-visible grounding aid, and they must survive into the model prompt — never stripped) [findings/17 §3]:

```
# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA
# All content below is FABRICATED for the RIO proof-of-concept. It imitates
# CSUB's real vocabulary but specific hours, dates, fees, and names may be
# fictional. Never present this as verified CSUB information outside the demo.
```

Line 1 is byte-exact `# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA` (em dash, not hyphen). Nothing precedes the banner — no front matter, no blank line above it.

**R3 (fabrication rule).** Every fact in the corpus follows exactly one of these four rules, keyed to the confidence flags in findings/13:

1. **[VERIFIED] items may be used verbatim** — names, numbers, addresses, URLs, the ITS summer schedule, the fall-2026 academic-calendar dates, the MyID/Duo flow wording [findings/13 claims 1–6, 10–11, 16–18, 20–23, 24–25 (calendar dates), 27 (graduation date)].
2. **Phone numbers are NEVER invented.** Every phone number in the corpus must appear in the allowlist below (all drawn from findings/13, any confidence tier — a fabricated number could be a real person's line). If a fabricated office needs a contact, point to the main operator line (661) 654-2782 or an email address instead of inventing a number.
3. **Specifics findings/13 flags [SEARCH-SNIPPET] or [UNVERIFIED] get FABRICATED plausible values** — per-office hours (findings/13 "Unverified" note: departmental hours are not listed on the real contact page), fee amounts beyond the Runner Rundown fees, session dates beyond the verified calendar, event details, staff names (invent none, or use obviously-generic role titles like "your assigned advisor"). Fabricated values must be plausible for Bakersfield/late-summer-2026 and stated with the same confidence as real ones — the banner (R2) is what marks them simulated, not per-fact hedging.
4. **Safety lines use ONLY the verified crisis list** (never fabricated, never paraphrased into different numbers): Counseling Center **(661) 654-3366** (after hours: call and press 2 to reach a crisis counselor), **988** Suicide & Crisis Lifeline (call or text, free, 24/7), UPD emergency **911 or (661) 654-2111**, UPD non-emergency **(661) 654-2677**, main operator **(661) 654-2782** [findings/13 claims 20–22].

**Phone/short-code allowlist** (the complete set of dialable strings permitted anywhere in the corpus; digit forms shown are the canonical corpus spelling — mnemonic forms like "654-CSUB (2782)" and "654-HELP (4357)" may appear in addition to, never instead of, the digit form):

| Number | Owner | findings/13 claim |
|---|---|---|
| (661) 654-2782 | Main operator (654-CSUB) | 1 |
| (661) 654-3036 | Admissions & Registrar | 2, 3 |
| (661) 654-3016 | Financial Aid & Scholarships | 4 |
| (661) 654-3225 | Student Financial Services | 4 |
| (661) 654-4357 | ITS Service Center (654-HELP) | 5 |
| (661) 654-2394 | Student Health Services | 6 |
| (661) 654-2677 | Parking / UPD non-emergency | 8, 20 |
| (661) 654-3988 | Icardo Center Box Office | 9 |
| (661) 654-2266 | Human Resources | 10 |
| (661) 654-3360 | Services for Students with Disabilities | 10 |
| (661) 654-3172 | Stiern Library checkout | 10 |
| (661) 654-3231 | Stiern Library research | 10 |
| (661) 654-2111 | UPD emergency | 20 |
| (661) 654-3366 | Counseling Center | 21 |
| (661) 654-3425 | ITS security line | 18 |
| (800) 700-4417 | Parking Management Bureau | 8 |
| 988 | Suicide & Crisis Lifeline | 22 |
| 911 | Emergency | 20 |
| 838255 | Veterans Crisis Line text | 22 |

**R4 (the 12 sections — content outline).** Exactly twelve `##` sections, in this order, each heading byte-exact as listed, each immediately followed (next line) by an HTML topic-tag comment `<!-- topic: <value> -->` where `<value>` is one of the `ask_campus_knowledge` `topic` enum values (`directory_hours | financial_aid | registration | orientation | it_help | parking | events | other`) — this pre-wires the >100 KB section pre-filter seam with zero tool-schema change [findings/17 §5.3]. Per-section requirements (findings/13 claim numbers in brackets; "fabricate" = R3 rule 3):

1. **`## Campus directory and department hours`** `<!-- topic: directory_hours -->` (~4 KB target)
   Main line (661) 654-2782 (654-CSUB); address 9001 Stockdale Highway, Bakersfield, CA 93311 [1]. Admissions: Student Services Building, room 47 SA, (661) 654-3036, admissions@csub.edu [2]. Office of the Registrar: same building/room/phone, registrar@csub.edu; handles transcripts, enrollment verifications, grades [3]. Financial Aid & Scholarships: (661) 654-3016, finaid@csub.edu; Student Financial Services (billing/refunds — a separate office): (661) 654-3225, sfs@csub.edu [4]. Student Health Services: building 28 HC, (661) 654-2394 [6]. Distractor entries: Human Resources, Administration 108 B, (661) 654-2266; Services for Students with Disabilities, 55 SA, (661) 654-3360; Stiern Library checkout (661) 654-3172 / research help (661) 654-3231 [10]. Use the native building-code format everywhere: "47 SA", "28 HC", "108 B" [11]. **Fabricate** per-office hours for each entry (e.g., Mon–Fri 8:00 AM–5:00 PM with a plausible summer variation) — real hours are unlisted [findings/13 Unverified note].

2. **`## ITS Service Center help desk`** `<!-- topic: it_help -->` (~3 KB target)
   (661) 654-4357 (654-HELP); walk-up counter Walter W. Stiern Library, Room 13, lower level; ServiceCenter@csub.edu; ServiceNow portal csub.service-now.com. Regular hours: phone 7 AM–6 PM Mon–Thu and 7 AM–5 PM Fri; walk-up 8 AM–5 PM Mon–Fri. **Summer hours (state these as currently in effect — seasonally correct for the demo window)**: phone 7 AM–6 PM Mon–Thu only; walk-up 8 AM–5 PM Mon–Thu, closed noon–1 PM for lunch. All VERIFIED — use verbatim, do not fabricate anything in this section [5].

3. **`## NetID, MyID password reset, and Duo 2-Step`** `<!-- topic: it_help -->` (~5 KB target)
   Identity vocabulary: NetID (username), MyID (self-service portal, myid.csub.edu), myCSUB (student portal/PeopleSoft), Duo 2-Step (MFA); NetID lookup at csub.edu/lookup [16]. Password-reset walkthrough mirroring the real flow: go to myid.csub.edu → enter NetID, click "Go" → select "Forgot Password / Activate Account" → an authorization code is emailed to the personal email on file → enter code → set a new password of 11–255 characters meeting 3 of 4 complexity requirements [17]. Duo: protects Microsoft 365, myCSUB, Canvas, PeopleSoft, and 30+ single-sign-on services (Box, Slack, Zoom, ServiceNow); device management via the "Duo Self Service Device Management Portal"; "Duo Verified Push" is the enhanced option; lost phone with no backup device → call the Service Center at (661) 654-4357; ITS security line (661) 654-3425; include the warning sentence **"NEVER share your Duo code with anyone."** verbatim (it grounds RIO refusing a read-aloud Duo code) [18]. Mention that support tickets live in ServiceNow with numbers formatted like INC0012345 (fabricated example) [19].

4. **`## Financial aid dates and disbursement`** `<!-- topic: financial_aid -->` (~4 KB target)
   Fall 2026 disbursement begins the week before classes start — the week of August 17, 2026; aid auto-applies to the student account balance first; leftover credit refunds via BankMobile Disbursements ("Manage My Refunds" in myCSUB); direct deposit arrives about 2–3 business days after disbursement [26]. Contacts: Financial Aid (661) 654-3016; refunds/billing questions to Student Financial Services (661) 654-3225 [4]. **Fabricate**: a FAFSA priority deadline for 2027–28, a verification-documents deadline, a "check your To Do List in myCSUB" status walkthrough, and a tuition payment-plan blurb [27].

5. **`## Registration and the fall 2026 academic calendar`** `<!-- topic: registration -->` (~3 KB target)
   All VERIFIED calendar facts, verbatim: first day of classes Monday, August 24, 2026; last day to add September 2; Census Day September 21 [23]. Registration windows already open: continuing students since April 6; new transfer/postbaccalaureate since June 1; new first-time freshmen since June 29 [24]. Fall 2026 graduation-application deadline was July 3, 2026 (now passed — direct late askers to the Registrar) [27]. **Fabricate**: one short generic paragraph each on registration holds (check myCSUB, contact the owning office) and waitlists.

6. **`## Runner Rundown new student orientation`** `<!-- topic: orientation -->` (~3.5 KB target)
   CSUB's orientation program is branded "Runner Rundown"; sessions run from July 6, 2026 [25]. Fees: $150 freshman / $105 transfer, due the Thursday before classes start; sign up via the myCSUB To Do List [25 — fees are SEARCH-SNIPPET; keep these values, they are already in the fake zone]. **Fabricate**: the remaining late-July/August session dates (2–3 specific dates), session length and format (e.g., one full day, campus tour + advising + ID card), and a what-to-bring list.

7. **`## Parking and permits`** `<!-- topic: parking -->` (~3.5 KB target)
   Parking sits under University Police: (661) 654-2677, parking@csub.edu; permits are fulfilled through the external Parking Management Bureau, (800) 700-4417, mycampuspermit.com [8]. **Fabricate**: fall-semester permit prices (student/employee/motorcycle), a daily-permit price, 2–3 lot names using the real "Lot E"-style vocabulary [21 places the Counseling Center near Parking Lot E], and a one-line citation-appeal pointer (appeal online via the Parking Management Bureau).

8. **`## Academic advising by college`** `<!-- topic: other -->` (~3 KB target)
   There is no single advising phone line. Name the real centers: NSME Student Advising and Success Center, SSE Advising Center, Arts & Humanities Student Center, and the Academic Advising & Resource Center (AARC); students find their assigned staff advisor in the myCSUB portal [7]. The section must teach the answer shape "ask the caller's major, then direct them to that college's center." **Fabricate** advising-center hours; do **not** invent advising phone numbers — direct callers to the main operator (661) 654-2782 or myCSUB instead (R3 rule 2).

9. **`## Counseling and crisis resources`** `<!-- topic: other -->` (~2.5 KB target — GROUNDING-ONLY)
   Open the section with this exact marker line (a corpus-internal note, harmless if the model reads it): `Note: for a caller in distress, RIO escalates directly; this section is reference information.` Live crisis handling is the tier-1 `escalate_to_human` static tool — LLM-free, never routed through this corpus [findings/17 §4.5]; this section exists only so knowledge questions ("what counseling services does CSUB have?") ground correctly. Content, ALL from the R3 rule-4 verified list, nothing fabricated: CSUB Counseling Center, Rivendell building on the west side of campus near Parking Lot E, (661) 654-3366, Mon–Fri 8 AM–5 PM; after hours call (661) 654-3366 and press 2 at the voicemail to reach a crisis counselor [21]; 988 Suicide & Crisis Lifeline — call or text 988, free, 24/7, confidential; Veterans Crisis Line: 988 then press 1, or text 838255 [22]; immediate danger: 911 or UPD (661) 654-2111 [20].

10. **`## Campus events, late summer 2026`** `<!-- topic: events -->` (~3.5 KB target — FULLY FABRICATED events)
    Invent 2–3 events in house style [14]: a "Future 'Runner Day" campus-preview day (fabricated August date), a Rowdy the Roadrunner meet-and-greet at the Icardo Center (fabricated date), and a Stiern Library workshop series (fabricated weekly schedule). Each event gets a date, time, location, and one-sentence description. Tickets/venue pointer: Icardo Center Box Office (661) 654-3988, tickets@csub.edu, gorunners.com/tickets [9].

11. **`## NextTech Kern conference`** `<!-- topic: events -->` (~3 KB target)
    CSUB's emerging-tech and AI conference: next edition Wednesday, October 28, 2026, on campus; Professional and Student tracks; early-bird registration $75 through September 28; nexttechkern@csub.edu; first held October 2025 [28 — the date is SEARCH-SNIPPET-flagged; keep it, the banner marks it simulated]. Include the flavor line that CSUB frames the event as connecting "global innovation with regional opportunity" [15]. **Fabricate**: a one-paragraph schedule outline (keynote, breakout tracks, student showcase) and a registration-steps blurb.

12. **`## About RIO and CSUB basics`** `<!-- topic: other -->` (~3 KB target)
    RIO stands for Roadrunner Intelligent Operator: an AI phone assistant demo for CSUB; **every fact RIO gives comes from simulated demo data**; RIO always identifies itself as an AI when asked (this paragraph must be consistent with the RIO self-description in docs/demo/RIO-ANNOUNCEMENT-EMAIL.md — the email spec owns that copy; on conflict the email wins and this section is edited to match). Campus basics: 9001 Stockdale Highway, Bakersfield, CA 93311; main operator (661) 654-2782 [1, 10]. Mascot: Rowdy the Roadrunner, chosen by student vote in November 1970 (368–15), voted No. 1 mascot of the 2016 NCAA Men's Basketball Tournament field [12]. School colors: blue and gold [13]. House vocabulary: "'Runner Nation", "Go 'Runners!", RunnerConnect, the student paper *The Runner* [14].

Sections 1, 10, and 12 deliberately double as distractors — corpus material no scripted scenario needs — so free-form self-serve calls feel alive rather than on-rails [findings/17 §3].

**R5 (corpus prose style).** The answering model quotes this text aloud over a phone line [findings/17 §2.4], so:
- Short plain sentences; bullets allowed; **no markdown tables** inside sections (the model mangles them into speech); no images, no links-as-markdown (bare URLs like `myid.csub.edu` are fine — callers hear them as "my I D dot C S U B dot E D U").
- Phone numbers always in digit form `(661) 654-3036` (mnemonic form may follow in parentheses); dates spelled out `August 24, 2026`; times as `8 AM–5 PM`.
- Each section self-contained: no "see the section above" cross-references — restate a fact where it is needed (the whole corpus is always in the prompt, but self-containment keeps the §5.3 pre-filter seam viable).
- American English; warm, factual, student-success register matching campus communications tone [findings/13 claim 15]; never hedge individual facts ("we think", "probably") — the R2 banner carries the simulation disclosure.

### The loader — `src/corpus.ts`

**R6 (module-scope load, `import.meta.url` pattern).** New module `src/corpus.ts`, verbatim apart from the comment text:

```ts
// src/corpus.ts — module-scope corpus load (demo Spec 04 R6).
// Path resolved from import.meta.url, NOT cwd — `assets/` is a sibling of both `src/` (tsx dev)
// and `dist/` (built), so '../assets/...' is correct in both layouts regardless of launch dir.
// Precedent: src/fallback.ts:40-44 (CLIP_PATH / defaultClipB64) and its cwd-fragility comment.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CORPUS_PATH = fileURLToPath(new URL('../assets/csub-corpus.md', import.meta.url));

/**
 * Loaded ONCE at module scope. buildMcpServer() constructs a fresh McpServer per request
 * (src/mcp-server.ts:8), so a read inside the tool handler or builder would re-run per call —
 * the read MUST stay here [findings/16 C15]. Includes the SIMULATED-DATA banner; consumers
 * must never strip it [findings/17 §3].
 */
export const CSUB_CORPUS: string = readFileSync(CORPUS_PATH, 'utf8');
```

Rules this encodes, each independently checkable:
- Path resolution via `import.meta.url` with `'../assets/csub-corpus.md'` — never a cwd-relative bare path (`node dist/server.js` from any non-repo-root directory would `ENOENT`-crash at boot; see the fragility comment at src/fallback.ts:32-39) [findings/16 C15].
- `readFileSync(..., 'utf8')` exactly once, at module top level — **never** inside `buildMcpServer()` or a tool handler, because `buildMcpServer()` runs per `/mcp` request (fresh `McpServer` per request is SDK-enforced, src/mcp-server.ts:7-9) [findings/16 C15].
- Single export: `CSUB_CORPUS: string`. No default export, no functions, no config reads — this module must stay import-safe from tests and from `src/mcp-server.ts` with zero side effects beyond the one file read.
- A missing/unreadable corpus file is a **boot-time crash by design** (same policy as the fallback clip): a deploy without the corpus must fail fast on Railway, not serve a knowledge tool with an empty string.

**R7 (consumption contract — enforced here, implemented elsewhere).** `src/mcp-server.ts` (or wherever the `ask_campus_knowledge` handler lives per the delegated-tool spec) imports `{ CSUB_CORPUS } from './corpus.js'` at module top and closes over it in the handler. Grep-checkable invariants this spec owns: the string `csub-corpus` appears in exactly one `src/` file (`src/corpus.ts`), and `readFileSync` for the corpus appears nowhere else. Corpus-first prompt order (corpus before the question, question last, for implicit caching and long-context recall [findings/17 §1.2, §2.4]) is the delegated-tool spec's requirement; this spec only guarantees the banner is inside `CSUB_CORPUS` so that ordering carries it.

### Tests — `test/corpus.test.ts`

**R8 (loader/content tests).** New vitest file (node environment, like the existing `test/fallback-asset.test.ts` asset precedent) with at least these assertions, each its own `it()`:
1. `CSUB_CORPUS` is a string of length ≥ 30,000 and ≤ 51,200 (bytes ≈ length here; assert on `Buffer.byteLength(CSUB_CORPUS, 'utf8')` to be exact).
2. The first line is exactly `# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA` and the first four lines match the R2 banner verbatim.
3. All twelve R4 `##` headings are present, in R4 order (assert ascending `indexOf`), and exactly twelve lines start with `## `.
4. Each heading's next non-empty line is its R4 `<!-- topic: ... -->` tag, and every tag value is one of the eight enum values.
5. Safety-number spot checks: the strings `(661) 654-3366`, `(661) 654-2111`, `988`, `(661) 654-2782`, and `NEVER share your Duo code` all appear.
6. Phone allowlist: every match of `/\(\d{3}\) \d{3}-\d{4}/g` in `CSUB_CORPUS` is a member of the R3 allowlist (encode the allowlist in the test).
7. Summer-hours grounding check: the strings `7 AM–6 PM` and `closed noon–1 PM` (ITS summer schedule, the one verified-hours anchor) appear.

### The update guide — `docs/demo/CORPUS-UPDATE-GUIDE.md`

**R9 (guide content).** A maintainer-facing markdown doc with exactly these five `##` sections (headings verbatim; prose may be expanded but every listed point must be present):

1. **`## What this file is`** — `assets/csub-corpus.md` is the single source of campus knowledge for RIO's `ask_campus_knowledge` tool; the whole file is sent to the answering model on every knowledge question (no retrieval); it is loaded once at process boot by `src/corpus.ts`; all content is simulated demo data per the top-of-file banner.
2. **`## How to update`** — the loop: (1) edit `assets/csub-corpus.md`; (2) run `npm test` locally (the corpus test enforces banner/size/structure); (3) commit and push to `main`; (4) Railway auto-deploys in about 2 minutes; (5) call the demo line and ask a question that exercises the change. **Warning, stated verbatim in the guide: "Every deploy restarts the process and severs any in-flight calls — push during a quiet window, not while someone is demoing."**
3. **`## Style rules for new content`** — restate R5 (spoken-style prose, digit phone format, spelled-out dates, no tables, self-contained sections) plus: new sections get a `##` heading and a `<!-- topic: ... -->` tag from the eight-value enum; new facts follow the R3 fabrication rule; **phone numbers only from the allowlist — never invent a dialable number** (reproduce the R3 allowlist table in the guide).
4. **`## Size ceiling`** — keep the file ≤ 50 KB (the test fails above 51,200 bytes; raise the test bound only together with a latency re-measurement, since the M3 gate `toolTotalMs < 1500 ms` must keep passing). If content needs ever push past ~100 KB, do **not** bolt on retrieval ad hoc: the designed upgrade is a per-topic section pre-filter inside the `ask_campus_knowledge` handler keyed on the tool's existing optional `topic` argument and the per-section `<!-- topic: ... -->` tags — a handler-only change, no tool-schema change, no new dependencies [findings/17 §1.5, §5.3]. That work is explicitly deferred until the ceiling is actually hit.
5. **`## Never edit these`** — the four R2 banner lines (byte-exact, first lines of the file); the crisis numbers in the counseling section (changes only with a re-verified source, since `escalate_to_human` speaks the same numbers and the two surfaces must never disagree); the twelve section headings and their topic tags (tests pin them — adding a 13th section means updating `test/corpus.test.ts` in the same commit).

## Interfaces

Consumed from elsewhere:
- `src/mcp-server.ts` `buildMcpServer()` per-request construction (src/mcp-server.ts:7-9) — the reason R6 mandates module-scope loading; nothing else is consumed.

Produced for other specs (exact facts other specs must agree with):
- File `assets/csub-corpus.md` — data only; 30,000–51,200 bytes; R2 banner; twelve R4 sections with `<!-- topic: ... -->` tags.
- Module `src/corpus.ts` exporting exactly `export const CSUB_CORPUS: string` (banner included; consumers must not strip it). Import path from `src/`: `./corpus.js`.
- Topic tag vocabulary (must equal the `ask_campus_knowledge` `topic` enum in the delegated-tool spec): `directory_hours`, `financial_aid`, `registration`, `orientation`, `it_help`, `parking`, `events`, `other` [findings/17 §5.3].
- Crisis numbers shared with the `escalate_to_human` static tool (its spoken lines must match §9 of the corpus): Counseling (661) 654-3366 (press 2 after hours), 988, UPD (661) 654-2111, operator (661) 654-2782.
- Doc `docs/demo/CORPUS-UPDATE-GUIDE.md` with the five R9 headings.
- Test file `test/corpus.test.ts`.

This spec produces **no env keys, no config changes, no tool registrations, and no runtime behavior** beyond the one module-scope file read. `MCP_MODEL_ID` / `MCP_MODEL_MAX_TOKENS` / `MCP_TOOL_TIMEOUT_MS` and the `{status, response_text}` envelope belong to the delegated-tool spec.

## Acceptance criteria

- **A1 (file + size):** `assets/csub-corpus.md` exists; `(Get-Item assets/csub-corpus.md).Length` is ≥ 30000 and ≤ 51200.
- **A2 (banner):** `Get-Content assets/csub-corpus.md -TotalCount 4` returns the four R2 lines byte-exact; line 1 is `# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA`.
- **A3 (sections):** the file contains exactly twelve lines beginning `## `, matching the R4 headings verbatim and in R4 order, each followed by its `<!-- topic: ... -->` tag.
- **A4 (phone discipline):** extracting all `(\d{3}) \d{3}-\d{4}` matches from the corpus yields a set that is a subset of the R3 allowlist; the four crisis-number strings and `NEVER share your Duo code` are present.
- **A5 (loader):** `src/corpus.ts` exists, contains `import.meta.url` and `../assets/csub-corpus.md`, and exports `CSUB_CORPUS`; `readFileSync` appears in no other file that references `csub-corpus`; `src/mcp-server.ts` contains no corpus file read (grep `csub-corpus` in `src/` → only `src/corpus.ts`).
- **A6 (tests):** `npx vitest run test/corpus.test.ts` passes with the seven R8 assertions; the full suite (`npm test`) still passes (356 pre-existing tests untouched — this spec adds files only, no edits to existing `src/` or `test/` files).
- **A7 (guide):** `docs/demo/CORPUS-UPDATE-GUIDE.md` exists with the five R9 `##` headings verbatim; it contains the deploy-warning sentence from R9.2, the phone allowlist table, and the strings `50 KB`, `100 KB`, and `topic` in the size-ceiling section.
- **A8 (boot behavior):** with `assets/csub-corpus.md` temporarily renamed, `node --input-type=module -e "await import('./dist/corpus.js')"` (after `npm run build`) exits non-zero with `ENOENT` — the fail-fast R6 policy; restore the file afterward.
- **A9 (no placeholders):** grepping the corpus and the guide for `TBD`, `TODO`, `XXX`, `lorem` yields no matches.

## Non-goals / out of scope

- **No retrieval of any kind**: no RAG, no embeddings, no BM25/keyword pre-filter, no chunking — whole-corpus prompt-stuffing is the decided strategy at this size [findings/17 §1.4–1.5]; the `topic` pre-filter seam is documented (R9.4) but explicitly NOT implemented.
- **No external fetch**: the corpus is never downloaded, scraped, or refreshed at runtime or build time; updates are git commits only.
- The `ask_campus_knowledge` tool itself — registration, `generateObject` call, `MCP_MODEL_ID`/timeout env keys, the `{status: 'ok'|'not_found'|'error', response_text}` envelope, the `NOT_FOUND` sentinel, the answering-model system prompt and its corpus-first ordering — all owned by the delegated-intelligence tool spec (this spec only hands it `CSUB_CORPUS`).
- Realtime-session instructions (the three-lane answering policy, "NEVER answer campus facts from memory", preambles) — persona/instructions spec. The corpus is never stuffed into `INSTRUCTIONS` [findings/16 C18].
- Crisis/escalation behavior — `escalate_to_human` is a tier-1 static tool spec concern; §9 here is grounding data only [findings/17 §4.5].
- Announcement-email copy — the email spec owns RIO's public self-description; §12 mirrors it.
- Corpus localization: the corpus is English-only; RIO's Spanish-switch happens in the realtime model, which translates the returned English answer itself (no Spanish corpus variant in this build).

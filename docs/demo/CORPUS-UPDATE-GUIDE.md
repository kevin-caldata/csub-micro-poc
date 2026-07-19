# CSUB Corpus Update Guide

Maintainer-facing guide for `assets/csub-corpus.md`, RIO's knowledge base for the `ask_campus_knowledge` tool. Demo Spec 04, R9.

## What this file is

`assets/csub-corpus.md` is the single source of campus knowledge for RIO's `ask_campus_knowledge` tool. There is no database, no retrieval index, and no external lookup behind that tool — the whole file is sent to the answering model on every knowledge question. It is loaded once at process boot by `src/corpus.ts` (module scope, never re-read per request) and exported as the string constant `CSUB_CORPUS`. All content in the file is simulated demo data, disclosed by the four-line SIMULATED-DATA banner at the very top of the file — that banner is part of every prompt sent to the model and must never be stripped.

## How to update

The update loop is a markdown edit and a git push — zero code changes:

1. Edit `assets/csub-corpus.md`.
2. Run `npm test` locally. The corpus test (`test/corpus.test.ts`) enforces the banner, the size envelope, the twelve required section headings and their topic tags, the phone-number allowlist, and the crisis-number spot checks — if any of those regress, the test suite catches it before it ships.
3. Commit and push to `main`.
4. Railway auto-deploys from `main` in about 2 minutes.
5. Call the demo line and ask a question that exercises the change, to confirm it's live.

**Warning:** Every deploy restarts the process and severs any in-flight calls — push during a quiet window, not while someone is demoing.

## Style rules for new content

New content follows the same rules the original corpus was written to:

- Short, plain, spoken-friendly sentences. Bullets are fine. **No markdown tables** anywhere in a section — the answering model mangles a table into speech, since this text is read aloud over a phone line.
- No images, and no links formatted as markdown — bare URLs only (for example `myid.csub.edu`, not a markdown link), since callers hear a bare URL read aloud as "my I D dot C S U B dot E D U."
- Phone numbers always in digit form, `(661) 654-3036` (a mnemonic form like "654-HELP" may follow in parentheses, never replace the digit form).
- Dates spelled out, `August 24, 2026`, not `8/24/26`.
- Time ranges with an en dash, `8 AM–5 PM`.
- Every section self-contained — no "see the section above" cross-references. Restate a fact where it's needed; the whole corpus is always in the prompt, but self-containment keeps the future per-topic pre-filter (see Size ceiling, below) viable if it's ever built.
- American English, warm and factual, matching the tone of real campus communications. Don't hedge individual facts ("we think," "probably") — the top-of-file banner is what discloses the simulation, not per-fact qualifiers.
- A new section gets a `##` heading and, on the very next line, a `<!-- topic: ... -->` tag whose value is one of the eight enum values below. A new fact within an existing section follows the fabrication rule that already governs that section (verified facts stay verbatim; anything not independently verifiable gets a plausible fabricated value stated with the same confidence as a real one).
- **Phone numbers are never invented — only numbers from the allowlist below may appear anywhere in the corpus.** If a new or fabricated office needs a contact point, give it the main operator line or an email address instead of inventing a number.
- **Voice-formatting: write "Rio," not "RIO," in prose** — this text is read aloud by a text-to-speech voice model, and a voice model spells all-caps tokens out letter by letter (that's the "R... I... O..." bug this rule exists to prevent). The one exception is the four-line SIMULATED-DATA banner at the top of the file, which keeps "RIO" — it is never sent through the answering model as spoken prose.

Phone/short-code allowlist (the complete set of dialable strings permitted anywhere in the corpus):

| Number | Owner |
|---|---|
| (661) 654-2782 | Main operator (654-CSUB) |
| (661) 654-3036 | Admissions & Registrar |
| (661) 654-3016 | Financial Aid & Scholarships |
| (661) 654-3225 | Student Financial Services |
| (661) 654-4357 | ITS Service Center (654-HELP) |
| (661) 654-2394 | Student Health Services |
| (661) 654-2677 | Parking / UPD non-emergency |
| (661) 654-3988 | Icardo Center Box Office |
| (661) 654-2266 | Human Resources |
| (661) 654-3360 | Services for Students with Disabilities |
| (661) 654-3172 | Stiern Library checkout |
| (661) 654-3231 | Stiern Library research |
| (661) 654-2111 | UPD emergency |
| (661) 654-3366 | Counseling Center |
| (661) 654-3425 | ITS security line |
| (800) 700-4417 | Parking Management Bureau |
| 988 | Suicide & Crisis Lifeline |
| 911 | Emergency |
| 838255 | Veterans Crisis Line text |

## Size ceiling

Keep the file at or below 50 KB. The test suite enforces an upper bound of 51,200 bytes and fails above it — raise that test bound only together with a latency re-measurement, since the `toolTotalMs` p50 < 1500 ms gate must keep passing regardless of corpus size.

If content ever needs to push past roughly 100 KB, do **not** bolt on retrieval (RAG, embeddings, chunking) ad hoc. The designed upgrade for that situation is a per-topic section pre-filter inside the `ask_campus_knowledge` handler: the tool already accepts an optional `topic` argument, and every section in this file already carries a `<!-- topic: ... -->` tag from the same eight-value enum (`directory_hours`, `financial_aid`, `registration`, `orientation`, `it_help`, `parking`, `events`, `other`). A handler-only change could filter sections by that tag before prompt-stuffing — no tool-schema change, no new dependency. That work is explicitly deferred until the ceiling is actually hit; it is documented here, not implemented.

## Never edit these

- The four SIMULATED-DATA banner lines — byte-exact, and always the first four lines of the file, with nothing above them (no front matter, no blank line).
- The crisis numbers in the counseling section: Counseling Center (661) 654-3366 (press 2 after hours), 988, UPD (661) 654-2111 / 911, operator (661) 654-2782. These change only with a re-verified source, because the `escalate_to_human` tool speaks the same numbers and the two surfaces must never disagree.
- The twelve section headings and their `<!-- topic: ... -->` tags — the test suite pins the heading text, the order, and the tag vocabulary. Adding a thirteenth section means updating `test/corpus.test.ts` in the same commit.

---

Amended 2026-07-19: voice-formatting — speakable text uses 'Rio' (TTS spelled out all-caps RIO); human decision.

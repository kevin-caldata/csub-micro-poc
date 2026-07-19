# RIO Self-Serve Announcement Email

**Date:** 2026-07-19 · **Status:** Draft for review (thought exercise; NO code changes implied)
**Purpose:** The self-serve replacement for the staged live demo. This email goes out to CSUB stakeholders/testers with the PoC phone number; recipients call it on their own time. It must carry the entire honesty burden the presenter would have carried in the room (Duplex rule: never leave anyone unsure what was real) [docs/findings/14-demo-craft-and-storytelling.md:221-229].
**Inputs:** docs/demo/RIO-DEMO-CONCEPT.md, docs/findings/13, docs/findings/14, plus light web research on beta/pilot invitation emails (citations in §2).
**Placeholders to fill before sending:** `[SENDER NAME/TITLE]`, `[FEEDBACK CHANNEL]`, `[PILOT END DATE]`.

---

## 1. The email (ready to send)

### Subject line options

1. **You're invited: call RIO, a working preview of CSUB's AI phone operator** *(recommended — "you're invited" framing leads with the recipient, not the product; see claim R2)*
2. Dial (661) 490-9364 and meet RIO — our proof-of-concept AI operator (all data simulated)
3. What if the CSUB phone line just… talked to you? Call our PoC and find out
4. RIO pilot: an AI operator you can call right now, day or night

### Body

---

Hi `[NAME]`,

You're invited to try something we've been building: **RIO, the Roadrunner Intelligent Operator** — a working proof-of-concept of what could one day replace the 9-option touch-tone menu on CSUB's main phone line. Instead of "press 1 for admissions," you just talk.

**Call any time, day or night: +1 (661) 490-9364**

No sign-up, no scheduled demo, no script. Dial it from your own phone whenever you like — 2 PM or 2 AM — and talk to it the way you'd talk to a front-desk person. It answers in English o en español.

**Four things to know before you dial (the honest part):**

- **Everything RIO "knows" is simulated.** Dates, phone extensions, ticket numbers, account lookups — all of it is fake demo data written to *sound* like CSUB. Nothing is connected to any real campus system, and no real student records exist anywhere in this prototype.
- **RIO tells you it's an AI** in its first sentence, and that's true — there is no human listening in or taking over.
- **Calls are logged.** Both sides of every conversation are transcribed into our server logs, and we use those logs to measure response speed — latency measurement is literally the point of this proof-of-concept. Please don't share real personal information on the call: no real student IDs, passwords, or anything sensitive.
- **It's a prototype on one small server.** Calls may occasionally drop, especially when we push updates. If it stumbles, that's useful data — tell us about it.

### What to try

RIO is at its best when you treat it like a person, not a menu. Some things worth trying:

1. **Ask about financial aid timing:** "When does my fall financial aid actually come through?" — it will cite a `[SIMULATED]` disbursement schedule modeled on the real academic calendar.
2. **Ask about orientation or the start of classes:** "When is Runner Rundown? When do classes start?" — again, `[SIMULATED]` data built to sound native to late-July.
3. **Switch to Spanish mid-call:** "¿Podemos hablar en español?" — it should follow you completely, mid-sentence, no "press 2 para español."
4. **Interrupt it.** Talk right over it while it's mid-answer — "wait, actually—" — and notice that it stops immediately and pivots. This is the thing a touch-tone tree can never do.
5. **Make it look something up:** "What's the number for the ITS Help Desk?" or "I forgot my password, can you help?" — you'll hear it say "one moment, let me check that," call a backend tool, and read back the `[SIMULATED]` result. (The password-reset "verification" always succeeds — it's theater. Never give it real credentials, and note that it will refuse to accept a Duo code, on purpose.)
6. **Ask "what time is it?"** — a deceptively small question. How it answers tells you something real about what a language model does and doesn't inherently know about the world.
7. **Ask for a human:** "Can you just transfer me to Financial Aid?" — it will narrate a warm, context-passing handoff. Be aware the "transfer" is `[SIMULATED]`: nobody is actually dialed, and the "Financial Aid desk" that picks up is the same AI wearing a second hat.

**One thing we ask you NOT to try: please don't role-play realistic emotional distress or crisis scenarios.** RIO does have a designed safety path — if a caller sounds like they're struggling, it's built to respond with warmth and route to real resources (the CSUB Counseling Center and the 988 Suicide & Crisis Lifeline, whose numbers are real). But in this prototype the far end of that escalation is simulated: **no human is ever actually notified**, so treating it as a crisis line would fail a person who genuinely needed it. Enacted distress can also trip the model's built-in safety systems and end the call, and it creates transcripts our team then has to review as if they might be real. If you or someone you know is actually struggling, call or text **988** — that one is real, free, and answered 24/7.

### What this simulates vs. what's real

RIO's vision has eight functional requirements. Here's the honest map of where each one stands on the call you're about to make:

| # | RIO requirement | On this call | Status |
|---|---|---|---|
| 1 | Natural-language intake & routing, English & Spanish | Fully conversational, no menus, real mid-call language switching. The directory info it reads back is `[SIMULATED]`. | **LIVE** |
| 2 | 24/7 after-hours self-service | It genuinely answers at 2 AM — there is no business-hours logic anywhere. The knowledge base behind the answers is `[SIMULATED]`. | **LIVE** (knowledge simulated) |
| 3 | Crisis-safe escalation | Distress recognition and the escalation path are really designed in, and the resource numbers it speaks (988, Counseling Center) are real. The handoff endpoint is `[SIMULATED]` — no human is contacted. | **SIMULATED** |
| 4 | Warm, context-passing transfers | RIO narrates the handoff with your name and reason — but it cannot dial anyone. Same call, second persona. | **SIMULATED** |
| 5 | Call recording & transcription | Transcription is real today — your call lands in structured server logs. Audio recording/retention is not built. | **PARTLY LIVE** (recording FUTURE) |
| 6 | Real-time KPI dashboards | Per-call latency and turn metrics are genuinely measured on your call — that's the PoC's deliverable. Dashboards to display them are not built. | **SIMULATED** (measurement live, presentation FUTURE) |
| 7 | Identity-verified self-service (password/Duo help) | The dialogue mirrors CSUB's real MyID/Duo flow, but "verification" always succeeds on fake data. It verifies nothing. | **SIMULATED** |
| 8 | Two-way SMS follow-up | If RIO says it "texted you a link," no text will arrive. Not built. | **FUTURE** |

### Under the hood (for the technically curious)

Your call hits a Twilio number, and the audio streams over a WebSocket to a small bridge service, which speaks directly to OpenAI's `gpt-realtime` speech-to-speech model via Vercel's AI Gateway — there is no separate speech-to-text → LLM → text-to-speech chain, which is why interruptions feel instant and turns feel like conversation. When RIO "looks something up," it's calling tools on an in-process MCP (Model Context Protocol) server that returns the fake demo data. The actual research deliverable is the instrumentation wrapped around all of this: every call produces per-turn time-to-first-audio, barge-in cutoff time, tool round-trip, and p50/p95 latency summaries. Your call is a data point — thank you for that.

### Practical notes

- **Availability is best-effort.** This runs on a single small cloud instance, and deploying updates severs any call in progress. If you get dropped or can't connect, try again later — it's a prototype, not a production line.
- **Expected call length:** most useful calls run 2–5 minutes. There's a hard cap of about 25 minutes per call.
- **All data is fake.** Worth repeating: if RIO tells you a date, a wait time, a ticket number, or that it "verified" anything — it's demo data. Check csub.edu or call the real operator line, (661) 654-CSUB, for anything that matters.
- **Feedback:** we genuinely want it — the weird moments most of all. Send impressions, transcript-worthy quotes, or bug reports to `[FEEDBACK CHANNEL]`. The pilot line stays up through `[PILOT END DATE]`.

Thanks for lending us your ears — and your phone. Go 'Runners!

`[SENDER NAME/TITLE]`

---

## 2. Design rationale (numbered claims)

**R1 — The email replaces the presenter as the honesty layer.** In a staged demo, limits are stated out loud in the room [docs/demo/RIO-DEMO-CONCEPT.md:228-239]. Self-serve, the email is the only place to do it, so every "must not imply" item from the concept doc appears in the body: no real transfers, no real verification, no real recording pipeline, fake KB, AI self-identification, and the live-vs-simulated table. The Duplex failure was ambiguity about what was real, not staging itself [docs/findings/14-demo-craft-and-storytelling.md:221-229] — hence `[SIMULATED]` tags on every fake specific and a per-requirement status table.

**R2 — Subject/opening lead with the recipient and the action, not the product.** Beta-invite guidance: frame as "You're invited to try X" rather than "We're excited to announce X," keep one clear call to action, and be honest about what's ready — testers who understand the context give better feedback ([Centercode](https://www.centercode.com/blog/how-to-write-super-clickable-beta-invite-emails-with-samples), [Sequenzy](https://www.sequenzy.com/blog/beta-feature-invitation-emails), [Postmark](https://postmarkapp.com/guides/user-invitation-email-best-practices)). The single CTA here is the phone number, bolded, repeated once in the practical notes via the real-operator contrast.

**R3 — "Call it yourself" is the strongest credibility move available.** Vendors put public demo lines on their homepages precisely because nothing in a deck matches dialing the number yourself [docs/findings/14-demo-craft-and-storytelling.md:34-43]; the self-serve format turns the demo's closing beat into the whole demo.

**R4 — The "what to try" list encodes the wow-moment checklist without staging.** Barge-in is the most reliable wow moment [docs/findings/14:79-84]; mid-call Spanish switch is what makes non-technical stakeholders say "that sounds real" [docs/findings/14:86-92]; tool call with spoken confirmation [docs/findings/14:94-97]; 24/7 pickup [docs/findings/14:99-104]. Financial-aid and orientation prompts match what real late-July callers actually ask, so the fake data sounds native [docs/findings/13-demo-csub-caller-context.md:44-48]. The Duo-refusal aside surfaces the security-literacy beat [docs/findings/13:33].

**R5 — "What time is it" is included as an honest-limits probe.** No clock tool exists in the PoC; the prompt invites recipients to discover a genuine model limitation themselves, which builds more trust than any claim — consistent with the under-promise discipline in [docs/findings/14:176-182].

**R6 — The crisis instruction is a "don't," with reasons, not a hidden feature.** Rationale mirrors the binding ethics note [docs/demo/RIO-DEMO-CONCEPT.md:241-243]: (a) the escalation far-end is simulated, so a real person in distress would be failed by it; (b) the Realtime API runs active safety classifiers that enacted distress can trip, halting the session; (c) it creates logs the team must treat as possibly real. The email still names the design (safety routing exists; resource numbers are real [docs/findings/13:38-40]) and gives the real 988 line plainly — the same courtesy the presenter script required.

**R7 — Requirement table maps 1:1 to the concept doc's 8-FR treatment table** [docs/demo/RIO-DEMO-CONCEPT.md:32-41], collapsed to LIVE / SIMULATED / FUTURE for a lay audience, with FR-5 split honestly (transcription real, recording absent [docs/demo/RIO-DEMO-CONCEPT.md:82-86]) and FR-6 split (measurement live, dashboards future [docs/demo/RIO-DEMO-CONCEPT.md:88-93]).

**R8 — Logging disclosure is explicit and specific.** Transcripts genuinely land in server logs keyed by call [docs/demo/RIO-DEMO-CONCEPT.md:84]; the email says so in plain words ("both sides… transcribed into our server logs"), states the purpose (latency measurement, the PoC deliverable), and pairs it with a don't-share-real-PII instruction — stronger than a vague "calls may be recorded" line, and consistent with California AI-disclosure sensitivity [docs/findings/14:221-229].

**R9 — Availability small print is required, not optional.** The PoC severs calls on deploy and caps sessions at ~25 minutes [docs/demo/RIO-DEMO-CONCEPT.md:239]; a self-serve audience will hit both, so the email pre-frames them as prototype behavior rather than letting them read as product failure.

**R10 — Roadrunner flavor is one controlled dose.** House style supports "Go 'Runners!" and the RIO/Runner Rundown vocabulary [docs/findings/13:26]; the concept doc's persona guidance is personality in one small dose, never a gimmick loop [docs/demo/RIO-DEMO-CONCEPT.md:121]. The email uses exactly two touches: the RIO name expansion and the sign-off.

**Sources (web):** [Centercode — beta invite emails](https://www.centercode.com/blog/how-to-write-super-clickable-beta-invite-emails-with-samples) · [Sequenzy — beta feature invitation emails](https://www.sequenzy.com/blog/beta-feature-invitation-emails) · [Postmark — user invitation email best practices](https://postmarkapp.com/guides/user-invitation-email-best-practices) · [HeroThemes — beta invite subject lines](https://herothemes.com/email-subject-lines/beta-invite/)

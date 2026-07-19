# RIO Demo Concept — "Talk to the University"

**Date:** 2026-07-19 · **Status:** Concept (thought exercise; NO code changes implied by this document)
**Audience:** CSUB stakeholders evaluating a standalone OpenAI-realtime voice approach vs Amazon Connect for the RIO contact-center replacement.
**Inputs:** findings/10–14, BRD_Micro_Voice_PoC.md. Every substantive claim cites its source as `[findings/NN §claim]` or `[BRD §n]`.
**Scope guardrail:** everything in this demo is FAKE DATA on the existing micro-PoC (Twilio → gpt-realtime-2.1 via Vercel AI Gateway, in-process MCP tools, latency instrumentation as the deliverable) [BRD §1]. Nothing here integrates a real campus system, and the demo must never imply otherwise (§7 below).

---

## 1. The story the demo tells

Today, a caller to (661) 654-2782 gets a 9-option touch-tone IVR: 40+ seconds of menu navigation, essentially blind transfers (~5 warm transfers a year), and **34.6% of business-hours callers — roughly 6,190 calls — hang up**. After 5 PM, on weekends, and all summer, coverage is effectively **0%**. Industry framing agrees this is structural, not incidental: 67% of callers abandon a touch-tone IVR within 90 seconds [findings/14 §C5].

The demo's one-sentence thesis: **re-point the same phone number at something a caller can simply talk to.** RIO — the Roadrunner Intelligent Operator — answers instantly, in the caller's own words, in English or Spanish, at 2 AM in July, and never dead-ends a person in crisis.

Narrative shape (per demo-craft research):

1. **Cold open — the villain in its own voice** [findings/14 §C5, §C6]: play 20–30 seconds of the *recorded, real* current CSUB phone tree (menus, hold prompt). Cut to silence. One slide: "34.6% of those callers hang up. After 5 PM, nobody answers at all."
2. **"Do the last thing first"** [findings/14 §C6]: go straight to the live calls (§4). No architecture slides before the first call — that is the classic failure mode.
3. **Metrics beat** [findings/14 §C20–C23]: one slide of latency measured *from the calls the room just heard* (the PoC's instrumentation is the deliverable [BRD §2 FR-6]), mapped to CSUB's own KPIs.
4. **Honest competitive slide** [findings/14 §C24–C26]: what they just heard that a Connect/Lex demo cannot show (native speech-to-speech, semantic barge-in, no intent tree), and what Connect legitimately has that this PoC does not (Contact Lens analytics, FedRAMP/PII compliance wrapper, WFM) — conceded proactively. Closing sentence: "Connect is a mature contact-center *operations* platform with a bolt-on voice bot; this is a next-generation *caller experience* with the operations layer still to build — and the two aren't mutually exclusive" [findings/14 §C26].
5. **Close — "call it yourself"** [findings/14 §C3]: put the Twilio number on screen and invite stakeholders to dial it from their own phones during Q&A. Nothing in a slide deck matches that.

Sector positioning available if asked: verified public case studies of universities running realtime-voice-class phone agents are essentially absent — the named precedents (Nevada State, ASU, UT Knoxville) are chat/assistant deployments — so CSUB can honestly claim near-first-mover status in the CSU space, with the thin-precedent risk acknowledged in the same breath [findings/14 §C28–C31].

---

## 2. The 8 functional requirements → demo treatment

Legend: **(a) LIVE** = demonstrable live with fake data on the micro-PoC as designed · **(b) SIMULATE** = simulatable/narratable in the demo with an honest label · **(c) OUT OF SCOPE** = not shown; one-line talk-track instead. Effort classes are detailed in §5.

| # | Requirement | Treatment | Mechanism |
|---|---|---|---|
| 1 | NL menu-less intake + routing, EN & ES (CX-01/CX-04) | **(a) LIVE** | Persona prompt + fake `route_call` tool |
| 2 | 24/7 after-hours self-service KB (CX-02/OO-02) | **(a) LIVE** (KB is fake) | Fake `lookup_campus_info` tool + staged "2 AM" persona |
| 3 | Crisis / active-threat routing (CX-06/OO-03) | **(b) SIMULATE** — carefully | Safety & Escalation prompt section + fake `escalate_to_human` tool |
| 4 | Warm, context-passing transfers (CX-05) | **(b) SIMULATE** | In-call persona handoff: `route_call` → hold clip → second persona |
| 5 | Recording + full transcription (FR-05/DR-06) | **(b) SIMULATE** (transcripts real, recording absent) | Existing per-call transcript logs, printed extract |
| 6 | Real-time + historical KPI dashboards (DR-01/FR-06) | **(b) SIMULATE** | Existing latency/turn instrumentation as a printed "KPI report" |
| 7 | Identity-verified self-service (SS-01/SS-04/NF-08) | **(a) LIVE** (verification is fake) | Fake `verify_identity` + `reset_password` tools, CSUB NetID/Duo vocabulary |
| 8 | Two-way SMS / omnichannel (CX-07) | **(c) OUT OF SCOPE** (narrated only) | Optional fake `send_sms` tool narration; honest talk-track |

### FR-1 — Natural-language bilingual intake & routing — (a) LIVE

This is the core requirement and the PoC's native strength: there are no intents, no slots, no menu to enumerate — any phrasing, topic pivots, compound requests [findings/14 §C24].

- **Persona**: replace the exported `INSTRUCTIONS` constant (`src/gateway.ts:241-244`) and `GREETING_INSTRUCTIONS` (`src/gateway.ts:248`) with the RIO persona (§3). One string edit each; the code comment explicitly anticipates this lever [findings/11 §C1–C2].
- **Spanish**: nothing in the code constrains language — VAD is energy-based, transcription auto-detects; the *only* English in the system is the prompt prose itself. An explicit switch rule in the instructions ("if the caller speaks Spanish, continue in Spanish; keep the same persona") is the entire change [findings/11 §C8] [findings/12 §1.1–1.2]. The known model weak spot — regional-accent control — is harmless here because the default Latin-American-leaning Spanish is the right register for a Kern County audience [findings/12 §1.4].
- **Routing**: fake MCP tool **`route_call(department, caller_name?, reason)`** → returns fake JSON `{department, phone_ext, location, handoff_blurb, estimated_wait}` seeded with real CSUB directory data (Financial Aid (661) 654-3016; Admissions/Registrar (661) 654-3036, Student Services 47 SA; ITS 654-HELP; Counseling 654-3366; UPD non-emergency 654-2677) [findings/13 §1]. One `registerTool` call in `src/mcp-server.ts` — the spec-mandated single-file extension point; live on the next phone call, no bridge changes [findings/11 §C3–C4]. Because the model reads returned text near-verbatim and closely follows sample phrases, the tool return *is* the script — the reliable way to stage a repeatable beat while staying genuinely live [findings/12 §2.6, §3.6].
- Advising has no single line at real CSUB — multiple college-based centers — so the authentic behavior is RIO asking the caller's major, then routing [findings/13 §7].

### FR-2 — 24/7 after-hours self-service — (a) LIVE (knowledge is fake)

The deployed PoC genuinely answers 24/7 — Railway runs continuously and there is no business-hours logic anywhere. What's fake is the knowledge base:

- Fake MCP tool **`lookup_campus_info(topic)`** returning canned late-July-2026 answers built from findings/13's calendar research: fall classes start Aug 24; freshman registration open since Jun 29; "Runner Rundown" orientation running since Jul 6; financial-aid disbursement begins the week of ~Aug 17 with BankMobile refunds 2–3 business days later [findings/13 §23–26]. These are exactly the questions real late-July callers ask, so the fake data sounds native.
- Staged as the "2 AM call" beat: on-screen clock showing 2:07 AM, working-student persona — the standard emotional frame for after-hours, backed by the best external number in higher ed (Nevada State: 36% of AI-assistant interactions after hours, 15% on weekends) [findings/14 §C11, §C29].
- Honest label: the clock is a prop (the demo happens whenever it happens); the point — "this system has no closing time" — is literally true of the deployed PoC.

### FR-3 — Safety-first crisis routing — (b) SIMULATE, carefully

The hard non-negotiable. What we can honestly show: **escalation is a designed path, same as any tool route — the AI never dead-ends a person in crisis** [findings/12 §4.4].

- **Prompt**: an explicit Safety & Escalation section (OpenAI's own prompt-skeleton pattern) listing distress cues and naming the escalation tool; sample escalation preamble spoken by the model [findings/12 §2.1, §4.3]. Base-model behavior already trends toward empathy + crisis-resource referral (988) [findings/12 §4.1].
- **Tool**: fake **`escalate_to_human(reason, urgency)`** → returns a warm-handoff blurb naming the real resources: CSUB Counseling Center (661) 654-3366 ("after hours, press 2 for a crisis counselor"), 988 Suicide & Crisis Lifeline (24/7, with a Bakersfield-based 988 center), UPD (661) 654-2111 / 911 for immediate danger [findings/13 §20–22]. The tool logs a `crisis_escalation` record that appears on the projected screen — the "proof" beat [findings/14 §C10].
- **Staging ethics** (see also §6): the scripted caller uses a *mild, clearly-scripted* cue ("honestly, I've been really overwhelmed and struggling lately") — never enacted realistic distress, which is in poor taste on stage and risks tripping the Realtime API's active safety classifiers mid-demo [findings/12 §4.2, §4.4].
- **Honest talk-track for the gap**: "In production, this route goes to a live human, UPD dispatch, or 988 — with the legacy 3CLogic IVR as failover. Today you'll hear the AI recognize the moment and execute the handoff path; the far end of that handoff is simulated."
- **Active-threat path**: do NOT demo. Talk-track only: "The dedicated active-threat route to police dispatch is a production requirement we would design with UPD, not something we simulate in a conference room."

### FR-4 — Warm, context-passing transfers — (b) SIMULATE

Real transfer is designed out of the PoC — the TwiML is `<Connect><Stream>` only, no `<Dial>`, no conference, no Twilio REST client [findings/11 §C9]. But every primitive for a convincing fake warm transfer inside one call already exists [findings/11 §C10]:

1. Caller asks for a human / needs a department → model calls `route_call` → tool returns the handoff blurb *containing the caller's name and stated reason*.
2. Model narrates: "I'm connecting you to Financial Aid now — I'll let them know you're calling about your Cal Grant disbursement."
3. (Optional polish) short hold/ring clip over the open Twilio WS via the existing fallback-clip pattern (`playFallbackAndCloseWith` mechanics: clear → sendMedia → mark-echo confirm) [findings/11 §C10].
4. Model resumes as a second persona via per-response instruction override (the greeting already uses exactly this mechanism): "Hi Maria, this is the Financial Aid desk — I see you're calling about your fall disbursement. RIO filled me in." [findings/11 §C10]
5. Simultaneously, the projected screen shows the fake context payload the "receiving party" got — the receiving-party-sees-who-and-why beat of CX-05, proven visually [findings/14 §C10].

Contrast line for the room: "Today's line does about five warm transfers a year. RIO does one per call, by default."

### FR-5 — Recording & full transcription — (b) SIMULATE (transcription genuinely exists; recording honestly absent)

- **Transcription is already real**: both sides of every call are transcribed into structured logs today — `input-transcript` / `output-transcript` JSON lines keyed by `callSid`; filtering one call reconstructs the full dialogue with zero bridge changes [findings/11 §C6]. Demo treatment: hand stakeholders a **printed one-page transcript of Call 1, produced from the logs of the call they just heard**, timestamped. That is a genuine artifact, not a mock-up.
- **Audio recording is a BRD non-goal** — no persistence, no DB, no recording pipeline exists; per-call state is in-memory and the only durable form is the log stream [BRD §1 non-goals] [findings/11 §C7].
- **Talk-track**: "Transcription is native to this architecture — you're holding it. Audio recording and retention is standard telephony plumbing (Twilio records with one TwiML attribute in production); we deliberately excluded it from a fake-data PoC, and the compliance/retention design is Phase 1A work."

### FR-6 — KPI dashboards — (b) SIMULATE as a printed report

- The latency instrumentation IS a per-call KPI record today: greeting chain, per-turn TTFB/bridge/turn totals, barge-in counts, tool latency, and a `stream-stop` summary with p50/p95/max — these are contact-center KPIs (answer speed, response latency, interruption rate, handle time, backend latency) generated per call [findings/11 §C7]. No capture code is missing — only presentation.
- Demo treatment: **one projected pane during calls** (live transcript + small latency readout) and **one summary slide after** — never raw event logs; leading with the end-state report is the executive pattern [findings/14 §C20]. Plus a printed "RIO Call Report" per demo call (the "KPI dashboard as a printed latency/log report" treatment).
- Use the executive vocabulary — containment, abandonment, deflection, transfer rate [findings/14 §C21] — and only *defensible* containment numbers: 25–35% early/realistic; never repeat vendor 60–80% claims. Under-promising here is a differentiator [findings/14 §C22].
- **Concede on the same slide**: real-time supervisor dashboards, sentiment, listen-in are exactly what Amazon Connect's Contact Lens does well; that layer is known, buildable engineering (or a reason the end-state pairs the RIO experience with an enterprise substrate) [findings/14 §C25–C26].

### FR-7 — Identity-verified self-service (password / Duo) — (a) LIVE (verification itself is fake)

The Help Desk deflection story, played in authentic CSUB vocabulary so it sounds native [findings/13 §16–19]:

- Fake tools: **`verify_identity(netid, dob_or_last4)`** → returns `{verified: true, name, student_id}` (always succeeds with scripted fake data); **`reset_password(netid)`** → returns "authorization code sent to the personal email on file" mirroring the real MyID flow (myid.csub.edu → Forgot Password / Activate Account → emailed code → 11–255-char password) [findings/13 §17]. Optionally `create_ticket` → "I've created ticket INC0012345" (ServiceNow vocabulary) [findings/13 §19].
- **The credibility moment**: digit-by-digit ID read-back — caller says a 9-digit student ID; RIO reads it back "8… 3… 5… 2…" and confirms — the guide-canonical pattern, on a model whose headline 2.1 improvement is alphanumeric recognition over noisy phone audio, including in Spanish [findings/12 §2.4, §6.1, §1.6].
- **The security-literacy moment**: RIO *refuses* to accept a Duo code read aloud ("I'll never ask for your Duo code — never share it with anyone"), mirroring CSUB's own published warning [findings/13 §18]. One prompt line; reads as security maturity to stakeholders.
- **Honest label**: "The verification here is theater — fake data, always succeeds. Real identity verification against campus systems is the SS-01 production design, and we will not pretend otherwise" (§6).

### FR-8 — Two-way SMS / omnichannel — (c) OUT OF SCOPE

The codebase does not touch Twilio SMS at all; even the REST client for `messages.create` could not be constructed today (no Account SID in config) [findings/11 §C12]. A fake `send_sms` tool ("I've texted you the link — SMS sent to (661) 555-0142") is one `registerTool` and the model narrates it convincingly [findings/11 §C12], but no phone buzzes, and a savvy stakeholder will notice.
**Recommended treatment: talk-track only** — "Two-way SMS on this same number is a Twilio product feature, not a research question; we scoped it out of the voice PoC deliberately. The omnichannel foundation is the platform choice, not this demo." (If a narrated beat is wanted, keep it to one sentence in Call 2 and label it fake on screen.)

---

## 3. RIO's persona

Grounded in findings/13 campus research and findings/12 prompting guidance.

- **Name:** RIO — spoken as "REE-oh," expanded once at greeting: "the Roadrunner Intelligent Operator."
- **Voice:** `marin` — already the configured default; professional, clear, front-desk register; OpenAI's recommended flagship voice; `cedar` is the alternate and an easy live voice-swap flex (env flip) [findings/12 §5.1–5.3] [findings/11 §C11]. Pre-demo: confirm `marin` applied via `session-updated.raw` (open spike S8); fallback `alloy` is one env change [findings/11 §C11] [findings/10 §G3/S8].
- **Greeting line (the highest-leverage 10 seconds — one string constant [findings/11 §C2]):**
  > "Thanks for calling Cal State Bakersfield! This is RIO, the Roadrunner Intelligent Operator — I'm an AI assistant, and I can help in English o en español. How can I help you today?"
  The up-front AI self-identification is non-negotiable (Duplex lesson; California disclosure law) [findings/14 §C27].
- **Tone:** warm, concise, confident, never fawning — 2–3 sentences per turn (the guide's own customer-service register, and the main lever for keeping a phone demo snappy) [findings/12 §2.2]. Kern-County-proud, student-success oriented, blue-and-gold [findings/13 §15].
- **Roadrunner flavor:** light and controlled — house style leans on "'Runner" ("'Runner Nation," "Runner Rundown," RunnerConnect), so one on-brand touch like "Welcome, 'Runner!" for a student caller or a closing "Go 'Runners!" matches campus tone; mascot Rowdy available as an aside, never a gimmick loop [findings/13 §12–14]. Personality in one small, controlled dose — grounding and handoffs beat voice tricks [findings/14 §C12].
- **Bilingual behavior:** default English; switch to Spanish only when the caller explicitly asks or produces a substantive Spanish utterance — never from accent alone (the documented failure mode in both directions); once switched, stay in Spanish with the same persona [findings/12 §1.2–1.3].

### Draft system-instructions block (concept prose — follows OpenAI's 8-section realtime skeleton [findings/12 §2.1])

> **Role & Objective.** You are RIO, the Roadrunner Intelligent Operator — the AI phone operator for California State University, Bakersfield. You answer questions, look things up, and route callers to the right campus office. You always identify yourself as an AI assistant.
>
> **Personality & Tone.** Warm, upbeat, and proud of CSUB and Kern County; concise and confident, never fawning. Keep answers to two or three sentences unless the caller asks for more. A light Roadrunner touch is welcome — "Welcome, 'Runner!" for students — used sparingly.
>
> **Context.** Campus: 9001 Stockdale Highway, Bakersfield. It is late July 2026: fall classes start August 24; registration and "Runner Rundown" orientation are underway; fall financial-aid disbursement begins the week before classes. Key offices: Financial Aid (661) 654-3016; Admissions & Registrar (661) 654-3036, Student Services 47 SA; ITS Service Center (661) 654-HELP; Counseling Center (661) 654-3366; University Police non-emergency (661) 654-2677, emergency 911 or (661) 654-2111.
>
> **Language.** English is the default. If the caller explicitly asks for Spanish or speaks a substantive utterance in Spanish, continue the conversation in Spanish for the rest of the call, keeping the same persona. Never switch based on accent alone.
>
> **Reference Pronunciations.** "CSUB" is spoken letter by letter: C-S-U-B. "RIO" is "REE-oh." "Kern" rhymes with "turn."
>
> **Numbers & Codes.** When reading numbers, IDs, or codes, speak each character separately and confirm: "Just to confirm, I heard 8… 3… 5… 2… Is that right?" Never ask for, or accept, a Duo verification code — remind callers never to share Duo codes with anyone.
>
> **Tools.** Before calling any tool, briefly say you're checking (e.g., "One moment, let me look that up"). Look-ups and routing are proactive — call them as soon as intent is clear. When a tool returns a handoff blurb, read it essentially verbatim.
>
> **Safety & Escalation.** If a caller expresses distress, hopelessness, self-harm, or a threat to anyone's safety: respond with warmth first, then immediately call escalate_to_human. Offer the CSUB Counseling Center at (661) 654-3366 — after hours, press 2 for a crisis counselor — and the 988 Suicide & Crisis Lifeline, available 24/7 by call or text. If anyone is in immediate danger, direct them to 911 or University Police at (661) 654-2111. Never dead-end these callers; never treat the moment as routine.

Two build cautions carried from the audit: the tool-preamble sentence must survive verbatim (a test asserts on the substring — append around it, don't delete it) [findings/11 §C1], and persona adherence on marin/cedar should be verified on our exact stack before demo day (a stale-but-cautionary SDK report exists) [findings/12 §5.4].

---

## 4. The live demo calls

Three scripted calls, ~90 / ~90 / ~60 seconds, total live audio under 5 minutes — short calls beat long ones; every extra minute multiplies exposure to failure modes [findings/14 §C18]. The caller is a rehearsed performer, never an ad-libber, with planned interruption points and a planned language switch [findings/14 §C7, §C17]. Ordering follows the impact logic of findings/14: task+proof first, wow-mechanics second, mission beat third.

### Call 1 (~90 s) — English intake, barge-in, warm "transfer" (FR-1, FR-4, FR-7 read-back)

| Beat | Caller (scripted) | Expected RIO behavior |
|---|---|---|
| Instant pickup | *(dials on speakerphone)* | Answers immediately — no rings, no hold [findings/14 §C13]; RIO greeting incl. AI self-ID [findings/14 §C27] |
| NL intake | "Hi — I'm starting in the fall and I still haven't seen my financial aid come through. I'm kind of stressed about it." | No menu; empathic one-liner; "One moment, let me check that" → `lookup_campus_info` → "Fall disbursement starts the week of August 17, and refunds hit your account two to three business days later through BankMobile." [findings/13 §26] |
| **Barge-in (the money shot)** | *(talks over RIO mid-sentence)* "— wait, sorry, actually can you just get me to a person in Financial Aid?" | Audio stops instantly (<500 ms [BRD §2 FR-2]), pivots without losing context [findings/14 §C8] [findings/12 §6.1] |
| Warm transfer | "Yeah, my name's Maria." | `route_call("Financial Aid", "Maria", "fall disbursement")` → "Connecting you now — I'll let them know you're calling about your fall disbursement, Maria." → (optional hold chime) → second persona: "Hi Maria, Financial Aid desk — RIO told me you're asking about your fall disbursement…" Projected screen shows the context payload the moment it's said [findings/11 §C10] [findings/14 §C10] |

**Payoff artifact:** the printed transcript + latency report of this exact call, handed out minutes later (§2 FR-5/FR-6).

### Call 2 (~90 s) — Spanish switch + after-hours self-service (FR-1 ES, FR-2)

Staging: on-screen wall clock reading 2:07 AM; parent persona [findings/14 §C11].

| Beat | Caller (scripted) | Expected RIO behavior |
|---|---|---|
| Late-night open | "Hi, sorry to call so late — I just got off work. My daughter starts at CSUB next month…" | Answers identically at "2 AM" — no closing time |
| **Language switch** | "La verdad, ¿podemos hablar en español? Es más fácil para mí." | Switches to Spanish immediately and completely, same persona — the moment non-technical stakeholders say "that sounds real" [findings/14 §C9] [findings/12 §1.1–1.2] |
| Self-service in Spanish | (in Spanish) "When does orientation happen, and when are classes?" | `lookup_campus_info` → answers in Spanish: Runner Rundown orientation is underway; classes start August 24 [findings/13 §23, §25] |
| Close | (in Spanish) "Thank you, that helps a lot." | Warm Spanish close; one 'Runner-brand touch |

Mission framing on the wrap slide: Kern County is majority-Hispanic (54.9%); ~29% of residents speak Spanish as their first language; CSUB is a Hispanic-Serving Institution — this beat is a service argument, not a parlor trick [findings/13 §29–30].

### Call 3 (~60 s) — crisis recognition and escalation (FR-3) — handled carefully

Introduced verbally first: "This next call is fully scripted and clearly fake — we would never stage real distress. What we're demonstrating is the routing rule: distress never dead-ends."

| Beat | Caller (scripted) | Expected RIO behavior |
|---|---|---|
| Mild scripted cue | "Honestly… I've been really overwhelmed and struggling lately. I don't really know who to talk to." | Warmth first, no lecture; then `escalate_to_human("emotional distress", …)` [findings/12 §4.3–4.4] |
| Handoff | *(listens)* | "I'm glad you called. Let me connect you with someone who can really help. The CSUB Counseling Center is at (661) 654-3366 — after hours, press 2 to reach a crisis counselor — and the 988 Lifeline is there 24/7 by call or text." [findings/13 §21–22]. Projected screen shows the `crisis_escalation` log record |
| Presenter close | *(hangs up)* | Talk-track: "Escalation is a designed path, same as any tool route — the AI never dead-ends a person in crisis. In production that handoff lands on a human, UPD, or 988, with the legacy IVR as failover." [findings/12 §4.4] |

### Wow-moment checklist (rehearse each explicitly)

- [ ] **Instant pickup** — zero rings, zero hold, contrasted against the cold-open hold music [findings/14 §C13]
- [ ] **AI self-identification** in the first sentence [findings/14 §C27]
- [ ] **Barge-in** — deliberate mid-sentence talk-over; audio stops instantly; rehearsed timing [findings/14 §C8]
- [ ] **Mid-call Spanish switch** — no "press 2 para español" fork [findings/14 §C9]
- [ ] **Tool call with spoken confirmation + on-screen proof** — RIO says what it did; screen shows the fake record appear, labeled FAKE [findings/14 §C10]
- [ ] **Digit-by-digit read-back** (if Call 1 includes an ID) [findings/12 §2.4, §6.1]
- [ ] **Live latency readout** during calls; measured p50/p95 on the wrap slide [findings/14 §C19–C20]
- [ ] **"Call it yourself" close** — number on screen for Q&A [findings/14 §C3]

### Fallback plan for live-demo failure

- **Recorded best-take, two clicks away**: full rehearsal recording (audio + synchronized screen capture) open in a background tab before the meeting; the pre-planned line is "Let me show you the same call from this morning's rehearsal — and I'll say clearly that this one is a recording" (the Duplex rule: never leave the room unsure what was live) [findings/14 §C14, §C27].
- **Frozen deploy**: pin a known-good build at least a day ahead; **no pushes to the auto-deploying `main` on demo day** — deploys sever live calls (SIGTERM) [findings/14 §C15] [BRD §7.6].
- **In-room smoke test 30 minutes prior**, same room, same handset, same carrier; if venue cell coverage is poor, pre-tested WiFi-calling or alternate handset [findings/14 §C19]. Quiet handset near the mic, not an untested boomy speakerphone [findings/14 §C17].
- **Voice check**: confirm `marin` in `session-updated.raw` during the smoke test; if rejected, one env flip to `alloy` [findings/11 §C11] [findings/10 §S8].
- **Rehearse the recovery itself** — switching to the recording without flustering; "demo gods" excuses read as unpreparedness in 2026 [findings/14 §C16].
- **Graceful in-call failure**: a failing tool never kills the call — the model reads the error and apologizes verbally (built-in behavior) [findings/11 §C5]; if a call drops entirely, redial once, then go to the recording.

---

## 5. What it would take (effort classes — NO implementation now)

Effort classes: **persona-prompt-only** (edit 1–2 string constants) · **one fake MCP tool** (one `registerTool` block, ~10 lines, single-file diff, live on next call [findings/11 §C4]) · **small code change** (touches bridge/session code beyond the sanctioned single-file patterns) · **out of scope** (not in the micro-PoC).

| Capability | Effort class | Extension point |
|---|---|---|
| RIO persona + branded greeting | **persona-prompt-only** | `INSTRUCTIONS` + `GREETING_INSTRUCTIONS` constants, `src/gateway.ts:241-248`; keep the tool-preamble sentence; optional additive `INSTRUCTIONS` env var (two-line config edit, sanctioned pattern) [findings/11 §C1–C2, §C13] |
| Spanish / bilingual behavior | **persona-prompt-only** | One language paragraph in the instructions; nothing in code constrains language [findings/11 §C8] [findings/12 §1.2] |
| `lookup_campus_info` (fake KB) | **one fake MCP tool** | `buildMcpServer()`, `src/mcp-server.ts` — the FR-5 spec-mandated extension point [findings/11 §C4, §C13]; canned data from findings/13 |
| `route_call` (fake routing + context payload) | **one fake MCP tool** | Same; return shape `{department, phone_ext, handoff_blurb, estimated_wait}` doubles as the demo script [findings/12 §3.6] |
| `verify_identity` + `reset_password` (+ `create_ticket`) | **one fake MCP tool each** | Same; CSUB NetID/MyID/Duo/ServiceNow vocabulary [findings/13 §16–19] |
| `escalate_to_human` (crisis path) | **one fake MCP tool** + persona Safety section | Same, plus prompt section [findings/12 §4.3–4.4] |
| Basic fake transfer (tool + narrated handoff, persona shift via prompt) | **one fake MCP tool + persona-prompt-only** | Model narrates handoff and shifts register per instructions; no new plumbing |
| Polished fake transfer (hold/ring clip + hard per-response persona override mid-call) | **small code change** | All primitives exist — clip playback via the fallback pattern (`src/fallback.ts:94-150`), per-response instruction override (`src/gateway.ts:604-607`), session callbacks as the sanctioned seam — but choreographing them mid-call is new session logic; hold-clip playback timing is spike S23 territory [findings/11 §C10, §C13] [findings/10 §S23] |
| Transcript hand-out + printed KPI/latency report | **zero code** (offline presentation work) | Transcripts and per-call KPI records already emitted; filter Railway logs by `@callSid` and format [findings/11 §C6–C7] |
| Live on-screen transcript/latency pane during the call | **small code change** | New read-only view over the log stream; no bridge changes, but it is new surface — the recorded-screen-capture fallback works with zero code |
| Voice A/B (marin ↔ cedar/alloy) | **env flip** | `VOICE` env var; verify via `session-updated.raw` [findings/11 §C11] |
| Fake `send_sms` narration | **one fake MCP tool** (recommend skipping; talk-track instead) | [findings/11 §C12] |
| Real SMS, real transfers/`<Dial>`, real recording pipeline, real identity verification, real dashboards, active-threat dispatch | **out of scope** | Excluded by the BRD's non-goals and fake-data charter [BRD §1] [findings/11 §C9, §C12]; talk-tracks in §2 |

---

## 6. Risks & honesty

**What we must NOT imply — state each limit out loud in the room:**

- **No real transfers.** The "warm transfer" is a persona handoff inside one AI call; no second human or system is ever connected; the TwiML cannot dial anyone [findings/11 §C9]. Say: "same call, second hat — the production version dials a real desk."
- **No real recording pipeline.** Transcript logs are real; audio recording, retention, and redaction do not exist here [findings/11 §C7] [BRD §1]. FR-05 is a Phase 1A blocker in the real program — do not wave at it.
- **No real identity verification.** `verify_identity` always succeeds on fake data. Never let a stakeholder believe credential actions were verified against anything.
- **No real knowledge base, no real dashboards, no real SMS.** Canned tool returns; a printed report; a narrated sentence at most [findings/11 §C12].
- **Label everything FAKE on screen, and declare live-vs-recorded explicitly.** The Google Duplex collapse was about ambiguity, not staging per se — never leave stakeholders unsure what was real; if the backup recording is used, say so; the agent self-identifies as AI at pickup (California disclosure context) [findings/14 §C27].
- **Use only defensible numbers.** Containment 25–35% early/realistic; attribute vendor stats as vendor stats; pair containment with a quality metric [findings/14 §C22]. Flag weak-provenance higher-ed numbers (WGU, Georgetown) or omit them [findings/14 §C30].
- **Concede Amazon Connect's real strengths proactively** — Contact Lens analytics, FedRAMP/PCI/HIPAA posture, PII redaction, WFM/omnichannel machinery — and note the approaches can compose [findings/14 §C25–C26].
- **Small print on "always answers":** the PoC inherits a 25-minute gateway session cap and severs calls on deploy [BRD §3, §7.6] — irrelevant to short demo calls, but don't claim production-grade availability.

**Crisis-demo ethics note (binding):**

The crisis beat is **scripted, announced as scripted before it plays, and uses a mild cue only** — never realistic or graphic distress, never a real caller, never improvised. Rationale: (1) staging realistic distress on stage is exploitative and will alienate exactly the stakeholders who own this requirement; (2) the Realtime API runs active safety classifiers that can halt a session tripped by harmful content — an unscripted distress performance risks a mid-demo halt [findings/12 §4.2, §4.4]; (3) the demonstrable claim is narrow and honest: *the AI recognizes distress and executes a designed escalation path with real resource numbers (Counseling Center, 988, UPD)* [findings/13 §20–22] — the far end of that path is production work with UPD and Counseling, not demo material. If any audience member is personally affected, the presenter's script includes the real 988 line as a genuine resource, stated plainly. The active-threat path is discussed, never performed (§2 FR-3).

**Residual demo risks:**

| Risk | Mitigation |
|---|---|
| `marin` rejected by gateway (open spike S8) | Pre-demo `session-updated.raw` check; `alloy` env fallback [findings/10 §S8] [findings/11 §C11] |
| Unwanted language behavior (accent-triggered switch) | Explicit switch-policy paragraph per OpenAI guidance; rehearse with the actual demo callers [findings/12 §1.2–1.3] |
| Model wanders off script | Sample phrases in instructions (model follows them near-verbatim) + tool returns as script + 2–3 sentence cap [findings/12 §2.6, §3.6] |
| Venue network/cell variance | In-room smoke test; tested handset; WiFi-calling fallback [findings/14 §C19] |
| Live "call it yourself" Q&A goes off-road | It's the strongest credibility move [findings/14 §C3]; accept the risk knowingly — persona guardrails and the safety section are the only rails; brief the room that it's a fake-data PoC first |

---

## Source docs

- `docs/findings/10-gap-analysis-and-contradictions.md` (scope guardrails, spikes S8/S23/G3)
- `docs/findings/11-demo-codebase-capability-audit.md` (C1–C13; all code extension points, file:line cites therein)
- `docs/findings/12-demo-realtime-model-capabilities.md` (§1–§6; OpenAI docs/community URLs cited therein)
- `docs/findings/13-demo-csub-caller-context.md` (§1–§30; csub.edu URLs cited therein; note its own unverified-items list before printing any fact)
- `docs/findings/14-demo-craft-and-storytelling.md` (C1–C31; demo-craft URLs cited therein)
- `BRD_Micro_Voice_PoC.md` (§1 purpose/non-goals, §2 FRs, §3 NFRs, §7 deploy rules)

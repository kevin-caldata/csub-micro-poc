# Findings 14 — Demo Craft & Storytelling for the CSUB Stakeholder Demo

**Date:** 2026-07-19
**Researcher:** subagent (demo-craft / storytelling domain — web research only, no code changes)
**Status:** Complete. All claims are web-sourced; vendor-marketing numbers are flagged as such. This is input to a demo-concept document, not an engineering finding.

## Scope

How great voice-AI / contact-center demos are staged, to inform the design of the live CSUB stakeholder demo of the RIO PoC (Twilio → gpt-realtime-2.1 via Vercel AI Gateway, MCP fake-data tools, latency instrumentation as the deliverable). Covers: (1) vendor demo narrative patterns, (2) wow moments for non-technical stakeholders, (3) live-demo risk management, (4) presenting metrics alongside a live call, (5) honest competitive framing vs Amazon Connect/Lex, (6) higher-ed AI phone deployments.

Source-confidence key: **[strong]** = primary vendor/press source or multiple independent sources; **[medium]** = single secondary source or vendor marketing; **[weak]** = unverified vendor blog claim, use only with attribution or not at all.

---

## 1. Demo narrative patterns — what the vendors actually stage

### C1. The canonical flagship demo is a live phone call with a task, a tool call, and a physical payoff — OpenAI DevDay 2024. **[strong]**

OpenAI's biggest Realtime API demo (DevDay SF, Oct 2024): developer-experience engineer Ilan Bigio had the voice agent **place a live phone call to order 400 chocolate-covered strawberries delivered to the venue, under a $1,500 budget** — i.e., a spoken goal, live function calling over Twilio, a negotiated conversation with a real human vendor, and then the strawberries were physically waiting as attendees exited ("the stage show had become reality"). The pattern to copy: *state a concrete goal out loud → let the audience hear the whole call → end with verifiable proof the tool call really happened.*
- https://www.latent.space/p/devday-2024
- https://techcrunch.com/2024/10/01/openais-devday-brings-realtime-api-and-other-treats-for-ai-app-developers/
- https://x.com/tsarnick/status/1841229808510042356

For CSUB: the analog of "strawberries at the door" is a fake-data tool result the audience can immediately verify on screen — e.g., the agent books a (fake) advising callback and the confirmation appears on the projected dashboard the moment the agent says it.

### C2. GPT-4o Spring Update (May 2024) established the emotional-range + interruption narrative. **[strong]**

The 15-minute livestreamed demo that "shocked audiences" did three things demo designers still copy: (a) presenters **interrupted the model mid-sentence and it stopped, listened, adjusted** — no waiting for it to finish; (b) they asked for a bedtime story and then **demanded escalating voice styles** (more dramatic → robot voice), demonstrating personality on command; (c) responses were fast enough to feel like "a remarkably naturally paced AI conversation." Tom's Guide's later hands-on headline: "if anything it is underhyped."
- https://www.technologyreview.com/2024/05/13/1092358/openais-new-gpt-4o-model-lets-people-interact-using-voice-or-video-in-the-same-model
- https://openai.com/index/hello-gpt-4o/
- https://www.tomsguide.com/ai/chatgpt/i-finally-saw-a-live-demo-of-chatgpt-4o-voice-if-anything-it-is-underhyped
- https://www.axios.com/2024/05/14/openai-chatgpt-4o-chatbot-her

### C3. The voice-agent platform vendors each stage a different core claim; the common denominator is "call it yourself." **[medium — synthesis of comparison posts + vendor sites]**

- **Retell AI**: managed, low-latency inbound phone agent — demos emphasize speed to a working agent and production latency (~600 ms class) rather than flash. https://www.retellai.com/ ; https://techsy.io/en/blog/retell-ai-vs-vapi-vs-bland
- **Vapi**: developer control — demos show swapping STT/LLM/TTS components; tested median latency ~500–700 ms with a tuned stack. https://tested.media/retell-vs-vapi-vs-bland-vs-synthflow/
- **Bland**: "human-sounding" proprietary voice + deterministic Pathways flows for outbound at 1,000+ concurrent calls. https://www.bland.ai/blog/retell-vs-vapi
- **Sierra**: enterprise CX story — build an agent from your own SOPs/transcripts, deploy one agent across chat/SMS/voice/email; voice pitched as "low enough latency to sustain natural phone conversation without the awkward pauses." https://sierra.ai/ ; https://www.retellai.com/blog/sierra-vs-decagon
- **Decagon**: control story for non-technical operators — natural-language "Agent Operating Procedures" ("if a refund is over $100, verify purchase date and escalate") compiled into enforceable logic; unified voice/chat/email. https://decagon.ai/product/voice ; https://cresta.com/guides/decagon-vs-sierra
- Several vendors (e.g., Upfirst) put a **public demo phone line on the homepage** — the strongest credibility move is inviting the audience to dial the number from their own phones. https://upfirst.ai/blog/english-and-spanish-ai-voice-agent

For CSUB: end the demo by putting the Twilio number on the screen and inviting stakeholders to call it from their own phones during Q&A. Nothing in a slide deck matches that.

### C4. Amazon Connect/Lex flagship demos are builder-and-dashboard demos, not caller-experience demos. **[strong]**

AWS's own Connect+Lex+Bedrock demo content centers on: building an IVR/bot "in hours using natural-language prompts," knowledge-base retrieval, intent routing, and the admin/analytics side (Contact Lens sentiment, real-time dashboards). The showcased artifacts are consoles and flows — hotel-reservation bots, account-balance checks — not a hyper-natural live conversation. This asymmetry is the CSUB demo's opening: *they demo the cockpit; we demo the passenger experience.*
- https://aws.amazon.com/blogs/machine-learning/deploy-generative-ai-agents-in-your-contact-center-for-voice-and-chat-using-amazon-connect-amazon-lex-and-amazon-bedrock-knowledge-bases/
- https://press.aboutamazon.com/2023/11/amazon-connect-introduces-generative-ai-capabilities-to-help-organizations-boost-worker-productivity-save-costs-and-improve-customer-service-experiences
- https://github.com/aws-samples/contact-center-genai-agent

### C5. Before/after framing vs the old IVR is a standard, well-supported narrative with citable industry numbers. **[medium — vendor-published stats; use with attribution]**

The published framing contrast: touch-tone IVR = "Press 1 for billing," 3–5 menu levels, **67% of callers abandon a touch-tone IVR within 90 seconds and 34% of those never call back**; traditional IVR contains only 10–30% of calls. AI voice agent = "How can I help you today?", caller speaks in their own words, vendors claim 60–80% autonomous resolution (treat the 60–80% as vendor marketing; independent Forrester-based figures are 25–35% — see C22).
- https://www.bland.ai/blog/ai-voice-agent-vs-traditional-ivr-systems
- https://konecto.ai/blog/ai-voice-agent-vs-ivr-complete-comparison-2026/
- https://www.retellai.com/blog/voice-ai-vs-ivr-conversational-agents-replacing-phone-trees
- https://www.ringlyn.com/blog/conversational-ivr-guide-2026/

Staging idea consistent with this pattern: **play 20–30 seconds of the real current CSUB phone-tree experience (recorded) first**, then place the live call to RIO. The old IVR is the villain; let it hang itself in its own voice. (The 67%-in-90s stat pairs directly with CSUB's own 34.6% abandonment number.)

### C6. "Do the last thing first" (Peter Cohan, *Great Demo!*) — open with the payoff, not the build-up. **[strong — established demo methodology]**

Cohan's core technique: show the end result first ("show them a photo of the delicious meal before the cooking instructions"), get the "Wow," then drill into detail only as the audience asks. Traditional demos "take 20–40 minutes to get to the point" and lose executives. For CSUB: the demo should open with the live call itself (or a 60-second recorded best-take), *then* explain architecture/latency — never the reverse. Architecture slides before the call is the classic failure mode.
- https://www.reprise.com/resources/blog/peter-cohan-on-how-to-get-the-end-result-in-a-software-demo
- https://www.linkedin.com/posts/petercohan_do-the-last-thing-first-begin-with-the-activity-7212511424420462592-swCC
- https://www.amazon.com/Great-Demo-Stunning-Software-Demonstrations/dp/059534559X

### C7. Scripted caller personas are standard practice in voice-AI evaluation and transfer directly to demo staging. **[strong]**

Voice-AI testing guidance: build **persona sets reflecting real caller demographics**, cover happy paths, edge cases, interruptions and adversarial inputs, and test each language/accent claimed. For a demo, this means 2–3 pre-written caller personas (e.g., "first-gen freshman asking about financial-aid deadline at 9pm," "parent who only speaks Spanish," "student who interrupts and changes topic mid-answer") with rehearsed scripts — the caller side of a live demo should be as scripted as the slides.
- https://www.cekura.ai/blogs/best-practices-for-ai-voice-agent-testing
- https://www.voiceflow.com/blog/ai-phone-call

---

## 2. Wow moments that land with non-technical stakeholders

### C8. Barge-in/interruption is the single most reliable wow moment — and it's the one thing legacy IVRs visibly cannot do. **[strong]**

"The ability to handle interruption is the first moment where the voice interface actually feels interactive instead of scripted"; a voice agent that doesn't handle interruptions "feels robotic in 30 seconds and unbearable in three minutes." OpenAI positions the Realtime API explicitly as the starting point for "barge-in, low first-audio latency, natural turn taking, and realtime tool use." Staging: the scripted caller should **deliberately talk over the agent mid-sentence** ("—actually wait, I meant the *spring* deadline") and let the room hear it stop instantly and pivot. Rehearse this; it is the money shot. (The PoC's own barge-in mechanics: `docs/findings/04-barge-in-and-realtime-voice-patterns.md`.)
- https://www.latent.space/p/realtime-api
- https://developers.openai.com/api/docs/guides/voice-agents
- https://medium.com/@abdullahirfan99_80517/making-openai-realtime-voice-agent-interruptible-cdb08e23e87b

### C9. Mid-call language switch is the moment that makes non-technical stakeholders say "that sounds real." **[strong]**

Multiple sources independently identify the mid-call switch (not a "press 2 para español" fork) as the reaction-getter: "Spanish voice AI quality is often what gets non-technical stakeholders to react with, 'Okay, that sounds real.'" Upfirst's homepage demo line has callers say "Can you speak in Spanish?" and the agent replies immediately in Spanish; LiveKit's reference agent detects the switch automatically mid-conversation. For CSUB (a Hispanic-Serving Institution region), a caller switching to Spanish mid-call and the agent following without a beat is both a wow moment and a mission-relevant service argument.
- https://upfirst.ai/blog/english-and-spanish-ai-voice-agent
- https://livekit.com/blog/build-multilingual-voice-agent-automatic-language-switching
- https://www.gladia.io/blog/multilingual-voice-agents
- https://www.assemblyai.com/blog/multilingual-voice-agent

### C10. Tool use with spoken confirmation — the agent must *say* what it did, and the screen must prove it. **[strong]**

The DevDay strawberries pattern (C1): the wow is not the API call, it's the agent narrating a real-world side effect that the audience can verify. In the PoC: agent says "I've scheduled a callback from an advisor for Tuesday at 2pm — you'll get a text confirmation," and the projected view shows the MCP tool invocation + fake record appearing in real time. Explicitly label all data FAKE on screen (see C27 on the Duplex authenticity backlash — never let stakeholders wonder what was real).
- https://www.latent.space/p/devday-2024

### C11. "It's 2am and someone answers" is the standard emotional frame for after-hours coverage — and it has hard higher-ed numbers behind it. **[strong]**

The 24/7 pitch is ubiquitous ("At 2 AM if needed"; "85% of callers refusing to try again after reaching voicemail"), but the higher-ed-specific evidence is better: at Nevada State University, **36% of AI assistant interactions happened after business hours and 15% on weekends** (see C29). Staging: open one scripted call with a wall clock on screen showing 2:07 AM and a persona line like "I know it's late, I just got off work…" — this maps 1:1 onto CSUB's "zero after-hours coverage" KPI.
- https://octavius.ai/ai-call-answering-after-hours/
- https://vida.io/blog/missed-call-solutions-guide
- https://gravyty.com/resources/case-studies/nevada-state-university-ai-financial-aid-expertise/

### C12. Personality/emotional range is a wow moment but must be used in one small, controlled dose. **[medium]**

GPT-4o's bedtime-story voice-style escalation drove the audience reaction (C2), and platforms sell "adapt tone and personality to institutional needs" (Element451). But contact-center guidance warns that great-sounding demos that stall or invent answers lose to boring agents that ground and hand off cleanly ("judge a phone agent on latency, grounding, and handoff, not the voice demo"). For CSUB: one warm, brand-appropriate beat (agent gently reassures an anxious student) — not voice tricks.
- https://element451.com/blog/an-alternative-to-higher-ed-call-centers
- https://www.lindy.ai/blog/ai-voice-agents

### C13. Instant pickup itself is a wow moment — zero rings, zero hold. **[medium]**

Callback-time compressions cited in higher-ed AI deployments (24 hours → 2 minutes; 18 hours → under 3 minutes) frame the contrast. In the room, the visceral version is simpler: the phone connects and a voice answers *immediately* — no ring cycle, no "your call is important to us." Contrast this against the recorded hold-music clip from C5's before/after framing.
- https://blog.voagents.ai/ai-use-cases/ai-voice-agents-for-higher-education/
- https://www.ondial.ai/blog/ai-voice-agents-admissions-follow-up-educational-institutions

---

## 3. Risk management for live demos

### C14. Always have a recorded backup of the exact demo, reachable in two clicks. **[strong]**

Sales-engineering consensus: keep "a recorded walkthrough… stored in a folder you can access quickly," and if the live version breaks say "Let me just show you a quick video of how this works in action" — pre-planned, not improvised. For a phone demo: record the best rehearsal take (audio + synchronized dashboard screen capture) and have it open in a background tab before the meeting starts.
- https://www.vidyard.com/blog/perfect-live-software-demos/
- https://www.guideflow.com/blog/sales-engineering-demo-best-practices
- https://www.reprise.com/resources/blog/software-demo-best-practices

### C15. Use a dedicated, frozen demo environment — never demo off a moving target. **[strong]**

"The most battle-tested SEs avoid demo risks entirely by using dedicated demo environments designed for reliability" — live/production environments introduce auth, dependency, data, and connectivity failure points. For the PoC: pin a known-good deploy on Railway (freeze `main` or use a `demo` tag) at least a day ahead; **no pushes to the auto-deploying branch on demo day**; run the full call flow as a smoke test 30 minutes before, from the same room, on the same phone.
- https://www.reprise.com/resources/blog/software-demo-best-practices
- https://medium.com/@srinathmohan_21939/why-tech-demos-fail-even-after-weeks-of-prep-and-what-you-can-do-about-it-5f5696fc7cab

### C16. "Demo gods" excuses no longer land — rehearsal and environment discipline are expected. **[medium]**

The demo-gods excuse "used to be met with chuckles but now is met with eye rolls." Failures that were survivable in 2018 read as unpreparedness in 2026. Corollary: rehearse the *recovery* too (switching to the recording, acknowledging without flustering — "failing forward").
- https://www.linkedin.com/pulse/sales-engineer-confessions-demo-blame-game-scott-taschler
- https://www.reprise.com/resources/blog/the-art-of-failing-forward-demo-lessons-learned
- https://www.reprise.com/resources/blog/demo-fails-how-to-turn-challenges-into-triumphs

### C17. Script and rehearse the *caller* side; the caller is a performer, not an ad-libber. **[strong]**

Voice-AI testing practice runs multi-turn simulations against defined personas and measures against thresholds (C7); the live-demo application is that the human caller follows a rehearsed script with planned interruption points and a planned language switch. Ad-libbed caller turns are the top self-inflicted demo killer: they wander into un-prompted territory, invite hallucination, and blow the time box. Known failure modes to script around: **background noise** (testing guidance explicitly layers in "cars, kitchens, busy offices" noise as an adversarial condition — so in the demo room, use a quiet handset near the mic, not open speakerphone in a boomy conference room unless tested there), and **over-long agent monologues** (cap responses via system prompt: 2–3 sentences unless asked for more).
- https://www.cekura.ai/blogs/best-practices-for-ai-voice-agent-testing
- https://shilotri.com/sales/sales-engineering/common-mistakes-to-avoid-during-technical-demos/

### C18. Keep each call short — the 60–90 second call beats the 5-minute call. **[medium — synthesis]**

Cohan: audiences decide "very rapidly" whether the end result is interesting (C6); demo-length guidance consistently pushes compression (an entire practitioner PDF is titled "Shorten That Demo"). Voice-specific: interruption-handling failure becomes "unbearable in three minutes" (C8) — long calls multiply exposure to every failure mode. Recommended shape: 3 scripted calls × ~90 seconds each (task+tool call / barge-in+language switch / 2am persona), not one long omnibus call. Total live-audio time under 5 minutes.
- https://masteringtechnicalsales.com/wp-content/uploads/2015/09/Shorten_That_Demo.pdf
- https://www.reprise.com/resources/blog/peter-cohan-on-how-to-get-the-end-result-in-a-software-demo

### C19. Latency is the spec most likely to kill the illusion — verify it in-room, not just in dashboards. **[strong]**

"Latency is the single most important spec to check"; "a sub-second, knowledge-grounded agent that hands off cleanly beats a great-sounding one that stalls." Cellular/venue-network variance affects the Twilio leg: test from the actual demo room on the actual carrier. If the venue's cell coverage is poor, plan a wired/WiFi-calling fallback or a different handset.
- https://www.lindy.ai/blog/ai-voice-agents
- https://www.cekura.ai/blogs/best-practices-for-ai-voice-agent-testing

---

## 4. Presenting metrics alongside the live call

### C20. Lead with the end-state dashboard (executives), drill down only on request. **[strong]**

"Leading with the end-state dashboard or report is the fastest way to engage senior leadership" (Cohan/Reprise). For CSUB: one projected screen during calls — live transcript + a small latency readout (the PoC's instrumentation is the deliverable; see `docs/findings/09-latency-instrumentation.md`) — and one *summary* slide after: measured time-to-first-audio, barge-in cut-off time, per-turn round trip. Don't show raw event logs unless asked.
- https://www.reprise.com/resources/blog/peter-cohan-on-how-to-get-the-end-result-in-a-software-demo

### C21. The executive metric set for an IVR-replacement story is standardized — use their vocabulary. **[strong]**

Executive IVR/IVA dashboards conventionally show: total volume, top intents, **containment rate**, self-service success, transfer rate, abandonment, repeat contact, and estimated cost impact; containment translates for executives to "lower cost-to-serve, faster resolution, scalable service." Presenting the PoC's story in these terms ("here is the abandonment we'd attack, here is the containment range the industry sees") signals contact-center literacy to stakeholders who are evaluating against Amazon Connect's mature reporting.
- https://www.kenwayconsulting.com/blog/ivr-metrics-executive-dashboards/
- https://umbrex.com/resources/company-analysis/customer-service-support/channel-containment-rate/
- https://www.parloa.com/knowledge-hub/what-is-containment-rate-in-contact-center/

### C22. Use *defensible* containment numbers: 25–35% early/realistic, 40–70% only in mature deployments. **[strong]**

Independent-data-based guidance: realistic mid-market blended containment is **25–35%** (Forrester-derived; a verified production end-to-end figure of 28% is cited); early deployments land 20–40%; 40–70% only after maturation. Vendor claims of 60–80% (C5) should not be promised. Also present a paired quality metric (CSAT / repeat-contact within 7 days) — "containment on its own tells you almost nothing about whether you're creating value," and gaming it ("the containment trap") is a known credibility hazard. Under-promising here is a differentiator, since stakeholders will hear inflated numbers from every vendor.
- https://www.blueorbitconsulting.com/blog-2-1/blog/contact-center-ai-roi-business-case
- https://www.teneo.ai/blog/containment-rate-call-centre-benchmarks-improve-it-2026
- https://www.parloa.com/blog/why-your-ai-cx-metrics-are-lying-to-you/
- https://rasa.com/blog/measure-ai-agent-performance-in-the-contact-center

### C23. Tie every demo beat to a named CSUB KPI on the same slide. **[medium — synthesis]**

The business-case guidance is to pair each capability with the outcome metric it moves and to model what happens to freed capacity explicitly. Mapping for the deck (CSUB KPIs as given in the RIO business case):
- **34.6% call abandonment** → instant-pickup beat (C13) + industry "67% abandon touch-tone IVR within 90 seconds" (C5) + containment range (C22).
- **Zero after-hours coverage** → 2am persona call (C11) + Nevada State's 36% after-hours / 15% weekend interaction share (C29).
- **Latency instrumentation** → the live latency readout during the call (C20) — evidence the team measures what it ships.
- https://www.blueorbitconsulting.com/blog-2-1/blog/contact-center-ai-roi-business-case
- https://www.balto.ai/blog/kpis-for-voice-ai-agents-in-contact-centers/

---

## 5. Competitive framing vs Amazon Connect / Lex — honest version

### C24. What the OpenAI-realtime PoC can show that a Connect/Lex demo typically cannot. **[strong]**

- **Speech-to-speech naturalness & latency**: the Realtime API processes audio natively without an STT→LLM→TTS transcode chain, "eliminating latency inherent in traditional pipelines" and enabling **semantic interruption** — the agent stops the instant the caller speaks. Lex-based Connect flows are intent/slot NLU pipelines (ASR → NLU → response), even when Bedrock LLMs generate answer text.
- **No menu tree at all**: Lex bots are built from intents and slot-filling; the Connect demo idiom is "create IVR systems in hours" — still an IVR authoring story. The PoC has no intents to enumerate: any phrasing, topic pivots, compound requests.
- **Barge-in as conversation, not DTMF**: Lex "streaming conversation APIs" support pause/hold-style interruptions that must be configured; realtime barge-in is native turn-taking behavior.
- https://www.latent.space/p/realtime-api
- https://developers.openai.com/api/docs/guides/realtime
- https://docs.aws.amazon.com/lexv2/latest/dg/contact-center.html
- https://aws.amazon.com/blogs/machine-learning/enhance-amazon-connect-and-lex-with-generative-ai-capabilities/

### C25. What Connect legitimately shows better — concede these on purpose. **[strong]**

- **Operational analytics**: Contact Lens real-time dashboards, live sentiment, supervisor listen-in/barge/agent-state controls, theme detection.
- **Compliance posture**: Contact Lens is FedRAMP Moderate, PCI, SOC, HIPAA-eligible; automatic PII redaction from transcripts/recordings; agent-compliance tracking (greetings/sign-offs). For a CSU (state entity, FERPA/accessibility obligations), this matters and stakeholders will know it.
- **Workforce/omnichannel machinery**: routing, queues, WFM, recording retention — a full contact-center suite vs. the PoC's single voice path.
- https://aws.amazon.com/about-aws/whats-new/2021/11/amazon-connect-contact-lens-fedramp-compliant/
- https://docs.aws.amazon.com/connect/latest/adminguide/contact-lens.html
- https://docs.aws.amazon.com/connect/latest/adminguide/dashboards.html
- https://aws.amazon.com/products/connect/customer/conversational-analytics/

### C26. The honest positioning sentence. **[synthesis]**

"Connect is a mature contact-center *operations* platform with a bolt-on voice bot; this PoC is a next-generation *caller experience* with contact-center operations still to build. Today you heard the part Connect cannot easily replicate; the dashboards and compliance wrapper are known, buildable engineering — and note these approaches aren't mutually exclusive (Connect can front real-time voice backends, so 'RIO experience + enterprise telephony substrate' is a viable end-state, not a binary)." Conceding C25 proactively converts the demo's biggest vulnerability (a stakeholder asking "but where's the reporting/compliance?") into evidence of candor.

### C27. Authenticity discipline: the Google Duplex lesson — never leave stakeholders unsure what was real. **[strong]**

Duplex (Google I/O 2018) wowed the room, then credibility collapsed under scrutiny: no business names on pickup, **no ambient background noise** on the "live" calls, and Google refused to answer whether calls were edited/staged — "more of an issue than the staging itself." It's now literally a Museum of Failure exhibit. Also an ethics flashpoint: the AI never identified itself as an AI. For CSUB: (a) state clearly what's live vs. recorded; (b) label all data FAKE on screen; (c) have the agent identify itself as an AI assistant at pickup — California has disclosure law in this space and CSUB stakeholders will care; (d) if the backup recording is used, say so.
- https://www.slashgear.com/google-duplex-ai-demo-io-2018-authenticity-concerns-17531106/
- https://techcrunch.com/2018/05/18/what-we-know-about-googles-duplex-demo-so-far/
- https://gizmodo.com/pretty-much-all-tech-demos-are-fake-as-hell-1826143494
- https://techcrunch.com/2018/05/10/duplex-shows-google-failing-at-ethical-and-creative-ai-design/
- https://museumoffailure.com/exhibition/google-duplex-demo-ai
- (disclosure-law note, re: OpenAI DevDay coverage) https://techcrunch.com/2024/10/01/openais-devday-brings-realtime-api-and-other-treats-for-ai-app-developers/

---

## 6. Higher-ed AI phone/assistant deployments — named cases

### C28. Named deployments exist but *voice-specific*, independently-verified higher-ed case studies are thin — say so honestly. **[medium overall]**

Most named higher-ed cases are chat/virtual-assistant deployments extended toward voice; the pure phone-agent numbers below are mostly vendor-published. Best-supported first:

### C29. Nevada State University (Gravyty/Ivy+Ocelot) — the strongest citable case. **[strong — vendor case study with named staff, since 2019]**

Deployed 2019 across Financial Aid, Admissions, Advising, IT; later campus-wide. **150,895 assistant interactions; 36% after business hours; 15% on weekends.** Anthony Morrone, Director of Financial Aid: "If a student can go to one institution and get answers immediately, while another requires them to search through a website… that institution has gained a customer." The 36%/15% split is the single best external number for CSUB's after-hours KPI.
- https://gravyty.com/resources/case-studies/nevada-state-university-ai-financial-aid-expertise/

### C30. Other named institutions (chat/assistant-adjacent, weaker sourcing on voice specifics). **[medium/weak — flag provenance if used]**

- **Arizona State University**: voice-activated campus assistant via Amazon Alexa ("ASU" skill; Echo Dots in residence halls) — a voice-UX precedent, not a call-center replacement. https://edtechmagazine.com/higher/article/2025/12/ai-agents-higher-education-transforming-student-services-and-support-perfcon
- **University of Tennessee, Knoxville**: "UT Verse" conversational AI for student everyday needs. Same source as above.
- **Western Governors University**: vendor-cited **23% improvement in student persistence** attributed to proactive AI phone outreach to at-risk online learners. **[weak — appears in a vendor blog; verify before quoting]** https://callin.io/education-answering-service/
- **Georgetown University**: vendor-cited 37% reduction in misdirected calls, 42% less chair time on routing from department AI voice assistants. **[weak — same vendor-blog class]** https://callin.io/education-answering-service/
- **Element451 (Bolt AI voice)**: sector product positioning — "unlimited concurrent calls 24/7," task completion (webinar enrollment), pitched explicitly as *An Alternative to Higher Ed Call Centers*; no named-school voice results published. https://element451.com/blog/an-alternative-to-higher-ed-call-centers
- Unnamed-institution vendor stats (usable only as "vendors report" color): 15,000-student university automating 38,000 calls/yr, $503K savings, +3.2% enrollment yield; callback time 24h → 2 min; response time 18h → <3 min; **77% of students would use AI agents for school processes; 52% more likely to apply where information is easier to find.** **[weak–medium]**
  https://blog.naitive.cloud/ai-agents-student-support-case-study/ ; https://blog.voagents.ai/ai-use-cases/ai-voice-agents-for-higher-education/ ; https://www.ondial.ai/blog/ai-voice-agents-admissions-follow-up-educational-institutions ; https://element451.com/blog/an-alternative-to-higher-ed-call-centers
- Sector framing: 2025 widely described as the year AI agents moved into real deployment in higher ed. https://www.higher-education-marketing.com/blog/the-year-of-the-ai-agent-in-higher-education

### C31. Implication: CSUB can claim near-first-mover status on *realtime voice* in the CSU/public-university space. **[synthesis]**

Because verified public case studies of universities running OpenAI-realtime-class phone agents are essentially absent (C28–C30), the demo can honestly frame CSUB as ahead of the sector — "the named precedents are chatbots; nobody in our sector has shown you *this* on a phone line" — which is itself a stakeholder wow beat, provided the thin-precedent risk is acknowledged in the same breath.

---

## Synthesis: recommended demo shape (for the demo-concept doc)

1. **Cold open (Cohan, C6):** 25-sec recording of today's real CSUB phone-tree hold experience → cut to silence → "34.6% of those callers hang up. After 5pm, nobody answers at all."
2. **Call 1 — instant pickup + task + tool (C1, C10, C13):** live speakerphone call; agent answers instantly, identifies itself as an AI (C27), answers a registrar question, books a fake advising callback; confirmation appears on projected dashboard; ~90 sec.
3. **Call 2 — barge-in + Spanish switch (C8, C9):** scripted interruption mid-answer; caller switches to Spanish; agent follows seamlessly; ~90 sec.
4. **Call 3 — 2am persona (C11):** on-screen clock 2:07 AM; working-student persona; ~60 sec.
5. **Metrics beat (C20–C23):** one slide — measured latency from the calls just heard; abandonment/after-hours KPI mapping; defensible 25–35% containment framing.
6. **Honest competitive slide (C24–C26):** what you just heard that Connect can't demo; what Connect has that this PoC doesn't (dashboards, FedRAMP/compliance) — conceded proactively.
7. **Close (C3):** Twilio number on screen; "call it yourself, right now, from your own phone."
   Risk kit throughout: frozen deploy + no-push freeze (C15), rehearsed caller scripts with planned interruption points (C17), recorded best-take two clicks away (C14), in-room latency smoke test 30 min prior (C19), total live-audio under 5 minutes (C18).

# 12 — gpt-realtime-2.1 Capabilities Relevant to the CSUB RIO Demo

Date: 2026-07-19 · Status: Research complete (web research; no code changes — thought exercise for the demo-concept doc)

Scope: what the model the PoC already targets (`openai/gpt-realtime-2.1`, `VOICE=marin` — BRD_Micro_Voice_PoC.md:121, BRD_Micro_Voice_PoC.md:301-303) can do that would make the CSUB stakeholder demo impressive: bilingual switching, persona prompting, narrative-driving tool calls, safe crisis routing, voice selection, and 2.1-specific talking points vs Amazon Connect.

Numbered-claims style. Confidence tags: **[VERIFIED]** = primary source (OpenAI docs/announcement) or multiple independent sources; **[REPORTED]** = single secondary source or community report; **[INFERENCE]** = our conclusion from the evidence.

---

## 1. Bilingual / Spanish mid-call switching

**1.1 [VERIFIED]** The realtime model family handles multilingual conversation natively — the model "can switch languages mid-sentence" — and Spanish is in the top tier of supported languages (alongside French, German, Portuguese, Mandarin, etc.). GPT-Realtime-2 advertises "32+ languages with native prosody," Spanish included.
Sources: https://openai.com/index/introducing-gpt-realtime/ · https://www.mindstudio.ai/blog/gpt-realtime-voice-models-explained · https://sheerbit.com/building-multilingual-voice-agents-with-livekit/

**1.2 [VERIFIED]** Language behavior is **prompt-controlled, not a session config field**. OpenAI's realtime prompting docs give the canonical patterns:
- Default/lock: "English is the default response language. Do not infer language from accent alone."
- Switch policy: switch only when the caller *explicitly asks* or produces *a substantive utterance in another language* — never from accent, filler words, or an isolated foreign phrase.
- Hard lock (if you want to forbid switching): "The conversation will be only in English. Do not respond in any other language even if the user asks."
For the demo we want the inverse of the hard lock: an explicit "if the caller speaks Spanish, continue the conversation in Spanish" rule in the instructions.
Source: https://developers.openai.com/api/docs/guides/realtime-models-prompting

**1.3 [VERIFIED]** The switch-policy guidance exists because the failure mode is real: community threads report older realtime models spontaneously replying in Spanish to accented English, and misdetecting language from accent. An explicit language section in the system prompt is the fix in both directions (preventing unwanted switches AND enabling wanted ones).
Sources: https://community.openai.com/t/realtime-api-often-replying-in-spanish/1146050 · https://community.openai.com/t/realtime-api-speech-non-english-voice-language-development/1105821

**1.4 [REPORTED]** *Accent* control within Spanish is the known weak spot: prompting cannot reliably force a specific regional accent. A July 2026 thread on Mexican Spanish concludes prompt instructions "help with wording and delivery a bit, but not the actual accent enough" (Realtime 2.0; custom voices suggested as the only real path). A peninsular-Spanish thread reports output skewed toward Latin American Spanish regardless of ALL-CAPS accent mandates. For a Bakersfield/CSUB demo audience the default Latin-American-leaning Spanish is arguably the *right* accent, so this limitation is harmless-to-favorable for us. **[INFERENCE]**
Sources: https://community.openai.com/t/trouble-getting-realtime-voices-to-sound-naturally-mexican-spanish/1381345 · https://community.openai.com/t/best-practice-to-enforce-spanish-peninsular-accent/1362871

**1.5 [VERIFIED]** OpenAI also ships a dedicated `gpt-realtime-translate` model (70+ input languages → 13 output languages, auto source-language detection, pace-matched) — not what we need for a single bilingual operator persona, but a good "and there's a whole translation model if RIO ever needs live interpretation" aside for stakeholders.
Sources: https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide · https://www.mindstudio.ai/blog/gpt-realtime-2-vs-gpt-realtime-translate

**1.6 [VERIFIED]** 2.1 specifically improved alphanumeric recognition *in Spanish* (and Chinese/Japanese/French) per OpenAI's internal evals cited in coverage — relevant if the demo has a Spanish-speaking caller read back a student ID.
Source: https://openai.com/index/introducing-gpt-realtime/ (eval lineage) · https://www.marktechpost.com/2026/07/06/openai-gpt-realtime-2-1-mini-reasoning-realtime-api/

**Demo implication [INFERENCE]:** a mid-call English→Spanish switch is low-risk and high-wow: one instructions paragraph ("If the caller speaks Spanish, respond in Spanish for the rest of the call; keep the same persona"), no code change, no per-language transcription config needed on our path. This is a stark contrast with Amazon Connect, where language is typically a per-contact-flow/Lex-locale configuration rather than a fluid mid-call capability.

---

## 2. Persona & instruction-following best practices (OpenAI Realtime Prompting Guide)

**2.1 [VERIFIED]** OpenAI's canonical prompt skeleton for realtime voice agents is a set of labeled sections: **Role & Objective · Personality & Tone · Context · Reference Pronunciations · Tools · Instructions/Rules · Conversation Flow · Safety & Escalation.** Our demo system prompt should mirror this exactly — it's also a nice slide ("we use OpenAI's own production prompt structure").
Sources: https://developers.openai.com/cookbook/examples/realtime_prompting_guide · https://cdn.openai.com/API/docs/realtime-prompting-guide.pdf

**2.2 [VERIFIED]** Personality/Tone example from the guide, directly reusable for a university operator: Personality "Friendly, calm and approachable expert customer service assistant"; Tone "Warm, concise, confident, never fawning"; Length "2–3 sentences per turn." Turn-length caps are the main lever for keeping a phone demo snappy.
Source: https://developers.openai.com/cookbook/examples/realtime_prompting_guide

**2.3 [VERIFIED]** Pacing: the session `speed` parameter only changes *playback rate*; perceived pace is prompted, e.g. "Deliver your audio response fast, but do not sound rushed. Do not modify the content of your response, only increase speaking speed." The inverse ("speak a little more slowly and clearly") is the pattern for an accessibility/elderly-caller beat in the demo.
Source: https://developers.openai.com/api/docs/guides/realtime-models-prompting

**2.4 [VERIFIED]** Numbers, codes, IDs — the guide's rules:
- "When reading numbers or codes, speak each character separately, separated by hyphens (e.g., 4-1-5). Repeat EXACTLY the provided number."
- Confirmation loop: "Just to confirm, I heard 8… 3… 5… 2… 1. Is that right?"
- Email: "Could you spell the email address character by character so I can make sure I have it exactly right?"
A student-ID read-back with digit-by-digit confirmation is a high-credibility contact-center moment.
Source: https://developers.openai.com/api/docs/guides/realtime-models-prompting

**2.5 [VERIFIED]** Reference Pronunciations section: short phonetic list for tricky terms, e.g. "Pronounce 'SQL' as 'sequel.'" For us: "Pronounce 'CSUB' as 'C-S-U-B'" (not "sub"), "Pronounce 'Runner' …", local names ("Kern" not "Kärn"). Keep the list short; grow it only when errors are observed.
Source: https://developers.openai.com/api/docs/guides/realtime-models-prompting

**2.6 [VERIFIED]** Meta-rules that matter for iteration: small wording changes make or break behavior; bullets over paragraphs; CAPITALIZE emphasis; the model "strongly closely follows sample phrases" — so give exact sample greetings/handoffs and it will use them nearly verbatim (this is how we make the demo deterministic without canned audio). For 2.x specifically: "Prompt Realtime 2 as a reasoning voice agent, not as a basic voice bot," start at `reasoning.effort: "low"`.
Sources: https://developers.openai.com/cookbook/examples/realtime_prompting_guide · https://developers.openai.com/api/docs/guides/realtime-models-prompting

---

## 3. Tool calling that drives the narrative

**3.1 [VERIFIED]** The intended production pattern is exactly the `route_call`-style design: spoken **preamble → tool call → model reads the result**. Guide-sanctioned preamble phrases: "I'm checking that now." / "I'll pull that up." / "Let me look into that." — with the nuance "use short preambles only when they help the user understand work is happening."
Source: https://developers.openai.com/api/docs/guides/realtime-models-prompting

**3.2 [VERIFIED]** Tool-eagerness guidance: read-only low-risk tools → "call when intent and required fields are clear" (no confirmation); write/destructive actions → summarize intended action and confirm first. Per-tool behavior can be tagged PROACTIVE / CONFIRMATION_FIRST / PREAMBLES. For the demo: `route_call` and `lookup_office_hours` are PROACTIVE; a hypothetical `submit_ticket` would be CONFIRMATION_FIRST.
Source: https://developers.openai.com/api/docs/guides/realtime-models-prompting

**3.3 [VERIFIED]** gpt-realtime-2.x can issue **parallel tool calls and keep talking while it works** ("narrate while it thinks" — e.g. "one moment, checking your calendar"), a GPT-5-class-reasoning feature new to the 2.x line. This masks tool latency natively.
Sources: https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/ · https://handyai.substack.com/p/model-drop-gpt-realtime-2 · https://www.datacamp.com/blog/gpt-realtime-2

**3.4 [REPORTED]** Latency budget for a tool round-trip in a realtime session: one 2026 production guide measures **function-call overhead of ~400–800 ms when the tool itself responds in <200 ms**; tool time beyond ~200 ms is felt as silence. Same source: API TTFB ~500 ms US, semantic VAD adds 100–200 ms vs basic VAD, and a Twilio test agent hit **1.1 s p50** first-word-after-caller-stops on gpt-realtime-2 — consistent with our BRD target of 1.0–1.5 s p50 (BRD_Micro_Voice_PoC.md:44).
Source: https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026

**3.5 [VERIFIED]** Standard latency-masking patterns for tools: pre-load known context into instructions (skip a greeting-time lookup), parallelize batched calls, speculative next-turn lookups, cache read-heavy results, and prompt a filler phrase before slow tools. Our MCP tools return fake data in-process (same-process StreamableHTTP), so tool execution is ~0 ms and the *only* cost is the model's tool-call round trip — meaning the demo will show tool calls at the fast end of 3.4's range. **[INFERENCE]** — and our latency instrumentation can put that number on screen, which is itself demo content.
Sources: https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026 · https://dev.to/deepak_mishra_35863517037/talking-to-machines-building-low-latency-voice-agents-with-openai-realtime-api-3c7p · https://developers.openai.com/api/docs/guides/voice-agents

**3.6 [INFERENCE]** Narrative-tool design for the demo: `route_call(department, reason)` returns `{department, phone_ext, handoff_blurb, estimated_wait}` (all fake); the instructions say "read the handoff_blurb verbatim, then confirm the transfer." Because the model closely follows sample phrases (2.6) and reads returned text faithfully, the tool return *is* the script — the reliable way to stage a repeatable demo beat while still being a genuinely live model.

---

## 4. Safety / crisis handling

**4.1 [VERIFIED]** Out of the box, OpenAI models are trained to respond to self-harm/distress with empathy and crisis-resource referral (US: 988 Suicide & Crisis Lifeline; elsewhere findahelpline.com). This behavior is in the model layer, not something we build.
Source: https://openai.com/index/helping-people-when-they-need-it-most/

**4.2 [VERIFIED]** The Realtime API additionally runs **active safety classifiers over sessions** — conversations that trip harmful-content detection can be halted; the 2.x line ships these with developer-tunable thresholds. Realtime sessions are not an unmoderated channel — a useful stakeholder reassurance vs "what if the AI says something awful on a recorded line."
Sources: https://openai.com/index/introducing-gpt-realtime/ · https://www.marktechpost.com/2026/05/08/openai-releases-three-realtime-audio-models-gpt-realtime-2-gpt-realtime-translate-and-gpt-realtime-whisper-in-the-realtime-api/

**4.3 [VERIFIED]** OpenAI's prompt skeleton ends with a **Safety & Escalation** section defining fallback/handoff logic. Documented patterns:
- Escalation trigger list: call `escalate_to_human` when "harassment, threats, self-harm, repeated failure, billing disputes > $50, caller is frustrated, or caller requests escalation."
- Escalation preamble the model speaks: "Let me connect you to a senior agent who can assist further."
- Failure handling: "Do not blame the user or expose raw tool errors. If the same failure happens repeatedly, offer an alternate path or escalation."
Source: https://developers.openai.com/api/docs/guides/realtime-models-prompting

**4.4 [INFERENCE]** Safe way to script the crisis-routing demo beat: do **not** have the demo caller enact realistic distress (risks tripping 4.2's classifiers mid-demo and is in poor taste on stage). Instead: (a) give the agent an `escalate_to_human(reason)` fake tool whose return is a warm-transfer blurb to the "CSUB Counseling Center / 988"; (b) put an explicit Safety & Escalation section in the prompt naming that tool for distress cues; (c) in the live demo use a *mild, clearly-scripted* cue (e.g. "honestly I've been really overwhelmed and struggling lately") that triggers empathy + escalation without graphic content. The takeaway line for stakeholders: "escalation is a designed path, same as any tool route — the AI never dead-ends a person in crisis." An emergency-helpline reference build (Analytics Vidhya, June 2026) uses the same shape: dispatch, escalate-to-live-operator, and de-escalation tools.
Sources: https://developers.openai.com/api/docs/guides/realtime-models-prompting · https://www.analyticsvidhya.com/blog/2026/06/build-an-ai-voice-agent-with-langchain/

**4.5 [VERIFIED]** OpenAI's Dec-2025 Model Spec update tightened voice-safety expectations (crisis handling, impersonation limits) — background context if a stakeholder asks about governance.
Source: https://callsphere.ai/blog/vw7f-openai-model-spec-voice-safety-2026

---

## 5. Voices

**5.1 [VERIFIED]** Current realtime lineup: **marin** and **cedar** (introduced with gpt-realtime Aug 2025, the flagship pair; on gpt-realtime-2 they are the recommended/optimized voices) plus the refreshed legacy set **alloy, ash, ballad, coral, echo, sage, shimmer, verse**. OpenAI explicitly recommends marin or cedar for best quality.
Sources: https://openai.com/index/introducing-gpt-realtime/ · https://developers.openai.com/api/docs/guides/realtime-conversations · https://community.openai.com/t/new-realtime-voice-models-in-the-api/1380471

**5.2 [REPORTED]** Character sketches from 2026 reviews: **marin** = brighter female voice, "professional and clear"; **cedar** = warm mid-range male, "natural and conversational"; alloy = neutral/balanced; echo = warm; shimmer = energetic. Cedar/marin uniquely produce natural pauses and fillers ("um, let me check") that kill the synthetic feel; reviewers call them the professional-empathetic register and "almost mandatory" for professional agents.
Sources: https://pasqualepillitteri.it/en/news/2153/gpt-realtime-2-openai-voice-model-gpt-5-reasoning · https://theplanettools.ai/tools/gpt-realtime · https://docs.vapi.ai/openai-realtime

**5.3 [INFERENCE]** For a university operator: **marin** (already our default — docs/specs/09-deployment-and-operations.md:71) is the right pick — professional, clear, female-presenting front-desk register; cedar is the strong alternate and an easy live "voice swap" demo beat (one session field). Our configured fallback ladder marin → alloy (docs/specs/10-testing-spikes-and-milestones.md:163) matches the ecosystem's ranking.

**5.4 [REPORTED]** Spanish per-voice quality: no authoritative per-voice Spanish benchmark exists. Evidence: cedar/marin praised for native-language prosody generally (explicitly incl. Italian); community threads (1.4) show accent-region control is weak across all voices, with output skewing Latin-American. Practical read: marin's Spanish is fluent with a Latin-American cast — fine for our audience; verify with a test call rather than trusting reviews. One caution: an openai-agents-python issue reported cedar/marin *ignoring instructions* in an early SDK integration (later-model artifact, likely stale, but argues for testing persona adherence on our exact stack during M1).
Sources: https://www.mindstudio.ai/blog/gpt-realtime-voice-models-explained · https://community.openai.com/t/trouble-getting-realtime-voices-to-sound-naturally-mexican-spanish/1381345 · https://github.com/openai/openai-agents-python/issues/1746

---

## 6. gpt-realtime-2.1 specifically (vs gpt-realtime-2) — demo talking points

**6.1 [VERIFIED]** Released **July 6, 2026** as `gpt-realtime-2.1` + `gpt-realtime-2.1-mini`. Three headline improvements over 2: **better alphanumeric recognition** (IDs/codes over noisy phone audio), **better silence & background-noise handling**, **smoother interruption (barge-in) behavior**.
Sources: https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896 · https://developers.openai.com/api/docs/models/gpt-realtime-2.1 · https://developers.openai.com/api/docs/changelog

**6.2 [VERIFIED]** **p95 latency down ≥25% across realtime models** via improved caching (cached audio input $0.30–0.40/M vs $32/M fresh). Directly strengthens our primary deliverable: the latency numbers we instrument are measured on the fastest realtime stack OpenAI has shipped.
Sources: https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896 · https://www.marktechpost.com/2026/07/06/openai-gpt-realtime-2-1-mini-reasoning-realtime-api/

**6.3 [VERIFIED]** Reasoning with **configurable effort (minimal/low/medium/high/xhigh; default low)** in a speech-to-speech model; 128k context; text+audio+image input; tool use/function calling; carried over from 2: GPT-5-class reasoning, parallel tool calls, talk-while-thinking. 2.1-mini brings reasoning to the $10/M-audio-input tier (a cost story for scaling RIO beyond the PoC).
Sources: https://developers.openai.com/api/docs/models/gpt-realtime-2.1 · https://explainx.ai/blog/openai-gpt-realtime-2-1-mini-reasoning-tool-use-api-2026 · https://www.datacamp.com/blog/gpt-realtime-2

**6.4 [INFERENCE]** Demo-showcasable 2.1 behaviors, mapped:
- **Alphanumeric**: caller says a 9-digit student ID over a cell connection; agent reads it back digit-by-digit correctly (6.1 + 2.4) — and can do it in Spanish (1.6).
- **Interruption**: presenter barges in mid-sentence; agent stops cleanly and picks up context (6.1) — pairs with our existing barge-in findings (docs/findings/04).
- **Noise**: make the call from the demo room with ambient chatter — 6.1's noise handling is the safety net.
- **Latency**: show the instrumented p50/p95 next to Amazon Connect's known multi-hop Lex→Lambda→Polly pipeline.

**6.5 [VERIFIED]** Pricing (per 1M tokens): 2.1 — text in $4 / cached $0.40 / text out $24; audio in $32 / cached $0.40 / audio out $64. 2.1-mini — text in $0.60; audio in $10 / out $20. Matches the BRD's verified gateway pass-through rates (BRD_Micro_Voice_PoC.md:45).
Source: https://developers.openai.com/api/docs/models/gpt-realtime-2.1

---

## Cross-cutting demo recommendations (summary)

1. One system prompt in OpenAI's 8-section skeleton (2.1) with: CSUB operator persona (2.2), pronunciation list incl. "C-S-U-B" (2.5), digit-by-digit ID read-backs (2.4), explicit Spanish-switch rule (1.2), tool preamble rules (3.1–3.2), and a Safety & Escalation section naming `escalate_to_human` (4.3).
2. Fake MCP tools that carry the narrative: `route_call`, `lookup_office_hours`, `escalate_to_human` — each returning a blurb the model reads near-verbatim (3.6). In-process tools mean tool beats land at the fast end of the 400–800 ms round-trip range (3.4–3.5).
3. Keep `VOICE=marin`; optionally swap to cedar live as a one-field flex (5.3).
4. Script the crisis beat with a mild cue + tool-routed warm transfer; never enact realistic distress on stage (4.4).
5. Lead the wrap-up with 2.1's own release notes (6.1–6.2): the PoC runs on a two-week-old model whose headline features — noisy-phone robustness, barge-in, latency — are precisely a contact center's pain points.

---

## Source index

Primary (OpenAI): openai.com/index/introducing-gpt-realtime · openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api · openai.com/index/helping-people-when-they-need-it-most · developers.openai.com/api/docs/models/gpt-realtime-2.1 · developers.openai.com/api/docs/guides/realtime-models-prompting · developers.openai.com/cookbook/examples/realtime_prompting_guide · cdn.openai.com/API/docs/realtime-prompting-guide.pdf · developers.openai.com/api/docs/changelog · community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896

Community/real-world: community.openai.com threads 1381345 (Mexican Spanish), 1362871 (peninsular accent), 1146050 (unwanted Spanish replies), 1105821 (non-English voices), 1380471 (new voices) · github.com/openai/openai-agents-python/issues/1746

Secondary/2026 coverage: marktechpost.com (2026/07/06 and 2026/05/08 pieces) · datacamp.com/blog/gpt-realtime-2 · handyai.substack.com/p/model-drop-gpt-realtime-2 · forasoft.com voice-agent production guide 2026 · mindstudio.ai model explainers · docs.vapi.ai/openai-realtime · theplanettools.ai/tools/gpt-realtime · pasqualepillitteri.it/en/news/2153 · explainx.ai gpt-realtime-2.1-mini · analyticsvidhya.com emergency voice agent (2026/06) · callsphere.ai Model Spec voice safety

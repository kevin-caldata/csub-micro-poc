# 17 — Demo Corpus & RAG Strategy for the Two-Tier "Intelligent Tools"

Date: 2026-07-19 · Status: Research complete (web + light repo research; thought exercise — NO code changes)

Scope: the unstructured CSUB knowledge corpus behind the planned "intelligent" MCP tools — how to serve it (prompt-stuffing vs lexical pre-filter vs embeddings RAG), how to ground the fast text model so it answers only from the corpus, what the corpus should contain (fake-but-authentic per docs/findings/13), how GPT-Realtime should decide when to call the knowledge tool, and whether one generic tool beats N topic tools.

Architecture context: GPT-Realtime formulates a question → MCP tool handler calls a flash-class text model (e.g. `google/gemini-3.1-flash-lite`) via the same Vercel AI Gateway text-generation API → model answers from the corpus → succinct text returns to GPT-Realtime. The corpus never enters the realtime context. Gateway/model plumbing specifics are findings/15-16 territory; this doc covers the corpus side only.

Numbered-claims style. Confidence tags: **[VERIFIED]** = primary vendor doc/announcement; **[REPORTED]** = secondary source; **[INFERENCE]** = our conclusion from the evidence.

---

## 1. Serving strategy: stuff the whole corpus — skip retrieval entirely

Comparison for a micro-PoC corpus of **tens of KB** (≈ 5k–20k tokens at ~4 chars/token):

**1.1 [VERIFIED]** Anthropic's own retrieval guidance draws the line far above our size: "If your knowledge base is smaller than 200,000 tokens (about 500 pages of material), you can just include the entire knowledge base in the prompt" — no RAG needed; use prompt caching for latency/cost (caching cited at ">2x" latency reduction, "up to 90%" cost reduction). Our corpus is ~1/10th to 1/40th of that threshold.
Source: https://www.anthropic.com/news/contextual-retrieval

**1.2 [VERIFIED]** Google's Gemini long-context doc says the large window "invites a more direct approach: providing all relevant information upfront" instead of "using RAG with vector databases, or filtering prompts to save tokens"; RAG remains valuable mainly for frequently-updated data, corpora exceeding the window, or cost control at scale. It also flags the one relevant quality caveat: single-needle retrieval is "~99% accuracy in many cases," but "in cases where you might have multiple 'needles'… the model does not perform with the same accuracy" — mitigated for us by asking one narrow question per tool call. Placement tip we should adopt verbatim: "the model's performance will be better if you put your query / question at the end of the prompt (after all the other context)."
Source: https://ai.google.dev/gemini-api/docs/long-context

**1.3 [REPORTED]** 2026 decision-framework write-ups converge on the same rule: for a small, stable corpus (the canonical example is "an internal FAQ with 20 pages that rarely changes"), long context wins outright — the RAG cost/accuracy advantages (cheaper per query; long-context degradation when relevant content is buried mid-window) only materialize at corpus sizes orders of magnitude beyond ours.
Sources: https://open-techstack.com/blog/rag-vs-long-context-2026/ · https://tianpan.co/blog/2026-04-09-long-context-vs-rag-production-decision-framework · https://www.elastic.co/search-labs/blog/rag-vs-long-context-model-llm · https://www.meilisearch.com/blog/rag-vs-long-context-llms

**1.4 Option comparison [INFERENCE, grounded in 1.1–1.3]:**

| | (a) Whole-corpus prompt-stuffing | (b) Lexical pre-filter (keyword/BM25) + top chunks | (c) Embeddings RAG |
|---|---|---|---|
| Latency | One model call; no retrieval hop. Prompt-size impact on TTFT is negligible at 5–20k tokens on a flash-class model; implicit/context caching cuts it further | One in-process BM25/keyword pass (~ms) + model call — marginally faster generation, same round trips | Adds embedding call per question (extra Gateway round trip) unless embeddings are precomputed AND the query embedding hop is still paid at runtime |
| Cost/question | ~15k input tokens × flash-lite-class pricing (2.5 Flash-Lite listed at $0.10/M input) ≈ **$0.002 per question** — a 500-call demo costs ~$1 | Slightly less (smaller prompt) — savings measured in tenths of a cent | Same + embedding costs; also new moving parts to pay for in dev time |
| Effort | Zero: one markdown file `readFileSync`'d into the system prompt | Small: chunker + BM25 lib + tuning chunk size/k | Largest: chunking, embedding model choice, vector store (even in-memory), similarity threshold tuning |
| Failure modes | Multi-needle dilution (1.2) — minor at this size | Retrieval misses (vocabulary mismatch: caller says "MFA", doc says "Duo 2-Step") — the classic lexical-gap failure BM25-only systems hit | Retrieval misses + threshold tuning; silent wrong-chunk answers are the worst possible demo bug |
| Demo risk | Lowest — the model always sees everything, so "the answer was in the corpus but retrieval missed it" cannot happen | Medium | Medium-high for zero benefit at this scale |

**1.5 Recommendation [INFERENCE]:** **(a) whole-corpus prompt-stuffing.** Every published threshold puts our corpus 1–2 orders of magnitude below the point where retrieval pays for itself; options (b) and (c) add the only new failure mode that could visibly embarrass a self-serve demo (retrieval miss → confident "I don't know" about something the corpus contains). Keep the corpus as a single markdown file with clear `##` section headers and delimiters (structure aids long-context recall — 1.2), question appended last. If the corpus ever grows past ~100k tokens, (b) BM25 pre-filter is the first upgrade, per Anthropic's own BM25+embeddings finding (49% retrieval-failure reduction when combined) — but that is post-demo territory.
Sources: 1.1–1.3 above · https://developers.googleblog.com/en/gemini-25-flash-lite-is-now-stable-and-generally-available/ (flash-lite latency/pricing positioning) · https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/ (3.1 Flash-Lite = fastest, most cost-efficient Gemini 3 model)

---

## 2. Grounding the answering model: answer-only-from-documents, succinct, NOT_FOUND

**2.1 [VERIFIED]** OpenAI's GPT-4.1 prompting guide gives the canonical strict-context instruction pair, directly reusable as the flash model's system prompt core:
- "Only use the documents in the provided External Context to answer the User Query."
- "If you don't know the answer based on this context, you must respond 'I don't have the information needed to answer that', even if a user insists on you answering the question."
It also documents the softer variant (context-first, general knowledge allowed when confident) — we want the strict one, because every fact in this demo is fake and any model-memory answer about the *real* CSUB would be a grounding leak. Placement note from the same guide: with long context, put instructions both above and below the corpus; if only once, above beats below.
Source: https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide

**2.2 [VERIFIED]** Anthropic's reduce-hallucinations guardrail doc: explicitly **allow the model to say "I don't know"** ("give Claude permission to say 'I don't know'… can drastically reduce false information"); restrict it to the provided documents rather than general knowledge; optionally ground in verbatim quotes for long documents (>20k tokens — beyond our size, so quote-extraction is optional here). The "permission to not know" framing is the piece most grounding prompts omit.
Source: https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations

**2.3 [VERIFIED]** Google's grounding stack (Vertex AI grounding / Agent Builder) codifies the same rules as system-instruction patterns: "NEVER make up information — only use data from the knowledge base" and "If the knowledge base does not contain the answer, clearly state that"; grounding "tethers… output to these data and reduces the chances of inventing content."
Sources: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/grounding/overview · https://oneuptime.com/blog/post/2026-02-17-how-to-implement-grounding-with-enterprise-data-in-vertex-ai-agent-builder/view

**2.4 Proposed answering-model system prompt [INFERENCE — assembled from 2.1–2.3 + findings/12 §2.2]:**

```
You answer questions for RIO, a phone operator at CSUB. Answer ONLY from the
documents below. Never use outside knowledge, even about the real CSUB.

Rules:
- Answer in 2-3 short sentences, spoken-style: plain words, no markdown, no
  lists, no headings. Phone numbers as digits like (661) 654-3036.
- If the documents do not contain the answer, reply with exactly: NOT_FOUND
- Never guess, never partially answer from memory, even if the question insists.

<documents>
{CORPUS}
</documents>

Question: {QUESTION}
```

The "2–3 sentences" cap mirrors the length lever OpenAI's realtime prompting guide uses for voice turns (findings/12 §2.2) — succinctness is enforced *here*, at the source, so GPT-Realtime never receives a wall of text to compress.

**2.5 NOT_FOUND handling [INFERENCE, grounded in the realtime guide's JSON-envelope pattern]:** the MCP handler should not pass the raw sentinel through. Wrap the reply in the small explicit JSON envelope the realtime prompting guide recommends for tool outputs ("`response_text` plus flags… so the response looks more in-distribution"):
- Found: `{"status":"ok","response_text":"<2-3 sentence answer>"}`
- Sentinel detected (exact-match or prefix-match on `NOT_FOUND`): `{"status":"not_found","response_text":"I don't have that information. Offer to connect the caller to the right department instead."}`

GPT-Realtime's instructions then say: *"If a knowledge tool returns status not_found, tell the caller you don't have that detail and offer to route them — never invent an answer."* This gives a graceful, on-persona miss and converts dead ends into the `route_call` demo beat. Exact-match sentinels beat asking the flash model for JSON because flash-tier models are more reliable emitting one token than a schema, and the handler stays trivial.
Source: https://developers.openai.com/api/docs/guides/realtime-models-prompting (tool-output envelope, failure phrasing "Do not blame the user or expose raw tool errors")

---

## 3. Corpus content plan (fake-but-authentic, per findings/13)

**FAKE-DATA rule (applies to every section):** use the *real* vocabulary, names, phone formats, and building codes documented in docs/findings/13-demo-csub-caller-context.md ([VERIFIED] items may be used as-is), but **fabricate every specific that findings/13 flags [SEARCH-SNIPPET]/[UNVERIFIED]** — hours, fees, dates beyond the verified academic calendar — with plausible values. The corpus opens with a banner that is both an internal marker and a model-visible grounding aid:

```
# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA
# All content below is FABRICATED for the RIO proof-of-concept. It imitates
# CSUB's real vocabulary but specific hours, dates, fees, and names may be
# fictional. Never present this as verified CSUB information outside the demo.
```

**[INFERENCE]** The banner should survive into the model prompt (not be stripped): it costs ~50 tokens and reinforces "answer only from here" by telling the model its own memory of the real CSUB is out of scope.

Twelve sections (~2–6 KB each → ~30–50 KB total, comfortably inside §1's envelope). Findings/13 claim numbers cited per section:

1. **Campus directory & department hours** — Admissions/Registrar (Student Services 47 SA, (661) 654-3036), Financial Aid ((661) 654-3016), Student Financial Services ((661) 654-3225), Student Health (28 HC, (661) 654-2394), building-code vocabulary ("47 SA" style). Fabricate per-office hours (flagged unlisted in findings/13 "Unverified" note). [findings/13 §1, claims 1–4, 6, 11]
2. **ITS Service Center & summer hours** — (661) 654-HELP (4357), Stiern Library Room 13, the verified summer schedule (phone 7am–6pm Mon–Thu; walk-up closed noon–1pm) — the one office whose real hours are verified, and seasonally correct for a July demo. [findings/13 claim 5]
3. **NetID / password reset / Duo 2-Step how-to** — myid.csub.edu flow, "Forgot Password / Activate Account," emailed authorization code, 11–255-char/3-of-4 password rule, Duo device portal, lost-phone → call 654-HELP, and the "NEVER share your Duo code" warning (sets up RIO refusing a read-aloud Duo code). [findings/13 §3, claims 16–19]
4. **Financial aid dates & disbursement** — fall disbursement "the week before classes" (week of Aug 17, 2026), BankMobile refunds ~2–3 business days, fabricated FAFSA-priority and verification-deadline dates clearly in the fake zone. [findings/13 claim 26]
5. **Registration & academic calendar** — first day Aug 24 2026, last day to add Sep 2, Census Day Sep 21, registration-window dates (all [VERIFIED] calendar facts, safe verbatim). [findings/13 claims 23–24]
6. **Runner Rundown orientation** — sessions from Jul 6 2026, $150 freshman/$105 transfer fee, sign-up via myCSUB To Do List; fabricate remaining July/August session dates. Top seasonal call driver. [findings/13 claim 25]
7. **Parking & permits** — UPD parking line (661) 654-2677, Parking Management Bureau / mycampuspermit.com, fabricated fall permit prices and lot names using real "Lot E"-style vocabulary. [findings/13 claims 8, 21]
8. **Advising by college** — no single advising line; NSME/SSE/A&H centers + AARC; corpus teaches the "ask the major, then direct" answer shape. [findings/13 claim 7]
9. **Counseling & crisis resources** — Counseling Center (661) 654-3366 press-2 after-hours crisis option, 988, UPD emergency (661) 654-2111. NOTE: crisis escalation stays a **simple tool** (tier 1) so it never depends on a second model call; this section exists only so knowledge questions ("what counseling services exist?") ground correctly. [findings/13 §4, claims 20–22]
10. **Campus events (late summer, fabricated)** — 2–3 invented events in house style ("Future 'Runner Day," a Rowdy meet-and-greet, a Stiern Library workshop series) + Icardo Center Box Office (661) 654-3988 as the tickets pointer. [findings/13 claims 9, 14]
11. **NextTech Kern** — Oct 28 2026 (findings/13 flags: confirm before print — for the corpus, keep it; it's marked simulated), early-bird $75 by Sep 28, nexttechkern@csub.edu, Professional/Student tracks. The self-referential demo hook: an AI operator answering questions about CSUB's AI conference. [findings/13 claim 28]
12. **RIO self-description & campus basics** — 9001 Stockdale Highway, main line (661) 654-CSUB, mascot/colors/"'Runner" vocabulary, plus a short "about this demo" paragraph so callers who ask "what are you?" get a grounded answer that matches the self-serve email copy. [findings/13 claims 10, 12–14]

**[INFERENCE]** Sections 1, 10, and 12 double as *distractors* — material the corpus contains but no scripted scenario needs — which is what makes free-form self-serve calls feel alive rather than on-rails.

---

## 4. Question routing: when GPT-Realtime calls the knowledge tool vs answers directly vs uses a static tool

Re-verified against the realtime prompting guide's tools section (https://developers.openai.com/api/docs/guides/realtime-models-prompting):

**4.1 [VERIFIED]** The guide's eagerness model: read-only, low-risk lookups → "call when intent and required fields are clear," no confirmation ("High eagerness works well for read-only, low-risk actions"). The knowledge tool is exactly this class → tag it PROACTIVE ("When calling a tool, do not ask for any user confirmation. Be proactive"). Write/high-impact actions (escalation, transfers) keep confirmation-first behavior — matching findings/12 §3.2.

**4.2 [VERIFIED]** Tool descriptions should carry explicit "Use when:" / "Do NOT use when:" sections, with sample preamble phrases; and the prompt's tool mentions must exactly match the registered tool list — "If the prompt mentions a tool that is not actually available… the model may invent a tool name or pretend it completed the action." So the instructions' routing rules and the MCP registrations (src/mcp-server.ts:12-37 — one `registerTool` per tool, per the FR-5 comment at src/mcp-server.ts:37) must be maintained as a pair.

**4.3 [VERIFIED]** Preambles: use "one short sentence" before tool calls that take noticeable time ("I'm checking that now"); skip them when "the answer is direct and can be given immediately." The knowledge tool adds a full text-model round trip on top of the ~400–800 ms tool-call overhead (findings/12 §3.4), so it is the one tool that should *always* get a preamble — and gpt-realtime-2.x can talk while the call runs (findings/12 §3.3), masking the flash-model latency.

**4.4 Three-lane routing rule for the Instructions section [INFERENCE, assembled from 4.1–4.3]:**

```
## Answering policy
- CAMPUS FACTS (hours, locations, dates, deadlines, fees, how-to steps,
  events, anything about CSUB): NEVER answer from your own knowledge, even
  if you think you know. Say a one-line preamble ("Let me check that for
  you"), then call ask_campus_knowledge with one clear, self-contained
  question. Speak only what the tool returns.
- ACTIONS: use the static tools — route_call to transfer, escalate_to_human
  for crisis or frustration (see Safety & Escalation), get_current_time for
  the time. Do not use ask_campus_knowledge to transfer or escalate.
- DIRECTLY (no tool): greetings, small talk, clarifying questions,
  repeating or rephrasing something a tool already returned this call, and
  describing what you can help with.
- If ask_campus_knowledge returns status "not_found", say you don't have
  that detail and offer to connect the caller to the right department.
```

The load-bearing line is the first one: the realtime model has real (possibly stale) knowledge of the real CSUB, and any from-memory answer would break the fake-data seal. "Never answer campus facts from memory" is the two-tier boundary expressed as a prompt rule; "one clear, self-contained question" is what keeps the corpus out of the realtime context — only the question and the 2–3-sentence answer cross.

**4.5 [VERIFIED]** Crisis routing must never route through the knowledge tier: the guide's escalation pattern (trigger list → `escalate_to_human` → spoken handoff, findings/12 §4.3) is a static tool with a canned return — no second model, no added latency, no chance of NOT_FOUND on a safety path. The routing rule above encodes this by naming escalation under ACTIONS.

---

## 5. One generic knowledge tool vs N topic-specific tools

The user's diagram shows several intelligent tools each hitting the flash model over the same datastore. For the demo, collapse them:

**5.1 [VERIFIED]** Every vendor's function-calling guidance warns that tool count is the main tool-selection error driver: OpenAI — "Aim for fewer than 20 functions… the more tools you register… the higher the chance of having the model select the wrong one"; Google — "providing too many can increase the risk of selecting an incorrect or suboptimal tool… ideally keeping the active set to a maximum of 10-20"; Anthropic — "More tools don't always lead to better outcomes," recommending "a few thoughtful tools targeting specific high-impact workflows" that "consolidate functionality" (their examples literally merge N lookup endpoints into one contextual tool).
Sources: https://developers.openai.com/api/docs/guides/function-calling · https://ai.google.dev/gemini-api/docs/function-calling · https://www.anthropic.com/engineering/writing-tools-for-agents

**5.2 [INFERENCE]** N topic tools (`ask_financial_aid`, `ask_it_help`, `ask_events`, …) would buy nothing here and cost twice:
- **No backend win**: all N handlers would run the identical prompt over the identical corpus — the "topic routing" the tool split performs is work the flash model does anyway by reading the question.
- **New failure mode**: every added tool creates a wrong-tool branch (caller asks "when do I get my aid refund if I'm also doing orientation?" — is that `ask_financial_aid` or `ask_orientation`?). With one tool, cross-topic questions are free; with N, they are selection errors. This is precisely the misfire class 5.1 warns about.
- **Prompt bloat**: N tools × "Use when/Do NOT use when" blocks (4.2) competes for the realtime model's instruction-following budget, where findings/12 §2.6 notes small wording changes already make or break behavior.

**5.3 Recommended surface [INFERENCE]:** one generic intelligent tool + the small static set:

```
ask_campus_knowledge(question: string, topic?: enum[
  "directory_hours" | "financial_aid" | "registration" | "orientation" |
  "it_help" | "parking" | "events" | "other"])
```

`topic` is optional metadata, not routing: it costs the realtime model nothing when omitted, shows up in latency/usage logs (which topics callers actually ask — itself demo content), and is a pre-wired seam for a §1.5-style section pre-filter if the corpus ever outgrows prompt-stuffing — the handler could stuff only matching sections without any tool-schema change. Description sketch: "Answers factual questions about CSUB — hours, locations, dates, deadlines, fees, how-to steps, events. Use when: the caller asks any campus fact. Do NOT use when: transferring a call, escalating, or making small talk."

**5.4 [VERIFIED-pattern / INFERENCE-application]** Separate tools are justified by different *behavior contracts*, not different topics: the realtime guide's per-tool PROACTIVE vs CONFIRMATION-FIRST tagging (4.1) is the real reason `route_call` and `escalate_to_human` stay distinct from `ask_campus_knowledge` — they carry different confirmation, preamble, and safety semantics. Same logic as Anthropic's consolidation examples, which merge same-contract lookups but keep distinct workflows apart. Result: a 4–5 tool surface (`ask_campus_knowledge`, `route_call`, `escalate_to_human`, plus existing demo tools per src/mcp-server.ts:12-36), comfortably inside every vendor's count guidance.

---

## Cross-cutting recommendation (summary)

1. One markdown corpus file (~30–50 KB, 12 sections per §3, simulated-data banner on top), prompt-stuffed whole into every flash-model call, question last (§1.5, 1.2).
2. Flash-model system prompt = strict-context grounding + 2–3-sentence spoken-style cap + exact `NOT_FOUND` sentinel (§2.4); MCP handler wraps replies in a `{status, response_text}` envelope (§2.5).
3. GPT-Realtime instructions get the three-lane answering policy (§4.4) with "never answer campus facts from memory" as the two-tier boundary, PROACTIVE + always-preamble tagging on the knowledge tool (§4.1, 4.3).
4. Exactly one generic `ask_campus_knowledge(question, topic?)` intelligent tool; keep static tools separate only where the behavior contract differs (§5.3–5.4).
5. Crisis/escalation never touches the intelligent tier (§4.5).

---

## Source index

Vendor primary: anthropic.com/news/contextual-retrieval · docs.anthropic.com …/reduce-hallucinations · anthropic.com/engineering/writing-tools-for-agents · ai.google.dev/gemini-api/docs/long-context · ai.google.dev/gemini-api/docs/function-calling · docs.cloud.google.com/vertex-ai/generative-ai/docs/grounding/overview · developers.openai.com/cookbook/examples/gpt4-1_prompting_guide · developers.openai.com/api/docs/guides/realtime-models-prompting · developers.openai.com/api/docs/guides/function-calling · developers.googleblog.com/en/gemini-25-flash-lite-is-now-stable-and-generally-available · blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite

Secondary (long-context vs RAG frameworks): open-techstack.com/blog/rag-vs-long-context-2026 · tianpan.co/blog/2026-04-09-long-context-vs-rag-production-decision-framework · elastic.co/search-labs/blog/rag-vs-long-context-model-llm · meilisearch.com/blog/rag-vs-long-context-llms · oneuptime.com Agent Builder grounding walkthrough

Repo: docs/findings/13-demo-csub-caller-context.md (corpus vocabulary + verified/unverified flags) · docs/findings/12-demo-realtime-model-capabilities.md §§2–4 (prompt skeleton, tool eagerness, latency budget) · src/mcp-server.ts:12-37 (registerTool pattern; FR-5 one-call-per-tool comment)

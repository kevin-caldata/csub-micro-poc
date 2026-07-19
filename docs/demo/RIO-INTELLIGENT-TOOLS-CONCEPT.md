# RIO Intelligent Tools — Two-Tier Delegated-Intelligence Architecture Concept

**Date:** 2026-07-19 · **Status:** Architecture concept (thought exercise; NO code changes implied)
**Question answered:** Can an MCP tool handler call a high-speed text model through the same Vercel AI Gateway the realtime leg already uses, answer a caller's question from an unstructured CSUB corpus, and hand a succinct answer back for GPT-Realtime to speak — without the corpus ever entering the realtime context?
**Inputs:** findings/15 (gateway text generation), findings/16 (codebase integration audit), findings/17 (corpus & RAG strategy), findings/11 (codebase capability audit), findings/12 (realtime model capabilities), docs/demo/RIO-DEMO-CONCEPT.md, docs/demo/RIO-ANNOUNCEMENT-EMAIL.md. Claims cite `[findings/NN §claim]` or file paths. Numbered-claims style.

---

## 1. Feasibility verdict (plain language, up front)

**Yes — this works exactly as drawn, with one latency caveat that is manageable, and it is dramatically cheaper than the alternative.**

1. **Same gateway, same key, both modalities.** The `AI_GATEWAY_API_KEY` already deployed on Railway authenticates both the realtime WebSocket leg and the text-generation API. A single `generateText`/`generateObject` call with a plain model-ID string routes through the gateway with zero new credentials [findings/15 §2–3]. The call site is one more `registerTool` handler in `buildMcpServer()` — the spec-sanctioned single extension point; the handler simply `await`s the text model and returns the answer as ordinary tool-result text [findings/16 §C1].

2. **Recommended model: `google/gemini-3.1-flash-lite`** — verified to exist on the gateway (2026-07-19, `https://ai-gateway.vercel.sh/v1/models`, 302 models listed): 1M context, $0.25/M in, $1.50/M out, implicit caching (cache-read $0.03/M) [findings/15 §8–9]. Gateway fallback chain to `google/gemini-2.5-flash-lite` ($0.10/$0.40, proven 0.36 s TTFT non-reasoning latency) is a native gateway feature [findings/15 §13, §17].

3. **Expected added latency: p50 ≈ 0.7–1.2 s, p95 ≈ 2–3 s** for the delegated call end-to-end — *provided* `thinkingConfig` is pinned to minimal and output is capped ~150 tokens. At default settings 3.1 Flash-Lite measures ~5.9 s TTFT (thinking budget absorbed into TTFT), so the pin is mandatory, not optional [findings/15 §12–14]. Roughly 1–2 s of that is masked by the spoken preamble RIO already mandates ("One moment, let me look that up"), so caller-perceived dead air is ~0–1 s in the common case [findings/16 §C6]. Gateway overhead itself is <20 ms [findings/15 §15].

4. **Per-call cost: ≈ $0.0005–$0.003 per delegated question** ($0.00048 at a 5 KB corpus; ~$0.002–0.003 at the full 30–50 KB corpus) [findings/15 §22; findings/16 §C16]. A viral self-serve demo — 1,000 calls × 3 intelligent questions — costs ~$1.50–$9 total in delegated intelligence [findings/15 §24].

5. **No architectural blockers found.** The tool loop already tolerates slow tools (preamble → event-gated silence, no timers), barge-in during tool execution is already race-safe, failures degrade to a spoken apology, and the 5 s client-side transport cap bounds the worst case [findings/16 §C4, §C7, §C11]. The only code delta beyond the tool handler itself is `npm install ai` — one package, zero new transitive dependencies (its pinned deps are byte-identical to what `@ai-sdk/gateway@4.0.23` already installed) [findings/15 §5; findings/16 §C8–C10].

**Verdict: feasible, cheap, and the right design.** The one thing that must be validated empirically before locking the preamble script is real p50/p95 from Railway (an afternoon with the existing latency instrumentation) [findings/15 §14, §25].

---

## 2. Two-tier tool taxonomy

**The tier rule (one sentence):** a tool is **static-fake** when its return must be deterministic, instant, or safety-critical (canned string, no model in the loop); it is **delegated-intelligence** when its job is answering an open-ended factual question whose answer lives in the corpus [findings/16 §C13; findings/17 §4.5].

Corollaries that make the rule sharp:

6. **Safety paths never touch the intelligent tier.** Crisis escalation must be deterministic and instant — canned handoff blurb with real resource numbers (988, Counseling Center (661) 654-3366, UPD). No second model call means no added latency, no paraphrase risk on safety-critical phone numbers, and no possibility of NOT_FOUND on a crisis path [findings/16 §C13; findings/17 §4.5].

7. **Separate tools are justified by different behavior contracts, not different topics.** `route_call` and `escalate_to_human` stay distinct from `ask_campus_knowledge` because they carry different confirmation/preamble/safety semantics (PROACTIVE vs CONFIRMATION-FIRST tagging), not because they cover different subjects [findings/17 §5.4].

8. **Exactly ONE delegated-intelligence tool.** N topic tools (`ask_financial_aid`, `ask_it_help`, …) would run the identical prompt over the identical corpus while creating wrong-tool selection branches and prompt bloat — the misfire class every vendor's function-calling guidance warns about (OpenAI: <20 tools; Google: 10–20 max; Anthropic: consolidate) [findings/17 §5.1–5.3].

| Tool | Tier | Why |
|---|---|---|
| `escalate_to_human(reason, urgency)` | **Static-fake** | Crisis path: deterministic, instant, real resource numbers verbatim [findings/16 §C13] |
| `route_call(department, caller_name?, reason)` | **Static-fake** | Fake directory return doubles as the handoff script; return-as-script depends on being canned [findings/12 §3.6; findings/16 §C13] |
| `verify_identity(netid, dob_or_last4)` | **Static-fake** | Always-succeeds theater on fake data; zero intelligence needed [findings/16 §C13] |
| `reset_password(netid)` | **Static-fake** | Canned MyID-flow text [findings/16 §C13] |
| `get_current_time()` | **Static-fake** | Already exists (src/mcp-server.ts); pure lookup [findings/11 §C3] |
| `create_ticket()` *(optional)* | **Static-fake** | Canned "INC0012345" string [findings/16 §C13] |
| `ask_campus_knowledge(question, topic?)` | **Delegated-intelligence** | Replaces `lookup_campus_info`'s canned-topic design; answers any campus-fact question from the corpus via flash-lite [findings/16 §C13; findings/17 §5.3] |

9. **The realtime model's routing policy is a three-lane prompt rule** [findings/17 §4.4]: (1) CAMPUS FACTS → never answer from memory, preamble, call `ask_campus_knowledge` with one clear self-contained question, speak only what the tool returns; (2) ACTIONS → static tools; (3) DIRECT → greetings, small talk, clarifications, rephrasing already-returned answers. The load-bearing line is "never answer campus facts from your own knowledge" — GPT-Realtime has real (possibly stale) knowledge of the real CSUB, and any from-memory answer breaks the fake-data seal [findings/17 §4.4].

---

## 3. Sequence walkthrough (annotated with latency)

The user's diagram, hop by hop. Numbers are measured where they exist, estimated (and marked) where they don't [findings/16 §C5 — honest limitation: no live-call measurements yet; M1–M5 produce them].

```
Caller ──phone──> Twilio Media Streams ──WS──> Bridge (Railway)
                                                 │
        (1) caller finishes question             │  server VAD detects end of speech
        (2) GPT-Realtime R1 response ────────────┤  ~500 ms TTFB API-side [findings/12 §3.4]
            ├── speaks preamble: "Let me check that for you"   ← ~1–2 s of audio, streaming
            └── emits function-call: ask_campus_knowledge({question})
        (3) ToolLoop → MCP client → in-process MCP server        ~5 ms warm connect,
            (StreamableHTTP, same process)                       single-digit-ms mcpMs
                                                                 [findings/16 §C5]
        (4) tool handler → Vercel AI Gateway (text modality)     <20 ms gateway overhead
            generateObject('google/gemini-3.1-flash-lite',       [findings/15 §15]
              corpus-first + question-last prompt,
              thinking minimal, maxOutputTokens ~150)
        (5) flash-lite reads corpus (~8–12k tok), answers        TTFT ~0.3–0.7 s (est.)
            2–3 spoken-style sentences                           + ~0.3 s generation
                                                                 → 0.7–1.2 s p50, 2–3 s p95
                                                                 [findings/15 §14]
        (6) handler wraps {status, response_text} envelope,      ~0 ms
            returns MCP tool result
        (7) ToolLoop sends function-call-output; double gate     gateWaitMs ~110 ms (design
            releases ONE follow-up response-create               example) [findings/16 §C5]
        (8) GPT-Realtime R2 speaks the answer                    secondTtfbMs ~550 ms (design
                                                                 example) [findings/16 §C5]
        Caller hears the answer.
```

10. **Where the preamble masks the delay:** tool execution (steps 3–6) overlaps the preamble audio — `function-call-arguments-done` arrives while R1's preamble is still streaming/playing, and the follow-up gate cannot release before R1's `response-done` anyway. Any tool time inside the preamble's ~1–2 s spoken duration is **free** — it never appears as caller-perceived dead air [findings/16 §C6]. The knowledge tool is therefore the one tool that should *always* carry a preamble; gpt-realtime-2.x can talk while the call runs [findings/17 §4.3; findings/12 §3.3].

11. **Budget arithmetic:** `toolTotalMs = mcpMs + gateWaitMs + secondTtfbMs`; holding the findings/09 design examples, the delegated call can spend ~800 ms and still meet the M3 `toolTotalMs < 1500` p50 acceptance ceiling; up to ~2 s lands fully masked by the preamble; the in-handler abort at 3.5 s (beneath the 5 s transport cap) bounds the worst case at a spoken apology ~4 s in [findings/16 §C6, §C12].

12. **Failure at any hop degrades gracefully, never fatally.** A `generateText` rejection or timeout becomes an `isError` tool result → `{"error": ...}` → the model apologizes verbally; the handler's own abort (`AbortSignal.any([extra.signal, AbortSignal.timeout(3500)])`) returns a clean handler-authored fallback string that reads better spoken than an SDK error. Nothing inside a tool handler can kill the phone call [findings/16 §C11–C12]. Barge-in during the tool gap is a documented no-op path; a caller talking over the gap engages existing race-safe machinery with no changes [findings/16 §C7].

---

## 4. Context-window protection — the argument in numbers

The corpus must live behind the MCP boundary, not in the realtime instructions. Four quantified reasons:

13. **Token price asymmetry.** `openai/gpt-realtime-2.1` bills text input at **$4/M** (cached $0.40/M); `google/gemini-3.1-flash-lite` bills **$0.25/M** (cache-read $0.03/M) — a 16× fresh / 13× cached input-price gap, before accounting for the realtime side re-billing session state on *every* turn [findings/15 §22–23; findings/12 §6.5].

14. **Recurring vs on-demand.** A 75 KB corpus ≈ 19k tokens stuffed into `INSTRUCTIONS` costs ~$0.076 on turn 1 plus ~$0.0076 per subsequent turn (cached) — ≈ **$0.16 of pure corpus overhead per 12-turn call, paid whether or not the caller asks a knowledge question**, multiplied by every self-serve caller. The same call delegating ~2 knowledge questions to flash-lite costs ~$0.004 total — **~40× cheaper, and only on knowledge turns** [findings/16 §C18]. At the smaller 5 KB-per-question granularity the gap is ~100× uncached [findings/15 §23].

15. **Window headroom.** The realtime window is a hard 128k that must also hold accumulating audio + transcript + tool history over a call that can legally run 25 minutes; a 19k-token instruction anchor permanently shrinks the evictable budget. Flash-lite's 1M window swallows the entire corpus per question with no accumulation at all [findings/16 §C18; findings/15 §23].

16. **Instruction-following degradation — the non-dollar half.** The RIO persona's safety section, disclosure rule, language policy, and the test-asserted tool-preamble sentence are enforced ONLY by instruction adherence, which the realtime prompting guidance predicates on a *compact* prompt; burying ~40 lines of behavioral rules under ~19,000 tokens of reference prose dilutes exactly the adherence a presenter-less self-serve demo depends on. It also drags prefill latency onto every turn — including the greeting — attacking the project's primary latency deliverable head-on [findings/16 §C18; findings/12 §2.6].

17. **The boundary contract:** only a one-sentence question crosses into the tool, and only a 2–3-sentence (~50–100 token) answer crosses back as an ordinary tool result (~$0.0004 of realtime input). The realtime context carries persona + tool schemas + conversation — nothing else [findings/16 §C16; findings/17 §4.4].

---

## 5. Corpus plan summary

Full detail in findings/17; the decisions:

18. **Strategy: whole-corpus prompt-stuffing. No retrieval.** At ~30–50 KB (~8–12k tokens) the corpus sits 1–2 orders of magnitude below every published RAG threshold (Anthropic's line: <200k tokens → stuff it; Google's long-context guidance says the same). Retrieval would add the only new failure mode that could visibly embarrass a self-serve demo: a miss on something the corpus contains. Corpus first, question last (long-context placement guidance); BM25 pre-filter is the first upgrade *if* the corpus ever passes ~100k tokens — post-demo territory [findings/17 §1.1–1.5]. The optional `topic` enum on the tool is the pre-wired seam for that upgrade, requiring no schema change [findings/17 §5.3].

19. **One markdown file, `assets/csub-corpus.md`,** loaded once at module scope per the existing `assets/` boot-load pattern (the fallback-clip precedent; `buildMcpServer()` constructs a fresh server per request, so the read must not sit inside it). Railway image impact: noise [findings/16 §C15]. Keeping the corpus as a stable prompt prefix makes repeat questions nearly free via implicit caching (cache-read $0.03/M) [findings/15 §21].

20. **Twelve sections, fake-but-authentic** (real CSUB vocabulary, phone formats, building codes from findings/13's verified items; every unverified specific fabricated with plausible values): directory & hours · ITS Service Center (verified summer hours — seasonally correct) · NetID/password/Duo how-to · financial-aid dates & disbursement · registration & academic calendar · Runner Rundown orientation · parking & permits · advising by college · counseling & crisis resources (grounding only — escalation stays tier 1) · campus events (fabricated) · NextTech Kern · RIO self-description & campus basics. Sections 1, 10, 12 double as distractors that make free-form self-serve calls feel alive [findings/17 §3]. A simulated-data banner heads the file and survives into the model prompt (~50 tokens) as both an internal marker and a grounding aid [findings/17 §3].

21. **Grounding rules (the answering model's system prompt):** answer ONLY from the documents, never from memory — even about the real CSUB (every model-memory answer is a grounding leak because all demo facts are fake); 2–3 short spoken-style sentences, no markdown, phone numbers as digits; explicit permission to not know; exact sentinel **`NOT_FOUND`** when the documents don't contain the answer [findings/17 §2.1–2.4].

22. **NOT_FOUND behavior:** the handler never passes the raw sentinel through. It wraps every reply in a small JSON envelope — `{"status":"ok","response_text":...}` or `{"status":"not_found","response_text":"I don't have that information. Offer to connect the caller to the right department instead."}` — and the realtime instructions say: if `not_found`, tell the caller you don't have that detail and offer to route them, never invent. A graceful miss becomes a `route_call` demo beat. Exact-match sentinel beats asking a flash-tier model for JSON [findings/17 §2.5].

---

## 6. Recommended tool surface (concept-level signatures + return shapes)

Six tools plus one optional — comfortably inside every vendor's tool-count guidance [findings/17 §5.4]. All returns are MCP text content; static tools return canned strings/JSON; the intelligent tool returns the §5.22 envelope.

**Tier 2 — delegated intelligence (exactly one):**

- **`ask_campus_knowledge(question: string, topic?: enum["directory_hours"|"financial_aid"|"registration"|"orientation"|"it_help"|"parking"|"events"|"other"])`**
  → `{"status":"ok"|"not_found","response_text":"<2–3 spoken-style sentences>"}`
  Description sketch: "Answers factual questions about CSUB — hours, locations, dates, deadlines, fees, how-to steps, events. Use when: the caller asks any campus fact. Do NOT use when: transferring a call, escalating, or making small talk." Tagged PROACTIVE, always-preamble. `topic` is optional log metadata, not routing [findings/17 §5.3, §4.1–4.3].
  Handler internals (concept): `generateObject` on `google/gemini-3.1-flash-lite`, thinking minimal, `maxOutputTokens ≈ 150`, corpus-first/question-last, `abortSignal: AbortSignal.any([extra.signal, AbortSignal.timeout(3500)])`, `maxRetries: 0`, gateway fallback `models: ['google/gemini-2.5-flash-lite']` [findings/15 §25; findings/16 §C12].

**Tier 1 — static-fake:**

- **`escalate_to_human(reason: string, urgency: enum["routine"|"urgent"|"crisis"])`**
  → canned warm-handoff blurb naming REAL resources verbatim: Counseling Center (661) 654-3366 (press 2 after hours), 988 Lifeline, UPD (661) 654-2111 / 911. Tagged for the Safety & Escalation prompt section; no model in the loop, ever [findings/16 §C13; findings/12 §4.3].
- **`route_call(department: string, caller_name?: string, reason?: string)`**
  → `{department, phone_ext, location, handoff_blurb, estimated_wait}` (fake, seeded with real directory numbers); the `handoff_blurb` IS the transfer script the model reads near-verbatim [findings/12 §3.6; findings/16 §C13].
- **`verify_identity(netid: string, dob_or_last4: string)`**
  → `{verified: true, name, student_id}` — always succeeds on fake data [findings/16 §C13].
- **`reset_password(netid: string)`**
  → canned MyID-flow text: "authorization code sent to the personal email on file" [findings/16 §C13].
- **`get_current_time()`** — already exists; ISO-8601 + timezone [findings/11 §C3]. (Note: the announcement email's "ask what time it is" probe assumes the honest-limits framing; with this tool registered, the beat becomes "it checks a tool" rather than "it can't know" — the email's item 6 phrasing should be reconciled, see §8 open questions.)
- **`create_ticket()`** *(optional)* → "ticket INC0012345" [findings/16 §C13]. `send_sms`: skip per the concept doc's own recommendation [findings/16 §C13].

23. **Prompt/tool pairing discipline:** the instructions' tool mentions must exactly match the registered list (a mentioned-but-absent tool invites invented tool names), and each description carries explicit "Use when / Do NOT use when" blocks [findings/17 §4.2].

---

## 7. What changes vs RIO-DEMO-CONCEPT.md

24. **Self-serve email replaces the staged demo entirely.** The phone number goes out via email — draft ready at `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` — and "call it yourself," formerly the closing beat, becomes the whole demo. Retired wholesale: cold-open recorded IVR + slides, projected panes (context payload, crisis-log record, live latency readout), the 2:07 AM clock prop, printed transcript/KPI hand-outs, the three scripted calls with a rehearsed performer, the wow-moment checklist, and the live-demo fallback plan (recorded best-take, smoke test, frozen deploy) [findings/16 §C14].

25. **The honesty layer migrates media.** Every "say out loud in the room" disclosure now lives in (a) the outbound email text — the [SIMULATED] tags, the per-FR LIVE/SIMULATED/FUTURE table, the logging disclosure, the 25-minute cap and deploy-severs-calls small print — and (b) the persona itself (AI self-ID in the greeting; fake-data nature voiced by RIO when relevant), since no presenter can label anything [findings/16 §C14; RIO-ANNOUNCEMENT-EMAIL.md §R1].

26. **The crisis section changes character.** Self-serve means real unsupervised callers may present real distress. This *strengthens* the case for `escalate_to_human` staying static-fake (deterministic real numbers, no LLM latency) and for the email's explicit "please don't role-play distress" instruction plus colleagues-only distribution [findings/16 §C14; RIO-ANNOUNCEMENT-EMAIL.md §R6].

27. **`lookup_campus_info`'s canned-topic design is superseded.** Its staging rationale (tool return as script for known topics) assumed a rehearsed caller. Self-serve callers ask anything — exactly the gap `ask_campus_knowledge` + corpus fills; the frozen fall-2026 fake facts move from per-topic canned strings into the corpus document [findings/16 §C14; findings/17 §3].

28. **Unchanged and still valid:** RIO persona and greeting, bilingual behavior, fake warm-transfer choreography (model-driven, presenter-free), digit read-back, instant pickup, and all §5 effort-class mechanics of the concept doc — the extension points are identical [findings/16 §C14].

---

## 8. Effort classes, open questions, risks

### Effort classes (concept vocabulary from RIO-DEMO-CONCEPT.md §5)

| Piece | Effort class | Notes |
|---|---|---|
| `npm install ai@7.x` | **trivial dependency add** | One package, zero new transitive deps [findings/15 §5; findings/16 §C9] |
| `ask_campus_knowledge` handler | **one MCP tool + small handler logic** | One `registerTool` block with a `generateObject` await, envelope wrap, abort/fallback plumbing — single-file diff at the FR-5 extension point [findings/16 §C1, §C12] |
| Static-fake tool set (5–6 tools) | **one fake MCP tool each** | ~10-line canned-return blocks, per findings/11 §C4 |
| Corpus authoring (`assets/csub-corpus.md`) | **content work, zero code** | 12 sections, ~30–50 KB, from findings/13 vocabulary + fabrication rules [findings/17 §3] |
| Corpus boot-load | **trivial** | Module-scope `readFileSync`, existing pattern [findings/16 §C15] |
| Realtime instruction updates (three-lane policy, not_found rule, persona) | **persona-prompt-only** | Keep the test-asserted preamble sentence intact [findings/11 §C1; findings/17 §4.4] |
| Latency validation (real p50/p95 from Railway) | **one afternoon of measurement** | Existing instrumentation habit; prerequisite to locking the preamble script [findings/15 §14, §25] |
| Announcement email finalization | **content work** | Fill placeholders; reconcile the "what time is it" item with `get_current_time` (below) |

### Open questions

29. **Real-world latency is unmeasured.** The p50 0.7–1.2 s / p95 2–3 s estimate rests on Artificial Analysis benchmarks scaled to our prompt size; no live-call numbers exist yet (M1–M5 still need the human). If measured p95 blows past the preamble mask, the documented fallbacks are `gemini-2.5-flash-lite` (no thinking budget to mismanage) or `gpt-oss-120b` on Groq/Cerebras [findings/15 §14; findings/16 §C5].

30. **Model availability drift.** `google/gemini-3.1-flash-lite` is verified as of 2026-07-19; gateway lineups and per-provider pricing shift (gpt-oss-120b already shows list-vs-API price divergence). Re-verify with the one-line public curl before build; the fallback chain covers transient removal at runtime [findings/15 §8, §10, §17].

31. **Corpus size ceiling.** Prompt-stuffing is right at 30–50 KB; the plan's own line is: past ~100k tokens, add a BM25 pre-filter via the pre-wired `topic` seam. Question: does anyone *want* a bigger corpus for the demo, or is 12 sections the deliberate cap? (Recommend: cap it — every added section is added fabrication to keep honest) [findings/17 §1.5, §5.3].

32. **Tool-selection misses.** The realtime model may answer a campus fact from memory (breaking the fake-data seal) or skip the preamble. Mitigations are prompt-only (the CAPITALIZED never-from-memory rule, sample phrases the model follows near-verbatim) but adherence on the exact stack is unverified — the same M1-era verification gap already flagged for persona adherence [findings/17 §4.4; findings/12 §2.6, §5.4].

33. **Thinking-config passthrough.** The latency pin assumes `providerOptions.google.thinkingConfig` (or equivalent) is honored through the gateway for 3.1 Flash-Lite. Findings/15 documents the knob; end-to-end verification through *our* gateway path is part of the measurement afternoon [findings/15 §12, §25].

34. **Email/tool inconsistency to resolve.** RIO-ANNOUNCEMENT-EMAIL.md item 6 frames "what time is it?" as a probe of what a model *can't* know (rationale R5: "no clock tool exists"), but `get_current_time` exists in the PoC today and stays in the recommended surface [findings/11 §C3]. Either drop the tool from the demo registration or rewrite the email item — currently they contradict.

### Risks

| Risk | Mitigation |
|---|---|
| Latency spike / gateway p99 tail | 3.5 s in-handler abort → graceful spoken fallback; gateway fallback chain; `maxRetries: 0` (a retry burns more time than a fallback) [findings/15 §15, §19; findings/16 §C12] |
| Flash model hallucinates past the corpus | Strict-context grounding prompt + NOT_FOUND sentinel + simulated-data banner; permission-to-not-know framing [findings/17 §2.1–2.4] |
| NOT_FOUND on a safety-adjacent question | Cannot happen on the crisis path — escalation is tier 1 by design; the corpus's counseling section exists only so *informational* questions ground [findings/17 §4.5, §3 item 9] |
| Realtime model answers facts from memory | Three-lane policy with the never-from-memory rule as its first line; verify adherence at M1 [findings/17 §4.4] |
| Cost runaway on viral email | Ceiling is ~$0.003/question at full corpus; implicit caching cuts repeats; 1,000-call worst case is single-digit dollars — realtime audio tokens, not delegation, dominate call cost [findings/15 §21–24] |
| Self-serve caller in real distress | Static-fake escalation speaks real 988/Counseling numbers instantly; email carries the don't-role-play instruction and real-988 pointer; colleagues-only distribution [findings/16 §C14; RIO-ANNOUNCEMENT-EMAIL.md §R6] |

---

## Source docs

- `docs/findings/15-gateway-text-generation-for-tools.md` (gateway text API, model lineup, latency, cost, reliability knobs)
- `docs/findings/16-two-tier-tool-integration-audit.md` (C1–C18; integration points, timeout containment, taxonomy, context-protection math)
- `docs/findings/17-demo-corpus-and-rag-strategy.md` (§1–§5; serving strategy, grounding, corpus content, routing policy, tool consolidation)
- `docs/findings/11-demo-codebase-capability-audit.md` (C1–C13; extension points)
- `docs/findings/12-demo-realtime-model-capabilities.md` (§1–§6; realtime prompting, tool eagerness, pricing)
- `docs/demo/RIO-DEMO-CONCEPT.md` (superseded staging layer; surviving persona/tool mechanics)
- `docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` (self-serve honesty layer; R1–R10)

# Finding 15 — Vercel AI Gateway Text Generation for Delegated-Intelligence MCP Tools

Research date: 2026-07-19. Scope: how the "intelligent" tier of the two-tier MCP tool design calls a
high-speed text model through the same Vercel AI Gateway the realtime leg already uses. No code was
changed; this is a thought-exercise reference for the self-serve demo direction.

Summary verdict up front: **yes, this works exactly as hoped.** The same `AI_GATEWAY_API_KEY` drives
both modalities; `google/gemini-3.1-flash-lite` exists on the gateway at $0.25/M in, $1.50/M out with a
1M context window; a 5 KB-corpus question costs ~$0.0005 (roughly 1/100th of what parking the corpus in
the realtime context would cost over a call); and the gateway gives us model-fallback chains for free.
The one real caveat is latency: flash-lite-class models are sub-second only when thinking is turned
down — at default settings Artificial Analysis measures ~5.9 s TTFT for 3.1 Flash-Lite, so the tool
handler must pin `thinkingConfig` low and cap output tokens.

---

## 1. Exact API — calling text models through the gateway from Node

1. **The canonical call is `generateText` from the `ai` package with a plain `creator/model-name`
   string.** The official text-generation doc's minimal example is exactly the shape we want
   (https://vercel.com/docs/ai-gateway/modalities/text-generation):

   ```typescript
   import { generateText } from 'ai';

   const { text } = await generateText({
     model: 'google/gemini-3.1-flash-lite',
     prompt: 'What is the capital of France?',
   });
   ```

   Plain string model IDs route through the AI Gateway because the gateway is the AI SDK's **default
   global provider** (https://ai-sdk.dev/docs/getting-started/choosing-a-provider). No `createGateway`
   call is required in the happy path.

2. **Auth is the env var we already have.** The gateway provider reads `AI_GATEWAY_API_KEY` from the
   environment by default (https://vercel.com/docs/ai-gateway/getting-started/text;
   https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway — `createGateway`'s `apiKey` option
   "Defaults to the `AI_GATEWAY_API_KEY` environment variable"). Our Railway service already validates
   and loads this exact variable (`src/config.ts:4`, `src/config.ts:90`).

3. **Same key for realtime and text — confirmed by construction.** It is one gateway-wide API key, not
   a per-modality credential. Our PoC already uses it for the realtime leg: `mintRealtimeToken`
   (`src/gateway.ts:81`) and `gateway.experimental_realtime(config.modelId)` (`src/gateway.ts:297`)
   authenticate with the same `AI_GATEWAY_API_KEY` that the text quickstart uses for `generateText`.
   The gateway docs use the identical key for AI SDK, OpenAI-compatible, and Anthropic-compatible
   endpoints (https://vercel.com/docs/ai-gateway/getting-started/text).

4. **`createGateway` exists if we ever need explicit config** (custom key, headers, team scoping), and
   is importable from either `ai` or `@ai-sdk/gateway`
   (https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway):

   ```typescript
   import { createGateway } from '@ai-sdk/gateway'; // or from 'ai'
   const gw = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
   // then: model: gw('google/gemini-3.1-flash-lite')
   ```

   A `gateway(...)` provider-instance form (`import { gateway } from 'ai'`) also works and is what our
   realtime code already imports from `@ai-sdk/gateway`.

5. **Dependency reality check (verified locally): `ai` is NOT currently installed — it is not a
   transitive dep of `@ai-sdk/gateway`; the relationship runs the other way.** `node_modules/ai` does
   not exist in this repo, and `package.json` pins only `@ai-sdk/gateway@4.0.23`. Meanwhile
   `npm view ai@latest` shows `ai@7.0.31` depends on **exactly** `@ai-sdk/gateway@4.0.23`,
   `@ai-sdk/provider@4.0.3`, and `@ai-sdk/provider-utils@5.0.11` — all three already present in our
   tree as deps of `@ai-sdk/gateway`. So `npm install ai` adds **one package and zero new transitive
   dependencies**. That is the entire delta to unlock `generateText`/`generateObject`.

6. **Zero-new-dependency alternative:** the gateway is OpenAI-Chat-Completions compatible at
   `https://ai-gateway.vercel.sh/v1` (and Anthropic-Messages and OpenResponses compatible), so a bare
   `fetch` POST with `Authorization: Bearer $AI_GATEWAY_API_KEY` works with no SDK at all
   (https://vercel.com/docs/ai-gateway/getting-started/text). Given claim 5, though, adding `ai` is
   cheap and buys typed results, retries, `generateObject`, and fallback plumbing — recommended.

7. **Structured output is first-class** via `generateObject` with a zod schema — same model string,
   same key (https://vercel.com/docs/ai-gateway/modalities/text-generation). See §4 for the
   answer+confidence shape.

## 2. Model lineup on the gateway (verified 2026-07-19 against `https://ai-gateway.vercel.sh/v1/models`)

8. **`google/gemini-3.1-flash-lite` exists** — the user's suggested class is real (the "3.1" guess was
   exactly right; there is no "gemini-3.1-flash" text model, the 3.1 generation ships Flash-Lite plus
   image variants). Directory returns 302 models total; the model-list endpoint is publicly readable
   (no auth needed), so re-verification is a one-line curl.

9. **Fast/cheap Gemini options (exact IDs, context, gateway pricing per M tokens):**

   | Model ID | Context | Max out | $/M in | $/M out | Notes |
   |---|---|---|---|---|---|
   | `google/gemini-3.1-flash-lite` | 1,000,000 | 65,000 | $0.25 | $1.50 | cache-read $0.03/M; flex tier $0.125/$0.75; priority tier $0.45/$2.70; tagged reasoning, tool-use, implicit-caching; regions: us, eu. Google positions it as the RAG/data-extraction workhorse ("improvements across … RAG snippet ranking, translation, data extraction") |
   | `google/gemini-3.1-flash-lite-preview` | 1,000,000 | — | $0.25 | $1.50 | preview alias, same price |
   | `google/gemini-2.5-flash-lite` | 1,048,576 | 65,536 | $0.10 | $0.40 | cheapest Gemini; proven non-reasoning latency (§3) |
   | `google/gemini-3-flash` | 1,000,000 | — | $0.50 | $3.00 | step up in quality and price |
   | `google/gemini-2.5-flash` | 1,000,000 | — | $0.30 | $2.50 | |
   | `google/gemini-3.5-flash` | 1,000,000 | — | $1.50 | $9.00 | too expensive for this role |

10. **Non-Google alternates in the same speed/price class (same source):**

    | Model ID | Context | $/M in | $/M out | Notes |
    |---|---|---|---|---|
    | `openai/gpt-5-nano` | 400,000 | $0.05 | $0.40 | cheapest OpenAI; cache-read $0.005/M |
    | `openai/gpt-5-mini` | 400,000 | $0.25 | $2.00 | |
    | `openai/gpt-5.4-nano` | 400,000 | $0.20 | $1.25 | newest nano generation |
    | `openai/gpt-5.4-mini` | 400,000 | $0.75 | $4.50 | |
    | `openai/gpt-oss-120b` | 131,072 | $0.10 | $0.50 | open-weights; served on the gateway by **Groq, Cerebras**, Baseten, Fireworks, Together, Bedrock, Parasail, Nebius (https://vercel.com/ai-gateway/models/gpt-oss-120b) — the fastest-token-stream option available through this gateway. (The public model page lists $0.35/$0.75; the `/v1/models` API returns $0.10/$0.50 — pricing varies by serving provider, gateway bills the provider actually used.) |
    | `amazon/nova-micro` | 128,000 | $0.035 | $0.14 | absolute cheapest; 8K max output |
    | `mistral/ministral-8b` | 128,000 | $0.15 | $0.15 | |

11. **Groq and Cerebras are not standalone model creators in the directory** (zero `groq/*` or
    `cerebras/*` IDs in `/v1/models`), but they ARE serving providers behind open models like
    `openai/gpt-oss-120b` and `meta/llama-*`, selectable/rankable via
    `providerOptions.gateway.order/only/sort` (see §4). Model pages show "live throughput and
    time-to-first-token metrics measured across real AI Gateway traffic" per provider
    (https://vercel.com/ai-gateway/models/gpt-oss-120b;
    https://vercel.com/changelog/live-model-performance-metrics-accessible-via-ai-gateway).

## 3. Latency

12. **Headline warning: at default settings, Gemini 3.1 Flash-Lite is NOT sub-second.** Artificial
    Analysis measures p50 TTFT **5.90 s**, output **280 tok/s**, end-to-end **7.69 s for ~500 output
    tokens** on a standardized 10K-input-token workload via Google AI Studio
    (https://artificialanalysis.ai/models/gemini-3-1-flash-lite-preview/providers). The model ships
    with configurable thinking levels (`minimal`/`low`/`medium`/`high` via
    `providerOptions.google.thinkingConfig`; thinking counts toward output tokens —
    https://vercel.com/ai-gateway/models/gemini-3.1-flash-lite), and AA's default-config measurement
    absorbs that thinking budget into TTFT.

13. **The non-reasoning floor for this class is ~0.3–0.4 s TTFT.** Gemini 2.5 Flash-Lite
    (non-reasoning) measures **0.36 s TTFT** on Google's API vs a 1.44 s median for its price tier
    (https://artificialanalysis.ai/models/gemini-2-5-flash-lite/providers). Google markets 3.1
    Flash-Lite at 360+ tok/s output, "fastest, lowest-cost Gemini series"
    (https://x.com/ArtificialAnlys/status/2028882198456352852;
    https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/).

14. **Realistic estimate for OUR workload** (~5 KB corpus ≈ 1,300 input tokens — 8× smaller than AA's
    test prompt — plus a 1–3 sentence / ~100-token answer, thinking pinned to `minimal`, non-streaming
    `generateText`): TTFT ~0.3–0.7 s + ~100 tokens ÷ ~300 tok/s ≈ 0.3 s generation → **p50 ≈ 0.7–1.2 s,
    p95 ≈ 2–3 s** end-to-end. This must be validated empirically (one afternoon with the existing
    `scripts/aggregate-latency.mjs` habit), but it comfortably fits inside a natural "let me check
    that for you" filler phrase from RIO. If p95 matters more than quality, `gemini-2.5-flash-lite`
    (no thinking budget to mismanage) or `gpt-oss-120b`-on-Groq/Cerebras are the safer picks.

15. **Gateway overhead is negligible for this use.** Vercel reports the gateway adds **<20 ms**, ~10 ms
    control-plane, 350+ req/s per vCPU
    (https://www.truefoundry.com/blog/vercel-ai-review-2026-we-tested-it-so-you-dont-have-to;
    https://vercel.com/blog/how-ai-gateway-runs-on-fluid-compute — "single-digit milliseconds for most
    customers"). An independent benchmark vs the native Anthropic SDK found ~15–20% slower on tiny
    prompts, difference vanishing at large context, with rare p99 tail spikes
    (https://dev.to/cliftonz/benchmarking-vercel-ai-gateway-against-the-native-anthropic-sdk-21g5) —
    tail spikes are exactly what the fallback chain in §4 is for.

16. **Region/edge story:** the gateway runs on Vercel's Fluid compute and routes to the nearest edge;
    model entries carry a `regions` field (`gemini-3.1-flash-lite`: `us`, `eu`). Our Railway US
    deployment → gateway US edge → Google US region is the default path; nothing to configure.

## 4. Reliability knobs

17. **Model fallback chains are a native gateway feature** — a `models` array under
    `providerOptions.gateway`; the gateway tries the primary, then each fallback in order, and reports
    what happened in `modelAttempts` metadata
    (https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks):

    ```typescript
    const { text } = await generateText({
      model: 'google/gemini-3.1-flash-lite',
      prompt: question,
      providerOptions: {
        gateway: { models: ['google/gemini-2.5-flash-lite', 'openai/gpt-5-nano'] },
      },
    });
    ```

18. **Provider routing/sorting:** `order`, `only`, and `sort: 'ttft' | 'tps' | 'cost'` under
    `providerOptions.gateway` control which serving provider handles a model — e.g. pin
    `gpt-oss-120b` to `order: ['cerebras', 'groq']`
    (https://vercel.com/docs/ai-gateway/models-and-providers/provider-options).

19. **Timeouts:** gateway-side `providerTimeouts` (1 s–13 min, fires only until first token) exist but
    **apply to BYOK credentials only**
    (https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts) — we use system
    credentials, so the tool handler should enforce its own deadline client-side. AI SDK supports both
    `abortSignal: AbortSignal.timeout(4000)` and a `timeout` setting on `generateText`; `maxRetries`
    defaults to 2 (set 0–1 for a voice call; a retry burns more time than a fallback answer)
    (https://ai-sdk.dev/docs/ai-sdk-core/settings). Sensible shape: 3–4 s abort → catch → RIO says the
    graceful "I couldn't pull that up, let me route you" line that the simple-tool tier already needs.

20. **Answer + confidence via `generateObject`** — supported through the gateway with the same model
    string (https://vercel.com/docs/ai-gateway/modalities/text-generation):

    ```typescript
    const { object } = await generateObject({
      model: 'google/gemini-3.1-flash-lite',
      schema: z.object({
        answer: z.string().describe('1-3 spoken-style sentences'),
        confidence: z.enum(['high', 'medium', 'low']),
      }),
      prompt: `${corpus}\n\nCaller question: ${question}`,
    });
    ```

    Note we already pin `zod@3.25.76` (`package.json`), so this costs nothing extra. A `low`
    confidence return can trigger the routing/handoff path instead of RIO guessing aloud.

21. **Prompt caching for the corpus:** `gemini-3.1-flash-lite` is tagged `implicit-caching` with
    cache-read at $0.03/M (12× cheaper than input), and the gateway offers `caching: 'auto'` in
    `providerOptions.gateway` (https://vercel.com/docs/ai-gateway/models-and-providers/provider-options).
    Keeping the corpus as a stable prompt prefix (corpus first, question last) makes repeat questions
    nearly free on the input side.

## 5. Cost — the context-protection argument in dollars

22. **Per-call cost, 5 KB corpus (~1,300 input tokens) + 100-token answer** (prices from
    `/v1/models`, 2026-07-19):

    | Model | Input cost | Output cost | Per call | Calls per $1 |
    |---|---|---|---|---|
    | `google/gemini-3.1-flash-lite` | $0.000325 | $0.000150 | **$0.00048** | ~2,100 |
    | `google/gemini-2.5-flash-lite` | $0.000130 | $0.000040 | **$0.00017** | ~5,900 |
    | `openai/gpt-5-nano` | $0.000065 | $0.000040 | **$0.00011** | ~9,500 |
    | `openai/gpt-5-mini` | $0.000325 | $0.000200 | **$0.00053** | ~1,900 |
    | `openai/gpt-oss-120b` (list price) | $0.000130 | $0.000050 | **$0.00018** | ~5,600 |
    | `amazon/nova-micro` | $0.000046 | $0.000014 | **$0.00006** | ~16,700 |

23. **Versus stuffing the corpus into the realtime session.** `openai/gpt-realtime-2.1` on the gateway
    bills text input at **$4/M** (cache-read $0.40/M), text output $24/M, audio at ~$32/M in / $64/M
    out (`/v1/models` + prior findings). A 1,300-token corpus resident in the realtime context is
    re-billed as input on every model turn: over a 10-turn call that's ~13,000 corpus-tokens ≈
    **$0.052 uncached (~$0.005 cached)** — versus **~$0.0005 total** to delegate one question to
    flash-lite. Delegation is roughly **100× cheaper uncached (10× cheaper even against a perfectly
    cached realtime prefix)**, and that's for ONE 5 KB corpus; the whole point is that the full CSUB
    corpus (tens/hundreds of KB) could never fit the realtime 128K window across concurrent topics
    anyway, while flash-lite's 1M window swallows it whole.

24. **The non-dollar half of the argument:** every corpus token in the realtime context also degrades
    the voice model (128K hard window vs flash-lite's 1M; realtime instruction-following measurably
    worsens as context bloats — prior findings 01–14). The two-tier design keeps the realtime context
    to persona + tool schemas + conversation, at a marginal delegation cost of ~5 hundredths of a cent
    per intelligent question. Even a viral self-serve demo (1,000 calls × 3 intelligent questions)
    costs ~**$1.50** in delegated intelligence on gemini-3.1-flash-lite.

## Recommendation snapshot

25. Install `ai@7.x` (one package, zero new transitive deps — claim 5). In the MCP tool handler:
    `generateObject` on `google/gemini-3.1-flash-lite` with `thinkingConfig` minimal,
    `maxOutputTokens ≈ 150`, corpus-first/question-last prompt for implicit caching,
    `abortSignal: AbortSignal.timeout(4000)`, `maxRetries: 0`, and gateway fallback
    `models: ['google/gemini-2.5-flash-lite']`. Measure real p50/p95 from Railway before locking the
    filler-phrase script.

## Source index

- https://vercel.com/docs/ai-gateway/modalities/text-generation
- https://vercel.com/docs/ai-gateway/getting-started/text
- https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
- https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks
- https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts
- https://ai-gateway.vercel.sh/v1/models (public; fetched 2026-07-19; 302 models)
- https://vercel.com/ai-gateway/models/gemini-3.1-flash-lite
- https://vercel.com/ai-gateway/models/gpt-oss-120b
- https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway
- https://ai-sdk.dev/docs/getting-started/choosing-a-provider
- https://ai-sdk.dev/docs/ai-sdk-core/settings
- https://artificialanalysis.ai/models/gemini-3-1-flash-lite-preview/providers
- https://artificialanalysis.ai/models/gemini-2-5-flash-lite/providers
- https://x.com/ArtificialAnlys/status/2028882198456352852
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/
- https://dev.to/cliftonz/benchmarking-vercel-ai-gateway-against-the-native-anthropic-sdk-21g5
- https://vercel.com/blog/how-ai-gateway-runs-on-fluid-compute
- https://www.truefoundry.com/blog/vercel-ai-review-2026-we-tested-it-so-you-dont-have-to
- https://vercel.com/changelog/live-model-performance-metrics-accessible-via-ai-gateway
- Local code: `src/config.ts:4,90` (AI_GATEWAY_API_KEY), `src/gateway.ts:81,297` (realtime uses same
  gateway/key), `package.json` (`@ai-sdk/gateway@4.0.23` pinned; `ai` absent), `node_modules` +
  `npm view ai@latest` (dependency graph verification)

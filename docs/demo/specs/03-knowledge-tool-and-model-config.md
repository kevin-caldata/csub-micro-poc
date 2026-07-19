# Demo Spec 03 — `ask_campus_knowledge` Delegated-Intelligence Tool + Model Config

Date: 2026-07-19 · Project: CSUB-RIO self-serve demo · Status: Draft for review
Depends on: base Spec 07 (MCP server + tool loop — `buildMcpServer` extension point, `runTool` transport cap, spoken-apology path), Demo Spec 04 (corpus file + module-scope loader — this spec CONSUMES its exported corpus string) · Enables: Demo Spec 02 (persona/instructions — references the envelope `status` values in the three-lane answering policy), Demo Spec 05 (performance measurement — consumes the `knowledge-call` log line)
Findings referenced: findings/15 (§1 claims 1–7 gateway text API, §2 claims 8–9 model lineup, §3 claims 12–14 latency/thinking, §4 claims 17–21 reliability knobs, §5 cost, claim 25 recommendation), findings/16 (C1–C4 handler placement, C8–C10 `ai` dependency, C11–C12 error containment, C15 corpus placement), findings/17 (§2 grounding contract, §2.5 envelope/sentinel, §5.3 one-generic-tool schema)

---

## Objective

When this spec is done, the MCP server exposes exactly ONE delegated-intelligence tool, `ask_campus_knowledge(question, topic?)`, registered at the FR-5 extension point in `buildMcpServer()` [findings/16 C1]. Its handler calls `generateObject` from the `ai` package against **`google/gemini-3.1-flash-lite` through the same Vercel AI Gateway** (same `AI_GATEWAY_API_KEY`) [findings/15 claims 1–3], answers strictly from the simulated CSUB corpus (corpus-first, question-last, thinking pinned minimal), and returns the envelope `{"status":"ok"|"not_found"|"error","response_text":"..."}` as the tool result text. Three new additive env keys (`MCP_MODEL_ID`, `MCP_MODEL_MAX_TOKENS`, `MCP_TOOL_TIMEOUT_MS`) configure it. On any failure or timeout the handler returns an `isError` result and the **existing** ToolLoop spoken-apology path handles it — no new failure machinery [findings/16 C11]. Every call emits one flat `knowledge-call` log line (`knowledgeMs` + token/cache counters) feeding Demo Spec 05's measurement pass. All handler tests run with an injected fake generate function — **no test ever performs a network call**.

## Deliverables

- Modify `src/config.ts` — three new env keys + three new `AppConfig` fields (additive only; no existing key touched).
- Modify `.env.example` — three new documented lines in the Tunables block.
- Modify `package.json` + `package-lock.json` — add `"ai": "7.0.31"` (exact pin, like every dep in this repo).
- New `src/knowledge.ts` — envelope schema/consts, system-prompt builder, `askCampusKnowledge()` handler logic, `KnowledgeGenerateFn` seam, `makeGatewayGenerate()` default implementation.
- Modify `src/mcp-server.ts` — thread `AppConfig` into `mcpRoutes`/`buildMcpServer`; one `registerTool('ask_campus_knowledge', ...)` call at the FR-5 comment.
- Modify `src/server.ts` — `await mcpRoutes(app)` → `await mcpRoutes(app, config)` (line 75).
- New `test/knowledge.test.ts` + additions to `test/config.test.ts`; call-site updates in `test/mcp-server.test.ts` and `test/tools.test.ts`.

## Requirements

### Config — `src/config.ts` (additive only)

**R1.** Add exactly three keys to `EnvSchema`, following the existing zod patterns (`z.coerce.number().int().positive()` as used by `PORT` at `src/config.ts:12`):

```ts
// ── Demo Spec 03: delegated-intelligence knowledge tool ──
MCP_MODEL_ID: z.string().min(1).default('google/gemini-3.1-flash-lite'),
MCP_MODEL_MAX_TOKENS: z.coerce.number().int().positive().default(150),
// MUST stay strictly below runTool's 5000 ms transport cap (src/tools.ts:42) so the handler's
// clean error envelope always wins the race against the SDK's generic RequestTimeout
// [findings/16 C3, C12].
MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive()
  .lt(5000, 'MCP_TOOL_TIMEOUT_MS must be < 5000 (runTool transport cap, src/tools.ts:42)')
  .default(3500),
```

Defaults: model `google/gemini-3.1-flash-lite` (exists on the gateway, 1M context, $0.25/M in / $1.50/M out, implicit-caching tagged [findings/15 claims 8–9]); `150` max output tokens (output length dominates flash-lite generation time; ~100–150 keeps generation ≈0.3 s [findings/15 claim 14; findings/16 C6]); `3500` ms in-handler budget beneath the 5000 ms transport ceiling [findings/16 C12].

**R2.** Add to the `AppConfig` interface and the `loadConfig` return object, in this exact spelling:

```ts
mcpModelId: string;        // ← e.MCP_MODEL_ID
mcpModelMaxTokens: number; // ← e.MCP_MODEL_MAX_TOKENS
mcpToolTimeoutMs: number;  // ← e.MCP_TOOL_TIMEOUT_MS
```

No other `AppConfig` field changes. Existing config tests must pass unmodified (all three keys have defaults).

**R3. SINGLE MODEL, NO FALLBACK (binding user decision).** There is **no** fallback-model env key, no model list, and no `providerOptions.gateway.models` array anywhere in `src/`. findings/15 claim 17 documents the gateway's native fallback-chain feature and claim 25 recommends one — that recommendation is **explicitly rejected**: the demo runs one model, and on failure/timeout the tool returns an error envelope so the existing spoken-apology path (R9) handles it. Rationale: a fallback chain hides the primary model's failure rate from the Spec 05 measurement pass, adds a second model's latency tail to the worst case, and doubles the tuning surface — the failure path we already own (apologize + offer to route) is the better demo behavior. Any future reintroduction of fallback is a design change requiring the human, not a tuning tweak.

**R4.** `.env.example` — append to the Tunables block (matching the file's comment style):

```
MCP_MODEL_ID=google/gemini-3.1-flash-lite  # knowledge-tool text model via the same AI Gateway; SINGLE model, NO fallback (demo spec 03 R3)
MCP_MODEL_MAX_TOKENS=150                   # knowledge answer cap; output length dominates flash-lite latency
MCP_TOOL_TIMEOUT_MS=3500                   # in-handler abort budget; MUST be < 5000 (runTool transport cap, src/tools.ts:42)
```

### Dependency — the `ai` package

**R5.** Add `"ai": "7.0.31"` to `package.json` dependencies (exact pin — `npm install --save-exact ai@7.0.31`; matches this repo's universal exact-pin convention, `package.json:18-27`). Verified 2026-07-19: `ai@7.0.31` depends on exactly `@ai-sdk/gateway@4.0.23`, `@ai-sdk/provider@4.0.3`, `@ai-sdk/provider-utils@5.0.11` — all three already in the lockfile at those exact versions as deps of the pinned `@ai-sdk/gateway@4.0.23`, so the install adds **one package and zero new transitive dependencies** [findings/15 claim 5; findings/16 C9]. The repo is pure ESM (`"type":"module"`, NodeNext); `import { generateObject } from 'ai'` type-checks and runs on Node 22 with no CJS concern [findings/16 C10]. After install, assert the lockfile still pins `@ai-sdk/gateway` at `4.0.23` (no dedupe churn).

### Config threading — how the handler receives `AppConfig`

**R6.** Today `buildMcpServer()` takes no arguments and `mcpRoutes(app)` is called from `buildApp` at `src/server.ts:75` with `config` in scope but not passed; `buildMcpServer()` runs **per request** inside the POST handler (`src/mcp-server.ts:45`, stateless-transport requirement, base Spec 07 R2). Change the signatures additively:

```ts
// src/mcp-server.ts
export interface BuildMcpServerDeps {
  /** Test seam (R11): replaces the real gateway call. Default: makeGatewayGenerate(cfg). */
  knowledgeGenerate?: KnowledgeGenerateFn;
}
export function buildMcpServer(cfg: AppConfig, deps?: BuildMcpServerDeps): McpServer;
export async function mcpRoutes(app: FastifyInstance, cfg: AppConfig, deps?: BuildMcpServerDeps): Promise<void>;
```

`mcpRoutes` passes `cfg`/`deps` through to each per-request `buildMcpServer(cfg, deps)` call; `src/server.ts:75` becomes `await mcpRoutes(app, config);` (the `config` validated once at boot, `src/server.ts:134` / `src/server.ts:41` — never re-parse `process.env` per request). Update the existing test call sites `mcpRoutes(app)` (`test/mcp-server.test.ts:10`, `test/tools.test.ts:14`, `test/tools.test.ts:110`) to `mcpRoutes(app, loadConfig({ ...BASE }))` with the same minimal `BASE` env object pattern used throughout the suite (e.g. `test/gateway.session-config.test.ts:80`) — those tests only invoke `get_current_time`/`hello`/unknown tools, so no network path is ever reached. Per-request cost of the extra argument is zero (object references only). Note: `MCP_MODEL_ID` etc. living in config does not violate base Spec 07 R5's "no tool knowledge in config" rule — that rule bans tool *names/schemas/dispatch tables*; these are tuning values, same class as `VOICE` or `VAD_SILENCE_MS`.

### Tool registration — `src/mcp-server.ts`

**R7.** Register exactly one new tool at the `// FR-5:` comment (`src/mcp-server.ts:37`) [findings/16 C1]. Name, schema, and description verbatim [findings/17 §5.3]:

```ts
server.registerTool(
  'ask_campus_knowledge',
  {
    description:
      'Answers factual questions about CSUB — hours, locations, dates, deadlines, fees, ' +
      'how-to steps, events. Use when: the caller asks any campus fact. Do NOT use when: ' +
      'transferring a call, escalating, or making small talk.',
    inputSchema: {
      // zod RAW SHAPE, never z.object(...) — base Spec 07 R5 house rule
      question: z.string().min(1).describe('One clear, self-contained question about CSUB.'),
      topic: z.enum(KNOWLEDGE_TOPICS).optional()
        .describe('Optional topic tag for logging only; never required.'),
    },
  },
  async ({ question, topic }, extra) =>
    askCampusKnowledge({ question, topic }, {
      cfg,
      corpus: CORPUS,
      generate: deps?.knowledgeGenerate ?? makeGatewayGenerate(cfg),
      signal: extra.signal,
      log: logEvent,
    }),
);
```

`KNOWLEDGE_TOPICS` (exported from `src/knowledge.ts`) is exactly `['directory_hours', 'financial_aid', 'registration', 'orientation', 'it_help', 'parking', 'events', 'other'] as const` — `topic` is metadata for the `knowledge-call` log line, **not** routing; the handler never branches on it [findings/17 §5.3]. `CORPUS` is a local alias for `CSUB_CORPUS`, Demo Spec 04's module-scope export (`const CORPUS = CSUB_CORPUS` after `import { CSUB_CORPUS } from './corpus.js'` — master plan D1; see Interfaces) — module scope is mandatory because `buildMcpServer` runs per request [findings/16 C15]. This tool is the ONLY delegated-intelligence tool; the six static tools (Demo Spec 02's scope) never call a model [findings/17 §4.5, §5.4].

### Handler — `src/knowledge.ts`

**R8.** Envelope contract (exported consts/schema — exact values):

```ts
export const KNOWLEDGE_ENVELOPE_SCHEMA = z.object({
  status: z.enum(['ok', 'not_found', 'error']),
  response_text: z.string(),
});
export type KnowledgeEnvelope = z.infer<typeof KNOWLEDGE_ENVELOPE_SCHEMA>;
export const NOT_FOUND_SENTINEL = 'NOT_FOUND';
export const NOT_FOUND_SPOKEN =
  "I don't have that information. Offer to connect the caller to the right department instead.";
export const KNOWLEDGE_ERROR_SPOKEN = "I couldn't reach the campus knowledge base just now.";
```

`NOT_FOUND_SPOKEN` is verbatim findings/17 §2.5; `KNOWLEDGE_ERROR_SPOKEN` is verbatim findings/16 C12. The `'error'` enum value is **reserved for the handler** (R9 catch path); the model is only ever instructed to emit `ok`/`not_found` (R10) — a model-emitted `'error'` is normalized per R9 step 4.

**R9.** `askCampusKnowledge(args, deps)` — exact flow:

```ts
export interface KnowledgeGenerateArgs {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
}
export interface KnowledgeGenerateResult {
  object: unknown; // validated by generateObject against KNOWLEDGE_ENVELOPE_SCHEMA in the real impl
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
}
export type KnowledgeGenerateFn = (args: KnowledgeGenerateArgs) => Promise<KnowledgeGenerateResult>;

export async function askCampusKnowledge(
  args: { question: string; topic?: (typeof KNOWLEDGE_TOPICS)[number] },
  deps: {
    cfg: AppConfig;
    corpus: string;
    generate: KnowledgeGenerateFn;
    signal: AbortSignal;                 // the SDK-provided extra.signal
    log: (fields: LogFields) => void;    // logEvent in production
  },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }>;
```

1. Build `abortSignal = AbortSignal.any([deps.signal, AbortSignal.timeout(deps.cfg.mcpToolTimeoutMs)])`. `extra.signal` is the SDK's per-request cancellation signal (fires on the client's 5 s-timeout cancellation notification, `@modelcontextprotocol/sdk` `shared/protocol.d.ts:175-177`); the two compose: 3.5 s self-imposed budget, 5 s hard transport ceiling behind it [findings/16 C12, C3].
2. Stamp `t0 = now()` (from `src/logger.ts:47` — monotonic `performance.now()`, never `Date.now()`), then `const { object, usage } = await deps.generate({ system, prompt, maxOutputTokens: deps.cfg.mcpModelMaxTokens, abortSignal })` where `system`/`prompt` come from R10. Stamp `t1 = now()` on resolve.
3. Parse `object` with `KNOWLEDGE_ENVELOPE_SCHEMA.safeParse` (belt-and-suspenders — the real generate already schema-validates; the fake seam may not). Parse failure → treat as step 5's catch path.
4. **Normalize**, in order: let `t = envelope.response_text.trim()`. If `envelope.status !== 'ok'` OR `t === ''` OR `t === NOT_FOUND_SENTINEL` OR `t.startsWith(NOT_FOUND_SENTINEL)` → result envelope is exactly `{ status: 'not_found', response_text: NOT_FOUND_SPOKEN }` (deterministic canned text; the raw sentinel must never reach the realtime model or the caller — sentinel exact/prefix match per findings/17 §2.5; empty-text and stray-`'error'` cases collapse to the same graceful miss). Otherwise the result envelope is `{ status: 'ok', response_text: t }`.
5. Return `{ content: [{ type: 'text', text: JSON.stringify(resultEnvelope) }] }` (no `isError`). The realtime model receives it via `runTool`'s `JSON.stringify(result)` passthrough (`src/tools.ts:50`) and the Demo Spec 02 instructions tell it to speak only `response_text` and to offer routing on `not_found` [findings/17 §2.5, §4.4].
6. **Catch (everything: abort/timeout `AbortError`, gateway 4xx/5xx, network, `NoObjectGeneratedError`, schema-parse failure):** return

   ```ts
   {
     isError: true,
     content: [{ type: 'text',
       text: JSON.stringify({ status: 'error', response_text: KNOWLEDGE_ERROR_SPOKEN }) }],
   }
   ```

   Never rethrow, never kill the call. `runTool` sees `isError` and converts the joined content text to `{"error": <text>}` (`src/tools.ts:43-49`); the gated follow-up `response-create` fires normally and the model apologizes verbally — the exact path base Spec 07 line 189 designed ("the model reads `{"error": ...}` … and apologizes verbally") [findings/16 C11]. Log the `knowledge-call` line (R12) with `status: 'error'` and `errName` before returning.

**R10.** Grounding prompt — corpus-first, question-last. Export `buildKnowledgeSystemPrompt(corpus: string): string` returning **exactly** this text with `{CORPUS}` substituted (assembled from findings/17 §2.4, adapted for `generateObject`'s structured output; strict-context + permission-to-say-I-don't-know per findings/17 §2.1–2.3):

```
You answer questions for RIO, a phone operator at CSUB. Answer ONLY from the
documents below. Never use outside knowledge, even about the real CSUB.

Rules:
- Answer in 2-3 short sentences, spoken-style: plain words, no markdown, no
  lists, no headings. Phone numbers as digits like (661) 654-3036.
- If the documents contain the answer, set status to "ok" and put the answer
  in response_text.
- If the documents do not contain the answer, set status to "not_found" and
  set response_text to exactly: NOT_FOUND
- Never guess, never partially answer from memory, even if the question insists.

<documents>
{CORPUS}
</documents>
```

The user prompt is `` `Question: ${question}` ``. The system string is **byte-stable across calls** (corpus is a fixed prefix, only the tiny user message varies) — this is what makes gemini-3.1-flash-lite's implicit caching bite (cache-read $0.03/M, 12× cheaper than input) [findings/15 claim 21; findings/17 §1.2 "put your query at the end of the prompt"]. Do not strip the corpus's SIMULATED-DATA banner — it doubles as a grounding aid [findings/17 §3]. The handler computes the system string once at module scope of `src/knowledge.ts` (`const SYSTEM = buildKnowledgeSystemPrompt(CORPUS)`), not per call.

**R11.** Default generate implementation — `makeGatewayGenerate(cfg: AppConfig): KnowledgeGenerateFn`, the ONLY place in the repo that imports from `'ai'`:

```ts
import { generateObject } from 'ai';
import { createGateway } from '@ai-sdk/gateway';

export function makeGatewayGenerate(cfg: AppConfig): KnowledgeGenerateFn {
  const gw = createGateway({ apiKey: cfg.aiGatewayApiKey }); // explicit key — no ambient-env reliance
  return async ({ system, prompt, maxOutputTokens, abortSignal }) => {
    const { object, usage } = await generateObject({
      model: gw(cfg.mcpModelId),
      schema: KNOWLEDGE_ENVELOPE_SCHEMA,
      system,
      prompt,
      maxOutputTokens,
      maxRetries: 0, // a retry burns more time than a spoken miss [findings/15 claim 19]
      abortSignal,
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: 'minimal' } },
      },
    });
    return { object, usage };
  };
}
```

- `createGateway({ apiKey: cfg.aiGatewayApiKey })` uses the same key the realtime leg already validates (`src/config.ts:4-10`, `src/gateway.ts:81`) — one gateway-wide key for both modalities [findings/15 claims 2–4]; the explicit `apiKey` matches this repo's no-ambient-config rule (cf. the `loadConfig` OIDC warning, `src/config.ts:6-7`).
- **Thinking-budget syntax (verified):** findings/15 claim 12 names the knob (`providerOptions.google.thinkingConfig`, levels `minimal`/`low`/`medium`/`high`); the exact passthrough form for Gemini 3-generation models is `providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } }` — Gemini 3 uses `thinkingLevel` (2.5-era models used `thinkingBudget`) per the AI SDK Google-provider docs (ai-sdk.dev/providers/ai-sdk-providers/google, "Thinking Configuration": "Gemini 3 models use thinking levels ranging from minimal to high"). The gateway forwards provider-keyed `providerOptions` to the serving provider (same mechanism as the realtime leg's `providerOptions.gateway.tags`, `src/gateway.ts:277`). Without this pin, default-config TTFT is ~5.9 s [findings/15 claim 12]; with it, expected p50 ≈ 0.7–1.2 s end-to-end [findings/15 claim 14].
- `generateObject` returns the schema-validated object; on schema failure it throws `NoObjectGeneratedError`, which R9 step 6 catches [findings/15 claims 7, 20].
- No `providerOptions.gateway.models` (R3). No streaming (the tool result is consumed whole).

**R12.** Instrumentation — one flat single-line log per invocation via `deps.log` (Railway `@attr` filters need flat top-level fields, findings/09 §5; same style as the `tool-call` line, `src/tools.ts:223-234`):

```
{"level":"info","message":"knowledge ok","event":"knowledge-call","status":"ok","topic":"financial_aid",
 "questionChars":52,"answerChars":141,"knowledgeMs":812.4,"inputTokens":9873,"outputTokens":63,
 "cachedInputTokens":9612,"reasoningTokens":0,"modelId":"google/gemini-3.1-flash-lite"}
```

- `knowledgeMs = ms(t0, t1)` (`src/logger.ts:46`, 1-decimal rounding) — the pure model-call duration, the number Demo Spec 05's tuning experiments regress against (`toolTotalMs < 1500` stays the M3 gate; `knowledgeMs` is its dominant new component [findings/16 C5–C6]).
- **Cache-hit indicators:** `cachedInputTokens` (from `usage.cachedInputTokens`; `> 0` = implicit-cache hit) and `inputTokens`/`outputTokens`/`reasoningTokens` — log `undefined`-valued fields as omitted (the logger already drops undefined). `reasoningTokens` persistently `> 0` means the `thinkingLevel: 'minimal'` pin is not taking effect — a Spec 05 red flag.
- `status` is the final envelope status (`ok` | `not_found` | `error`); the error path adds `errName` (`err.name`, e.g. `AbortError` vs `TimeoutError` vs `APICallError`) so timeouts are distinguishable from gateway failures in aggregation.
- `topic` logs the caller-model-supplied tag or is omitted; `questionChars`/`answerChars` are lengths, never the raw text at info level (question text may contain caller PII-ish content; the corpus is simulated but caller questions are real).

**R13.** The always-on spoken preamble that masks this tool's latency is enforced by the existing `INSTRUCTIONS` const (`src/gateway.ts:241-244`) and is **test-asserted verbatim**: `test/gateway.session-config.test.ts:101-102` and `:124-127` assert the exact substring `"Before calling any tool, briefly say you're checking (e.g., 'One moment, let me look that up')."`. This spec must not touch `INSTRUCTIONS`; Demo Spec 02 (persona) owns its evolution and MUST keep that sentence intact (hard constraint). The latency math depends on it: tool execution overlaps the preamble audio, so ~1–2 s of `knowledgeMs` is caller-invisible [findings/16 C4, C6; findings/17 §4.3].

### Testing rules — NO network, ever

**R14.** The injection seam is `KnowledgeGenerateFn` (R9), threaded as `buildMcpServer(cfg, { knowledgeGenerate: fake })` / `mcpRoutes(app, cfg, { knowledgeGenerate: fake })` (R6). Vitest tests (node environment, never jsdom — base Spec 07 A4 note) MUST exercise `askCampusKnowledge` and the registered tool only through injected fakes; `makeGatewayGenerate` is unit-tested via `vi.mock('ai', ...)` asserting the options it passes to `generateObject` — the mock resolves locally, so no test ever opens a socket to the gateway. Existing tests calling the static tools through `mcpRoutes` (R6 call-site updates) never reach `makeGatewayGenerate` because the default is only invoked when `ask_campus_knowledge` itself is called.

## Interfaces

**Consumes:**
- `AppConfig` + `loadConfig` from `src/config.ts` (extended here, R1–R2).
- `CSUB_CORPUS: string` — Demo Spec 04's export from `src/corpus.ts`, imported as `{ CSUB_CORPUS } from './corpus.js'` and optionally aliased locally to `CORPUS` where this spec's snippets use that name (master plan D1) (module-scope `readFileSync` of `assets/csub-corpus.md` via the `import.meta.url` pattern of `src/fallback.ts:40-44`; module scope mandatory because `buildMcpServer` runs per request [findings/16 C15]).
- `logEvent`, `now`, `ms`, `LogFields` from `src/logger.ts` (`:46-47`, `:63`).
- `runTool`'s 5000 ms transport cap and `isError → {"error": ...} → spoken apology` contract (`src/tools.ts:42-54`) — unchanged, relied upon.
- `zod@3.25.76` (already pinned; satisfies both the MCP SDK peer and `generateObject` schemas [findings/15 claim 20]).

**Produces:**
- Env keys: `MCP_MODEL_ID` (default `google/gemini-3.1-flash-lite`), `MCP_MODEL_MAX_TOKENS` (default `150`), `MCP_TOOL_TIMEOUT_MS` (default `3500`, validated `< 5000`). `AppConfig` fields: `mcpModelId`, `mcpModelMaxTokens`, `mcpToolTimeoutMs`.
- Signatures other demo specs must match: `buildMcpServer(cfg: AppConfig, deps?: BuildMcpServerDeps)`, `mcpRoutes(app, cfg, deps?)` (Demo Spec 02's six static tools register inside the same `buildMcpServer(cfg, ...)`; static handlers take no deps).
- Tool name `ask_campus_knowledge` with args `{ question: string; topic?: KNOWLEDGE_TOPICS[number] }`; `KNOWLEDGE_TOPICS` as listed in R7.
- Envelope contract for Demo Spec 02's instructions: tool result text is JSON `{"status":"ok"|"not_found"|"error","response_text":string}`; error results additionally arrive wrapped as `{"error": ...}` by `runTool`. Exported consts: `KNOWLEDGE_ENVELOPE_SCHEMA`, `NOT_FOUND_SENTINEL` (`'NOT_FOUND'`), `NOT_FOUND_SPOKEN`, `KNOWLEDGE_ERROR_SPOKEN`, `buildKnowledgeSystemPrompt`, `askCampusKnowledge`, `makeGatewayGenerate`, `KnowledgeGenerateFn`.
- Log event `knowledge-call` with flat fields `status`, `topic?`, `questionChars`, `answerChars`, `knowledgeMs`, `inputTokens?`, `outputTokens?`, `cachedInputTokens?`, `reasoningTokens?`, `modelId`, `errName?` (Demo Spec 05's measurement input).
- Dependency pin: `ai@7.0.31` exact.

## Acceptance criteria

- **A1** (config defaults): `loadConfig({ ...BASE })` (the suite's minimal env) yields `mcpModelId === 'google/gemini-3.1-flash-lite'`, `mcpModelMaxTokens === 150`, `mcpToolTimeoutMs === 3500`.
- **A2** (config validation): `MCP_TOOL_TIMEOUT_MS: '5000'` → `loadConfig` throws with a message matching `/runTool transport cap/`; `'0'`, `'-1'`, and `'1.5'` all throw; `MCP_MODEL_MAX_TOKENS: '0'` throws; `MCP_MODEL_ID: ''` throws. `MCP_TOOL_TIMEOUT_MS: '4999'` succeeds.
- **A3** (no fallback): `grep -rE 'FALLBACK_MODEL|MCP_FALLBACK|gateway.*models\s*:' src/` finds nothing; `KnowledgeGenerateFn` and `makeGatewayGenerate` reference exactly one model id (`cfg.mcpModelId`). Checkable by inspection + a grep in CI notes; no fallback env key exists in `EnvSchema`.
- **A4** (dependency): `package.json` contains `"ai": "7.0.31"`; after `npm install`, `package-lock.json` still pins `@ai-sdk/gateway@4.0.23`, `@ai-sdk/provider@4.0.3`, `@ai-sdk/provider-utils@5.0.11` and adds only the `ai` entry; `npm run typecheck` passes.
- **A5** (happy path, fake generate): with `knowledgeGenerate` resolving `{ object: { status: 'ok', response_text: 'The Runner Rundown fee is $150 for freshmen.' } }`, calling `ask_campus_knowledge` through a real in-process `mcpRoutes(app, cfg, { knowledgeGenerate })` + `runTool` returns a string whose parsed `content[0].text` parses to exactly `{ status: 'ok', response_text: 'The Runner Rundown fee is $150 for freshmen.' }` and `isError` is absent. The fake received: `system` containing the corpus fixture and ending with `</documents>`, `prompt === 'Question: <question>'`, `maxOutputTokens === 150`, an `AbortSignal` instance.
- **A6** (sentinel/normalization): fakes returning `{ status: 'ok', response_text: 'NOT_FOUND' }`, `{ status: 'ok', response_text: 'NOT_FOUND — nothing in the docs.' }`, `{ status: 'not_found', response_text: 'anything' }`, `{ status: 'error', response_text: 'x' }`, and `{ status: 'ok', response_text: '   ' }` ALL yield the envelope `{ status: 'not_found', response_text: NOT_FOUND_SPOKEN }` with no `isError`. The literal string `NOT_FOUND` never appears in any returned `response_text`.
- **A7** (error/timeout → spoken apology): (a) fake generate rejecting with `new Error('boom')` → result has `isError: true` and text parsing to `{ status: 'error', response_text: KNOWLEDGE_ERROR_SPOKEN }`; (b) fake generate that never resolves + `cfg` built with `MCP_TOOL_TIMEOUT_MS: '50'` → same envelope within ~150 ms (proves `AbortSignal.timeout` composition); (c) end-to-end through `runTool` against the in-process server, the returned string parses to `{ error: <string containing 'status":"error'> }` — the exact shape that triggers the existing spoken-apology path (`src/tools.ts:43-49`; base Spec 07 line 189). No test rejects/throws.
- **A8** (abort composition): a fake that records its `abortSignal` and resolves → the signal aborts when the injected `extra.signal` fires (drive via the MCP client cancelling or a manual `AbortController` passed through `askCampusKnowledge` directly).
- **A9** (tool definition): `fetchToolDefs(client)` output includes `ask_campus_knowledge` with `parameters.properties.question.type === 'string'`, `parameters.required` containing `'question'` and NOT `'topic'`, `parameters.properties.topic.enum` deep-equal to the R7 list, and no `$schema` key (base Spec 07 R8 mapping unchanged).
- **A10** (default wrapper options, `vi.mock('ai')`): `makeGatewayGenerate(cfg)` invoked once → the mocked `generateObject` was called with `schema: KNOWLEDGE_ENVELOPE_SCHEMA`, `maxRetries: 0`, `maxOutputTokens: cfg.mcpModelMaxTokens`, and `providerOptions` deep-equal to `{ google: { thinkingConfig: { thinkingLevel: 'minimal' } } }`; the model argument was produced from `cfg.mcpModelId`. No network I/O occurs (mock resolves locally).
- **A11** (instrumentation): the injected `log` fake captures exactly one `event: 'knowledge-call'` line per invocation with numeric `knowledgeMs` (1-decimal), `status` matching the returned envelope, `questionChars`/`answerChars` correct, and — when the fake generate supplies `usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 }` — those exact values flat at top level. Error-path lines carry `status: 'error'` and `errName`.
- **A12** (regression): full suite green — all 356 pre-existing tests pass with only the R6 call-site edits; `test/gateway.session-config.test.ts` still asserts the R13 preamble sentence untouched.
- **A13** (live smoke, deferred to Demo Spec 05's measured pass): one real call asking a corpus fact → one `knowledge-call` line with `status: 'ok'`, and the co-emitted `tool-call` line keeps `toolTotalMs < 1500` p50 across the Spec 05 sample (M3 gate; failed tuning experiments revert per the master performance rule).

## Non-goals / out of scope

- **Corpus authoring and loading** — `assets/csub-corpus.md` content (12 sections, SIMULATED-DATA banner) and the `src/corpus.ts` module-scope loader are Demo Spec 04. This spec only consumes its `CORPUS` export.
- **No RAG, no pre-filter, no chunking** — whole-corpus prompt-stuffing is the decided strategy at ~30–50 KB [findings/17 §1.1–1.5]; the optional `topic` arg is a logging tag and a future seam, not a retrieval mechanism.
- **No fallback model** (R3 — decided, not deferred), no `providerOptions.gateway.order/only/sort` provider routing, no gateway-side `providerTimeouts` (BYOK-only anyway [findings/15 claim 19]), no streaming.
- The six static fake tools, the RIO persona/`INSTRUCTIONS` rewrite, Spanish-switch, and the three-lane answering policy — Demo Spec 02 (this spec only pins the envelope contract those instructions reference and the R13 preamble constraint).
- Latency tuning experiments, measurement aggregation, and the revert rule — Demo Spec 05 (this spec only emits the `knowledge-call` line it consumes).
- ToolLoop, `runTool`, the double gate, and the 5000 ms transport cap — unchanged (base Spec 07); this spec deliberately fits inside them.
- Announcement email content — separate deliverable (`docs/demo/RIO-ANNOUNCEMENT-EMAIL.md` rewrite).

---

Amended 2026-07-19: live-call tuning — timeout 4500, max tokens 400, brevity rule; DEV evidence in ledger.

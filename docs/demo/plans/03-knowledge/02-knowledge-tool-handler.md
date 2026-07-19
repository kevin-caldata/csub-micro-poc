# DB1.2 — `ask_campus_knowledge` handler, gateway wrapper, and the `buildMcpServer(cfg, deps?)` signature change

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development

**Goal:** Create `src/knowledge.ts` (envelope schema, grounding prompt, `askCampusKnowledge` handler, `makeGatewayGenerate` gateway wrapper, `KnowledgeGenerateFn` injection seam), change `buildMcpServer()`/`mcpRoutes()` to the `(cfg, deps?)` signatures with ALL call-site updates (master plan D3 — this task owns them), and register `ask_campus_knowledge` at the `// FR-5:` extension point. Every test uses an injected fake or `vi.mock('ai')` — no network, ever.

**Global Constraints:** All Global Constraints in `docs/demo/specs/00-master-demo-plan.md` §G bind every step of this plan. Load-bearing here: **G2** (single model, no fallback — grep-gated), **G5** (statelessness — corpus + system prompt computed once at module scope, no module-level mutable state), **G9** (the ONLY permitted edit outside this task's declared files is the one-line change at `src/server.ts:75`), **G10** (no network in tests), **G4** (never touch `test/gateway.session-config.test.ts` or `src/gateway.ts`).

**Wave:** DB · **Depends on:** M-A complete (DA1 corpus → `CSUB_CORPUS`; DA2 static tools → six-tool `buildMcpServer` body with the `// FR-5:` comment as the last line of the tool block) AND `docs/demo/plans/03-knowledge/01-config-keys-and-dependency.md` (the three `MCP_*` config keys + `ai@7.0.31` installed) · **Blocks:** M-B, Wave DC (E4/E5 consume the `knowledge-call` line)

**References (read BEFORE writing code):**
- `docs/demo/specs/00-master-demo-plan.md` — §3 G2/G5/G9/G10, §4 interface table (signatures, log-event field list, magic strings), §5 D1/D3/D4/D11, §8 test rules (KF-1)
- `docs/demo/specs/03-knowledge-tool-and-model-config.md` — R6–R14, A5–A11; acceptance text is normative. Read the §1 rename table in the master plan first: Spec 03's "Demo Spec 02 (persona)" references mean Demo Spec 01.
- `src/mcp-server.ts` — post-DA2 shape; the per-request `buildMcpServer()` call inside the POST handler (pre-DA2 anchor: `src/mcp-server.ts:45`) and the `// FR-5:` comment (pre-DA2 anchor `:37`; locate by comment text, DA2 shifts lines)
- `src/tools.ts:39-55` — `runTool`'s 5000 ms transport cap (`:42`), `isError → {"error": <joined text>}` conversion (`:43-49`), success passthrough (`:50`). UNCHANGED — relied upon, never edited.
- `src/logger.ts:46-47` (`ms`, `now` — monotonic, 1-decimal), `:63-66` (`logEvent`), `:7-14` (`LogFields`)
- `src/config.ts` — `AppConfig` with the three `mcpModelId`/`mcpModelMaxTokens`/`mcpToolTimeoutMs` fields landed by plan 03-knowledge/01
- `src/server.ts:74-76` — the `await mcpRoutes(app);` call site
- `test/gateway.session-config.test.ts:7-11` — the suite's minimal `BASE` env-object pattern (READ ONLY — G4: never edit this file)

## Files

**Create:** `src/knowledge.ts`, `test/knowledge.test.ts`
**Modify:** `src/mcp-server.ts` (signatures + one `registerTool` call + imports), `src/server.ts` (line 75 ONLY), `test/mcp-server.test.ts` (call-site arity only), `test/tools.test.ts` (call-site arity only)
**Do NOT touch:** `src/config.ts`, `.env.example`, `package.json`, `package-lock.json` (owned by 03-knowledge/01), `src/gateway.ts`, `test/gateway.session-config.test.ts` (DB2's files, G4), `src/tools.ts`, `src/corpus.ts`, and everything in G9's frozen list.

## Interfaces

**Consumes:**
- `AppConfig`/`loadConfig` from `src/config.ts` incl. `mcpModelId`, `mcpModelMaxTokens`, `mcpToolTimeoutMs` (03-knowledge/01)
- `CSUB_CORPUS: string` from `./corpus.js` (DA1; master plan D1 — the export is named `CSUB_CORPUS`, alias locally as `const CORPUS = CSUB_CORPUS` where Spec 03 snippets say `CORPUS`)
- `logEvent`, `now`, `ms`, `LogFields` from `./logger.js`
- `runTool` contract `src/tools.ts:42-54` (unchanged)
- `ai@7.0.31` (`generateObject`) and `@ai-sdk/gateway@4.0.23` (`createGateway`) — `src/knowledge.ts` is the ONLY module in the repo importing from `'ai'`
- `zod@3.25.76`

**Produces** (exact names — master plan §4 interface table):
- `src/mcp-server.ts`: `export interface BuildMcpServerDeps { knowledgeGenerate?: KnowledgeGenerateFn }`, `export function buildMcpServer(cfg: AppConfig, deps?: BuildMcpServerDeps): McpServer`, `export async function mcpRoutes(app: FastifyInstance, cfg: AppConfig, deps?: BuildMcpServerDeps): Promise<void>` — plus the existing DA2 exports unchanged
- `src/knowledge.ts`: `KNOWLEDGE_TOPICS`, `KNOWLEDGE_ENVELOPE_SCHEMA`, `KnowledgeEnvelope`, `NOT_FOUND_SENTINEL = 'NOT_FOUND'`, `NOT_FOUND_SPOKEN`, `KNOWLEDGE_ERROR_SPOKEN`, `buildKnowledgeSystemPrompt`, `askCampusKnowledge`, `makeGatewayGenerate`, `KnowledgeGenerateFn` (+ `KnowledgeGenerateArgs`, `KnowledgeGenerateResult`)
- Tool `ask_campus_knowledge(question: string, topic?: KNOWLEDGE_TOPICS[number])` — the seventh and final tool
- Log event `knowledge-call` with flat fields `status`, `topic?`, `questionChars`, `answerChars`, `knowledgeMs`, `inputTokens?`, `outputTokens?`, `cachedInputTokens?`, `reasoningTokens?`, `modelId`, `errName?` (Spec 03 R12; master D2/D11 — event name is exactly `knowledge-call`)

## Steps

### Preflight

- [ ] Read every Reference. Confirm prerequisites landed: `src/config.ts` has `mcpToolTimeoutMs` (03-knowledge/01), `package.json` has `"ai": "7.0.31"`, `src/corpus.ts` exports `CSUB_CORPUS` (DA1), `src/mcp-server.ts` registers the six static tools with `// FR-5:` as the last line of the tool block and server identity `{ name: 'rio-demo', version: '1.0.0' }` (DA2). If any is missing, STOP and report BLOCKED — do not implement prerequisites yourself.
- [ ] Run `npx vitest run` once to record the pre-task green count (baseline 356 + Wave DA + 03-knowledge/01 additions; apply the KF-1 flake rule from master plan §8 R8.2 if only the two `test/harness.test.ts` barge-in tests fail: re-run `npx vitest run test/harness.test.ts` — green in isolation passes).

### Part 1 — `src/knowledge.ts` core (unit level, injected fakes)

- [ ] Write `test/knowledge.test.ts` — unit sections only for now. Shared fixtures: `const BASE = { AI_GATEWAY_API_KEY: 'vck_test', TWILIO_AUTH_TOKEN: 'tok_test', PUBLIC_HOST: 'example.ngrok.app' }` (the `test/gateway.session-config.test.ts:7-11` pattern); `cfg = loadConfig({ ...BASE })`; a log fake `const lines: LogFields[] = []; const log = (f: LogFields) => lines.push(f)`; fake generates built per test. Call `askCampusKnowledge({ question, topic? }, { cfg, corpus: FIXTURE_CORPUS, generate: fake, signal: new AbortController().signal, log })` directly (`FIXTURE_CORPUS` is a short local string — the injection seam makes unit tests corpus-independent). Tests:
  1. `buildKnowledgeSystemPrompt` — returns the Spec 03 R10 template verbatim with the corpus substituted inside `<documents>...</documents>`, no `{CORPUS}` placeholder remaining; contains the exact line fragment `set response_text to exactly: NOT_FOUND`; byte-identical across two calls with the same corpus (cache-stability, R10).
  2. **A5 (unit) happy path** — fake resolves `{ object: { status: 'ok', response_text: 'The Runner Rundown fee is $150 for freshmen.' } }` → return value has NO `isError`, and `JSON.parse(result.content[0].text)` deep-equals that envelope. The fake received: `system` containing `FIXTURE_CORPUS` and ending with `</documents>`, `prompt === 'Question: ' + question`, `maxOutputTokens === 150`, `abortSignal instanceof AbortSignal`.
  3. **A6 normalization** (`it.each` over the five Spec 03 A6 fakes: `{status:'ok',response_text:'NOT_FOUND'}`, `{status:'ok',response_text:'NOT_FOUND — nothing in the docs.'}`, `{status:'not_found',response_text:'anything'}`, `{status:'error',response_text:'x'}`, `{status:'ok',response_text:'   '}`) → every result envelope deep-equals `{ status: 'not_found', response_text: NOT_FOUND_SPOKEN }`, no `isError`, and the literal `NOT_FOUND` never appears in the returned `response_text`.
  4. Malformed object — fake resolves `{ object: { garbage: true } }` → the R9.3 safeParse failure takes the catch path: `isError: true`, text parses to `{ status: 'error', response_text: KNOWLEDGE_ERROR_SPOKEN }`.
  5. **A7(a) error path** — fake rejects `new Error('boom')` → `isError: true` + the same error envelope; the captured log line has `status: 'error'` and `errName: 'Error'`. Never rejects/throws.
  6. **A7(b) timeout composition** — `cfg50 = loadConfig({ ...BASE, MCP_TOOL_TIMEOUT_MS: '50' })` and an abort-honoring never-resolving fake (exact helper — an implementer gets this wrong otherwise):
     ```ts
     const hangingFake: KnowledgeGenerateFn = ({ abortSignal }) =>
       new Promise((_, reject) =>
         abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true }));
     ```
     → error envelope within ~150 ms (assert elapsed `performance.now()` delta < 150), `errName: 'TimeoutError'` on the log line (the `AbortSignal.timeout` reason is a DOMException named `TimeoutError` — distinguishes budget expiry from client cancellation).
  7. **A8 abort composition** — fake records its received `abortSignal` then resolves an ok envelope; call again with a manual `AbortController`'s signal as `deps.signal`, using the hanging fake, and `controller.abort()` after 10 ms → the recorded/received signal aborts (proves `AbortSignal.any([deps.signal, timeout])` composes BOTH inputs), error envelope with `errName: 'AbortError'`.
  8. **A11 instrumentation** — exactly ONE `event: 'knowledge-call'` line per invocation (happy, not_found, and error paths each); fields: `status` matches the returned envelope status, `questionChars`/`answerChars` are the correct lengths, `knowledgeMs` is a number with ≤ 1 decimal; with the fake supplying `usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 }` those exact values appear FLAT at top level; `topic: 'financial_aid'` passed in args appears on the line; `modelId === cfg.mcpModelId`; error-path lines carry `errName`.
- [ ] Run `npx vitest run test/knowledge.test.ts` → expect FAIL: `Cannot find module '../src/knowledge.js'` (or equivalent resolution error).
- [ ] Implement `src/knowledge.ts` per Demo Spec 03 **R8** (envelope consts — the four exported strings/schema are specified verbatim in R8; copy them exactly), **R9** (the six-step handler flow — signatures, `AbortSignal.any([deps.signal, AbortSignal.timeout(deps.cfg.mcpToolTimeoutMs)])`, `t0`/`t1` via `now()` from `./logger.js`, safeParse, the normalization order, the catch-everything error return — all specified verbatim in R9), **R10** (the grounding-prompt template — copy the R10 text exactly, `{CORPUS}` substituted; user prompt `` `Question: ${question}` ``). Design notes the spec leaves implicit:
  - Import `{ CSUB_CORPUS } from './corpus.js'` (master D1) and compute `const SYSTEM = buildKnowledgeSystemPrompt(CSUB_CORPUS)` once at module scope (G5/R10). Inside the handler select `deps.corpus === CSUB_CORPUS ? SYSTEM : buildKnowledgeSystemPrompt(deps.corpus)` — production never rebuilds per call, unit tests can inject tiny fixtures, and there is no module-level mutable state (G5 forbids a memo cache).
  - `KNOWLEDGE_TOPICS = ['directory_hours', 'financial_aid', 'registration', 'orientation', 'it_help', 'parking', 'events', 'other'] as const` (Spec 03 R7 / master §4 — identical to the corpus topic-tag vocabulary).
  - Emit the R12 log line on EVERY path, including before the catch-path return; omit undefined usage fields (the logger already drops undefined); log lengths, never raw question/answer text.
  - The handler never branches on `topic` — it is log metadata only (R7).
- [ ] Run `npx vitest run test/knowledge.test.ts` → expect PASS. Run `npx tsc --noEmit` → clean.
- [ ] Commit:
  ```
  feat(knowledge): askCampusKnowledge handler, envelope, grounding prompt (Demo Spec 03 R8-R10, R12)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Part 2 — `makeGatewayGenerate` (mocked `ai`, A10)

- [ ] Add a `makeGatewayGenerate` describe block to `test/knowledge.test.ts`. At the top of the file add `vi.mock('ai', ...)` (hoisted; harmless to Part 1 — those tests use injected fakes and never reach `generateObject`) exposing a `generateObject` spy that resolves `{ object: { status: 'ok', response_text: 'x' }, usage: {} }`, and `vi.mock('@ai-sdk/gateway', ...)` exposing a `createGateway` spy that records its options and returns a function `(id: string) => ({ mockModelId: id })`. Tests:
  9. **A10 options** — `await makeGatewayGenerate(cfg)({ system: 's', prompt: 'p', maxOutputTokens: cfg.mcpModelMaxTokens, abortSignal: new AbortController().signal })` → the mocked `generateObject` was called exactly once with: `schema: KNOWLEDGE_ENVELOPE_SCHEMA` (same reference), `maxRetries: 0`, `maxOutputTokens: cfg.mcpModelMaxTokens`, `providerOptions` deep-equal to `{ google: { thinkingConfig: { thinkingLevel: 'minimal' } } }`, `system`/`prompt`/`abortSignal` passed through, and `model` deep-equal `{ mockModelId: cfg.mcpModelId }`. No network I/O occurs.
  10. `createGateway` was called with `{ apiKey: cfg.aiGatewayApiKey }` (explicit key — no ambient-env reliance, Spec 03 R11).
- [ ] Run `npx vitest run test/knowledge.test.ts` → expect the two new tests FAIL (`makeGatewayGenerate` not exported).
- [ ] Implement `makeGatewayGenerate` in `src/knowledge.ts` per Demo Spec 03 **R11** — the full function body is specified verbatim there (imports `generateObject` from `'ai'`, `createGateway` from `'@ai-sdk/gateway'`; `maxRetries: 0`; `providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } }`; no `providerOptions.gateway.models` — G2; no streaming). If `ai@7.0.31`'s `generateObject` result exposes usage under different field names than R9's `KnowledgeGenerateResult` (master D11 allows cosmetic drift), contain the mapping entirely inside `makeGatewayGenerate` and note it in the completion report.
- [ ] Run `npx vitest run test/knowledge.test.ts` → expect PASS. Run `npx tsc --noEmit` → clean.
- [ ] Commit:
  ```
  feat(knowledge): makeGatewayGenerate gateway wrapper, minimal-thinking pin (Demo Spec 03 R11)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

### Part 3 — signature change + registration + call sites (master D3)

- [ ] Add an integration describe block to `test/knowledge.test.ts`: boot `Fastify({ logger: false })`, `await mcpRoutes(app, cfg, { knowledgeGenerate: fake })`, listen on port 0, `createMcpClient(port)` from `../src/tools.js` (mirror the `test/tools.test.ts:12-26` beforeAll/afterAll pattern). Tests:
  11. **D4 exact-seven pin** — `tools/list` names sorted deep-equal `['ask_campus_knowledge', 'escalate_to_human', 'get_current_time', 'reset_password', 'route_call', 'send_sms', 'verify_identity']` (master plan D4: this server-side exact-list assertion lives HERE so DA2's containment test stands untouched).
  12. **A9 tool definition** — `fetchToolDefs(client)` includes `ask_campus_knowledge` with `parameters.properties.question.type === 'string'`, `parameters.required` containing `'question'` and NOT `'topic'`, `parameters.properties.topic.enum` deep-equal to the `KNOWLEDGE_TOPICS` list, and no `$schema` key anywhere in the def.
  13. **A5 end-to-end** — with the fake resolving the Runner-Rundown envelope, `await runTool(client, 'ask_campus_knowledge', JSON.stringify({ question: 'How much is the Runner Rundown fee?' }))` → parse result → no `error` key, `JSON.parse(parsed.content[0].text)` deep-equals the envelope; the fake's captured `system` contains the byte-exact corpus banner line `# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA` (em dash — proves the REAL `CSUB_CORPUS` flows through registration).
  14. **A7(c) apology-path shape** — with a rejecting fake, the `runTool` return string parses to `{ error: <string> }` whose value contains `status":"error` — exactly what triggers the existing spoken-apology conversion at `src/tools.ts:43-49`; no test rejects.
- [ ] Run `npx vitest run test/knowledge.test.ts` → expect the integration tests FAIL (current two-arg-less `mcpRoutes` ignores `cfg`/`deps`; `ask_campus_knowledge` unknown → exact-seven mismatch and `Tool ask_campus_knowledge not found`).
- [ ] Modify `src/mcp-server.ts` per Demo Spec 03 **R6** and **R7**:
  - Signatures exactly as in R6: `export interface BuildMcpServerDeps { knowledgeGenerate?: KnowledgeGenerateFn }`; `buildMcpServer(cfg: AppConfig, deps?: BuildMcpServerDeps)`; `mcpRoutes(app: FastifyInstance, cfg: AppConfig, deps?: BuildMcpServerDeps)`. `mcpRoutes` passes `cfg`/`deps` into the per-request `buildMcpServer(cfg, deps)` call inside the POST handler (pre-DA2 anchor `src/mcp-server.ts:45`). Config is received, never re-parsed from `process.env` per request.
  - One `registerTool('ask_campus_knowledge', ...)` call inserted at the `// FR-5:` comment (last line of the tool block) — the registration object and handler wiring are specified verbatim in R7 (description text, zod RAW-shape `inputSchema` with `question`/`topic`, handler delegating to `askCampusKnowledge` with `{ cfg, corpus: CORPUS, generate: deps?.knowledgeGenerate ?? makeGatewayGenerate(cfg), signal: extra.signal, log: logEvent }`). Add `import { CSUB_CORPUS } from './corpus.js'; const CORPUS = CSUB_CORPUS;` at module scope (D1) and the `./knowledge.js` imports. The `// FR-5:` comment itself stays, now above the new registration or reworded per DA2's layout — it must remain the recognizable extension-point marker.
  - Do NOT construct `makeGatewayGenerate(cfg)` at module scope — the `deps?.knowledgeGenerate ?? makeGatewayGenerate(cfg)` expression per R7 runs inside the registration closure; no module-level mutable state (G5).
- [ ] Update ALL call sites (master D3 — this task owns every one):
  - `src/server.ts:75`: `await mcpRoutes(app);` → `await mcpRoutes(app, config);` — this ONE line and nothing else in the file (G9; leave the line-74 comment as-is).
  - `test/mcp-server.test.ts` (pre-DA2 anchor `:10`) and `test/tools.test.ts` (pre-DA2 anchors `:14`, `:110`) — DA2 may have shifted lines; update EVERY `mcpRoutes(app` / `mcpRoutes(app2` occurrence in both files to `mcpRoutes(app, loadConfig({ ...BASE }))`, adding `import { loadConfig } from '../src/config.js';` and the three-key `BASE` const (same object as Part 1) where absent. Arity-only edits — change no assertion in either file. These tests never invoke `ask_campus_knowledge`, so `makeGatewayGenerate` is never called and no socket to the gateway ever opens (Spec 03 R14).
- [ ] Run `npx vitest run test/knowledge.test.ts test/mcp-server.test.ts test/tools.test.ts` → expect PASS (all three files). Run `npx tsc --noEmit` → clean (catches any missed call site).
- [ ] Commit:
  ```
  feat(mcp): buildMcpServer(cfg, deps?) signature + ask_campus_knowledge registration (Demo Spec 03 R6-R7, master D3/D4)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

## Verify

- [ ] `npx vitest run` → zero failures beyond the KF-1 allowance (baseline 356 + all demo tests added by earlier waves + this task's additions — master plan §8/D14; record the actual total for the ledger). If ONLY the two `test/harness.test.ts` barge-in tests fail, re-run `npx vitest run test/harness.test.ts` — green in isolation = pass, note it.
- [ ] `npx tsc --noEmit` → clean.
- [ ] Targeted: `npx vitest run test/knowledge.test.ts` → all ≥ 14 tests pass, no skips.
- [ ] Grep gates (Spec 03 A3 / master A2, run from repo root):
  - `grep -rE "FALLBACK_MODEL|MCP_FALLBACK|gateway.*models\s*:" src/` → zero hits (G2).
  - `grep -rln "from 'ai'" src/` → exactly `src/knowledge.ts`.
  - `grep -rn "CSUB_CORPUS" src/` → hits only in `src/corpus.ts`, `src/knowledge.ts`, `src/mcp-server.ts`.
  - `grep -c "knowledge-tool" src/knowledge.ts` → 0 (event name is `knowledge-call`, master D2).
- [ ] `git diff --stat` over this task's commits touches ONLY: `src/knowledge.ts`, `src/mcp-server.ts`, `src/server.ts`, `test/knowledge.test.ts`, `test/mcp-server.test.ts`, `test/tools.test.ts` — and the `src/server.ts` diff is exactly one line (G9/G14).
- [ ] Confirm `test/gateway.session-config.test.ts` is untouched and its two preamble assertions (`:100-102`, `:124-128`) still pass in the full run (G4, master R8.5).

## Completion Report

```
Task: DB1.2 — ask_campus_knowledge handler + buildMcpServer(cfg, deps?) signature
Status: <complete | blocked: reason>
Files changed: <list>
Commands run: <cmd → outcome, one line each>
Spec 03 acceptance verified: A5 <p/f> A6 <p/f> A7 <p/f> A8 <p/f> A9 <p/f> A10 <p/f> A11 <p/f> A12(full suite) <p/f>; master D4 exact-seven <p/f>
Full-suite count: <n passed> (KF-1 invoked: <yes/no>)
Deviations from plan: <none | list — e.g. D11 usage-field-name mapping inside makeGatewayGenerate>
New interfaces exposed: buildMcpServer(cfg, deps?), mcpRoutes(app, cfg, deps?), BuildMcpServerDeps, src/knowledge.ts exports per plan Interfaces
Notes for ledger: <≤3 lines>
```

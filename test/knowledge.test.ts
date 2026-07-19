import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { loadConfig } from '../src/config.js';
import type { LogFields } from '../src/logger.js';
import {
  buildKnowledgeSystemPrompt,
  askCampusKnowledge,
  NOT_FOUND_SENTINEL,
  NOT_FOUND_SPOKEN,
  KNOWLEDGE_ERROR_SPOKEN,
  KNOWLEDGE_ENVELOPE_SCHEMA,
  KNOWLEDGE_TOPICS,
  type KnowledgeGenerateFn,
} from '../src/knowledge.js';

// Hoisted — harmless to the Part 1 tests above, which use injected fakes and never reach
// generateObject. Spies record their call options for the makeGatewayGenerate assertions below;
// both mocks resolve/return locally, so no test ever opens a socket to the gateway (G10).
const generateObjectMock = vi.fn(async () => ({ object: { status: 'ok', response_text: 'x' }, usage: {} }));
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...(args as [unknown])),
}));

const createGatewayMock = vi.fn((_opts: unknown) => (id: string) => ({ mockModelId: id }));
vi.mock('@ai-sdk/gateway', () => ({
  createGateway: (...args: unknown[]) => createGatewayMock(...(args as [unknown])),
}));

const BASE = {
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
};

const FIXTURE_CORPUS = 'FIXTURE CORPUS: The Runner Rundown fee is $150 for freshmen.';

const cfg = loadConfig({ ...BASE });

function makeLog(): { lines: LogFields[]; log: (f: LogFields) => void } {
  const lines: LogFields[] = [];
  return { lines, log: (f: LogFields) => lines.push(f) };
}

describe('buildKnowledgeSystemPrompt', () => {
  it('returns the R10 template verbatim with the corpus substituted, no {CORPUS} left, cache-stable', () => {
    const s1 = buildKnowledgeSystemPrompt(FIXTURE_CORPUS);
    const s2 = buildKnowledgeSystemPrompt(FIXTURE_CORPUS);
    expect(s1).toContain(FIXTURE_CORPUS);
    expect(s1).not.toContain('{CORPUS}');
    expect(s1).toContain('set response_text to exactly: NOT_FOUND');
    expect(s1).toContain('<documents>');
    expect(s1.trim().endsWith('</documents>')).toBe(true);
    expect(s1).toBe(s2); // byte-identical across calls with the same corpus
  });
});

describe('askCampusKnowledge — unit (injected fakes, no network)', () => {
  it('A5 happy path — returns the envelope verbatim, no isError, correct generate call shape', async () => {
    const question = 'How much is the Runner Rundown fee?';
    let received: Parameters<KnowledgeGenerateFn>[0] | undefined;
    const fake: KnowledgeGenerateFn = async (args) => {
      received = args;
      return { object: { status: 'ok', response_text: 'The Runner Rundown fee is $150 for freshmen.' } };
    };
    const { log } = makeLog();

    const result = await askCampusKnowledge(
      { question },
      { cfg, corpus: FIXTURE_CORPUS, generate: fake, signal: new AbortController().signal, log },
    );

    expect(result.isError).toBe(undefined);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      status: 'ok',
      response_text: 'The Runner Rundown fee is $150 for freshmen.',
    });

    expect(received).toBeTruthy();
    expect(received!.system).toContain(FIXTURE_CORPUS);
    expect(received!.system.endsWith('</documents>')).toBe(true);
    expect(received!.prompt).toBe(`Question: ${question}`);
    expect(received!.maxOutputTokens).toBe(150);
    expect(received!.abortSignal instanceof AbortSignal).toBe(true);
  });

  it.each([
    { status: 'ok', response_text: 'NOT_FOUND' },
    { status: 'ok', response_text: 'NOT_FOUND — nothing in the docs.' },
    { status: 'not_found', response_text: 'anything' },
    { status: 'error', response_text: 'x' },
    { status: 'ok', response_text: '   ' },
  ])('A6 normalization — %o collapses to the canned not_found envelope', async (fakeObject) => {
    const fake: KnowledgeGenerateFn = async () => ({ object: fakeObject });
    const { log } = makeLog();

    const result = await askCampusKnowledge(
      { question: 'anything' },
      { cfg, corpus: FIXTURE_CORPUS, generate: fake, signal: new AbortController().signal, log },
    );

    expect(result.isError).toBe(undefined);
    const envelope = JSON.parse(result.content[0]!.text);
    expect(envelope).toEqual({ status: 'not_found', response_text: NOT_FOUND_SPOKEN });
    expect(envelope.response_text).not.toContain(NOT_FOUND_SENTINEL);
  });

  it('malformed object — safeParse failure takes the catch path', async () => {
    const fake: KnowledgeGenerateFn = async () => ({ object: { garbage: true } });
    const { log } = makeLog();

    const result = await askCampusKnowledge(
      { question: 'q' },
      { cfg, corpus: FIXTURE_CORPUS, generate: fake, signal: new AbortController().signal, log },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      status: 'error',
      response_text: KNOWLEDGE_ERROR_SPOKEN,
    });
  });

  it('A7(a) error path — rejecting fake never throws out of the handler', async () => {
    const fake: KnowledgeGenerateFn = async () => {
      throw new Error('boom');
    };
    const { lines, log } = makeLog();

    const result = await askCampusKnowledge(
      { question: 'q' },
      { cfg, corpus: FIXTURE_CORPUS, generate: fake, signal: new AbortController().signal, log },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      status: 'error',
      response_text: KNOWLEDGE_ERROR_SPOKEN,
    });
    const line = lines.find((l) => l.event === 'knowledge-call');
    expect(line).toBeTruthy();
    expect(line!.status).toBe('error');
    expect(line!.errName).toBe('Error');
  });

  it('A7(b) timeout composition — errors within ~150ms with errName TimeoutError', async () => {
    const cfg50 = loadConfig({ ...BASE, MCP_TOOL_TIMEOUT_MS: '50' });
    const hangingFake: KnowledgeGenerateFn = ({ abortSignal }) =>
      new Promise((_, reject) =>
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true }),
      );
    const { lines, log } = makeLog();

    const t0 = performance.now();
    const result = await askCampusKnowledge(
      { question: 'q' },
      { cfg: cfg50, corpus: FIXTURE_CORPUS, generate: hangingFake, signal: new AbortController().signal, log },
    );
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(150);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      status: 'error',
      response_text: KNOWLEDGE_ERROR_SPOKEN,
    });
    const line = lines.find((l) => l.event === 'knowledge-call');
    expect(line!.errName).toBe('TimeoutError');
  });

  it('A8 abort composition — AbortSignal.any composes BOTH the deps.signal and the timeout', async () => {
    let recordedSignal: AbortSignal | undefined;
    const recordingFake: KnowledgeGenerateFn = async ({ abortSignal }) => {
      recordedSignal = abortSignal;
      return { object: { status: 'ok', response_text: 'x' } };
    };
    const rawSignal = new AbortController().signal;
    const { log: log1 } = makeLog();
    await askCampusKnowledge(
      { question: 'q' },
      { cfg, corpus: FIXTURE_CORPUS, generate: recordingFake, signal: rawSignal, log: log1 },
    );
    expect(recordedSignal instanceof AbortSignal).toBe(true);
    expect(recordedSignal).not.toBe(rawSignal); // proves composition, not passthrough

    const hangingFake: KnowledgeGenerateFn = ({ abortSignal }) =>
      new Promise((_, reject) =>
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true }),
      );
    const controller = new AbortController();
    const { lines, log } = makeLog();
    const promise = askCampusKnowledge(
      { question: 'q' },
      { cfg, corpus: FIXTURE_CORPUS, generate: hangingFake, signal: controller.signal, log },
    );
    setTimeout(() => controller.abort(), 10);
    const result = await promise;

    expect(result.isError).toBe(true);
    const line = lines.find((l) => l.event === 'knowledge-call');
    expect(line!.errName).toBe('AbortError');
  });

  it('A11 instrumentation — exactly one knowledge-call line per invocation, fields correct', async () => {
    const question = 'How much is the Runner Rundown fee?';
    const answer = 'The Runner Rundown fee is $150 for freshmen.';

    // happy path
    {
      const fake: KnowledgeGenerateFn = async () => ({
        object: { status: 'ok', response_text: answer },
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
      });
      const { lines, log } = makeLog();
      await askCampusKnowledge(
        { question, topic: 'financial_aid' },
        { cfg, corpus: FIXTURE_CORPUS, generate: fake, signal: new AbortController().signal, log },
      );
      const knowledgeLines = lines.filter((l) => l.event === 'knowledge-call');
      expect(knowledgeLines.length).toBe(1);
      const line = knowledgeLines[0]!;
      expect(line.status).toBe('ok');
      expect(line.topic).toBe('financial_aid');
      expect(line.questionChars).toBe(question.length);
      expect(line.answerChars).toBe(answer.length);
      expect(typeof line.knowledgeMs).toBe('number');
      expect(Number(((line.knowledgeMs as number) * 10).toFixed(0)) % 1).toBe(0); // <= 1 decimal
      expect(line.inputTokens).toBe(100);
      expect(line.outputTokens).toBe(20);
      expect(line.cachedInputTokens).toBe(80);
      expect(line.modelId).toBe(cfg.mcpModelId);
    }

    // not_found path
    {
      const fake: KnowledgeGenerateFn = async () => ({ object: { status: 'not_found', response_text: 'anything' } });
      const { lines, log } = makeLog();
      await askCampusKnowledge(
        { question },
        { cfg, corpus: FIXTURE_CORPUS, generate: fake, signal: new AbortController().signal, log },
      );
      const knowledgeLines = lines.filter((l) => l.event === 'knowledge-call');
      expect(knowledgeLines.length).toBe(1);
      expect(knowledgeLines[0]!.status).toBe('not_found');
    }

    // error path
    {
      const fake: KnowledgeGenerateFn = async () => {
        throw new Error('boom');
      };
      const { lines, log } = makeLog();
      await askCampusKnowledge(
        { question },
        { cfg, corpus: FIXTURE_CORPUS, generate: fake, signal: new AbortController().signal, log },
      );
      const knowledgeLines = lines.filter((l) => l.event === 'knowledge-call');
      expect(knowledgeLines.length).toBe(1);
      expect(knowledgeLines[0]!.status).toBe('error');
      expect(knowledgeLines[0]!.errName).toBe('Error');
    }
  });
});

describe('makeGatewayGenerate (mocked ai / @ai-sdk/gateway — no network, A10)', () => {
  it('A10 options — calls the mocked generateObject with the exact wrapper options', async () => {
    generateObjectMock.mockClear();
    createGatewayMock.mockClear();
    const { makeGatewayGenerate } = await import('../src/knowledge.js');

    const abortSignal = new AbortController().signal;
    const result = await makeGatewayGenerate(cfg)({
      system: 's',
      prompt: 'p',
      maxOutputTokens: cfg.mcpModelMaxTokens,
      abortSignal,
    });

    expect(result.object).toEqual({ status: 'ok', response_text: 'x' });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const call = generateObjectMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.schema).toBe(KNOWLEDGE_ENVELOPE_SCHEMA);
    expect(call.maxRetries).toBe(0);
    expect(call.maxOutputTokens).toBe(cfg.mcpModelMaxTokens);
    expect(call.providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: 'minimal' } } });
    expect(call.system).toBe('s');
    expect(call.prompt).toBe('p');
    expect(call.abortSignal).toBe(abortSignal);
    expect(call.model).toEqual({ mockModelId: cfg.mcpModelId });
  });

  it('createGateway was called with the explicit apiKey — no ambient-env reliance (R11)', async () => {
    createGatewayMock.mockClear();
    const { makeGatewayGenerate } = await import('../src/knowledge.js');
    makeGatewayGenerate(cfg);
    expect(createGatewayMock).toHaveBeenCalledWith({ apiKey: cfg.aiGatewayApiKey });
  });
});

describe('ask_campus_knowledge — registered tool, end-to-end via mcpRoutes + runTool', () => {
  it('D4: tools/list returns exactly the seven frozen tool names', async () => {
    const { mcpRoutes } = await import('../src/mcp-server.js');
    const { createMcpClient, closeMcpClient, fetchToolDefs } = await import('../src/tools.js');
    const app2 = Fastify({ logger: false });
    const fake: KnowledgeGenerateFn = async () => ({ object: { status: 'ok', response_text: 'x' } });
    await mcpRoutes(app2, cfg, { knowledgeGenerate: fake });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const address = app2.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
    const client = await createMcpClient(address.port);

    const defs = await fetchToolDefs(client);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        'ask_campus_knowledge',
        'escalate_to_human',
        'get_current_time',
        'reset_password',
        'route_call',
        'send_sms',
        'verify_identity',
      ].sort(),
    );

    await closeMcpClient(client);
    await app2.close();
  });

  it('A9: ask_campus_knowledge tool definition shape', async () => {
    const { mcpRoutes } = await import('../src/mcp-server.js');
    const { createMcpClient, closeMcpClient, fetchToolDefs } = await import('../src/tools.js');
    const app2 = Fastify({ logger: false });
    const fake: KnowledgeGenerateFn = async () => ({ object: { status: 'ok', response_text: 'x' } });
    await mcpRoutes(app2, cfg, { knowledgeGenerate: fake });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const address = app2.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
    const client = await createMcpClient(address.port);

    const defs = await fetchToolDefs(client);
    const def = defs.find((d) => d.name === 'ask_campus_knowledge');
    expect(def).toBeTruthy();
    const params = def!.parameters as {
      properties: Record<string, { type?: string; enum?: string[] }>;
      required?: string[];
    };
    expect(params.properties.question!.type).toBe('string');
    expect(params.required).toContain('question');
    expect(params.required).not.toContain('topic');
    expect(params.properties.topic!.enum).toEqual([...KNOWLEDGE_TOPICS]);
    expect(JSON.stringify(def)).not.toContain('$schema');

    await closeMcpClient(client);
    await app2.close();
  });

  it('A5 end-to-end: real CSUB_CORPUS flows through registration; envelope round-trips via runTool', async () => {
    const { mcpRoutes } = await import('../src/mcp-server.js');
    const { createMcpClient, closeMcpClient, runTool } = await import('../src/tools.js');
    const app2 = Fastify({ logger: false });
    let receivedSystem = '';
    const fake: KnowledgeGenerateFn = async ({ system }) => {
      receivedSystem = system;
      return { object: { status: 'ok', response_text: 'The Runner Rundown fee is $150 for freshmen.' } };
    };
    await mcpRoutes(app2, cfg, { knowledgeGenerate: fake });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const address = app2.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
    const client = await createMcpClient(address.port);

    const result = await runTool(
      client,
      'ask_campus_knowledge',
      JSON.stringify({ question: 'How much is the Runner Rundown fee?' }),
    );
    const parsed = JSON.parse(result) as { error?: string; content: Array<{ text: string }> };
    expect(parsed.error).toBe(undefined);
    const envelope = JSON.parse(parsed.content[0]!.text);
    expect(envelope).toEqual({ status: 'ok', response_text: 'The Runner Rundown fee is $150 for freshmen.' });
    expect(receivedSystem).toContain('# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA');

    await closeMcpClient(client);
    await app2.close();
  });

  it('A7(c): rejecting fake surfaces as {error} whose value contains status":"error — the apology-path shape', async () => {
    const { mcpRoutes } = await import('../src/mcp-server.js');
    const { createMcpClient, closeMcpClient, runTool } = await import('../src/tools.js');
    const app3 = Fastify({ logger: false });
    const fake: KnowledgeGenerateFn = async () => {
      throw new Error('boom');
    };
    await mcpRoutes(app3, cfg, { knowledgeGenerate: fake });
    await app3.listen({ port: 0, host: '127.0.0.1' });
    const address = app3.server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
    const client = await createMcpClient(address.port);

    const result = await runTool(client, 'ask_campus_knowledge', JSON.stringify({ question: 'q' }));
    const parsed = JSON.parse(result) as { error: string };
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error).toContain('status":"error');

    await closeMcpClient(client);
    await app3.close();
  });
});

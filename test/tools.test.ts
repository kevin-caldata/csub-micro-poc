import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpRoutes, VERIFICATION_TOKEN_REGEX } from '../src/mcp-server.js';
import { createMcpClient, closeMcpClient, fetchToolDefs, runTool } from '../src/tools.js';
import { loadConfig } from '../src/config.js';

const BASE = {
  AI_GATEWAY_API_KEY: 'vck_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  PUBLIC_HOST: 'example.ngrok.app',
};

expect(globalThis.window).toBe(undefined); // G6 guard — plain node environment, never jsdom

let app: FastifyInstance;
let client: Client;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await mcpRoutes(app, loadConfig({ ...BASE }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  client = await createMcpClient(address.port);
});

afterAll(async () => {
  await closeMcpClient(client);
  await app.close();
});

describe('fetchToolDefs', () => {
  it('A4: createMcpClient connects without throwing (stateless server — no session id asserted)', () => {
    expect(client).toBeTruthy();
  });

  it('A4: returns at least 6 defs; every entry has type === "function"', async () => {
    const defs = await fetchToolDefs(client);
    expect(defs.length >= 6).toBeTruthy();
    for (const d of defs) {
      expect(d.type).toBe('function');
    }
  });

  it('A4: contains none of $schema, execution, title, annotations, _meta anywhere', async () => {
    const defs = await fetchToolDefs(client);
    const json = JSON.stringify(defs);
    for (const key of ['$schema', 'execution', 'title', 'annotations', '_meta']) {
      expect(!json.includes(key), `unexpected key "${key}" found in ${json}`).toBeTruthy();
    }
  });

  it('A4: get_current_time.parameters deep-equals {type:"object",properties:{}}', async () => {
    const defs = await fetchToolDefs(client);
    const tool = defs.find((d) => d.name === 'get_current_time');
    expect(tool).toBeTruthy();
    expect(tool.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('A4: verify_identity.parameters.properties.name matches; no required array', async () => {
    const defs = await fetchToolDefs(client);
    const tool = defs.find((d) => d.name === 'verify_identity');
    expect(tool).toBeTruthy();
    const parameters = tool.parameters as { properties: Record<string, unknown>; required?: unknown };
    expect(parameters.properties['name']).toEqual({
      type: 'string',
      description: "The caller's full name as spoken.",
    });
    expect(parameters.required).toBe(undefined);
  });
});

describe('runTool', () => {
  it('bad args (zod validation failure) → resolves with isError message, does not reject', async () => {
    const result = await runTool(client, 'verify_identity', '{"name": 42}');
    const parsed = JSON.parse(result) as { error: string };
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error.startsWith('MCP error -32602: Input validation error:'), parsed.error).toBeTruthy();
  });

  it('unknown tool → resolves with exact "Tool nope not found" message', async () => {
    const result = await runTool(client, 'nope', '{}');
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBe('MCP error -32602: Tool nope not found');
  });

  it('empty-string args guard → treated as {}, success JSON with no error key', async () => {
    const result = await runTool(client, 'get_current_time', '');
    const parsed = JSON.parse(result) as { content: Array<{ text: string }>; error?: string };
    expect(parsed.error).toBe(undefined);
    const payload = JSON.parse(parsed.content[0]!.text) as Record<string, unknown>;
    expect(payload.utc as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.timezone).toBe('America/Los_Angeles');
  });

  it('whitespace-only args guard → treated as {}, success JSON', async () => {
    const result = await runTool(client, 'get_current_time', '   ');
    const parsed = JSON.parse(result) as { content: Array<{ text: string }>; error?: string };
    expect(parsed.error).toBe(undefined);
    const payload = JSON.parse(parsed.content[0]!.text) as Record<string, unknown>;
    expect(payload.utc as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.timezone).toBe('America/Los_Angeles');
  });

  it('"{}" args guard → treated as {}, success JSON', async () => {
    const result = await runTool(client, 'get_current_time', '{}');
    const parsed = JSON.parse(result) as { content: Array<{ text: string }>; error?: string };
    expect(parsed.error).toBe(undefined);
    const payload = JSON.parse(parsed.content[0]!.text) as Record<string, unknown>;
    expect(payload.utc as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.timezone).toBe('America/Los_Angeles');
  });

  it('valid args → success JSON, verified true with a matching verification_token', async () => {
    const result = await runTool(client, 'verify_identity', '{"name":"Ada"}');
    const parsed = JSON.parse(result) as { content: Array<{ text: string }>; error?: string };
    expect(parsed.error).toBe(undefined);
    const payload = JSON.parse(parsed.content[0]!.text) as Record<string, unknown>;
    expect(payload.verified).toBe(true);
    expect(payload.verification_token as string).toMatch(VERIFICATION_TOKEN_REGEX);
  });

  it('transport failure (server closed) → resolves (does not reject) with a non-empty error string', async () => {
    const app2 = Fastify({ logger: false });
    await mcpRoutes(app2, loadConfig({ ...BASE }));
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const address2 = app2.server.address();
    if (address2 === null || typeof address2 === 'string') {
      throw new Error('expected a bound TCP address');
    }
    const client2 = await createMcpClient(address2.port);
    await app2.close();

    const result = await runTool(client2, 'verify_identity', '{}');
    const parsed = JSON.parse(result) as { error: string };
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error.length > 0).toBeTruthy();
  });
});

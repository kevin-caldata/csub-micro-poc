import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpRoutes } from './mcp-server.js';
import { createMcpClient, closeMcpClient, fetchToolDefs, runTool } from './tools.js';

assert.equal(globalThis.window, undefined); // G6 guard — plain node environment, never jsdom

let app: FastifyInstance;
let client: Client;

before(async () => {
  app = Fastify({ logger: false });
  await mcpRoutes(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  client = await createMcpClient(address.port);
});

after(async () => {
  await closeMcpClient(client);
  await app.close();
});

describe('fetchToolDefs', () => {
  it('A4: createMcpClient connects without throwing (stateless server — no session id asserted)', () => {
    assert.ok(client);
  });

  it('A4: returns exactly 2 defs; every entry has type === "function"', async () => {
    const defs = await fetchToolDefs(client);
    assert.equal(defs.length, 2);
    for (const d of defs) {
      assert.equal(d.type, 'function');
    }
  });

  it('A4: contains none of $schema, execution, title, annotations, _meta anywhere', async () => {
    const defs = await fetchToolDefs(client);
    const json = JSON.stringify(defs);
    for (const key of ['$schema', 'execution', 'title', 'annotations', '_meta']) {
      assert.ok(!json.includes(key), `unexpected key "${key}" found in ${json}`);
    }
  });

  it('A4: get_current_time.parameters deep-equals {type:"object",properties:{}}', async () => {
    const defs = await fetchToolDefs(client);
    const tool = defs.find((d) => d.name === 'get_current_time');
    assert.ok(tool);
    assert.deepEqual(tool.parameters, { type: 'object', properties: {} });
  });

  it('A4: hello.parameters.properties.name matches; no required array', async () => {
    const defs = await fetchToolDefs(client);
    const tool = defs.find((d) => d.name === 'hello');
    assert.ok(tool);
    const parameters = tool.parameters as { properties: Record<string, unknown>; required?: unknown };
    assert.deepEqual(parameters.properties['name'], { type: 'string', description: 'Name to greet' });
    assert.equal(parameters.required, undefined);
  });
});

describe('runTool', () => {
  it('bad args (zod validation failure) → resolves with isError message, does not reject', async () => {
    const result = await runTool(client, 'hello', '{"name": 42}');
    const parsed = JSON.parse(result) as { error: string };
    assert.equal(typeof parsed.error, 'string');
    assert.ok(parsed.error.startsWith('MCP error -32602: Input validation error:'), parsed.error);
  });

  it('unknown tool → resolves with exact "Tool nope not found" message', async () => {
    const result = await runTool(client, 'nope', '{}');
    const parsed = JSON.parse(result) as { error: string };
    assert.equal(parsed.error, 'MCP error -32602: Tool nope not found');
  });

  it('empty-string args guard → treated as {}, success JSON with no error key', async () => {
    const result = await runTool(client, 'get_current_time', '');
    const parsed = JSON.parse(result) as { content: Array<{ text: string }>; error?: string };
    assert.equal(parsed.error, undefined);
    assert.match(parsed.content[0]!.text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('whitespace-only args guard → treated as {}, success JSON', async () => {
    const result = await runTool(client, 'get_current_time', '   ');
    const parsed = JSON.parse(result) as { content: Array<{ text: string }>; error?: string };
    assert.equal(parsed.error, undefined);
    assert.match(parsed.content[0]!.text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('"{}" args guard → treated as {}, success JSON', async () => {
    const result = await runTool(client, 'get_current_time', '{}');
    const parsed = JSON.parse(result) as { content: Array<{ text: string }>; error?: string };
    assert.equal(parsed.error, undefined);
    assert.match(parsed.content[0]!.text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('valid args → success JSON, content[0].text === "Hello, Ada!"', async () => {
    const result = await runTool(client, 'hello', '{"name":"Ada"}');
    const parsed = JSON.parse(result) as { content: Array<{ text: string }>; error?: string };
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.content[0]!.text, 'Hello, Ada!');
  });

  it('transport failure (server closed) → resolves (does not reject) with a non-empty error string', async () => {
    const app2 = Fastify({ logger: false });
    await mcpRoutes(app2);
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const address2 = app2.server.address();
    if (address2 === null || typeof address2 === 'string') {
      throw new Error('expected a bound TCP address');
    }
    const client2 = await createMcpClient(address2.port);
    await app2.close();

    const result = await runTool(client2, 'hello', '{}');
    const parsed = JSON.parse(result) as { error: string };
    assert.equal(typeof parsed.error, 'string');
    assert.ok(parsed.error.length > 0);
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpRoutes } from './mcp-server.js';
import { createMcpClient, closeMcpClient, fetchToolDefs } from './tools.js';

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

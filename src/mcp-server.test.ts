import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { mcpRoutes } from './mcp-server.js';

let app: FastifyInstance;
let base: string;

before(async () => {
  app = Fastify({ logger: false });
  await mcpRoutes(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.close();
});

const jsonHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function rpcPost(body: unknown, headers: Record<string, string> = jsonHeaders): Promise<Response> {
  return fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('mcpRoutes — POST /mcp', () => {
  it('A1: tools/list returns 200 application/json with exactly get_current_time and hello', async () => {
    const res = await rpcPost({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /^application\/json/);

    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_current_time', 'hello']);
  });

  it('tools/call hello with a name greets that name', async () => {
    const res = await rpcPost({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'hello', arguments: { name: 'Ada' } },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { content: Array<{ type: string; text: string }> } };
    assert.equal(body.result.content[0]!.text, 'Hello, Ada!');
  });

  it('tools/call get_current_time returns an ISO-8601 timestamp with an IANA timezone suffix', async () => {
    const res = await rpcPost({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_current_time', arguments: {} },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { content: Array<{ type: string; text: string }> } };
    assert.match(body.result.content[0]!.text, /^\d{4}-\d{2}-\d{2}T.*\(.+\)$/);
  });

  it('A2: sequential then concurrent POSTs all succeed; no stateless-transport-reuse error ever surfaces', async () => {
    const listReq = { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} };

    const seq1 = await rpcPost(listReq);
    const seq1Text = await seq1.text();
    const seq2 = await rpcPost(listReq);
    const seq2Text = await seq2.text();

    const [conc1, conc2] = await Promise.all([rpcPost(listReq), rpcPost(listReq)]);
    const [conc1Text, conc2Text] = await Promise.all([conc1.text(), conc2.text()]);

    for (const res of [seq1, seq2, conc1, conc2]) {
      assert.equal(res.status, 200);
    }
    for (const text of [seq1Text, seq2Text, conc1Text, conc2Text]) {
      assert.doesNotMatch(text, /Stateless transport cannot be reused/);
    }
  });

  it('A3: GET /mcp returns 405 with the exact method-not-allowed body', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'GET' });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  it('A3: DELETE /mcp returns 405 with the exact method-not-allowed body', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'DELETE' });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  it('A1 sanity: POST without the Accept pair returns 406', async () => {
    const res = await rpcPost(
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
      { 'content-type': 'application/json', accept: 'application/json' },
    );
    assert.equal(res.status, 406);
  });

  it('A1 sanity: POST with Content-Type: text/plain returns 415', async () => {
    const res = await rpcPost(
      { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
      { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' },
    );
    assert.equal(res.status, 415);
  });
});

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mcpRoutes } from '../src/mcp-server.js';

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await mcpRoutes(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
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
  it('A1: tools/list returns 200 application/json and contains the registered tool surface', async () => {
    const res = await rpcPost({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toMatch(/^application\/json/);

    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name).sort();
    for (const name of ['get_current_time', 'hello', 'reset_password', 'verify_identity']) {
      expect(names).toContain(name);
    }
  });

  it('tools/call hello with a name greets that name', async () => {
    const res = await rpcPost({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'hello', arguments: { name: 'Ada' } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: Array<{ type: string; text: string }> } };
    expect(body.result.content[0]!.text).toBe('Hello, Ada!');
  });

  it('tools/call get_current_time returns an ISO-8601 timestamp with an IANA timezone suffix', async () => {
    const res = await rpcPost({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_current_time', arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: Array<{ type: string; text: string }> } };
    expect(body.result.content[0]!.text).toMatch(/^\d{4}-\d{2}-\d{2}T.*\(.+\)$/);
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
      expect(res.status).toBe(200);
    }
    for (const text of [seq1Text, seq2Text, conc1Text, conc2Text]) {
      expect(text).not.toMatch(/Stateless transport cannot be reused/);
    }
  });

  it('A3: GET /mcp returns 405 with the exact method-not-allowed body', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  it('A3: DELETE /mcp returns 405 with the exact method-not-allowed body', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({
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
    expect(res.status).toBe(406);
  });

  it('A1 sanity: POST with Content-Type: text/plain returns 415', async () => {
    const res = await rpcPost(
      { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
      { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' },
    );
    expect(res.status).toBe(415);
  });
});

import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { logEvent } from './logger.js';

/** Fresh McpServer per request (stateless mode requires it — SDK throws on reuse). */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'hello-world', version: '1.0.0' });

  // Tool 1: no args → config has no inputSchema; handler signature is (extra) => ...
  server.registerTool(
    'get_current_time',
    { description: 'Returns the current server time as ISO-8601 plus IANA timezone.' },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: `${new Date().toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
        },
      ],
    }),
  );

  // Tool 2: zod RAW SHAPE (plain object of zod schemas — NOT z.object(...)).
  // Handler's first arg is the parsed+typed args object.
  server.registerTool(
    'hello',
    {
      description: 'Say a friendly hello.',
      inputSchema: { name: z.string().optional().describe('Name to greet') },
    },
    async ({ name }) => ({
      content: [{ type: 'text' as const, text: `Hello, ${name ?? 'world'}!` }],
    }),
  );
  // FR-5: adding a tool = one more registerTool call here. Nothing else changes.
  return server;
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post('/mcp', async (request, reply) => {
    // Take over the raw response; the transport writes status/headers/body itself.
    reply.hijack();
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON instead of SSE framing
    });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      // Fastify already parsed the JSON body — MUST forward it as parsedBody.
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      logEvent({ level: 'error', message: 'mcp request failed', event: 'mcp-error', err: String(err) }); // shared logger — Fastify runs logger:false (Spec 08 R3)
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    }
  });

  // Stateless server: no GET SSE stream, no DELETE session termination (official example pattern).
  const notAllowed = async (_req: unknown, reply: { code: (n: number) => { send: (body: unknown) => unknown } }) =>
    reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}

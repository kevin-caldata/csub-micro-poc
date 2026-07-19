import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { logEvent } from './logger.js';

/** SIM-V- + 6 uppercase hex — verify_identity mints it, reset_password shape-validates it (Spec 02 R5/R6/R9). */
export const VERIFICATION_TOKEN_REGEX = /^SIM-V-[0-9A-F]{6}$/;

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
  // Tool 3: verify_identity — pure theater, mints the SIM-V- verification token (Spec 02 R5).
  server.registerTool(
    'verify_identity',
    {
      description:
        "Simulated identity check required before account actions like a password reset. Provide the caller's name or date of birth — either one is enough. Always succeeds on this demo line and returns a clearly simulated student record plus a verification_token that reset_password requires. Use when: the caller wants a password reset or account-specific help. Do NOT use for: general campus questions.",
      inputSchema: {
        name: z.string().optional().describe("The caller's full name as spoken."),
        dob: z.string().optional().describe("The caller's date of birth, any spoken format."),
      },
    },
    async ({ name, dob }) => {
      const trimmedName = name?.trim() ?? '';
      const trimmedDob = dob?.trim() ?? '';
      const hasName = trimmedName.length > 0;
      const hasDob = trimmedDob.length > 0;

      if (!hasName && !hasDob) {
        logEvent({
          level: 'info',
          message: 'static tool served',
          event: 'static-tool',
          tool: 'verify_identity',
          verified: false,
          verifiedWith: 'none',
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                simulated: true,
                verified: false,
                status: 'need_detail',
                message: 'Ask the caller for their name or date of birth, then call verify_identity again with it.',
              }),
            },
          ],
        };
      }

      const verifiedWith = hasName && hasDob ? 'name+dob' : hasName ? 'name' : 'dob';
      const verificationToken = `SIM-V-${randomBytes(3).toString('hex').toUpperCase()}`;
      logEvent({
        level: 'info',
        message: 'static tool served',
        event: 'static-tool',
        tool: 'verify_identity',
        verified: true,
        verifiedWith,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              simulated: true,
              verified: true,
              status: 'verified',
              student: {
                name: hasName ? trimmedName : 'CSUB Student',
                netid: 'rrunner900',
                student_id: '900123456',
                record_flag: 'SIMULATED RECORD — not a real student',
              },
              verification_token: verificationToken,
              note: 'Keep the verification_token; reset_password requires it.',
            }),
          },
        ],
      };
    },
  );

  // Tool 4: reset_password — consumes the token; real MyID vocabulary (Spec 02 R6).
  server.registerTool(
    'reset_password',
    {
      description:
        'Simulated NetID password reset through CSUB\'s MyID system. Requires the verification_token returned by verify_identity earlier in this call — if you do not have one, call verify_identity first. Never invent or guess a token. Returns the reset steps to read to the caller.',
      inputSchema: {
        verification_token: z
          .string()
          .describe('The verification_token string returned by verify_identity earlier in this call.'),
      },
    },
    async ({ verification_token }) => {
      const tokenValid = VERIFICATION_TOKEN_REGEX.test(verification_token);
      logEvent({
        level: 'info',
        message: 'static tool served',
        event: 'static-tool',
        tool: 'reset_password',
        tokenValid,
      });

      if (!tokenValid) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                simulated: true,
                status: 'not_verified',
                message:
                  "That token is not valid. Call verify_identity with the caller's name or date of birth, then retry reset_password with the token it returns.",
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              simulated: true,
              status: 'reset_initiated',
              system: 'MyID (myid.csub.edu)',
              narrative:
                "I've started a password reset through MyID. An authorization code has been sent to the personal email on file. Go to myid.csub.edu, enter your NetID, and choose 'Forgot Password / Activate Account', then enter the code. Your new password must be 11 to 255 characters and meet 3 of the 4 complexity requirements.",
              duo_reminder:
                "Never share your Duo code with anyone — not even with me. If you've lost your Duo device, call the ITS Service Center at (661) 654-4357.",
            }),
          },
        ],
      };
    },
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

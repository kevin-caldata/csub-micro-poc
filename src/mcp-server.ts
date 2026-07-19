import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { logEvent } from './logger.js';

/** SIM-V- + 6 uppercase hex — verify_identity mints it, reset_password shape-validates it (Spec 02 R5/R6/R9). */
export const VERIFICATION_TOKEN_REGEX = /^SIM-V-[0-9A-F]{6}$/;

/** route_call directory row shape (Spec 02 R4). */
export interface RouteEntry {
  keywords: string[];
  department: string;
  phone: string;
  extension: string;
  location: string;
  estimatedWaitMinutes: number;
}

/** 11 rows, spec order (row order is authoritative for matching — Spec 02 R4). */
export const ROUTE_DIRECTORY: RouteEntry[] = [
  {
    keywords: ['admission'],
    department: 'Admissions',
    phone: '(661) 654-3036',
    extension: '3036',
    location: 'Student Services Building, 47 SA',
    estimatedWaitMinutes: 4,
  },
  {
    keywords: ['registrar', 'records', 'transcript', 'enrollment'],
    department: 'Office of the Registrar',
    phone: '(661) 654-3036',
    extension: '3036',
    location: 'Student Services Building, 47 SA',
    estimatedWaitMinutes: 6,
  },
  {
    keywords: ['billing', 'refund', 'cashier', 'student financial'],
    department: 'Student Financial Services',
    phone: '(661) 654-3225',
    extension: '3225',
    location: 'Student Services Building',
    estimatedWaitMinutes: 5,
  },
  {
    keywords: ['financial aid', 'fafsa', 'scholarship', 'aid'],
    department: 'Financial Aid & Scholarships',
    phone: '(661) 654-3016',
    extension: '3016',
    location: 'Student Services Building',
    estimatedWaitMinutes: 8,
  },
  {
    keywords: ['it', 'help desk', 'password', 'tech', 'duo', 'netid'],
    department: 'ITS Service Center',
    phone: '(661) 654-4357',
    extension: '4357',
    location: 'Walter W. Stiern Library, Room 13',
    estimatedWaitMinutes: 3,
  },
  {
    keywords: ['health'],
    department: 'Student Health Services',
    phone: '(661) 654-2394',
    extension: '2394',
    location: 'Building 28 HC',
    estimatedWaitMinutes: 7,
  },
  {
    keywords: ['parking', 'permit'],
    department: 'Parking Services',
    phone: '(661) 654-2677',
    extension: '2677',
    location: 'University Police Department, 6 PS',
    estimatedWaitMinutes: 5,
  },
  {
    keywords: ['police', 'upd', 'safety'],
    department: 'University Police (non-emergency)',
    phone: '(661) 654-2677',
    extension: '2677',
    location: 'Building 6 PS',
    estimatedWaitMinutes: 2,
  },
  {
    keywords: ['counseling'],
    department: 'Counseling Center',
    phone: '(661) 654-3366',
    extension: '3366',
    location: 'Rivendell building, near Parking Lot E',
    estimatedWaitMinutes: 4,
  },
  {
    keywords: ['athletic', 'ticket', 'box office'],
    department: 'Icardo Center Box Office',
    phone: '(661) 654-3988',
    extension: '3988',
    location: 'Icardo Center',
    estimatedWaitMinutes: 3,
  },
  {
    keywords: ['advis'],
    department: 'Academic Advising (AARC)',
    phone: '(661) 654-2782',
    extension: '2782',
    location: "ask the caller's major, then direct via operator",
    estimatedWaitMinutes: 6,
  },
];

const ROUTE_FALLBACK: RouteEntry = {
  keywords: [],
  department: 'Campus Operator',
  phone: '(661) 654-2782',
  extension: '2782',
  location: '9001 Stockdale Highway',
  estimatedWaitMinutes: 1,
};

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
  // Tool 5: escalate_to_human — the crisis path: deterministic, instant, LLM-free (Spec 02 R3).
  server.registerTool(
    'escalate_to_human',
    {
      description:
        'Log an escalation and get the exact phone numbers to read aloud to the caller. Use when: the caller mentions self-harm, a crisis, or danger, or is distressed, angry, or asks for a human. Do NOT use for: routine department transfers (use route_call). For crisis calls, call this immediately — do not ask clarifying questions first.',
      inputSchema: {
        reason: z.string().describe('One short sentence on why the caller needs a human.'),
        urgency: z
          .enum(['routine', 'urgent', 'crisis'])
          .describe(
            "'crisis' for any mention of self-harm or danger; 'urgent' for time-sensitive or highly distressed; 'routine' otherwise.",
          ),
      },
    },
    async ({ reason, urgency }) => {
      const speakThis =
        urgency === 'crisis'
          ? 'Please know these are real resources that can help right now: the CSUB Counseling Center at (661) 654-3366 — after hours, press 2 to reach a crisis counselor. You can also call or text 988, the Suicide and Crisis Lifeline, free and available any time. If you are in immediate danger, call 911 or University Police at (661) 654-2111. This demo line cannot transfer your call, so please dial one of those numbers directly.'
          : urgency === 'urgent'
            ? 'The campus operator at (661) 654-2782 can connect you with a person during business hours. If this is a safety concern, University Police are at (661) 654-2111, or call 911. This demo line cannot transfer your call, so please dial directly.'
            : 'The campus operator at (661) 654-2782 can connect you with any campus office during business hours. This demo line cannot transfer your call, so please dial that number directly.';

      logEvent({
        level: urgency === 'crisis' ? 'warn' : 'info',
        message: 'escalation requested',
        event: 'crisis-escalation',
        tool: 'escalate_to_human',
        urgency,
        reason: reason.slice(0, 200),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              simulated: true,
              status: 'escalation_logged',
              live_transfer: false,
              speak_this: speakThis,
              resources: [
                {
                  name: 'CSUB Counseling Center',
                  phone: '(661) 654-3366',
                  note: 'after hours, press 2 to reach a crisis counselor',
                },
                { name: '988 Suicide & Crisis Lifeline', phone: '988', note: 'call or text, free, 24/7' },
                { name: 'University Police (emergency)', phone: '(661) 654-2111', note: 'or call 911' },
                { name: 'Campus Operator', phone: '(661) 654-2782', note: 'business hours' },
              ],
            }),
          },
        ],
      };
    },
  );
  // Tool 6: route_call — fake context-payload handoff to a campus department (Spec 02 R4).
  server.registerTool(
    'route_call',
    {
      description:
        "Prepare a simulated transfer to a campus department. Returns the department's number, location, estimated wait, and a handoff script to read to the caller, and passes along a context note so the caller never repeats themselves. Use when: the caller asks to be transferred or needs something only that office can do. Do NOT use for: crisis or distress (use escalate_to_human) or answering factual questions (use ask_campus_knowledge).",
      inputSchema: {
        department: z
          .string()
          .describe("Department or office to reach, e.g. 'financial aid', 'admissions', 'IT help desk', 'registrar'."),
        context: z
          .string()
          .optional()
          .describe("One-sentence summary of the caller's need, passed to the department so the caller does not repeat themselves."),
      },
    },
    async ({ department, context }) => {
      const lowered = department.toLowerCase();
      const matchedEntry = ROUTE_DIRECTORY.find((entry) => entry.keywords.some((kw) => lowered.includes(kw)));
      const matched = matchedEntry !== undefined;
      const entry = matchedEntry ?? ROUTE_FALLBACK;
      const contextNote = context ?? 'General inquiry.';

      logEvent({
        level: 'info',
        message: 'static tool served',
        event: 'static-tool',
        tool: 'route_call',
        department: entry.department,
        matched,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              simulated: true,
              status: 'transfer_ready',
              live_transfer: false,
              department: entry.department,
              phone: entry.phone,
              extension: entry.extension,
              location: entry.location,
              estimated_wait_minutes: entry.estimatedWaitMinutes,
              context_note: contextNote,
              handoff_blurb: `I'm connecting you to ${entry.department} at ${entry.phone}. I've passed along a note so you won't have to repeat yourself: ${contextNote} Estimated wait is about ${entry.estimatedWaitMinutes} minutes.`,
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

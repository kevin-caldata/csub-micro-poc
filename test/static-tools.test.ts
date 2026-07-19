import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mcpRoutes, VERIFICATION_TOKEN_REGEX } from '../src/mcp-server.js';

// Shared harness — copied verbatim from test/mcp-server.test.ts:8-30. Later chain steps
// (crisis/route/sms/time tools) append their describe blocks below reusing this same setup.
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

let nextId = 1000;

/** Calls a tool via a fresh JSON-RPC POST (each POST hits a fresh McpServer — statelessness, R9). */
function callTool(name: string, args: unknown): Promise<Response> {
  return rpcPost({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
}

interface RpcCallResult {
  result: { content: Array<{ type: string; text: string }>; isError?: boolean };
}

/** Parses the tool's JSON text payload out of a decoded tools/call response body. */
function parsePayload(body: RpcCallResult): Record<string, unknown> {
  return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
}

/** Adapts logger.test.ts's withCapturedOutput to async: captures stdout across an awaited fn. */
async function withCapturedOutputAsync(fn: () => Promise<void>): Promise<string[]> {
  const originalStdoutWrite = process.stdout.write;
  const lines: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  return lines;
}

describe('static tools — identity flow (verify_identity / reset_password)', () => {
  it('tools/list contains verify_identity and reset_password, each advertising a $schema-bearing inputSchema', async () => {
    const res = await rpcPost({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const body = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('verify_identity');
    expect(names).toContain('reset_password');
    for (const toolName of ['verify_identity', 'reset_password']) {
      const tool = body.result.tools.find((t) => t.name === toolName);
      expect(tool).toBeTruthy();
      expect(JSON.stringify(tool!.inputSchema)).toContain('$schema');
    }
  });

  it('verify_identity {} returns need_detail', async () => {
    const res = await callTool('verify_identity', {});
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.simulated).toBe(true);
    expect(payload.verified).toBe(false);
    expect(payload.status).toBe('need_detail');
    expect(payload.message).toBe(
      'Ask the caller for their name or date of birth, then call verify_identity again with it.',
    );
  });

  it('verify_identity with whitespace-only name and dob returns need_detail', async () => {
    const res = await callTool('verify_identity', { name: '   ', dob: ' ' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.verified).toBe(false);
    expect(payload.status).toBe('need_detail');
  });

  it('verify_identity {name:"Ada Lovelace"} verifies and mints a SIM-V token', async () => {
    const res = await callTool('verify_identity', { name: 'Ada Lovelace' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.verified).toBe(true);
    expect(payload.status).toBe('verified');
    const student = payload.student as Record<string, unknown>;
    expect(student.name).toBe('Ada Lovelace');
    expect(student.netid).toBe('rrunner900');
    expect(student.student_id).toBe('900123456');
    expect(student.record_flag).toBe('SIMULATED RECORD — not a real student');
    expect(payload.verification_token as string).toMatch(VERIFICATION_TOKEN_REGEX);
    expect(payload.note).toBe('Keep the verification_token; reset_password requires it.');
  });

  it('verify_identity {dob:"March 5 2004"} uses the CSUB Student placeholder and never echoes the dob', async () => {
    const res = await callTool('verify_identity', { dob: 'March 5 2004' });
    const body = (await res.json()) as RpcCallResult;
    const payload = parsePayload(body);
    const student = payload.student as Record<string, unknown>;
    expect(student.name).toBe('CSUB Student');
    expect(JSON.stringify(payload)).not.toContain('March 5 2004');
  });

  it('both tools put "simulated" as the first payload key', async () => {
    const verifyRes = await callTool('verify_identity', { name: 'Ada' });
    const verifyPayload = parsePayload((await verifyRes.json()) as RpcCallResult);
    expect(Object.keys(verifyPayload)[0]).toBe('simulated');

    const resetRes = await callTool('reset_password', { verification_token: 'nope' });
    const resetPayload = parsePayload((await resetRes.json()) as RpcCallResult);
    expect(Object.keys(resetPayload)[0]).toBe('simulated');
  });

  it('verify→reset token flow works across two fresh server instances', async () => {
    const verifyRes = await callTool('verify_identity', { name: 'Ada' });
    const verifyPayload = parsePayload((await verifyRes.json()) as RpcCallResult);
    const token = verifyPayload.verification_token as string;

    const resetRes = await callTool('reset_password', { verification_token: token });
    const resetPayload = parsePayload((await resetRes.json()) as RpcCallResult);
    expect(resetPayload.status).toBe('reset_initiated');
    expect(resetPayload.system).toBe('MyID (myid.csub.edu)');
    const narrative = resetPayload.narrative as string;
    for (const substr of [
      'myid.csub.edu',
      'Forgot Password / Activate Account',
      'authorization code',
      'personal email on file',
      '11 to 255 characters',
    ]) {
      expect(narrative).toContain(substr);
    }
    expect(resetPayload.duo_reminder as string).toContain('(661) 654-4357');
  });

  it('reset_password with a malformed token returns recoverable not_verified, not isError', async () => {
    const res = await callTool('reset_password', { verification_token: 'nope' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcCallResult;
    expect(body.result.isError).toBeFalsy();
    const payload = parsePayload(body);
    expect(payload.status).toBe('not_verified');
    expect(payload.message).toBe(
      "That token is not valid. Call verify_identity with the caller's name or date of birth, then retry reset_password with the token it returns.",
    );
  });

  it('reset_password rejects lowercase hex (regex is uppercase-only)', async () => {
    const res = await callTool('reset_password', { verification_token: 'SIM-V-abc123' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.status).toBe('not_verified');
  });

  it('reset_password {} hits the SDK -32602 validation isError path', async () => {
    const res = await callTool('reset_password', {});
    const body = (await res.json()) as RpcCallResult;
    expect(body.result.isError).toBe(true);
  });

  it('verify_identity is deterministic apart from the minted token', async () => {
    const res1 = await callTool('verify_identity', { name: 'Ada' });
    const payload1 = parsePayload((await res1.json()) as RpcCallResult);
    const res2 = await callTool('verify_identity', { name: 'Ada' });
    const payload2 = parsePayload((await res2.json()) as RpcCallResult);
    delete payload1.verification_token;
    delete payload2.verification_token;
    expect(payload1).toEqual(payload2);
  });

  it('handlers emit exactly one static-tool log line each', async () => {
    const verifyLines = await withCapturedOutputAsync(async () => {
      await callTool('verify_identity', { name: 'Ada' });
    });
    expect(verifyLines.length).toBe(1);
    const verifyLog = JSON.parse(verifyLines[0]!) as Record<string, unknown>;
    expect(verifyLog.event).toBe('static-tool');
    expect(verifyLog.level).toBe('info');
    expect(verifyLog.message).toBe('static tool served');
    expect(verifyLog.tool).toBe('verify_identity');
    expect(verifyLog.verified).toBe(true);
    expect(verifyLog.verifiedWith).toBe('name');

    const resetLines = await withCapturedOutputAsync(async () => {
      await callTool('reset_password', { verification_token: 'nope' });
    });
    expect(resetLines.length).toBe(1);
    const resetLog = JSON.parse(resetLines[0]!) as Record<string, unknown>;
    expect(resetLog.event).toBe('static-tool');
    expect(resetLog.level).toBe('info');
    expect(resetLog.message).toBe('static tool served');
    expect(resetLog.tool).toBe('reset_password');
    expect(resetLog.tokenValid).toBe(false);
  });
});

describe('escalate_to_human', () => {
  const CRISIS_SPEAK_THIS =
    'Please know these are real resources that can help right now: the CSUB Counseling Center at (661) 654-3366 — after hours, press 2 to reach a crisis counselor. You can also call or text 988, the Suicide and Crisis Lifeline, free and available any time. If you are in immediate danger, call 911 or University Police at (661) 654-2111. This demo line cannot transfer your call, so please dial one of those numbers directly.';
  const URGENT_SPEAK_THIS =
    'The campus operator at (661) 654-2782 can connect you with a person during business hours. If this is a safety concern, University Police are at (661) 654-2111, or call 911. This demo line cannot transfer your call, so please dial directly.';
  const ROUTINE_SPEAK_THIS =
    'The campus operator at (661) 654-2782 can connect you with any campus office during business hours. This demo line cannot transfer your call, so please dial that number directly.';

  it('crisis: payload matches R3 — simulated, status escalation_logged, live_transfer false, exact crisis speak_this, exactly the four resources in order', async () => {
    const res = await callTool('escalate_to_human', { reason: 'caller mentioned self-harm', urgency: 'crisis' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.simulated).toBe(true);
    expect(payload.status).toBe('escalation_logged');
    expect(payload.live_transfer).toBe(false);
    expect(payload.speak_this).toBe(CRISIS_SPEAK_THIS);
    expect(payload.resources).toEqual([
      { name: 'CSUB Counseling Center', phone: '(661) 654-3366', note: 'after hours, press 2 to reach a crisis counselor' },
      { name: '988 Suicide & Crisis Lifeline', phone: '988', note: 'call or text, free, 24/7' },
      { name: 'University Police (emergency)', phone: '(661) 654-2111', note: 'or call 911' },
      { name: 'Campus Operator', phone: '(661) 654-2782', note: 'business hours' },
    ]);
  });

  it('crisis: the strings (661) 654-3366, 988, (661) 654-2111, (661) 654-2782 all appear in the serialized payload', async () => {
    const res = await callTool('escalate_to_human', { reason: 'caller mentioned self-harm', urgency: 'crisis' });
    const body = (await res.json()) as RpcCallResult;
    const serialized = JSON.stringify(parsePayload(body));
    for (const s of ['(661) 654-3366', '988', '(661) 654-2111', '(661) 654-2782']) {
      expect(serialized).toContain(s);
    }
  });

  it('crisis: emits exactly one crisis-escalation log line at level warn with urgency and reason', async () => {
    const lines = await withCapturedOutputAsync(async () => {
      await callTool('escalate_to_human', { reason: 'caller mentioned self-harm', urgency: 'crisis' });
    });
    const crisisLines = lines.filter((l) => l.includes('"event":"crisis-escalation"'));
    expect(crisisLines.length).toBe(1);
    const parsed = JSON.parse(crisisLines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe('warn');
    expect(parsed.urgency).toBe('crisis');
    expect(parsed.reason).toBe('caller mentioned self-harm');
  });

  it('crisis: a 250-char reason is sliced to 200 in the log line', async () => {
    const longReason = 'x'.repeat(250);
    const lines = await withCapturedOutputAsync(async () => {
      await callTool('escalate_to_human', { reason: longReason, urgency: 'crisis' });
    });
    const crisisLines = lines.filter((l) => l.includes('"event":"crisis-escalation"'));
    const parsed = JSON.parse(crisisLines[0]!) as Record<string, unknown>;
    expect((parsed.reason as string).length).toBe(200);
  });

  it('urgent: exact urgent speak_this; log level info', async () => {
    const lines = await withCapturedOutputAsync(async () => {
      const res = await callTool('escalate_to_human', { reason: 'caller is very upset', urgency: 'urgent' });
      const payload = parsePayload((await res.json()) as RpcCallResult);
      expect(payload.speak_this).toBe(URGENT_SPEAK_THIS);
    });
    const crisisLines = lines.filter((l) => l.includes('"event":"crisis-escalation"'));
    expect(crisisLines.length).toBe(1);
    const parsed = JSON.parse(crisisLines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
  });

  it('routine: exact routine speak_this; log level info', async () => {
    const lines = await withCapturedOutputAsync(async () => {
      const res = await callTool('escalate_to_human', { reason: 'caller wants a human', urgency: 'routine' });
      const payload = parsePayload((await res.json()) as RpcCallResult);
      expect(payload.speak_this).toBe(ROUTINE_SPEAK_THIS);
    });
    const crisisLines = lines.filter((l) => l.includes('"event":"crisis-escalation"'));
    expect(crisisLines.length).toBe(1);
    const parsed = JSON.parse(crisisLines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
  });

  it('payload\'s first key is "simulated"', async () => {
    const res = await callTool('escalate_to_human', { reason: 'caller wants a human', urgency: 'routine' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(Object.keys(payload)[0]).toBe('simulated');
  });

  it('invalid urgency value yields the SDK -32602 isError result', async () => {
    const res = await callTool('escalate_to_human', { reason: 'caller wants a human', urgency: 'panic' });
    const body = (await res.json()) as RpcCallResult;
    expect(body.result.isError).toBe(true);
  });

  it('tools/list advertises the exact R3 description string', async () => {
    const res = await rpcPost({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const body = (await res.json()) as { result: { tools: Array<{ name: string; description: string }> } };
    const tool = body.result.tools.find((t) => t.name === 'escalate_to_human');
    expect(tool).toBeTruthy();
    expect(tool!.description).toBe(
      'Log an escalation and get the exact phone numbers to read aloud to the caller. Use when: the caller mentions self-harm, a crisis, or danger, or is distressed, angry, or asks for a human. Do NOT use for: routine department transfers (use route_call). For crisis calls, call this immediately — do not ask clarifying questions first.',
    );
  });

  it('determinism: two identical crisis calls return byte-identical text', async () => {
    const res1 = await callTool('escalate_to_human', { reason: 'caller mentioned self-harm', urgency: 'crisis' });
    const body1 = (await res1.json()) as RpcCallResult;
    const res2 = await callTool('escalate_to_human', { reason: 'caller mentioned self-harm', urgency: 'crisis' });
    const body2 = (await res2.json()) as RpcCallResult;
    expect(body1.result.content[0]!.text).toBe(body2.result.content[0]!.text);
  });
});

describe('route_call', () => {
  it('financial aid + context: department/phone/extension/location/wait per the R4 row, context_note echoed, handoff_blurb equals the rendered template', async () => {
    const res = await callTool('route_call', { department: 'financial aid', context: 'asking about fall disbursement' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.department).toBe('Financial Aid & Scholarships');
    expect(payload.phone).toBe('(661) 654-3016');
    expect(payload.extension).toBe('3016');
    expect(payload.location).toBe('Student Services Building');
    expect(payload.estimated_wait_minutes).toBe(8);
    expect(payload.context_note).toBe('asking about fall disbursement');
    expect(payload.handoff_blurb).toBe(
      "I'm connecting you to Financial Aid & Scholarships at (661) 654-3016. I've passed along a note so you won't have to repeat yourself: asking about fall disbursement Estimated wait is about 8 minutes.",
    );
  });

  it("no keyword match falls back to Campus Operator with context_note 'General inquiry.'", async () => {
    const res = await callTool('route_call', { department: 'basket weaving club' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.department).toBe('Campus Operator');
    expect(payload.phone).toBe('(661) 654-2782');
    expect(payload.extension).toBe('2782');
    expect(payload.location).toBe('9001 Stockdale Highway');
    expect(payload.estimated_wait_minutes).toBe(1);
    expect(payload.context_note).toBe('General inquiry.');
  });

  it("'student financial services' resolves to Student Financial Services — billing row wins before the aid keyword", async () => {
    const res = await callTool('route_call', { department: 'student financial services' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.department).toBe('Student Financial Services');
  });

  it("'IT help desk' resolves to ITS Service Center", async () => {
    const res = await callTool('route_call', { department: 'IT help desk' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.department).toBe('ITS Service Center');
  });

  it('matching lowercases the department arg', async () => {
    const res = await callTool('route_call', { department: 'FINANCIAL AID' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(payload.department).toBe('Financial Aid & Scholarships');
  });

  it('ROUTE_DIRECTORY exports exactly 11 rows in the R4 table order', async () => {
    const { ROUTE_DIRECTORY } = await import('../src/mcp-server.js');
    expect(ROUTE_DIRECTORY.length).toBe(11);
    expect(ROUTE_DIRECTORY.map((r) => r.department)).toEqual([
      'Admissions',
      'Office of the Registrar',
      'Student Financial Services',
      'Financial Aid & Scholarships',
      'ITS Service Center',
      'Student Health Services',
      'Parking Services',
      'University Police (non-emergency)',
      'Counseling Center',
      'Icardo Center Box Office',
      'Academic Advising (AARC)',
    ]);
  });

  it('emits one static-tool log line with tool route_call, the resolved department, and matched:false on fallback', async () => {
    const hitLines = await withCapturedOutputAsync(async () => {
      await callTool('route_call', { department: 'financial aid' });
    });
    const hitLog = JSON.parse(hitLines.filter((l) => l.includes('"event":"static-tool"') && l.includes('route_call'))[0]!) as Record<
      string,
      unknown
    >;
    expect(hitLog.tool).toBe('route_call');
    expect(hitLog.department).toBe('Financial Aid & Scholarships');
    expect(hitLog.matched).toBe(true);

    const fallbackLines = await withCapturedOutputAsync(async () => {
      await callTool('route_call', { department: 'basket weaving club' });
    });
    const fallbackLog = JSON.parse(
      fallbackLines.filter((l) => l.includes('"event":"static-tool"') && l.includes('route_call'))[0]!,
    ) as Record<string, unknown>;
    expect(fallbackLog.tool).toBe('route_call');
    expect(fallbackLog.department).toBe('Campus Operator');
    expect(fallbackLog.matched).toBe(false);
  });

  it('tools/list advertises the exact R4 description string', async () => {
    const res = await rpcPost({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const body = (await res.json()) as { result: { tools: Array<{ name: string; description: string }> } };
    const tool = body.result.tools.find((t) => t.name === 'route_call');
    expect(tool).toBeTruthy();
    expect(tool!.description).toBe(
      "Prepare a simulated transfer to a campus department. Returns the department's number, location, estimated wait, and a handoff script to read to the caller, and passes along a context note so the caller never repeats themselves. Use when: the caller asks to be transferred or needs something only that office can do. Do NOT use for: crisis or distress (use escalate_to_human) or answering factual questions (use ask_campus_knowledge).",
    );
  });

  it('payload\'s first key is "simulated"; live_transfer is false', async () => {
    const res = await callTool('route_call', { department: 'financial aid' });
    const payload = parsePayload((await res.json()) as RpcCallResult);
    expect(Object.keys(payload)[0]).toBe('simulated');
    expect(payload.live_transfer).toBe(false);
  });
});

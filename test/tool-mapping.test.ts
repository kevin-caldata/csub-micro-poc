// T10.3 — Tool-mapping suite (Spec 10 R4) against src/tools.ts, using the verbatim
// findings/05 C8 listTools() fixture (never the live-server integration path that
// test/tools.test.ts and test/tool-loop.test.ts already cover). This suite tests the
// pure mapping/executor logic with stubbed MCP clients so it is deterministic and
// doesn't duplicate the boot-a-real-Fastify-server coverage those files provide.
import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { fetchToolDefs, runTool } from '../src/tools.js';
import { LIST_TOOLS_RESPONSE_FIXTURE } from './fixtures/list-tools-response.js';

expect(globalThis.window).toBe(undefined); // G6 guard — plain node environment, never jsdom

/** A stub MCP `Client` exposing only the members fetchToolDefs/runTool touch. */
function stubClient(overrides: Partial<{ listTools: Client['listTools']; callTool: Client['callTool'] }>): Client {
  return overrides as unknown as Client;
}

describe('fetchToolDefs — R4.1/R4.2/R4.3 against the verbatim findings/05 C8 fixture', () => {
  it('R4.1: output objects have exactly the keys type, name, description, parameters; type === "function"', async () => {
    const client = stubClient({ listTools: async () => LIST_TOOLS_RESPONSE_FIXTURE as never });
    const defs = await fetchToolDefs(client);
    expect(defs.length).toBe(2);
    for (const d of defs) {
      expect(Object.keys(d).sort()).toEqual(['description', 'name', 'parameters', 'type']);
      expect(d.type).toBe('function');
    }
  });

  it('R4.1: execution, title, annotations, _meta never leak (never spread)', async () => {
    const client = stubClient({ listTools: async () => LIST_TOOLS_RESPONSE_FIXTURE as never });
    const defs = await fetchToolDefs(client);
    const json = JSON.stringify(defs);
    for (const key of ['execution', 'taskSupport', 'forbidden', 'title', 'annotations', '_meta']) {
      expect(json.includes(key), `leaked key/value "${key}" in ${json}`).toBe(false);
    }
  });

  it('R4.2: $schema is stripped from parameters; additionalProperties and properties are preserved', async () => {
    const client = stubClient({ listTools: async () => LIST_TOOLS_RESPONSE_FIXTURE as never });
    const defs = await fetchToolDefs(client);
    const hello = defs.find((d) => d.name === 'hello');
    expect(hello).toBeTruthy();
    const parameters = hello!.parameters as {
      $schema?: string;
      additionalProperties?: boolean;
      properties: Record<string, unknown>;
    };
    expect(parameters.$schema).toBe(undefined);
    expect('$schema' in parameters).toBe(false);
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties).toEqual({ name: { type: 'string', description: 'Name to greet' } });
  });

  it('R4.3: the no-args tool\'s {"type":"object","properties":{}} passes through unchanged', async () => {
    const client = stubClient({ listTools: async () => LIST_TOOLS_RESPONSE_FIXTURE as never });
    const defs = await fetchToolDefs(client);
    const noArgs = defs.find((d) => d.name === 'get_current_time');
    expect(noArgs).toBeTruthy();
    expect(noArgs!.parameters).toEqual({ type: 'object', properties: {} });
    expect(noArgs!.description).toBe('Returns the current time in ISO format with timezone.');
  });
});

describe('runTool — R4.4 against a stubbed MCP client', () => {
  it('R4.4a class 1: handler throw (isError:true, plain message) → JSON.stringify({error: text}), does not throw', async () => {
    const client = stubClient({
      callTool: async () => ({
        content: [{ type: 'text', text: 'boom: deliberate failure' }],
        isError: true,
      }),
    }) as unknown as Client;
    const result = await runTool(client, 'always_fails', '{}');
    expect(result).toBe(JSON.stringify({ error: 'boom: deliberate failure' }));
  });

  it('R4.4a class 2: isError:true "MCP error -32602: Input validation error…" → same shape, does not throw', async () => {
    const message = 'MCP error -32602: Input validation error: Invalid arguments for tool hello: [{"code":"invalid_type"}]';
    const client = stubClient({
      callTool: async () => ({ content: [{ type: 'text', text: message }], isError: true }),
    }) as unknown as Client;
    const result = await runTool(client, 'hello', '{"name": 42}');
    expect(result).toBe(JSON.stringify({ error: message }));
  });

  it('R4.4a class 3: isError:true "MCP error -32602: Tool nope not found" → same shape, does not throw', async () => {
    const message = 'MCP error -32602: Tool nope not found';
    const client = stubClient({
      callTool: async () => ({ content: [{ type: 'text', text: message }], isError: true }),
    }) as unknown as Client;
    const result = await runTool(client, 'nope', '{}');
    expect(result).toBe(JSON.stringify({ error: message }));
  });

  it('R4.4b: a thrown transport error also yields an error-JSON string, never rejects/throws', async () => {
    const client = stubClient({
      callTool: async () => {
        throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:1');
      },
    }) as unknown as Client;
    await expect(runTool(client, 'hello', '{}')).resolves.toBe(
      JSON.stringify({ error: 'fetch failed: ECONNREFUSED 127.0.0.1:1' }),
    );
  });

  it('R4.4c: arguments reaches callTool as a parsed object, not a JSON string', async () => {
    const callTool = vi.fn(async (params: { name: string; arguments?: unknown }) => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    const client = stubClient({ callTool: callTool as unknown as Client['callTool'] }) as unknown as Client;
    await runTool(client, 'hello', '{"name":"Ada"}');
    expect(callTool).toHaveBeenCalledTimes(1);
    const params = callTool.mock.calls[0]![0] as { name: string; arguments: unknown };
    expect(params.name).toBe('hello');
    expect(typeof params.arguments).toBe('object');
    expect(params.arguments).toEqual({ name: 'Ada' });
  });

  it('R4.4c: empty-string argument payload is guarded — callTool receives {}', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const client = stubClient({ callTool: callTool as unknown as Client['callTool'] }) as unknown as Client;
    await runTool(client, 'get_current_time', '');
    const params = callTool.mock.calls[0]![0] as { arguments: unknown };
    expect(params.arguments).toEqual({});
  });

  it('R4.4c: "{}" argument payload is guarded — callTool receives {}', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const client = stubClient({ callTool: callTool as unknown as Client['callTool'] }) as unknown as Client;
    await runTool(client, 'get_current_time', '{}');
    const params = callTool.mock.calls[0]![0] as { arguments: unknown };
    expect(params.arguments).toEqual({});
  });

  it('R4.4c: whitespace-only argument payload is guarded — callTool receives {}', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const client = stubClient({ callTool: callTool as unknown as Client['callTool'] }) as unknown as Client;
    await runTool(client, 'get_current_time', '   ');
    const params = callTool.mock.calls[0]![0] as { arguments: unknown };
    expect(params.arguments).toEqual({});
  });

  it('timeout class (fake-timer-able): runTool injects a 5000ms timeout — a never-resolving stub that ' +
    'rejects at exactly that mark surfaces as error-JSON without throwing (vi.useFakeTimers)', async () => {
    vi.useFakeTimers();
    try {
      const callTool = vi.fn((
        _params: unknown,
        _resultSchema: unknown,
        options: { timeout: number },
      ) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error(`MCP error: request timed out after ${options.timeout}ms`)), options.timeout);
        }));
      const client = stubClient({ callTool: callTool as unknown as Client['callTool'] }) as unknown as Client;

      const pending = runTool(client, 'slow_tool', '{}');
      // Confirm runTool forwarded the 5000ms budget (R9/findings/05 C9) rather than the SDK's
      // 60000ms default — assert the injected timeout value before advancing the clock.
      expect(callTool).toHaveBeenCalledTimes(1);
      const forwardedOptions = callTool.mock.calls[0]![2] as { timeout: number };
      expect(forwardedOptions.timeout).toBe(5000);

      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      const parsed = JSON.parse(result) as { error: string };
      expect(parsed.error).toContain('timed out after 5000ms');
    } finally {
      vi.useRealTimers();
    }
  });
});

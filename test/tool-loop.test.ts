import { describe, it, expect } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';
import { ToolLoop } from '../src/tools.js';
import type { LogFields } from '../src/logger.js';

expect(globalThis.window).toBe(undefined); // G6 guard — plain node environment, never jsdom

/** Flushes pending microtasks/macrotasks queued by the async tool-loop continuations. */
function flush(times = 6): Promise<void> {
  return times <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => setImmediate(() => flush(times - 1).then(resolve)));
}

/** A manually-resolvable promise for race control (order-independence / dispose tests). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fake MCP `Client` whose `callTool` always succeeds with a text result. */
function fakeClient(callTool: (...args: unknown[]) => Promise<unknown> = async () => ({
  content: [{ type: 'text', text: 'ok' }],
})): Client {
  return { callTool } as unknown as Client;
}

interface Harness {
  loop: ToolLoop;
  sent: ClientEvent[];
  logs: LogFields[];
  setActive: (v: boolean) => void;
}

function makeHarness(client: Client): Harness {
  const sent: ClientEvent[] = [];
  const logs: LogFields[] = [];
  let active = false;
  const loop = new ToolLoop({
    client,
    gwSend: async (ev: ClientEvent) => {
      sent.push(ev);
    },
    isResponseActive: () => active,
    log: (f: LogFields) => logs.push(f),
  });
  return { loop, sent, logs, setActive: (v) => (active = v) };
}

describe('ToolLoop', () => {
  it('happy path: output sent then exactly one gated response-create', async () => {
    const { loop, sent } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();

    const itemCreates = sent.filter((e) => e.type === 'conversation-item-create');
    expect(itemCreates.length).toBe(1);
    const item = (itemCreates[0] as { item: Record<string, unknown> }).item;
    expect(item.type).toBe('function-call-output');
    expect(item.callId).toBe('c1');
    expect(item.name).toBe('get_current_time');
    expect(typeof item.output).toBe('string');

    const responseCreates = sent.filter((e) => e.type === 'response-create');
    expect(responseCreates.length).toBe(1);

    const itemIdx = sent.findIndex((e) => e.type === 'conversation-item-create');
    const rcIdx = sent.findIndex((e) => e.type === 'response-create');
    expect(itemIdx < rcIdx, 'output must be sent before response-create').toBeTruthy();
  });

  it('order-independence: response-done arriving before the tool resolves still gates correctly', async () => {
    const gate = deferred<{ content: Array<{ type: string; text: string }> }>();
    const { loop, sent } = makeHarness(fakeClient(async () => gate.promise));

    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    expect(sent.filter((e) => e.type === 'response-create').length, 'no response-create before output sent').toBe(0);

    gate.resolve({ content: [{ type: 'text', text: 'ok' }] });
    await flush();

    const responseCreates = sent.filter((e) => e.type === 'response-create');
    expect(responseCreates.length).toBe(1);
    const itemIdx = sent.findIndex((e) => e.type === 'conversation-item-create');
    const rcIdx = sent.findIndex((e) => e.type === 'response-create');
    expect(itemIdx < rcIdx).toBeTruthy();
  });

  it('gate condition (c): defers while a response is active, releases on the next response-done, tags autoResponseIntervened', async () => {
    const { loop, sent, logs, setActive } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();

    setActive(true); // a VAD-created response is active when the gate is first fully evaluable
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    expect(sent.filter((e) => e.type === 'response-create').length).toBe(0);

    setActive(false);
    loop.onResponseDone({ responseId: 'rX', status: 'completed' }); // any response-done re-checks the gate
    await flush();
    expect(sent.filter((e) => e.type === 'response-create').length).toBe(1);

    loop.onAudioDelta('r1'); // still the tool-bearing response — must not stamp
    loop.onAudioDelta('r2'); // new responseId — the follow-up
    const line = logs.find((l) => l.event === 'tool-call');
    expect(line?.autoResponseIntervened).toBe(true);
  });

  it('idempotence (d): further response-done events after the gated send add zero more response-create', async () => {
    const { loop, sent } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    expect(sent.filter((e) => e.type === 'response-create').length).toBe(1);

    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    expect(sent.filter((e) => e.type === 'response-create').length).toBe(1);
  });

  it('multi-call response: two function calls in r1 -> two outputs, still exactly one response-create', async () => {
    const { loop, sent } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i2', callId: 'c2', name: 'hello', arguments: '{}' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();

    expect(sent.filter((e) => e.type === 'conversation-item-create').length).toBe(2);
    expect(sent.filter((e) => e.type === 'response-create').length).toBe(1);
  });

  it('cancelled response-done status still proceeds through the gate (barge-in during tool response)', async () => {
    const { loop, sent } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'cancelled' });
    await flush();

    expect(sent.filter((e) => e.type === 'response-create').length).toBe(1);
  });

  it('benign-error retry: resets followupCreateSent so a second response-create IS sent', async () => {
    const { loop, sent } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    expect(sent.filter((e) => e.type === 'response-create').length).toBe(1);

    // Contrast: without the benign-error call, further response-done events add nothing
    // (idempotence, proven above) — the benign-error reset is what re-arms the gate here.
    loop.onBenignCreateWhileActiveError();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    expect(sent.filter((e) => e.type === 'response-create').length).toBe(2);
  });

  it('A10: exactly one flat-field tool-call line at the follow-up first delta; loop state clears after', async () => {
    const { loop, logs } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();

    loop.onAudioDelta('r1'); // same responseId as the tool-bearing response — must NOT stamp
    let toolCallLines = logs.filter((l) => l.event === 'tool-call');
    expect(toolCallLines.length).toBe(0);

    loop.onAudioDelta('r2'); // new responseId -> tFollowupFirstDelta
    toolCallLines = logs.filter((l) => l.event === 'tool-call');
    expect(toolCallLines.length).toBe(1);

    const line = toolCallLines[0]!;
    expect(line.tool).toBe('get_current_time');
    expect(line.callId).toBe('c1');
    for (const key of ['mcpMs', 'gateWaitMs', 'secondTtfbMs', 'toolTotalMs'] as const) {
      const v = line[key];
      expect(typeof v, `${key} must be numeric`).toBe('number');
      expect(Math.round((v as number) * 10) / 10, `${key} must be rounded to 1 decimal`).toBe(v);
    }
    expect((line.toolTotalMs as number) >= (line.mcpMs as number)).toBeTruthy();

    // Loop state cleared afterwards — a subsequent delta on a third responseId logs nothing.
    loop.onAudioDelta('r3');
    expect(logs.filter((l) => l.event === 'tool-call').length).toBe(1);
  });

  it('A11: dispose stops sends and logs even after a late tool resolution; no unhandled rejection', async () => {
    const gate = deferred<{ content: Array<{ type: string; text: string }> }>();
    const { loop, sent, logs } = makeHarness(fakeClient(async () => gate.promise));

    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.dispose();
    gate.resolve({ content: [{ type: 'text', text: 'ok' }] });
    await flush();

    expect(sent.length, 'gwSend must never be called after dispose').toBe(0);
    expect(logs.length, 'no line logged after dispose').toBe(0);
  });
});

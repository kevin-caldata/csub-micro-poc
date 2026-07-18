import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';
import { ToolLoop } from './tools.js';
import type { LogFields } from './logger.js';

assert.equal(globalThis.window, undefined); // G6 guard — plain node environment, never jsdom

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
    assert.equal(itemCreates.length, 1);
    const item = (itemCreates[0] as { item: Record<string, unknown> }).item;
    assert.equal(item.type, 'function-call-output');
    assert.equal(item.callId, 'c1');
    assert.equal(item.name, 'get_current_time');
    assert.equal(typeof item.output, 'string');

    const responseCreates = sent.filter((e) => e.type === 'response-create');
    assert.equal(responseCreates.length, 1);

    const itemIdx = sent.findIndex((e) => e.type === 'conversation-item-create');
    const rcIdx = sent.findIndex((e) => e.type === 'response-create');
    assert.ok(itemIdx < rcIdx, 'output must be sent before response-create');
  });

  it('order-independence: response-done arriving before the tool resolves still gates correctly', async () => {
    const gate = deferred<{ content: Array<{ type: string; text: string }> }>();
    const { loop, sent } = makeHarness(fakeClient(async () => gate.promise));

    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    assert.equal(sent.filter((e) => e.type === 'response-create').length, 0, 'no response-create before output sent');

    gate.resolve({ content: [{ type: 'text', text: 'ok' }] });
    await flush();

    const responseCreates = sent.filter((e) => e.type === 'response-create');
    assert.equal(responseCreates.length, 1);
    const itemIdx = sent.findIndex((e) => e.type === 'conversation-item-create');
    const rcIdx = sent.findIndex((e) => e.type === 'response-create');
    assert.ok(itemIdx < rcIdx);
  });

  it('gate condition (c): defers while a response is active, releases on the next response-done, tags autoResponseIntervened', async () => {
    const { loop, sent, logs, setActive } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();

    setActive(true); // a VAD-created response is active when the gate is first fully evaluable
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    assert.equal(sent.filter((e) => e.type === 'response-create').length, 0);

    setActive(false);
    loop.onResponseDone({ responseId: 'rX', status: 'completed' }); // any response-done re-checks the gate
    await flush();
    assert.equal(sent.filter((e) => e.type === 'response-create').length, 1);

    loop.onAudioDelta('r1'); // still the tool-bearing response — must not stamp
    loop.onAudioDelta('r2'); // new responseId — the follow-up
    const line = logs.find((l) => l.event === 'tool-call');
    assert.equal(line?.autoResponseIntervened, true);
  });

  it('idempotence (d): further response-done events after the gated send add zero more response-create', async () => {
    const { loop, sent } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    assert.equal(sent.filter((e) => e.type === 'response-create').length, 1);

    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    assert.equal(sent.filter((e) => e.type === 'response-create').length, 1);
  });

  it('multi-call response: two function calls in r1 -> two outputs, still exactly one response-create', async () => {
    const { loop, sent } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i2', callId: 'c2', name: 'hello', arguments: '{}' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();

    assert.equal(sent.filter((e) => e.type === 'conversation-item-create').length, 2);
    assert.equal(sent.filter((e) => e.type === 'response-create').length, 1);
  });

  it('cancelled response-done status still proceeds through the gate (barge-in during tool response)', async () => {
    const { loop, sent } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'cancelled' });
    await flush();

    assert.equal(sent.filter((e) => e.type === 'response-create').length, 1);
  });

  it('benign-error retry: resets followupCreateSent so a second response-create IS sent', async () => {
    const { loop, sent } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    assert.equal(sent.filter((e) => e.type === 'response-create').length, 1);

    // Contrast: without the benign-error call, further response-done events add nothing
    // (idempotence, proven above) — the benign-error reset is what re-arms the gate here.
    loop.onBenignCreateWhileActiveError();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();
    assert.equal(sent.filter((e) => e.type === 'response-create').length, 2);
  });

  it('A10: exactly one flat-field tool-call line at the follow-up first delta; loop state clears after', async () => {
    const { loop, logs } = makeHarness(fakeClient());
    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.onResponseDone({ responseId: 'r1', status: 'completed' });
    await flush();

    loop.onAudioDelta('r1'); // same responseId as the tool-bearing response — must NOT stamp
    let toolCallLines = logs.filter((l) => l.event === 'tool-call');
    assert.equal(toolCallLines.length, 0);

    loop.onAudioDelta('r2'); // new responseId -> tFollowupFirstDelta
    toolCallLines = logs.filter((l) => l.event === 'tool-call');
    assert.equal(toolCallLines.length, 1);

    const line = toolCallLines[0]!;
    assert.equal(line.tool, 'get_current_time');
    assert.equal(line.callId, 'c1');
    for (const key of ['mcpMs', 'gateWaitMs', 'secondTtfbMs', 'toolTotalMs'] as const) {
      const v = line[key];
      assert.equal(typeof v, 'number', `${key} must be numeric`);
      assert.equal(Math.round((v as number) * 10) / 10, v, `${key} must be rounded to 1 decimal`);
    }
    assert.ok((line.toolTotalMs as number) >= (line.mcpMs as number));

    // Loop state cleared afterwards — a subsequent delta on a third responseId logs nothing.
    loop.onAudioDelta('r3');
    assert.equal(logs.filter((l) => l.event === 'tool-call').length, 1);
  });

  it('A11: dispose stops sends and logs even after a late tool resolution; no unhandled rejection', async () => {
    const gate = deferred<{ content: Array<{ type: string; text: string }> }>();
    const { loop, sent, logs } = makeHarness(fakeClient(async () => gate.promise));

    loop.onFunctionCallArgsDone({ responseId: 'r1', itemId: 'i1', callId: 'c1', name: 'get_current_time', arguments: '' });
    await flush();
    loop.dispose();
    gate.resolve({ content: [{ type: 'text', text: 'ok' }] });
    await flush();

    assert.equal(sent.length, 0, 'gwSend must never be called after dispose');
    assert.equal(logs.length, 0, 'no line logged after dispose');
  });
});

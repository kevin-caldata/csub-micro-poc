import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Experimental_RealtimeModelV4ClientEvent as ClientEvent } from '@ai-sdk/provider';
import { ms, now } from './logger.js';
import type { LogFields } from './logger.js';
import type { ToolTiming } from './latency.js';

export interface RealtimeToolDef {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** Per-call MCP client: create at call start (Twilio `start`), close at call teardown (`stop`/hangup). */
export async function createMcpClient(port: number): Promise<Client> {
  const client = new Client({ name: 'voice-bridge', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );
  return client; // measured: ~5 ms warm (init POST + initialized POST), well off the audio path
}

/** Thin wrapper over the SDK's own teardown — one call per call (Spec 05 teardown). */
export async function closeMcpClient(client: Client): Promise<void> {
  await client.close();
}

/** listTools → gateway session-update.tools. Explicit field mapping; never spread. */
export async function fetchToolDefs(client: Client): Promise<RealtimeToolDef[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => {
    const { $schema: _drop, ...parameters } = t.inputSchema as Record<string, unknown>;
    return { type: 'function' as const, name: t.name, description: t.description, parameters };
  });
}

/** function-call-arguments-done → tool output string for conversation-item-create. */
export async function runTool(client: Client, name: string, argsJson: string): Promise<string> {
  try {
    const args = argsJson && argsJson.trim() ? JSON.parse(argsJson) : {};
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
    if (result.isError) {
      // Server-side tool failure (throw / bad args / unknown tool) — surfaced here, NOT thrown.
      const msg = (result.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? '')
        .join('\n');
      return JSON.stringify({ error: msg || 'tool failed' });
    }
    return JSON.stringify(result); // {content:[{type:'text',text:...}]}
  } catch (err) {
    // Transport/protocol-level failure (McpError, fetch error, timeout) — never kill the call.
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

// ── ToolLoop (Spec 07 R10–R14) ──────────────────────────────────────────────────────────────
// Per-call tool-call state machine: function-call-arguments-done -> runTool ->
// conversation-item-create{function-call-output} -> exactly one double-gated response-create,
// with ToolTiming stamps and the flat one-line 'tool-call' log. Instantiated once per Session
// (T05 wires it); handles any number of sequential tool round trips over the life of one call.

export interface ToolLoopDeps {
  client: Client;
  gwSend: (ev: ClientEvent) => Promise<void>; // Session passes GatewayLeg.send (no-ops when WS not OPEN)
  isResponseActive: () => boolean; // Session's responseActive flag (Spec 05 R8) — queried at gate time
  log: (fields: LogFields) => void; // Session injects a wrapper adding callSid/streamSid/turn
}

export interface PendingToolCall {
  callId: string;
  name: string;
  outputSent: boolean;
  timing: ToolTiming;
}

/** Exactly Spec 07 R10's `ToolLoopState` shape — kept private to the class. */
interface ToolLoopState {
  pendingToolCalls: Map<string, PendingToolCall>;
  toolResponseIds: Set<string>;
  toolResponseDone: boolean;
  followupCreateSent: boolean;
  awaitingFollowup: boolean;
}

function freshState(): ToolLoopState {
  return {
    pendingToolCalls: new Map(),
    toolResponseIds: new Set(),
    toolResponseDone: false,
    followupCreateSent: false,
    awaitingFollowup: false,
  };
}

export class ToolLoop {
  private readonly deps: ToolLoopDeps;
  private state: ToolLoopState = freshState();

  /** Tracks which of `state.toolResponseIds` have seen response-done, so `toolResponseDone`
   * is correct even in the (untested-by-spec, still-supported) multi-response-per-cycle case. */
  private readonly doneResponseIds = new Set<string>();

  /** The follow-up responseId once lazily attached from its first audio-delta (R11.4/S16). */
  private followupResponseId: string | undefined;

  /** Set when tryReleaseGate() finds (a)/(b)/(d) satisfied but is blocked on (c) — a VAD-auto
   * response was active. Surfaced as `autoResponseIntervened: true` on the eventual tool-call
   * line(s) for this cycle (R12). */
  private autoResponseIntervened = false;

  /** R14 latch — consulted before every gwSend/log in async continuations. Never closes the
   * MCP client (Session owns closeMcpClient). */
  private disposed = false;

  constructor(deps: ToolLoopDeps) {
    this.deps = deps;
  }

  /** R11.1: record the pending call, then asynchronously run the tool and send its output. */
  onFunctionCallArgsDone(ev: { responseId: string; itemId: string; callId: string; name: string; arguments: string }): void {
    if (this.disposed) return;
    const timing: ToolTiming = { callId: ev.callId, name: ev.name, tArgsDone: now() };
    const pending: PendingToolCall = { callId: ev.callId, name: ev.name, outputSent: false, timing };
    this.state.pendingToolCalls.set(ev.callId, pending);
    this.state.toolResponseIds.add(ev.responseId);
    void this.runAndSend(pending, ev.arguments);
  }

  private async runAndSend(pending: PendingToolCall, argsJson: string): Promise<void> {
    const output = await runTool(this.deps.client, pending.name, argsJson);
    if (this.disposed) return;
    pending.timing.tToolResolved = now();

    await this.deps.gwSend({
      type: 'conversation-item-create',
      item: { type: 'function-call-output', callId: pending.callId, name: pending.name, output },
    });
    if (this.disposed) return;

    pending.timing.tOutputSent = now();
    pending.outputSent = true;
    this.tryReleaseGate();
  }

  /** R11.3: response-done for a tool-bearing response (or any other) always re-checks the gate
   * — this IS the deferred-retry path (R12), never a timer. */
  onResponseDone(ev: { responseId: string; status?: string }): void {
    if (this.disposed) return;
    if (this.state.toolResponseIds.has(ev.responseId)) {
      this.doneResponseIds.add(ev.responseId);
      this.state.toolResponseDone = [...this.state.toolResponseIds].every((id) => this.doneResponseIds.has(id));
    }
    this.tryReleaseGate();
  }

  /** R12 — the double gate. Sends exactly one response-create iff (a) toolResponseDone, (b)
   * every pending call's output is sent, (c) no response is currently active, (d) not already
   * sent this cycle. (c) is checked last (and only once (a)/(b)/(d) hold) so idempotent re-
   * checks never spuriously flag autoResponseIntervened. */
  private tryReleaseGate(): void {
    if (this.disposed) return;
    if (this.state.toolResponseIds.size === 0) return; // no active tool cycle
    if (!this.state.toolResponseDone) return; // (a)
    const allOutputSent = [...this.state.pendingToolCalls.values()].every((p) => p.outputSent);
    if (!allOutputSent) return; // (b)
    if (this.state.followupCreateSent) return; // (d) idempotence guard
    if (this.deps.isResponseActive()) {
      // (c) fails — a VAD-auto response is active. Do nothing; the next onResponseDone retries.
      this.autoResponseIntervened = true;
      return;
    }

    this.state.followupCreateSent = true;
    this.state.awaitingFollowup = true;
    const sentAt = now();
    for (const p of this.state.pendingToolCalls.values()) p.timing.tResponseCreateSent = sentAt;

    if (this.disposed) return;
    void this.deps.gwSend({ type: 'response-create' });
  }

  /** R12 lost-race recovery: a create-while-active error arrived anyway (benign) — reset the
   * idempotence guard so the next response-done retries the send. */
  onBenignCreateWhileActiveError(): void {
    if (this.disposed) return;
    this.state.followupCreateSent = false;
  }

  /** R11.4/S16: lazy follow-up attach, called on EVERY audio-delta. Only meaningful once
   * awaitingFollowup is set; ignores deltas still belonging to the tool-bearing response(s);
   * the first delta of a genuinely new responseId is the follow-up's first delta. */
  onAudioDelta(responseId: string): void {
    if (this.disposed) return;
    if (!this.state.awaitingFollowup) return;
    if (this.state.toolResponseIds.has(responseId)) return; // still the original response — not the follow-up
    if (this.followupResponseId !== undefined) return; // already attached this cycle

    this.followupResponseId = responseId;
    const t = now();
    const intervened = this.autoResponseIntervened;
    for (const pending of this.state.pendingToolCalls.values()) {
      pending.timing.tFollowupFirstDelta = t;
      this.emitToolCallLine(pending.timing, intervened);
    }
    this.resetCycle();
  }

  private emitToolCallLine(timing: ToolTiming, autoResponseIntervened: boolean): void {
    if (this.disposed) return;
    const mcpMs = timing.tToolResolved !== undefined ? ms(timing.tArgsDone, timing.tToolResolved) : undefined;
    const gateWaitMs =
      timing.tOutputSent !== undefined && timing.tResponseCreateSent !== undefined
        ? ms(timing.tOutputSent, timing.tResponseCreateSent)
        : undefined;
    const secondTtfbMs =
      timing.tResponseCreateSent !== undefined && timing.tFollowupFirstDelta !== undefined
        ? ms(timing.tResponseCreateSent, timing.tFollowupFirstDelta)
        : undefined;
    const toolTotalMs =
      timing.tFollowupFirstDelta !== undefined ? ms(timing.tArgsDone, timing.tFollowupFirstDelta) : undefined;

    this.deps.log({
      level: 'info',
      message: `tool ${timing.name} round trip`,
      event: 'tool-call',
      tool: timing.name,
      callId: timing.callId,
      mcpMs,
      gateWaitMs,
      secondTtfbMs,
      toolTotalMs,
      ...(autoResponseIntervened ? { autoResponseIntervened: true } : {}),
    });
  }

  /** Clears all per-cycle state so the next tool round trip in this call starts fresh. */
  private resetCycle(): void {
    this.state = freshState();
    this.doneResponseIds.clear();
    this.followupResponseId = undefined;
    this.autoResponseIntervened = false;
  }

  /** R14: abandon unresolved runTool promises (their continuations no-op once disposed) —
   * does NOT close the MCP client (Session owns closeMcpClient via T07.2/T07.3). */
  dispose(): void {
    this.disposed = true;
  }
}

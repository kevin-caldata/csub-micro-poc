import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

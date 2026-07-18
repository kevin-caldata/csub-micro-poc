// Test-fixture helper for the gateway-leg ws client (T04.3). Named `*.test.ts` deliberately per
// plan 04-gateway-leg/03-ws-client-leg.md: excluded from `dist` by the build (tsconfig `exclude`),
// harmless under `tsx --test` (it registers zero tests, so it contributes 0 passing tests), and
// imported by src/gateway.leg.test.ts (and later T04.4/T04.5 test files). T10 later relocates it
// to `test/fakes/`.
//
// ZERO test registrations live in this file — see the plan's explicit instruction.

import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket as WSClient } from 'ws';

/** Minimal handle on the mock gateway ws server used by gateway-leg tests. */
export interface MockGateway {
  /** `ws://127.0.0.1:<port>` — pass as `MintResult.url` in tests (openGatewayLeg connects to `mint.url`). */
  url: string;
  port: number;
  /** Every client->server frame received, JSON-parsed, in arrival order. */
  frames: unknown[];
  /** Count of ws-protocol `ping` frames received from the client (A12 evidence). */
  readonly pingCount: number;
  /** Resolves with the current (or next) client connection's raw `ws.WebSocket`. */
  nextConnection(): Promise<WSClient>;
  /** JSON.stringify + send to the most recent connection. */
  send(json: unknown): void;
  /** Send a raw (non-JSON) text frame to the most recent connection — for parse-error tests. */
  sendRaw(text: string): void;
  /** Close the most recent connection with the given code/reason. */
  close(code?: number, reason?: string): void;
  /** Tear down the mock server (and any open connection). */
  stop(): Promise<void>;
}

/**
 * Starts a local `ws` server on an ephemeral port for gateway-leg tests.
 *
 * Trap (documented in the plan): ws@8 clients abort the handshake if the server selects no
 * subprotocol, and `openGatewayLeg`'s client always offers `['ai-gateway-realtime.v1',
 * 'ai-gateway-auth.<token>']` — so this mock MUST implement `handleProtocols` and echo one back.
 */
export async function startMockGateway(): Promise<MockGateway> {
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: (protocols: Set<string>) => {
      const first = protocols.values().next().value;
      return first ?? false;
    },
  });

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  const addr = wss.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const url = `ws://127.0.0.1:${port}`;

  const frames: unknown[] = [];
  let pingCount = 0;
  let current: WSClient | undefined;
  let connectionWaiters: Array<(ws: WSClient) => void> = [];

  wss.on('connection', (ws: WSClient) => {
    current = ws;
    ws.on('ping', () => {
      pingCount++;
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      try {
        frames.push(JSON.parse(data.toString()));
      } catch {
        // Not every test sends valid JSON to the mock itself; irrelevant to gateway.ts under test.
      }
    });
    const waiters = connectionWaiters;
    connectionWaiters = [];
    for (const w of waiters) w(ws);
  });

  function nextConnection(): Promise<WSClient> {
    if (current && current.readyState === current.OPEN) return Promise.resolve(current);
    return new Promise((resolve) => connectionWaiters.push(resolve));
  }

  function requireCurrent(): WSClient {
    if (!current) throw new Error('startMockGateway: no client connection yet — await nextConnection() first');
    return current;
  }

  function send(json: unknown): void {
    requireCurrent().send(JSON.stringify(json));
  }

  function sendRaw(text: string): void {
    requireCurrent().send(text);
  }

  function close(code?: number, reason?: string): void {
    requireCurrent().close(code, reason);
  }

  async function stop(): Promise<void> {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return {
    url,
    port,
    frames,
    get pingCount() {
      return pingCount;
    },
    nextConnection,
    send,
    sendRaw,
    close,
    stop,
  };
}

/**
 * Re-exported so leg tests can spin up the A10 non-101 (upgrade-refused) fixture without a WS
 * server at all. Node's `http.Server` destroys upgrade requests with NO response whatsoever
 * unless an `'upgrade'` listener is attached — so the plain `res.writeHead`/`request` handler
 * alone would never surface a status code to the `ws` client. Answer the upgrade directly.
 */
export async function startPlainHttpServer(statusCode: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(statusCode);
    res.end('refused');
  });
  server.on('upgrade', (_req, socket) => {
    socket.end(`HTTP/1.1 ${statusCode} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    url: `ws://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

import { describe, it, beforeEach, expect } from 'vitest';
import { buildApp } from '../src/server.js';
import { sessions, type SessionHandle } from '../src/state.js';
import type { AppConfig } from '../src/config.js';

// Minimal fixture (matches server.test.ts's pattern) — test files are excluded from
// tsc's `include` (tsconfig.json), so tsx's transpile-only run does not require every
// AppConfig field here.
const fixtureConfig: AppConfig = {
  aiGatewayApiKey: 'vck_test',
  twilioAuthToken: 'tok_test',
  port: 3000,
  publicHost: 'example.ngrok.app',
  modelId: 'openai/gpt-realtime-2.1',
  audioMode: 'transcode',
  voice: 'marin',
} as AppConfig;

/** Wraps process.stdout.write to capture logEvent()'s minified-JSON lines; always restore in `finally`. */
function captureStdout(): { lines: () => Record<string, unknown>[]; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    lines: () =>
      chunks
        .map((c) => {
          try {
            return JSON.parse(c);
          } catch {
            return null;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== null),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

beforeEach(() => {
  sessions.clear();
});

describe('shutdown — drain before close (Spec 02 R8, A7/A8)', () => {
  it('A7 gate + drain-before-close: gates /twiml, /health, and new WS upgrades; exempts /stream-status; leaves the already-open WS alone; resolves quickly once sessions empties; no straggler teardown', async () => {
    const exitCalls: number[] = [];
    const exitSpy = (code: number) => {
      exitCalls.push(code);
    };

    const { app, shutdown } = await buildApp(fixtureConfig, { deadlineMs: 3000, pollMs: 25, exit: exitSpy });

    // Test-only WS route, registered before app.ready().
    app.get('/test-ws', { websocket: true }, () => {});
    await app.ready();

    const ws = await app.injectWS('/test-ws');
    let closed = false;
    ws.on('close', () => {
      closed = true;
    });

    let teardownCalls = 0;
    const handle: SessionHandle = {
      teardown() {
        teardownCalls++;
        sessions.delete('fake-stream-sid'); // R2 contract: self-delete on every exit path
      },
    };
    sessions.set('fake-stream-sid', handle);

    const done = shutdown('SIGTERM'); // NOT awaited yet

    // draining flips synchronously before shutdown()'s first await; a tick just lets
    // any queued microtasks settle before we start asserting.
    await new Promise((r) => setImmediate(r));

    const twimlRes = await app.inject({ method: 'POST', url: '/twiml' });
    expect(twimlRes.statusCode).toBe(503);

    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(503);

    const streamStatusRes = await app.inject({
      method: 'POST',
      url: '/stream-status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        StreamEvent: 'stream-started',
        CallSid: 'CA1',
        StreamSid: 'MZ1',
      }).toString(),
    });
    expect(streamStatusRes.statusCode).toBe(204);

    await expect((() => app.injectWS('/test-ws'))()).rejects.toThrow(); // non-101 refusal during drain

    expect(closed).toBe(false); // already-open WS not severed while draining

    sessions.delete('fake-stream-sid'); // simulate natural call end

    await done;

    expect(exitCalls).toEqual([0]);
    expect(teardownCalls).toBe(0); // straggler teardown never needed

    // app.close()'s preClose sends a graceful close to the already-open WS over injectWS's fake
    // duplex socket, which has no real transport to ack it — ws's ~30 s close handshake timers
    // (both ends) would otherwise keep the test process alive well past the assertions above.
    // Force both ends closed now that the assertions are done; harmless test-only cleanup.
    for (const client of app.websocketServer.clients) client.terminate();
    ws.terminate();
  });

  it('A7 straggler sweep: teardown(\'server shutdown\') invoked when sessions never empties; exits by ~deadline', async () => {
    const exitCalls: number[] = [];
    const exitSpy = (code: number) => {
      exitCalls.push(code);
    };

    const { shutdown } = await buildApp(fixtureConfig, { deadlineMs: 300, pollMs: 25, exit: exitSpy });

    let teardownCalls = 0;
    let lastReason = '';
    const handle: SessionHandle = {
      teardown(reason: string) {
        teardownCalls++;
        lastReason = reason;
        sessions.delete('stuck-stream-sid');
      },
    };
    sessions.set('stuck-stream-sid', handle);

    const start = Date.now();
    await shutdown('SIGTERM');
    const elapsed = Date.now() - start;

    expect(teardownCalls).toBe(1);
    expect(lastReason).toBe('server shutdown');
    expect(exitCalls).toEqual([0]);
    expect(elapsed < 2000, `expected shutdown to resolve well under 2000ms, got ${elapsed}ms`).toBeTruthy();
  });

  it('A8 idempotence: a second SIGTERM/SIGINT during shutdown is a no-op; exactly one shutdown-start log line', async () => {
    const exitCalls: number[] = [];
    const exitSpy = (code: number) => {
      exitCalls.push(code);
    };

    const { shutdown } = await buildApp(fixtureConfig, { deadlineMs: 200, pollMs: 25, exit: exitSpy });

    const capture = captureStdout();
    let p1: Promise<void>;
    let p2: Promise<void>;
    try {
      p1 = shutdown('SIGTERM');
      p2 = shutdown('SIGINT');
      await Promise.all([p1, p2]);
    } finally {
      capture.restore();
    }

    expect(exitCalls).toEqual([0]);
    const startLines = capture.lines().filter((l) => l.event === 'shutdown-start');
    expect(startLines.length).toBe(1);
  });
});

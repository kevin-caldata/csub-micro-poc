// scripts/concurrency-probe.ts
//
// S24 gateway-session concurrency ramp (Spec 10 R20). Answers "the number" (how many
// concurrent realtime sessions this team can hold open) and "the locus" (does rejection
// manifest at token mint — an HTTP/GatewayError class — or at WS-open — unexpected-response
// status/body or an early close code/reason?) without placing a single phone call.
//
// Deliberately does NOT import src/gateway.ts (or src/config.ts): this is a standalone probe
// that must not depend on bridge wiring. It imports @ai-sdk/gateway and ws directly and mirrors
// Spec 04 R4's connect constants (perMessageDeflate: false, handshakeTimeout: 5000) verbatim
// rather than re-deriving them.
//
// Algorithm (Spec 10 R20, verbatim): for connection i = 1..15, then continuing in steps of 5
// up to a maximum of 30: mint a token via the factory-form `gateway.experimental_realtime
// .getToken(...)` [findings/01 claim 2 / C1 — NEVER call getToken on the model instance] ->
// open the WS with the returned url/protocols -> immediately send a minimal `session-update`
// with VAD off (satisfies the 30 s first-message rule; no billing-relevant audio) -> hold the
// socket open. Stop at the first rejection (mint failure, non-101 upgrade, or early close);
// close ALL held sockets in a `finally`. Print a `connection # -> result` table.
//
// Usage: npx tsx --env-file=.env scripts/concurrency-probe.ts
// Env:   AI_GATEWAY_API_KEY (required), MODEL_ID (optional, default openai/gpt-realtime-2.1)
//
// This is a live-network probe against Vercel AI Gateway — running it holds real (if idle,
// audio-silent) sessions open for up to ~60 s and is billed at whatever the concurrency ceiling
// turns out to be. Execution against a real key is deferred to M4 (Spec 10 R20/R21); this task
// only builds + typechecks the script and verifies its offline (no-key) refusal path.

if (!process.env.AI_GATEWAY_API_KEY || process.env.AI_GATEWAY_API_KEY.trim() === '') {
  console.error(
    'AI_GATEWAY_API_KEY is not set. Without it, @ai-sdk/gateway falls back to Vercel OIDC, ' +
      'which throws a confusing off-Vercel authentication error (findings/01 gotcha 5; Spec 04 ' +
      'R2). Set AI_GATEWAY_API_KEY (Vercel dashboard -> AI Gateway -> API Keys) and re-run with ' +
      '--env-file=.env.',
  );
  process.exit(1);
}

const { gateway, GatewayError } = await import('@ai-sdk/gateway');
const { default: WebSocket } = await import('ws');

const MODEL_ID = process.env.MODEL_ID?.trim() || 'openai/gpt-realtime-2.1';
const TOKEN_TTL_SECONDS = 600;
const RAMP_INITIAL = 15; // Spec 10 R20: i = 1..15 one at a time
const RAMP_STEP = 5; // then in steps of 5
const RAMP_MAX = 30; // ...up to a maximum of 30
const HANDSHAKE_TIMEOUT_MS = 5000; // Spec 04 R4 connect constant — mirrored, not re-derived

interface ProbeOutcome {
  connection: number;
  result: string;
  rejected: boolean;
  socket?: import('ws').WebSocket;
}

/** Mirrors gateway.ts's classifyMintError (Spec 04 R3) without importing src/gateway.ts. */
function classifyMintError(err: unknown): { errorType: string; statusCode: number | undefined } {
  if (err instanceof GatewayError) {
    // GatewayError subclasses carry a distinguishing `name`; the base class exposes statusCode.
    return { errorType: err.constructor.name, statusCode: err.statusCode };
  }
  return { errorType: 'unknown', statusCode: undefined };
}

/**
 * Attempts one full connection: mint -> WS open (with the mandatory connect constants) ->
 * immediate minimal session-update -> settle on `open` (held) or a rejection outcome.
 */
async function attemptConnection(connection: number): Promise<ProbeOutcome> {
  let mint: { token: string; url: string };
  try {
    const result = await gateway.experimental_realtime.getToken({
      model: MODEL_ID, // required
      expiresAfterSeconds: TOKEN_TTL_SECONDS,
    });
    mint = { token: result.token, url: result.url };
  } catch (cause) {
    const { errorType, statusCode } = classifyMintError(cause);
    return { connection, result: `mint-failed ${errorType} ${statusCode ?? 'unknown'}`, rejected: true };
  }

  const rt = gateway.experimental_realtime(MODEL_ID);
  const wsCfg = rt.getWebSocketConfig({ token: mint.token, url: mint.url });

  return new Promise<ProbeOutcome>((resolve) => {
    const gw = new WebSocket(wsCfg.url, wsCfg.protocols, {
      perMessageDeflate: false, // Spec 04 R4 — ws client default is ON, must disable
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS, // Spec 04 R4 — no ws default; unset hangs 75-130s
    });
    let settled = false;
    const settle = (result: string, rejected: boolean): void => {
      if (settled) return;
      settled = true;
      if (rejected) gw.terminate();
      resolve({ connection, result, rejected, socket: rejected ? undefined : gw });
    };

    gw.on('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 200);
        settle(`unexpected-response ${res.statusCode} ${body}`, true);
      });
      res.on('error', () => settle(`unexpected-response ${res.statusCode} <unreadable body>`, true));
    });

    gw.on('open', () => {
      // Immediately send the minimal session-update — VAD off (turnDetection: null) satisfies
      // the 30 s first-message rule without generating any billing-relevant audio traffic.
      gw.send(JSON.stringify({ type: 'session-update', config: { instructions: 'probe', turnDetection: null } }));
      settle('open', false);
    });

    gw.on('close', (code: number, reasonBuf: Buffer) => {
      settle(`close ${code} ${reasonBuf.toString('utf8')}`, true);
    });

    gw.on('error', (err: Error) => {
      // Accompanies unexpected-response/close in most cases; settle only if nothing else has
      // (e.g. a black-holed handshake that times out without a close frame).
      settle(`close 0 ${err.message}`, true);
    });
  });
}

/** Builds the ramp sequence per Spec 10 R20: 1..15 one at a time, then +5 per step to 30. */
function rampTargets(): number[] {
  const targets: number[] = [];
  for (let i = 1; i <= RAMP_INITIAL; i++) targets.push(i);
  for (let target = RAMP_INITIAL + RAMP_STEP; target <= RAMP_MAX; target += RAMP_STEP) targets.push(target);
  return targets;
}

async function main(): Promise<void> {
  const outcomes: ProbeOutcome[] = [];
  const held: import('ws').WebSocket[] = [];

  try {
    let connection = 0;
    let rejectedAt: number | undefined;
    for (const target of rampTargets()) {
      if (rejectedAt !== undefined) break;
      while (connection < target) {
        connection += 1;
        const outcome = await attemptConnection(connection);
        outcomes.push(outcome);
        if (outcome.socket) held.push(outcome.socket);
        console.log(`connection ${outcome.connection} -> ${outcome.result}`);
        if (outcome.rejected) {
          rejectedAt = outcome.connection;
          break;
        }
      }
    }
  } finally {
    // Close ALL sockets, whether the ramp succeeded fully, was rejected partway, or threw.
    for (const socket of held) {
      try {
        socket.close(1000, 'concurrency probe complete');
      } catch {
        // best-effort cleanup only
      }
    }
  }

  console.log('\nconnection # -> result');
  console.log('-----------------------');
  for (const outcome of outcomes) {
    console.log(`${outcome.connection} -> ${outcome.result}`);
  }

  const rejection = outcomes.find((o) => o.rejected);
  if (rejection) {
    console.log(
      `\nS24: rejection first observed at connection ${rejection.connection} (${rejection.result}); ` +
        `${rejection.connection - 1} concurrent session(s) held successfully.`,
    );
  } else {
    console.log(`\nS24: no rejection observed through ${outcomes.length} connection(s) (ramp cap reached).`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

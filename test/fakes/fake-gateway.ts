// T10.5 — protocol-faithful fake gateway WS server (Spec 10 R9).
//
// Speaks the normalized AI SDK realtime protocol VERBATIM (findings/02's vendored client/server
// unions) on the wire — exactly what `src/gateway.ts`'s `openGatewayLeg` sends/receives when
// pointed at this server via the `GATEWAY_WS_URL` override (Spec 10 R10, `src/config.ts` +
// `src/gateway.ts`). The gateway model is an identity codec (findings/02 claim 3), so the JSON
// frames here ARE the normalized events — camelCase `type` strings like `session-update`,
// `response-create`, never OpenAI wire names like `session.update`.
//
// Importable as a module (`startFakeGateway`) for `test/harness.test.ts` (T10.6) and runnable
// standalone: `node --import tsx test/fakes/fake-gateway.ts [--port <n>] [--scenario a,b,c]`.

import { WebSocketServer, type WebSocket as WSClient } from 'ws';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Scenario flags (Spec 10 R9's scripted-anomaly + barge-in/tool-call behaviors). */
export interface FakeGatewayScenario {
  /** Emits a benign `error` event shortly after `session-updated` (R9 anomaly 1). */
  benignError?: boolean;
  /** Emits one JSON-ARRAY text frame shortly after `session-updated` (R9 anomaly 2 / S13). */
  arrayFrame?: boolean;
  /** Emits an unmapped `custom {rawType:'rate_limits.updated'}` event (R9 anomaly 3). */
  unmappedCustom?: boolean;
  /** Mid-VAD-turn-audio, emits `speech-started` and expects a `conversation-item-truncate`
   *  reply, acking via `custom` then `response-done {status:'cancelled'}` (R9 barge-in script). */
  bargeIn?: boolean;
  /** Serves the greeting `response-create` as a scripted tool call (`verify_identity`/Kevin) instead of
   *  plain audio, then a follow-up audio response once the client's gated `response-create`
   *  arrives (R9 tool-call script). */
  toolCall?: boolean;
  /**
   * T10.6 follow-up (Spec 10 A6/R12(e)): only meaningful paired with `bargeIn`. Sends the
   * barge-in-eligible response's ENTIRE pre-interrupt audio-delta run back-to-back at cadence
   * ~0 (`BURST_DELTA_COUNT` frames, one event-loop tick apart) instead of the default single
   * delta at `DELTA_CADENCE_MS`. See the doc comment on `BURST_DELTA_COUNT` below for why this
   * is necessary: without it, the caller-driven fake-twilio client's simulated playback
   * backlog never exceeds zero by the time the scripted interrupt fires, so the truncate epoch
   * always finds itself already disarmed (no bug — see `test/harness.test.ts`'s FINDING/
   * RESOLUTION comment on the barge-in scenario). Existing scenarios (this flag unset) are
   * byte-for-byte untouched — the burst branch is only reachable when this flag is `true`.
   */
  deltaBurst?: boolean;
}

export interface StartFakeGatewayOptions {
  port?: number;
  scenario?: FakeGatewayScenario;
}

export interface FakeGatewayHandle {
  port: number;
  /** Every client→server frame received, JSON-parsed, in arrival order (object OR array — the
   *  array-frame contract is a property of the CLIENT here, not this field; this fake's own
   *  array-frame anomaly is server→client only, per R9). */
  received: unknown[];
  close(): Promise<void>;
}

const FIRST_MESSAGE_TIMEOUT_MS = 5000; // mirrors the real gateway's 30 s rule, scaled down for tests (findings/01 claim 8)
const DELTA_CADENCE_MS = 50; // findings/04 D2
const VAD_TRIGGER_APPEND_COUNT = 25; // R9: "after receiving ≥25 input-audio-append frames"
const SILENCE_FRAME_B64 = Buffer.alloc(160, 0xff).toString('base64'); // 160 B 0xFF mu-law silence

/**
 * `scenario.deltaBurst` count (T10.6 follow-up, Spec 10 A6/R12(e)). fake-twilio.ts models
 * simulated playback with a single running `playheadAtMs` counter that only ever advances by
 * bytes actually received, starting from the moment the Twilio WS opens — so by the time the
 * VAD-triggered response's first delta is sent (after the fixed ~500 ms VAD_TRIGGER_APPEND_COUNT
 * wait plus test-harness bootstrap), that counter is already 800 ms-1 s behind real elapsed
 * time (empirically measured by polling the live Session while running this exact scenario —
 * see test/harness.test.ts's comment on the barge-in describe block). One 20 ms delta can never
 * close an ~1 s deficit, so its mark echoes back (drains the epoch) within single-digit ms —
 * long before any later scripted step. `BURST_DELTA_COUNT` frames sent back-to-back (2000 ms of
 * simulated audio) comfortably out-runs that deficit, leaving fake-twilio's simulated buffer
 * genuinely non-empty ("plays behind what's been delivered") when the interrupt fires shortly
 * after — the state Session.markQueue/responseStartTimestamp need to be non-empty/armed for a
 * real conversation-item-truncate to be produced.
 */
const BURST_DELTA_COUNT = 100;

/**
 * S5 ASSUMPTION (Spec 10 R9, verbatim from the spec's jsonc block): this exact `session.updated`
 * raw shape has NOT been observed live through the gateway — M1-02 is the runtime spike that
 * confirms (or corrects) it. Update this fixture to the observed shape once a real call's
 * `session-updated.raw` is logged (Spec 10 §Open items: "the fake-gateway session-updated.raw
 * fixture shape is an S5 assumption ... update the fixture to the observed shape after M1-02").
 */
const SESSION_UPDATED_RAW_FIXTURE = {
  type: 'session.updated',
  event_id: 'evt_1',
  session: {
    type: 'realtime',
    model: 'gpt-realtime-2.1',
    audio: {
      input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
      output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
    },
  },
};

/** Minimal shape used to switch on incoming client frames without importing the SDK's types
 *  (this fake deliberately has zero dependency on `@ai-sdk/*` — it only speaks the wire JSON). */
interface InboundFrame {
  type?: string;
  itemId?: string;
  contentIndex?: number;
  audioEndMs?: number;
  [key: string]: unknown;
}

export async function startFakeGateway(opts: StartFakeGatewayOptions = {}): Promise<FakeGatewayHandle> {
  const scenario = opts.scenario ?? {};
  const received: unknown[] = [];

  const wss = new WebSocketServer({ port: opts.port ?? 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  const addr = wss.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  wss.on('connection', (ws: WSClient) => handleConnection(ws, scenario, received));

  return {
    port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

function handleConnection(ws: WSClient, scenario: FakeGatewayScenario, received: unknown[]): void {
  let gotFirstMessage = false;
  let appendCount = 0;
  let vadFired = false;
  let greeted = false;
  let toolCallPending = false;
  let toolFollowupSent = false;
  let expectingTruncate = false;
  let bargeInItemId: string | undefined;
  let bargeInResponseId: string | undefined;

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const send = (ev: unknown): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
  };

  const firstMessageTimer = setTimeout(() => {
    if (!gotFirstMessage) ws.close(1008, 'no session-update within 5s of connect');
  }, FIRST_MESSAGE_TIMEOUT_MS);

  ws.on('close', () => clearTimeout(firstMessageTimer));

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return; // malformed client JSON is not this fake's contract to validate
    }
    received.push(parsed);
    const frames = (Array.isArray(parsed) ? parsed : [parsed]) as InboundFrame[];

    for (const ev of frames) {
      if (!gotFirstMessage) {
        gotFirstMessage = true;
        clearTimeout(firstMessageTimer);
        if (ev.type !== 'session-update') {
          ws.close(1008, 'first client message must be session-update');
          return;
        }
        void onSessionUpdate();
        continue;
      }

      switch (ev.type) {
        case 'input-audio-append':
          appendCount++;
          if (!vadFired && appendCount >= VAD_TRIGGER_APPEND_COUNT) {
            vadFired = true;
            void runVadTurn();
          }
          break;

        case 'response-create':
          if (!greeted) {
            greeted = true;
            void runGreeting();
          } else if (toolCallPending && !toolFollowupSent) {
            toolFollowupSent = true;
            void runAudioResponse('resp_followup', { allowBargeIn: false });
          }
          break;

        case 'conversation-item-truncate':
          if (expectingTruncate) {
            expectingTruncate = false;
            void ackTruncate(ev);
          }
          break;

        default:
          break; // conversation-item-create, response-cancel, etc. — observed via `received` only
      }
    }
  });

  async function onSessionUpdate(): Promise<void> {
    send({ type: 'session-created', sessionId: 'sess_fake', raw: {} });
    await wait(5);
    send({ type: 'session-updated', raw: SESSION_UPDATED_RAW_FIXTURE });

    // Scenario anomalies fire once, shortly after session-updated — independent of the main
    // greeting/VAD/barge-in/tool-call script (R9: "each behind a scenario flag").
    if (scenario.benignError) {
      await wait(10);
      send({
        type: 'error',
        message: 'Cancellation failed: no active response found',
        code: 'response_cancel_not_active',
        raw: {},
      });
    }
    if (scenario.arrayFrame) {
      await wait(10);
      // A literal JSON-array text frame (findings/02 claim 4 / S13) — bypasses `send()`'s
      // single-object stringify on purpose.
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify([
            { type: 'custom', rawType: 'conversation.created', raw: {} },
            { type: 'custom', rawType: 'conversation.item.retrieved', raw: {} },
          ]),
        );
      }
    }
    if (scenario.unmappedCustom) {
      await wait(10);
      send({ type: 'custom', rawType: 'rate_limits.updated', raw: { rate_limits: [] } });
    }
  }

  async function runGreeting(): Promise<void> {
    const responseId = 'resp_greet';
    if (scenario.toolCall) {
      toolCallPending = true; // set synchronously (before the first await) — see runToolCallScript
      await runToolCallScript(responseId);
      return;
    }
    await runAudioResponse(responseId, { allowBargeIn: false });
  }

  async function runVadTurn(): Promise<void> {
    send({ type: 'speech-started', raw: {} });
    await wait(5);
    send({ type: 'speech-stopped', raw: {} });
    await wait(5);
    send({ type: 'audio-committed', itemId: 'item_user_1', raw: {} });
    await wait(5);
    await runAudioResponse('resp_vad', { allowBargeIn: scenario.bargeIn === true });
  }

  /** D2 event order: response-created → output-item-added → N×audio-delta → transcript
   *  delta/done → audio-done → response-done{completed}. When `allowBargeIn`, the response is
   *  interrupted after its first delta instead of completing (R9 barge-in script). */
  async function runAudioResponse(responseId: string, opts: { allowBargeIn: boolean }): Promise<void> {
    const itemId = `item_${responseId}`;
    send({ type: 'response-created', responseId, raw: {} });
    await wait(DELTA_CADENCE_MS);
    send({ type: 'output-item-added', responseId, itemId, raw: {} });

    if (opts.allowBargeIn && scenario.deltaBurst) {
      // Burst mode (see BURST_DELTA_COUNT's doc comment): send the FULL pre-interrupt
      // audio-delta run back-to-back at cadence ~0 (one event-loop tick apart), instead of the
      // single default-cadence delta below. Only reachable when scenario.deltaBurst is set —
      // every other scenario (including bargeIn without deltaBurst) is untouched by this branch.
      for (let i = 0; i < BURST_DELTA_COUNT; i++) {
        send({ type: 'audio-delta', responseId, itemId, delta: SILENCE_FRAME_B64, raw: {} });
        await wait(0); // one tick — lets fake-twilio's ws actually receive/process each frame in order
      }
      // A short real-time gap before the interrupt so a few genuine inbound Twilio frames land
      // in between (Session.latestMediaTimestamp advances), giving a small, plausible, NONZERO
      // audioEndMs at truncate time rather than exactly 0 (findings/04 V3: a plausible ongoing
      // truncate, not an edge case).
      await wait(DELTA_CADENCE_MS);
      send({ type: 'speech-started', raw: {} });
      bargeInItemId = itemId;
      bargeInResponseId = responseId;
      expectingTruncate = true;
      return;
    }

    const deltaCount = 3;
    for (let i = 0; i < deltaCount; i++) {
      await wait(DELTA_CADENCE_MS);
      if (opts.allowBargeIn && i === 1) {
        send({ type: 'speech-started', raw: {} });
        bargeInItemId = itemId;
        bargeInResponseId = responseId;
        expectingTruncate = true;
        return; // the rest of this response's script is replaced by ackTruncate below
      }
      send({ type: 'audio-delta', responseId, itemId, delta: SILENCE_FRAME_B64, raw: {} });
    }
    await wait(DELTA_CADENCE_MS);
    send({ type: 'audio-transcript-delta', responseId, itemId, delta: 'ok', raw: {} });
    await wait(5);
    send({ type: 'audio-transcript-done', responseId, itemId, transcript: 'ok', raw: {} });
    await wait(5);
    send({ type: 'audio-done', responseId, itemId, raw: {} });
    await wait(5);
    send({ type: 'response-done', responseId, status: 'completed', raw: {} });
  }

  /** Validates {itemId, contentIndex:0, audioEndMs≥0} (R9) — mirrors OpenAI's real "audio_end_ms
   *  greater than actual duration -> error" behavior (findings/04 V3) rather than blindly acking. */
  async function ackTruncate(ev: InboundFrame): Promise<void> {
    const valid =
      ev.itemId === bargeInItemId &&
      ev.contentIndex === 0 &&
      typeof ev.audioEndMs === 'number' &&
      ev.audioEndMs >= 0;
    if (!valid) {
      send({
        type: 'error',
        message: `truncate validation failed for item ${String(ev.itemId)}`,
        code: 'truncate_out_of_range',
        raw: {},
      });
      return;
    }
    // The ack arrives as `custom` (findings/04 V9) — never a normalized event.
    send({
      type: 'custom',
      rawType: 'conversation.item.truncated',
      raw: {
        type: 'conversation.item.truncated',
        item_id: ev.itemId,
        content_index: ev.contentIndex,
        audio_end_ms: ev.audioEndMs,
      },
    });
    await wait(5);
    send({
      type: 'response-done',
      responseId: bargeInResponseId ?? 'resp_vad',
      status: 'cancelled',
      raw: { response: { status_details: { reason: 'turn_detected' } } },
    });
  }

  /** response-created → output-item-added → function-call-arguments-done('verify_identity', Kevin) →
   *  response-done{completed}. The client's `conversation-item-create` + gated single
   *  `response-create` follow-up is served by the `response-create` case above
   *  (findings/04 G7 — exactly one gated response-create is a TEST-side assertion over
   *  `received`, not something this fake enforces itself). */
  async function runToolCallScript(responseId: string): Promise<void> {
    const itemId = `item_${responseId}`;
    send({ type: 'response-created', responseId, raw: {} });
    await wait(DELTA_CADENCE_MS);
    send({ type: 'output-item-added', responseId, itemId, raw: {} });
    await wait(DELTA_CADENCE_MS);
    send({
      type: 'function-call-arguments-done',
      responseId,
      itemId,
      callId: 'call_1',
      name: 'verify_identity',
      arguments: '{"name":"Kevin"}',
      raw: {},
    });
    await wait(5);
    send({ type: 'response-done', responseId, status: 'completed', raw: {} });
  }
}

// ── CLI entry: `node --import tsx test/fakes/fake-gateway.ts [--port <n>] [--scenario a,b,c]` ──

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

function parseCliArgs(argv: string[]): StartFakeGatewayOptions {
  const opts: StartFakeGatewayOptions = {};
  const portIdx = argv.indexOf('--port');
  if (portIdx !== -1 && argv[portIdx + 1]) opts.port = Number(argv[portIdx + 1]);
  const scenarioIdx = argv.indexOf('--scenario');
  const scenarioArg = scenarioIdx !== -1 ? argv[scenarioIdx + 1] : undefined;
  if (scenarioArg) {
    const scenario: FakeGatewayScenario = {};
    for (const flag of scenarioArg.split(',')) {
      (scenario as Record<string, boolean>)[flag.trim()] = true;
    }
    opts.scenario = scenario;
  }
  return opts;
}

if (isDirectRun()) {
  startFakeGateway(parseCliArgs(process.argv.slice(2)))
    .then((handle) => {
      // eslint-disable-next-line no-console
      console.log(`fake-gateway listening on ws://127.0.0.1:${handle.port}`);
    })
    .catch((err: unknown) => {
      console.error('fake-gateway failed to start', err);
      process.exitCode = 1;
    });
}

// T10.5 — fake Twilio Media Streams WS client (Spec 10 R11).
//
// Drives the real bridge exactly as Twilio would: signs and POSTs `/twiml` like the Twilio
// webhook backend, then opens the bidirectional `/twilio-media` WS and speaks the exact wire
// schemas from findings/03 claims 4-5 (all numeric-looking fields are STRINGS on the wire).
//
// Importable as a module (`runFakeCall`) for `test/harness.test.ts` (T10.6) and runnable
// standalone: `node --import tsx test/fakes/fake-twilio.ts --base-url http://127.0.0.1:<port>
// --auth-token <token> --public-host localhost:<port>`.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import twilio from 'twilio'; // default-import + destructure: safe under both ESM and CJS emit (twilio is a CJS package)
const { getExpectedTwilioSignature } = twilio;

const MEDIA_FRAME_MS = 20; // findings/03 claim 8 — the observed (not contractual) inbound cadence
const SILENCE_FRAME_B64 = Buffer.alloc(160, 0xff).toString('base64'); // digital silence, mu-law/8000

export interface CallScript {
  /** Number of 20 ms inbound silence frames to stream. Default 30 — comfortably over the
   *  fake-gateway's ≥25-frame VAD-turn trigger (Spec 10 R9). */
  mediaFrameCount?: number;
  /** Wall-clock settle time after the last media frame, before `stop`+close, to let any
   *  in-flight bridge → Twilio traffic (audio-delta, marks) arrive and be captured. */
  postMediaWaitMs?: number;
}

export interface RunFakeCallOptions {
  /** e.g. `http://127.0.0.1:3000` — where the real Fastify app under test is listening. */
  baseUrl: string;
  authToken: string;
  /** Bare host (e.g. `localhost:3000`) — MUST match the app's `config.publicHost` so the
   *  `/twiml` signature this fake computes matches what the app validates (findings/03 claim 15). */
  publicHost: string;
  script?: CallScript;
}

export interface MarkCapture {
  name: string;
  receivedAtMs: number;
  echoedAtMs?: number;
}

export interface CallCapture {
  callSid: string;
  streamSid: string;
  token: string;
  /** Every outbound `media` message the bridge sent to this fake, in arrival order. */
  media: Array<{ payload: string; receivedAtMs: number }>;
  /** Every outbound `mark` message the bridge sent, with the (simulated) echo time if any. */
  marks: MarkCapture[];
  /** Every outbound `clear` message the bridge sent. */
  clears: Array<{ receivedAtMs: number }>;
  startedAtMs: number;
  endedAtMs: number;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** wss URL for the `/twilio-media` route, matching `baseUrl`'s scheme (http→ws, https→wss). */
function wsUrlFor(baseUrl: string): string {
  const u = new URL(baseUrl);
  const wsScheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsScheme}//${u.host}/twilio-media`;
}

/**
 * R11.1: POST /twiml form-encoded with the standard webhook params, signed exactly like Twilio
 * signs it (findings/03 claim 15) — this exercises the app's signature validation AND token mint
 * as a side effect, not just the WS leg. Returns the per-call token parsed out of the TwiML.
 */
async function postTwiml(opts: RunFakeCallOptions, callSid: string): Promise<string> {
  const params: Record<string, string> = {
    CallSid: callSid,
    AccountSid: `ACfake${randomHex(16)}`,
    From: '+15550001',
    To: '+15550002',
    CallStatus: 'ringing',
    Direction: 'inbound',
  };
  const signUrl = `https://${opts.publicHost}/twiml`; // the URL the app signs against — never baseUrl's scheme/host
  const signature = getExpectedTwilioSignature(opts.authToken, signUrl, params);

  const res = await fetch(new URL('/twiml', opts.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: new URLSearchParams(params).toString(),
  });
  const xml = await res.text();
  if (!res.ok) {
    throw new Error(`fake-twilio: POST /twiml failed (${res.status}): ${xml.slice(0, 300)}`);
  }
  const match = /<Parameter\s+name="token"\s+value="([^"]+)"\s*\/>/.exec(xml);
  const token = match?.[1];
  if (!token) {
    throw new Error(`fake-twilio: no <Parameter name="token"> found in TwiML response: ${xml}`);
  }
  return token;
}

/**
 * Drives one full scripted call through the real bridge (Spec 10 R11 items 1-5) and returns the
 * captured outbound traffic + timings for assertions.
 */
export async function runFakeCall(opts: RunFakeCallOptions): Promise<CallCapture> {
  const script = opts.script ?? {};
  const mediaFrameCount = script.mediaFrameCount ?? 30;
  const postMediaWaitMs = script.postMediaWaitMs ?? 500;

  const callSid = `CAfake${randomHex(16)}`;
  const streamSid = `MZfake${randomHex(16)}`;

  const token = await postTwiml(opts, callSid);

  const ws = new WebSocket(wsUrlFor(opts.baseUrl));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const startedAtMs = Date.now();
  const capture: CallCapture = {
    callSid,
    streamSid,
    token,
    media: [],
    marks: [],
    clears: [],
    startedAtMs,
    endedAtMs: 0,
  };

  // R11.4 playback simulation state: Twilio "buffers and plays in order" at 8 bytes/ms
  // (findings/03 claim 6/7). `playheadAtMs` is the wall-clock time by which every byte sent so
  // far will have finished playing, assuming continuous playback from `startedAtMs`.
  let playheadAtMs = startedAtMs;
  const pendingMarkTimers = new Map<string, NodeJS.Timeout>();

  let seq = 1;
  const send = (msg: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    let msg: { event?: string; media?: { payload: string }; mark?: { name: string } };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case 'media': {
        const payload = msg.media?.payload ?? '';
        capture.media.push({ payload, receivedAtMs: Date.now() });
        const bytes = Buffer.from(payload, 'base64').length;
        playheadAtMs += bytes / 8; // 8 bytes/ms @ 8000 Hz mu-law
        break;
      }
      case 'mark': {
        const name = msg.mark?.name ?? '';
        const entry: MarkCapture = { name, receivedAtMs: Date.now() };
        capture.marks.push(entry);
        // Echo after the simulated remaining-buffer delay — the time until `playheadAtMs`
        // (the point by which all audio sent so far will have finished playing).
        const delay = Math.max(0, playheadAtMs - Date.now());
        const timer = setTimeout(() => {
          pendingMarkTimers.delete(name);
          entry.echoedAtMs = Date.now();
          send({ event: 'mark', sequenceNumber: String(seq++), streamSid, mark: { name } });
        }, delay);
        pendingMarkTimers.set(name, timer);
        break;
      }
      case 'clear': {
        capture.clears.push({ receivedAtMs: Date.now() });
        // R11.4: immediately echo EVERY pending mark and zero the simulated buffer.
        for (const [name, timer] of pendingMarkTimers) {
          clearTimeout(timer);
          const entry = capture.marks.find((m) => m.name === name && m.echoedAtMs === undefined);
          if (entry) entry.echoedAtMs = Date.now();
          send({ event: 'mark', sequenceNumber: String(seq++), streamSid, mark: { name } });
        }
        pendingMarkTimers.clear();
        playheadAtMs = Date.now();
        break;
      }
      default:
        break;
    }
  });

  // R11.2: connected, then start (customParameters.token, incrementing string sequenceNumber).
  send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
  send({
    event: 'start',
    sequenceNumber: String(seq++),
    streamSid,
    start: {
      accountSid: `ACfake${randomHex(16)}`,
      streamSid,
      callSid,
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      customParameters: { token },
    },
  });

  // R11.3: 20 ms inbound silence frames, string timestamp advancing by 20.
  let timestampMs = 0;
  let chunk = 1;
  for (let i = 0; i < mediaFrameCount; i++) {
    send({
      event: 'media',
      sequenceNumber: String(seq++),
      streamSid,
      media: {
        track: 'inbound',
        chunk: String(chunk++),
        timestamp: String(timestampMs),
        payload: SILENCE_FRAME_B64,
      },
    });
    timestampMs += MEDIA_FRAME_MS;
    await new Promise((resolve) => setTimeout(resolve, MEDIA_FRAME_MS));
  }

  await new Promise((resolve) => setTimeout(resolve, postMediaWaitMs));

  // R11.5: stop + close.
  send({
    event: 'stop',
    sequenceNumber: String(seq++),
    streamSid,
    stop: { accountSid: `ACfake${randomHex(16)}`, callSid },
  });
  for (const timer of pendingMarkTimers.values()) clearTimeout(timer);
  pendingMarkTimers.clear();
  await new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
    ws.close(1000, 'call ended');
    // ws may already be closed by the server (bridge closes on `stop`/teardown) — resolve either way.
    setTimeout(resolve, 500);
  });

  capture.endedAtMs = Date.now();
  return capture;
}

// ── CLI entry: node --import tsx test/fakes/fake-twilio.ts --base-url <url> --auth-token <t>
//    --public-host <host> ──

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  const baseUrl = argValue(argv, '--base-url');
  const authToken = argValue(argv, '--auth-token');
  const publicHost = argValue(argv, '--public-host');

  if (!baseUrl || !authToken || !publicHost) {
    console.log(
      'usage: node --import tsx test/fakes/fake-twilio.ts --base-url <http://host:port> ' +
        '--auth-token <TWILIO_AUTH_TOKEN> --public-host <host:port>',
    );
    process.exitCode = baseUrl || authToken || publicHost ? 1 : 0;
  } else {
    runFakeCall({ baseUrl, authToken, publicHost })
      .then((capture) => {
        // eslint-disable-next-line no-console
        console.log(
          `fake-twilio call complete: callSid=${capture.callSid} media=${capture.media.length} ` +
            `marks=${capture.marks.length} clears=${capture.clears.length}`,
        );
      })
      .catch((err: unknown) => {
        console.error('fake-twilio run failed', err);
        process.exitCode = 1;
      });
  }
}

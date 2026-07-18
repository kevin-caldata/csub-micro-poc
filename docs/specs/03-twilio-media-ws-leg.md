---
# Spec 03 — Twilio Media Streams WebSocket Leg (`WS /twilio-media`)
Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Draft for review
Depends on: 01 (scaffold/config/server boot), 02 (`POST /twiml` webhook + per-call token registry) · Enables: 04 (gateway WS leg), 05 (barge-in/session orchestration), 08 (latency instrumentation)
Findings referenced: findings/03 (claims 1, 4–8, 10–11, 14, Impl C/D, gotchas 3–8), findings/08 (V2–V5, V9, V11, V13, Impl "WS /twilio-media", backpressure, error/close matrix, gotchas 1, 8–11, 14), findings/04 (V7, D3, D4, G2, G4, correction 3), findings/06 (C11), findings/09 (§2 turn state machine, mark instrumentation), findings/10 (C4, C5, C15, T3, G7 pin note, S17, S19, S21–S23)
---

## Objective

When this spec is done, the bridge process exposes a `GET /twilio-media` WebSocket route (via `@fastify/websocket@11.3.0`) that accepts Twilio bidirectional Media Stream connections, authenticates each stream against the per-call token minted by `/twiml`, maintains a `Map<streamSid, Session>` registry with fully isolated per-call state, and provides the exact outbound `media`/`mark`/`clear` send helpers and close/error/backpressure handling the rest of the bridge builds on. Closing this WebSocket is the clean-hangup mechanism (TwiML `<Connect>` fall-through). No gateway logic lives here — this spec defines the Twilio-facing half of the Session and the hooks specs 04/05 attach to.

## Deliverables

Create:
- `D:\projects-linean\CSUB-RIO-POC\src\twilio-media.ts` — route registration function `registerTwilioMediaRoute(app, deps)`, inbound message dispatch, token gate, timeouts, outbound send helpers (`sendMedia`, `sendMark`, `sendClear`, `hangup`), close/error wiring.
- `D:\projects-linean\CSUB-RIO-POC\src\sessions.ts` — `Session` interface (Twilio-leg fields + declared extension points for specs 04/05), `createSession()`, the module-level `sessions: Map<string, Session>` registry, and idempotent `teardownSession()`.
- `D:\projects-linean\CSUB-RIO-POC\test\twilio-media.test.ts` — vitest (node environment, never jsdom — findings/10 G6) tests using `fastify.injectWS()` (findings/08 V4).

Modify:
- `D:\projects-linean\CSUB-RIO-POC\src\server.ts` — register `@fastify/websocket` with the options in R1; call `registerTwilioMediaRoute`.
- `D:\projects-linean\CSUB-RIO-POC\src\config.ts` — add `TWILIO_VALIDATE_UPGRADE` (boolean, default `false`).
- `package.json` — ensure `@fastify/websocket` is pinned **exactly** `11.3.0` (findings/08 V2; the `five` dist-tag is a legacy trap — never install it). Companion pins owned by other specs but consumed here: `fastify@5.10.0` (`^5` acceptable), `ws@8.21.1`, `twilio@6.0.2` exact (findings/10 C14).

## Requirements

### R1 — Plugin registration (server.ts)

Register `@fastify/websocket@11.3.0` on the Fastify 5 instance exactly as follows [findings/08 Impl "Server boot", V5, gotcha 14]:

```ts
import fastifyWebsocket from '@fastify/websocket';

await app.register(fastifyWebsocket, {
  options: {
    perMessageDeflate: false,     // server default is already false; explicit = documentation (findings/10 C15)
    maxPayload: 1 * 1024 * 1024,  // Twilio frames ~400 B JSON; 1 MB closes the pre-auth allocation hole; excess ⇒ ws closes 1009
  },
  errorHandler: (err, socket, _req, _reply) => {
    logEvent({ level: 'error', message: 'ws handler error', event: 'ws-error', err: String(err) });
    socket.terminate();
  },
});
```

Registration must be awaited before the route is declared. Do **not** pass `noServer` (plugin errors) or `path` (plugin warns) [findings/08 V4].

### R2 — Route declaration: v11 `(socket, req)` handler API

The route MUST use the `@fastify/websocket` v11 handler signature — `socket` is a plain `ws.WebSocket`, handshake already complete (101 sent) when the handler runs:

```ts
app.get('/twilio-media', { websocket: true }, (socket /* ws.WebSocket */, req /* FastifyRequest */) => { ... });
```

The legacy `(connection, req)` / `connection.socket` API is gone in v11; any code shaped that way is a build failure (`connection.socket is undefined`) [findings/08 V3, gotcha 1]. WS routes are GET-only; a plain (non-upgrade) HTTP GET to this route gets the plugin's 404 — Railway healthchecks must point at `/health`, never here [findings/08 gotcha 7].

`'error'` and `'close'` listeners MUST be attached synchronously inside the handler, before any awaits — an unhandled `'error'` event crashes the process and severs every concurrent call (FR-3 hazard) [findings/08 gotcha 10, error matrix].

### R3 — Inbound message parsing rules

- Twilio sends JSON **text** frames only. In the `'message'` handler `(data: Buffer, isBinary: boolean)`: if `isBinary`, ignore and return. Then `JSON.parse(data.toString())`; a parse failure logs once and returns (never throws out of the handler).
- **All numeric-looking fields are STRINGS** (`sequenceNumber`, `media.chunk`, `media.timestamp`) — convert with `Number(...)`. TypeScript types for these messages MUST declare them `string` [findings/03 claim 4, gotcha 4].
- Every message **after** `connected` carries top-level `streamSid` [findings/03 claim 4].
- Dispatch on `msg.event` ∈ `connected | start | media | mark | stop | dtmf`; unknown event names log once at debug and are ignored.

Verified inbound schemas (vendor these as TS types in `twilio-media.ts`) [findings/03 claim 4]:

```jsonc
// connected — first message; NO streamSid yet
{ "event": "connected", "protocol": "Call", "version": "1.0.0" }

// start — second message
{ "event": "start", "sequenceNumber": "1", "streamSid": "MZ...",
  "start": { "accountSid": "AC...", "streamSid": "MZ...", "callSid": "CA...",
    "tracks": ["inbound"],
    "mediaFormat": { "encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1 },
    "customParameters": { "token": "<per-call token>" } } }

// media — only track "inbound" ever arrives on a bidirectional stream
{ "event": "media", "sequenceNumber": "3", "streamSid": "MZ...",
  "media": { "track": "inbound", "chunk": "1", "timestamp": "160", "payload": "<b64 raw mu-law>" } }

// mark (echo)
{ "event": "mark", "sequenceNumber": "4", "streamSid": "MZ...", "mark": { "name": "r<respId>:<seq>" } }

// stop
{ "event": "stop", "sequenceNumber": "5", "streamSid": "MZ...", "stop": { "accountSid": "AC...", "callSid": "CA..." } }

// dtmf
{ "event": "dtmf", "streamSid": "MZ...", "sequenceNumber": "5", "dtmf": { "track": "inbound_track", "digit": "1" } }
```

Frame size/cadence is NOT contractual (~20 ms/160 B observed) — no code may assume exact sizes [findings/03 claim 8]. Log observed first-frame cadence once per call for spike S22.

### R4 — Per-message handling (state machine)

Follows findings/03 Impl D and findings/04 D4, exactly:

**`connected`** — no `streamSid` exists yet; send nothing, bridge nothing. On WS handler entry, arm a 5 s timer: if no `start` arrives within 5 s of upgrade, `socket.close(1008, 'no start')` [findings/03 Impl D timeout guards]. Clear the timer on `start`.

**`start`** — the auth gate and session birth:
1. Extract `msg.start.streamSid`, `msg.start.callSid`, `msg.start.customParameters?.token`, `msg.start.mediaFormat`.
2. **Verify the token BEFORE bridging any audio or attaching the gateway leg.** The token registry is built by spec 02 (`/twiml` mints a per-call `randomUUID()` token and stores `{ token → PendingCall { callSid, createdAt, gatewayAuth } }`, 60 s TTL, single-use — Spec 02 R5.2). Verification here = one call to Spec 02's `claimPendingCall(candidate)`, which checks TTL, enforces single-use, and compares **constant-time** (`crypto.timingSafeEqual` over SHA-256 digests so lengths always match) [findings/03 claim 11, Impl D step 2].
3. On failure (missing/unknown/expired/reused token): log `{event:'auth-fail', callSid}` and `socket.close(1008, 'bad token')` — 1008 = policy violation. **Never create a Session; never open/attach the gateway leg.** Closing the WS ends the call via `<Connect>` fall-through [findings/03 claim 1; findings/08 gotcha 8].
4. On success: `const session = createSession({ twilioWs: socket, streamSid, callSid, log })`; `sessions.set(streamSid, session)`; emit the `stream-start` log event (one line: `callSid`, `streamSid`, `mediaFormat`); invoke `deps.onSessionStart(session)` (spec 05 attaches the gateway leg here, via spec 04's `openGatewayLeg`).

**`media`** —
```ts
session.latestMediaTimestamp = Number(msg.media.timestamp);  // the caller-side playback clock (findings/04 V7, G9)
session.onTwilioMedia?.(msg.media.payload);                   // hook installed by spec 05: input-audio-append (Path A) or DSP→append (Path B)
```
Never log per frame (Railway 500 lines/s cap) [findings/09 rules]. Only `track:"inbound"` arrives on bidirectional streams [findings/03 claim 4].

**`mark`** — remove-by-name ONLY, tolerant of unknown/late names [findings/04 G2, D4; findings/10 C4]:
```ts
const i = session.markQueue.indexOf(msg.mark.name);
if (i !== -1) session.markQueue.splice(i, 1);      // NEVER a bare shift()
if (session.markQueue.length === 0) session.onPlaybackDrained?.();  // spec 05: resets responseStartTimestamp (stale-epoch fix, findings/04 G1)
if (isFirstMarkOfResponse(msg.mark.name)) session.onFirstMarkEcho?.(msg.mark.name); // spec 08: tFirstMarkEcho
```
**Mark-echo-on-clear semantics (normative):** Twilio echoes ALL pending marks back after a `clear` — a mark echo received after a `clear` means "flushed", NOT "played". Unknown/late names MUST be silently ignored (no throw, no queue corruption); non-first echoes are never logged [findings/03 claim 16.3, gotcha 3; findings/04 V7; findings/09 rules].

**`stop`** — the call/stream ended from Twilio's side: emit `stream-stop` (spec 08 adds the call-summary payload), then `teardownSession(session)` (R8). Note the WS `'close'` event will also fire; teardown is idempotent.

**`dtmf`** — log one line `{event:'dtmf', digit}` only; no other action (PoC scope, BRD §5.4 note in findings/03 claim 4).

### R5 — Outbound message contracts (send helpers)

Implement in `twilio-media.ts`, each guarded by `socket.readyState === WebSocket.OPEN` (send on CLOSING/CLOSED doesn't throw but errors via callback — guard anyway) [findings/08 Impl]:

```ts
// media — raw mu-law/8000 base64, NO file/WAV header bytes (garbled audio otherwise, findings/03 gotcha 5)
sendMedia(session, payloadB64: string): void
  → socket.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: payloadB64 } }))

// mark — UNIQUE per-response names; see naming rule below
sendMark(session, name: string): void
  → socket.send(JSON.stringify({ event: 'mark', streamSid: session.streamSid, mark: { name } })); session.markQueue.push(name)

// clear — flush Twilio's playback buffer (barge-in step 1); triggers the mark-echo storm handled in R4
sendClear(session): void
  → socket.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }))
```

- **No outbound pacing or re-framing.** Twilio accepts `media` payloads of ANY size, buffers, and plays in order — forward each gateway `audio-delta` payload as one `media` message the instant it arrives; never batch, never chunk to 160-byte frames, never sleep [findings/03 claims 5/7; findings/06 C11; findings/10 C8].
- **Mark naming rule (decides findings/10 T3):** one namespace — `r<responseId>:<seq>` with a per-session monotonically increasing `markSeq`, one mark sent immediately after each `sendMedia` [findings/04 D4]. The **first** mark of each response (`:<seq>` where seq was captured at that response's first delta) doubles as the `tFirstMarkEcho` instrumentation point; no separate `t<turn>-first` mark exists. `isFirstMarkOfResponse` is implemented by tracking the first mark name issued per `responseId`. Revisit granularity (mark every Nth delta) only after spike S17 shows delta cadence.
- No `track` field on outbound sends [findings/03 claim 5].

### R6 — Backpressure guard on the outbound path

Checked before **every** `sendMedia` (gateway produces faster than realtime; a stalled Twilio socket queues unboundedly in process memory) [findings/08 "Backpressure" + V13]:

```ts
const MAX_BUFFERED = 1_000_000; // ~1 MB ≈ 25 s of mu-law queued locally — call unrecoverable
if (socket.bufferedAmount > MAX_BUFFERED) {
  session.log.warn({ buffered: socket.bufferedAmount }, 'twilio leg backpressure — dropping call');
  socket.close(1011, 'backpressure');   // 'close' handler performs teardown
  return;
}
```

`bufferedAmount` = kernel-unflushed writable bytes + sender-queued bytes. Include its final value in the `stream-stop` summary line to catch creep. Do NOT implement any pacing/queueing as a "fix" — forward-immediately is the design; Twilio is the pacer.

### R7 — Close/error handling and clean hangup

- **All teardown lives in the `'close'` handler** — single, idempotent path. `'error'` handlers log only (ws always emits `'close'` after `'error'`) [findings/08 error matrix rule, gotcha 10].
- `'close'` listener signature is `(code: number, reason: Buffer)` — call `reason.toString()` before logging [findings/08 V13, gotcha 9].
- `teardownSession(session)` (in `sessions.ts`): idempotent (guard with a `tornDown` flag); clears the start-timeout; calls `session.onTeardown?.()` (spec 05 closes the gateway leg with code 1000 and the per-call MCP client); `sessions.delete(session.streamSid)` — mandatory on every path or the SIGTERM drain loop never completes [findings/08 shutdown notes].
- **Clean hangup mechanism (normative for FR-7):** with the PoC TwiML (`<Response><Connect><Stream/></Connect></Response>`, nothing after `</Connect>`), the bridge closing the Twilio WS makes `<Connect>` finish, TwiML fall through, and **the call end** — this IS how the bridge hangs up [findings/03 claim 1]. `hangup(session, code = 1000, reason = 'bye')` = `socket.close(code, reason)`. Use 1000 for deliberate hangup, 1001 during SIGTERM shutdown (spec on drain), 1008 auth failure, 1011 backpressure/internal fault.
- Corollary: an unhandled exception that kills the socket hangs up on the caller — every per-session handler body is wrapped so exceptions log and (only if the session is unrecoverable) close deliberately [findings/03 gotcha 7].
- Close-code interpretation for the summary log [findings/08 error/close matrix]: 1000/1005 after a `stop` event = normal hangup; 1006 with no `stop` = network drop/Twilio abort → flag `abnormal: true` in the `stream-stop` summary.

### R8 — Optional defense-in-depth: upgrade-signature validation (config-flagged, log-only)

Primary auth is the R4 token gate — this requirement never replaces it. Behind env `TWILIO_VALIDATE_UPGRADE` (parsed as `config.twilioValidateUpgrade`, default `false`), and **log-only in the PoC** (never reject on mismatch), executed at WS handler entry [findings/03 claim 10, Impl C; findings/10 C5]:

```ts
import twilio from 'twilio';                // default-import + destructure: safe under both ESM and
const { validateRequest } = twilio;         // CJS emit (twilio@6.0.2 is CJS — same pattern as Spec 02 R5.1)

const sig = req.headers['x-twilio-signature'] as string | undefined;  // Node lowercases; Twilio doc: WS header IS lowercase
// Always log header presence — this is spike S21's data point:
logEvent({ level: 'info', message: 'x-twilio-signature on upgrade', event: 'upgrade-signature', present: !!sig });
if (config.twilioValidateUpgrade && sig) {
  const host = config.publicHost;                        // PUBLIC_HOST ?? RAILWAY_PUBLIC_DOMAIN — NEVER req.hostname (findings/03 gotcha 8; Spec 01 R5)
  const wssUrl = `wss://${host}/twilio-media`;           // scheme MUST be wss (Twilio signs the TwiML URL), NOT https
  const ok = validateRequest(config.twilioAuthToken, sig, wssUrl, {});  // upgrade is a GET: params = {}
  logEvent({ level: 'info', message: 'upgrade signature validation (advisory)', event: 'upgrade-signature-check', ok });
}
```

Root cause of the classic pitfall: servers see the upgrade as `https://…` while Twilio signed `wss://…` — the scheme rewrite fixes it (twilio-labs/twilio-aspnet#162) [findings/03 claim 10]. Under ngrok local dev the host differs again — one more reason this stays advisory [findings/03 gotcha 13].

### R9 — Session interface and registry (`sessions.ts`)

```ts
import type { WebSocket } from 'ws';

export interface Session {
  // owned by this spec (Twilio leg)
  twilioWs: WebSocket;
  streamSid: string;
  callSid: string;
  latestMediaTimestamp: number;          // ms; ← every inbound media.timestamp (Number()ed)
  markQueue: string[];                   // mark names sent, not yet echoed; length>0 ⇒ audio buffered/playing at Twilio
  markSeq: number;                       // monotonic; unique mark names r<responseId>:<seq>
  tornDown: boolean;
  log: (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;
                                         // wrapper over the shared logger (Spec 01 R12 / Spec 08 R1) with
                                         // { callSid, streamSid } pre-bound — Fastify runs logger:false, so
                                         // req.log is a no-op and MUST NOT be used for structured events
  /** Implements Spec 02's SessionHandle: delegates to teardownSession(this, reason). */
  teardown(reason: string): void;
  // extension points — installed by later specs, typed here as optional callbacks
  onTwilioMedia?: (payloadB64: string) => void;   // spec 05 (gateway append / DSP)
  onPlaybackDrained?: () => void;                  // spec 05 (barge-in epoch reset)
  onFirstMarkEcho?: (name: string) => void;        // spec 08 (tFirstMarkEcho)
  onTeardown?: () => void;                         // specs 05/07 (close gateway leg, MCP client)
  // fields OWNED by specs 04/05/07/08 but declared here so the object shape is stable:
  responseStartTimestamp: number | null;
  currentResponseId: string | null;
  lastAssistantItemId: string | null;
  responseActive: boolean;
  pendingToolCalls: Map<string, unknown>;
  timestamps: Record<string, number>;
  dspState?: unknown;
}

// ONE process-wide map: this MUST be (or re-export) Spec 02's src/state.ts `sessions` instance
// (master plan R-2 — two Map instances would break the SIGTERM drain). Session implements SessionHandle.
export const sessions = new Map<string, Session>();
export function createSession(init: {...}): Session;   // initializes: latestMediaTimestamp=0, markQueue=[], markSeq=0, responseStartTimestamp=null, ... (findings/04 D3/D4 'start' case)
export function teardownSession(s: Session): void;      // R7 semantics
```

Per-call isolation is structural: no module-level state other than the `sessions` Map; every handler closes over its own `session` (BRD FR-3, §5.8). The Map is also the SIGTERM drain's completion signal (spec on shutdown) — `sessions.delete` on every teardown path is load-bearing.

### R10 — Logging discipline (interface to spec 08)

This spec emits exactly these structured events via the shared logger: `stream-start`, `auth-fail`, `dtmf`, `upgrade-signature`, `upgrade-signature-check`, `ws-error`, `stream-stop` (with `code`, `reason`, `abnormal`, final `bufferedAmount`). NEVER logged: `media` frames, individual mark echoes (except through the `onFirstMarkEcho` hook), per-delta sends [findings/09 rules; BRD §5.9]. All fields flat and top-level for Railway Log Explorer filtering.

## Acceptance criteria

All checkable via vitest + `fastify.injectWS('/twilio-media')` (findings/08 V4) with a stub token registry, unless noted.

- **A1 (auth happy path):** send `connected` then `start` with a valid unclaimed token → a Session exists in `sessions` keyed by the exact `streamSid` from the start message; `deps.onSessionStart` was invoked once; `stream-start` logged once.
- **A2 (auth gate — primary, maps FR-7 "never bridge unauthenticated"):** `start` with a missing, unknown, expired, or **reused** token → socket closes with code **1008**, `sessions` stays empty, `onSessionStart` never called. Token comparison code path uses `crypto.timingSafeEqual` (assert by code review/unit test of the compare helper).
- **A3 (start timeout):** open the WS, send only `connected` (or nothing) → socket closed with 1008 within ~5 s (use fake timers).
- **A4 (string numerics):** a `media` message with `timestamp: "12345"` results in `session.latestMediaTimestamp === 12345` (number). The TS types declare `timestamp`/`sequenceNumber`/`chunk` as `string`.
- **A5 (mark semantics, maps findings/10 C4):** with `markQueue = ['rA:1','rA:2']`: echo `rA:1` → queue `['rA:2']`; echo unknown name `zz` → queue unchanged, no throw; echo `rA:2` → queue `[]` and `onPlaybackDrained` fired exactly once. A bare `shift()` appears nowhere in the mark path.
- **A6 (outbound contracts):** `sendMedia`/`sendMark`/`sendClear` produce byte-exact JSON `{"event":"media","streamSid":...,"media":{"payload":...}}`, `{"event":"mark","streamSid":...,"mark":{"name":...}}`, `{"event":"clear","streamSid":...}`; no `track` field outbound; `sendMark` pushes the name onto `markQueue`; helpers no-op (without throwing) when `readyState !== OPEN`.
- **A7 (no pacing):** a 100 KB payload is sent as ONE `media` message; grep-level check that no timer/sleep/re-chunking exists on the outbound path.
- **A8 (backpressure):** with `bufferedAmount` stubbed > 1,000,000, the next `sendMedia` closes the socket with **1011** and does not send.
- **A9 (teardown):** on client close (and separately on `stop`), `teardownSession` runs once even if both paths fire, `sessions.delete` happened, `onTeardown` called once, `stream-stop` logged with `code`/`reason` string (Buffer converted). `'error'` on the socket alone does NOT tear down (close does, immediately after) and never crashes the process.
- **A10 (isolation, maps FR-3):** two concurrent injected WS connections with distinct streamSids produce two independent Sessions; media on one never mutates the other; closing one leaves the other live.
- **A11 (upgrade validation flag):** default config → no `validateRequest` call on upgrade; header presence still logged. With `TWILIO_VALIDATE_UPGRADE=true` and a mismatching signature → connection still proceeds (log-only), and the logged URL used was `wss://<PUBLIC_HOST>/twilio-media` with `{}` params.
- **A12 (route hygiene):** binary frames and unparseable text frames are ignored without teardown; plain HTTP GET to `/twilio-media` returns 404; handler signature is `(socket, req)` (v11) — no `connection.socket` anywhere in the repo.
- **A13 (live, M1):** on the first deployed call, `stream-start` shows `mediaFormat {audio/x-mulaw, 8000, 1}`, hanging up produces `stop` → `stream-stop` with a normal close code, and bridge-initiated `hangup()` audibly ends the call (Connect fall-through) — FR-7 clean-hangup evidence.

## Out of scope

- `POST /twiml` webhook, signature validation of the webhook, TwiML generation, and the token **minting**/registry implementation (spec 02 — this spec only consumes `claimPendingCall`).
- The gateway WS leg (spec 04), `input-audio-append` forwarding, and everything sent TO the gateway (spec 05). This spec installs `session.onTwilioMedia` as a hook only.
- Barge-in decision logic (`speech-started` handling, truncate math, `responseStartTimestamp` lifecycle) — spec 05. This spec provides `sendClear`, the mark queue, `latestMediaTimestamp`, and the `onPlaybackDrained` hook it needs.
- DSP/transcoding (Path B) — spec 06; the mu-law payload passes through this leg opaque in both directions.
- SIGTERM drain orchestration and the `onRequest` drain gate (spec 02) — but `sessions` Map + 1001 close code defined here are its inputs.
- The optional `/stream-status` log-only route and `<Stream statusCallback>` attribute (findings/03 Impl E) — owned by spec 02 alongside the TwiML; recommended for S19 evidence.
- Spoken-fallback (canned mu-law apology clip) design for FR-7 — findings/10 G4; this spec delivers only the clean-hangup half.

## Open items deferred to runtime spikes (findings/10 Part 4)

- **S19** — caller-experience timing on WS handshake failure and mid-call bridge drop (dead-air window before fall-through/hangup). Kill test at M1 with the spec-02 `statusCallback` attached.
- **S21** — whether `x-twilio-signature` is present on every Media Streams upgrade. The R8 `upgrade-signature` log line collects this on every call; only after it's confirmed may `TWILIO_VALIDATE_UPGRADE` ever graduate from log-only.
- **S22** — Twilio handshake timeout, max accepted inbound media size, and actual inbound frame cadence on this account/region (expect 20 ms/160 B). One log line from M1 media timestamps.
- **S23 (first half)** — whether a canned mu-law clip sent immediately before `twilioWs.close()` reliably plays (feeds the G4 spoken-fallback decision; 10-minute M1 probe).
- **S17** — gateway `audio-delta` chunk cadence: if deltas are tiny, revisit mark-per-delta granularity (mark every Nth delta) per findings/10 T3; the remove-by-name queue is already correct at any granularity.
- **S20** — Twilio account upgraded/approved (human console check) — gates the A10-at-scale parallel-call test (FR-3) per findings/03 claim 12.

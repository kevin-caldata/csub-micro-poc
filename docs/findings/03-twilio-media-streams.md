# Findings 03 — Twilio Media Streams + Voice Webhook Leg

**Date:** 2026-07-18
**Researcher:** Claude (research agent), independent verification of BRD §5.4, §5.6 (Twilio side), §6, §5.8/§5.9 (Twilio-adjacent)
**Scope:** TwiML `<Connect><Stream>` semantics, `<Parameter>` custom params, exact inbound/outbound WebSocket message schemas, audio format contract, frame cadence, Twilio-side buffering/pacing, `X-Twilio-Signature` validation (incl. the WS-upgrade pitfall), per-call token auth pattern, inbound concurrency, Media Streams limits, `<Stream>` failure behavior, and the `twilio` npm package (version + `validateRequest` API).
**Evidence base:** live fetches of official Twilio docs (July 2026), `twilio@6.0.2` installed from npm and source-read, a live Node round-trip test of TwiML generation + signature validation, and the twilio-labs GitHub issue documenting the WS-upgrade validation pitfall.

---

## Verified claims

### 1. `<Connect><Stream>` is the bidirectional form; TwiML blocks until the WS closes — **VERIFIED**

Official doc (https://www.twilio.com/docs/voice/twiml/stream):

- `<Start><Stream>`: unidirectional (listen-only); "While Twilio is setting up the Media Stream, it immediately continues with the next TwiML instruction. If no instruction follows, the Call disconnects."
- `<Connect><Stream>`: bidirectional; **"Twilio doesn't execute subsequent TwiML instructions" until your server closes the WebSocket connection.** When the WS closes, `<Connect>` finishes.
- `<Connect>` doc (https://www.twilio.com/docs/voice/twiml/connect): **"If you do not provide an `action` URL, `<Connect>` will finish and Twilio will move on to the next TwiML verb in the document. If there is no further verb, Twilio will end the phone call."**

Consequence for the PoC: with the BRD's TwiML (`<Response><Connect><Stream .../></Connect></Response>` and nothing after `</Connect>`), **the bridge closing the Twilio WS ends the call**. That is the clean-hangup mechanism for FR-7. If a spoken fallback via `<Say>` after stream failure is ever wanted, append verbs after `</Connect>` or use the `action` attribute (see §Implementation detail D).

### 2. Query strings on `url` are unsupported; use `<Parameter>` — **VERIFIED**

Exact doc wording (stream page): "The `url` *does not* support query string parameters. To pass custom key value pairs to the WebSocket, make use of Custom Parameters instead."

Corroborated by error 31920 docs (https://www.twilio.com/docs/api/errors/31920), which list "The `<Stream>` `url` includes query string parameters" as a cause of WebSocket handshake failure. So a query string doesn't just get ignored — **it can break the handshake entirely**. `wss` is the **only** supported scheme ("Twilio supports only `wss` for Media Streams"). The `url` may be relative or absolute.

### 3. `<Parameter>` values arrive in `start.customParameters` — **VERIFIED**

- TwiML: nested `<Parameter name="..." value="..."/>` elements inside `<Stream>`.
- Constraint (exact wording): **"The combined length of each `<Parameter>` `name` and `value` attributes must be under 500 characters."** (Per-parameter limit; no documented max parameter count.)
- They surface verbatim as a flat string→string object at `start.customParameters` in the `start` WS message (schema below). The BRD's per-call token pattern (`<Parameter name="token" value="..."/>` → verify in `start`) is fully supported.

### 4. Inbound WS message schemas — **VERIFIED** (exact, from https://www.twilio.com/docs/voice/media-streams/websocket-messages)

All messages are **JSON text frames**. All numeric-looking fields (`sequenceNumber`, `chunk`, `timestamp`) are **strings** — parse with `Number(...)`. Every message after `connected` carries a top-level `streamSid`.

**`connected`** — first message on WS establishment:
```json
{ "event": "connected", "protocol": "Call", "version": "1.0.0" }
```

**`start`** — second message; contains everything needed to key/authorize the session:
```json
{
  "event": "start",
  "sequenceNumber": "1",
  "start": {
    "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "streamSid":  "MZxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "callSid":    "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "tracks": [ "inbound" ],
    "mediaFormat": { "encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1 },
    "customParameters": { "token": "the-per-call-token" }
  },
  "streamSid": "MZxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```
Docs state `mediaFormat.encoding` "Value is always `audio/x-mulaw`", `sampleRate` "Value is always `8000`", `channels` "Value is always `1`". `sequenceNumber` starts at 1 and increments per message across the stream.

**`media`** — the audio frames:
```json
{
  "event": "media",
  "sequenceNumber": "3",
  "media": {
    "track": "inbound",
    "chunk": "1",
    "timestamp": "160",
    "payload": "<base64 raw mu-law bytes>"
  },
  "streamSid": "MZxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```
- `media.track`: `inbound` or `outbound` — for **bidirectional** streams you only ever receive `inbound` (the caller); the `track` TwiML attribute applies to unidirectional streams only ("bidirectional streams can only receive the `inbound_track`").
- `media.chunk`: "The first message will begin with 1 and increment with each subsequent message." Per-track counter.
- `media.timestamp`: "Presentation Timestamp in Milliseconds from the start of the stream" — this is the field the barge-in `audioEndMs` math consumes (`latestMediaTimestamp`).
- `media.payload`: "Raw audio encoded in base64" (mu-law bytes, no container/header).

**`mark`** (inbound echo; bidirectional streams only):
```json
{ "event": "mark", "sequenceNumber": "4", "streamSid": "MZ...", "mark": { "name": "my label" } }
```
"When that media message's playback is complete, Twilio sends a mark message to your server using the same mark.name as the one your server sent." **Nuance:** marks are ALSO echoed on `clear` (see claim 7) — an echoed mark does not always mean the audio played.

**`stop`** — stream stopped or call ended:
```json
{
  "event": "stop",
  "sequenceNumber": "5",
  "stop": { "accountSid": "AC...", "callSid": "CA..." },
  "streamSid": "MZ..."
}
```

**`dtmf`** (bidirectional streams only; not in the BRD but free to log):
```json
{ "event": "dtmf", "streamSid": "MZ...", "sequenceNumber": "5",
  "dtmf": { "track": "inbound_track", "digit": "1" } }
```

### 5. Outbound WS message schemas — **VERIFIED** (exact)

**`media`** (send audio to the caller):
```json
{ "event": "media", "streamSid": "MZ...", "media": { "payload": "<base64 raw mulaw/8000>" } }
```
- Docs: payload is "Raw mulaw/8000 audio encoded in base64". **"The media.payload should not contain audio file type header bytes. Providing header bytes causes the media to be streamed incorrectly."** (No WAV/AU headers.)
- Docs: **"The audio can be of any size."** — you are not required to send 20 ms frames outbound; forwarding each gateway `audio-delta` payload as-is (after transcode if Path B) is fine.
- No `track` field is needed/used on outbound sends for bidirectional streams.

**`mark`**:
```json
{ "event": "mark", "streamSid": "MZ...", "mark": { "name": "resp-42-chunk-7" } }
```
"Send a mark event message after sending a media event message to be notified when the audio that you have sent has been completed. Twilio sends back a mark event with a matching name when the audio ends."

**`clear`**:
```json
{ "event": "clear", "streamSid": "MZ..." }
```
"Send a clear message if you want to interrupt the audio that has been sent in various media messages. This empties all buffered audio and causes any mark messages to be sent back to your WebSocket server."

### 6. Audio format contract — **VERIFIED**

Both directions: `audio/x-mulaw`, 8000 Hz, 1 channel, base64-encoded raw bytes, no headers. Inbound is declared in `start.mediaFormat` (always those values); outbound must match ("Raw mulaw/8000").

### 7. Twilio-side buffering/pacing of outbound audio — **VERIFIED**

Docs: **"The media messages are buffered and played in the order received."** The bridge does NOT pace outbound audio to realtime — dump `audio-delta` chunks as fast as they arrive; Twilio plays them back at 8 kHz in order. This is exactly why `clear` exists (flush the Twilio-side buffer on barge-in) and why `mark` exists (know what was actually *played* vs merely *buffered*). BRD §5.4 "Twilio buffers and plays in order — no pacing needed" is correct.

### 8. Frame size/cadence ~20 ms / 160 bytes is NOT contractual — **VERIFIED (as "not contractual")**

The current official docs specify **no** chunk size or cadence anywhere (checked both the WebSocket-messages page and the Media Streams overview). 160 bytes of mu-law @ 8 kHz = 20 ms is the arithmetic reality and the widely observed behavior, but the docs deliberately leave it unspecified, and outbound is explicitly "any size". BRD guidance ("never assume exact sizes; keep DSP length-agnostic") stands — the mu-law decode is per-byte and the Path B resampler must consume arbitrary-length chunks with persistent filter state.

### 9. `X-Twilio-Signature` validation of `POST /twiml` — **VERIFIED** (SDK source read)

Signature algorithm (verified in `twilio@6.0.2` source, `lib/webhooks/webhooks.js`): take the full webhook URL (with query string), append each POST param as `name+value` sorted alphabetically by name, HMAC-SHA1 with the account Auth Token as key, base64. Comparison is timing-safe (`scmp`). `validateRequest` tries **four** URL variants to absorb Twilio backend inconsistency: {with, without} explicit port × {WHATWG, legacy-querystring} encodings.

Live round-trip test executed against the installed package (sign + validate → `true`) — see §Implementation detail B for the exact call.

### 10. WS-upgrade signature validation: possible but scheme-mismatched — BRD claim **PARTIALLY WRONG (overstated), pattern still correct**

Facts established:
- Twilio **does** send `X-Twilio-Signature` on the Media Streams WebSocket upgrade request, and Twilio's own webhook-security doc acknowledges WS validation: "When validating the signature on a WebSocket request, note that the header parameter name will be all lowercase: `x-twilio-signature`." (https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- The signature is computed over the **`wss://` URL exactly as written in the TwiML**, while the server-side request object reports `https://` — so naive validation fails. Documented publicly in twilio-labs/twilio-aspnet issue #162 ("for the signatures to match, the URL must be adjusted to have a wss:// URL instead of https://"): https://github.com/twilio-labs/twilio-aspnet/issues/162
- Since the upgrade is a GET with no form body, params are `{}` — validate as `validateRequest(authToken, sig, 'wss://HOST/twilio-media', {})`.

So the BRD's "Do NOT try to validate the WS upgrade … known pitfall" is **overstated**: validation IS feasible if you rebuild the URL with the `wss:` scheme and empty params (snippet in §Implementation detail C). However, the BRD's chosen pattern — validate the HTTPS webhook, mint a per-call random token, pass via `<Parameter>`, verify in `start.customParameters` before bridging — is **sound, simpler, and proxy-robust** (no dependency on Railway's proxy preserving the exact host/path view). Recommendation: keep the token pattern as primary; optionally ALSO check the upgrade signature as defense-in-depth (it's three lines).

### 11. Per-call token via `<Parameter>` as the auth pattern — **VERIFIED (viable)**

`customParameters` verified present in `start` (claim 3/4). Under the 500-char combined limit, a 128–256-bit random token (hex/base64url) fits trivially. Note the token authenticates the *stream* against the *webhook*, closing the loop: only an entity that received the signature-validated TwiML response knows the token. Use a constant-time compare and expire tokens (single-use, ~60 s TTL) since the TwiML may be logged by Twilio.

### 12. Inbound concurrency on one number — **LIKELY (support article; exact page not fetchable, paraphrase from search index)**

Twilio support article "How Fast Can I Place or Receive Phone Calls with Twilio?" (https://help.twilio.com/articles/223180028): Twilio places **no rate/concurrency limitation on inbound calls** for accounts with an approved Business Profile — "you can have as many concurrent calls as your servers will allow". CPS (calls-per-second) limits apply to **outbound** dialing only. Caveats: (a) new/unapproved accounts may have limited concurrency; (b) **trial** accounts restrict inbound callers to verified numbers and play a trial message. BRD §6's "no Twilio-side concurrency limit" holds for an upgraded account at PoC scale (5 concurrent), but each concurrent call = 1 webhook POST + 1 WS, so the bridge is the ceiling. (Could not fetch the help-center page body directly — 403/JS-rendered; marked LIKELY, not VERIFIED.)

### 13. Media Streams limits — **VERIFIED**

From https://www.twilio.com/docs/voice/media-streams:
- **"For bidirectional Streams, you can have only one Stream per Call."**
- "For unidirectional Streams, you can stream up to four tracks at a time on a Call" (shared budget with SIPREC, Real-Time Transcription, AMD — irrelevant to this PoC).
- "Each Media Stream is associated with one WebSocket connection."
- Regions: US1 default; also available in IE1 and AU1. (PoC uses US1 — matches the Railway us-east4 placement rationale.)
- No documented per-stream duration limit; a bidirectional stream lives as long as the call (Twilio's generic max call duration is 24 h — not a factor for 5–10 min calls).
- No documented WS idle/handshake timeout values (see Open questions).

### 14. `<Stream>` failure behavior — handshake failure **VERIFIED** as error 31920 + `stream-error` callback; call-flow consequence **LIKELY**

- If the endpoint answers the upgrade with anything other than HTTP 101 → **error 31920 "Stream - WebSocket - Handshake Error"**, "the stream fails to start" (https://www.twilio.com/docs/api/errors/31920). Causes include: no WS support at the URL, wrong path, query string on `url`.
- `statusCallback` (if set on `<Stream>`) receives `StreamEvent` ∈ {`stream-started`, `stream-stopped`, `stream-error`} with `StreamError` "detailed error message", plus `AccountSid`, `CallSid`, `StreamSid`, `StreamName`, `Timestamp` (ISO 8601).
- What the *call* does next is **not explicitly documented**. Given the `<Connect>` contract ("finish → move on to the next TwiML verb… no further verb → end the phone call"), the expected behavior on stream failure/close is: `<Connect>` completes → falls through → with the BRD's TwiML (nothing after `</Connect>`) **the call ends** (caller hears a hangup, not dead air). This matches community-reported behavior but needs a 5-minute runtime confirmation (kill-test in M1/FR-7). Mid-call WS drop (bridge crash): same fall-through expectation; also unverified timing (how fast Twilio detects the drop).

### 15. `twilio` npm package — **VERIFIED against the npm registry, 2026-07-16 publish**

- `latest` = **6.0.2** (registry modified 2026-07-16). Other dist-tags are historical/irrelevant (`rc: 4.0.0-rc.5`, etc.).
- `engines`: `node >= 20.0.0` — compatible with the BRD's Node 22.x.
- BRD §5.1 pins `twilio: latest` for "signature validation only" — fine; the webhook module has been API-stable across majors. If pinning exactly (recommended for reproducibility, consistent with the rest of §5.1): `twilio@6.0.2`.
- Note: the package pulls in deprecated `scmp` (npm warns; harmless — it's a timing-safe compare, Node's `crypto.timingSafeEqual` equivalent). 52 packages installed total.
- `validateRequest` exact signature — **VERIFIED** from installed `lib/webhooks/webhooks.d.ts`:
  ```ts
  function validateRequest(
    authToken: string,      // Twilio account Auth Token
    twilioHeader: string,   // value of the X-Twilio-Signature header
    url: string,            // the FULL URL (with query string) Twilio requested
    params: Record<string, any>  // the POST form params
  ): boolean;
  ```
  Also exported: `getExpectedTwilioSignature(authToken, url, params): string`, `validateRequestWithBody(authToken, twilioHeader, url, body): boolean` (JSON bodies w/ `bodySHA256` — not needed here; Twilio voice webhooks are form-encoded), `validateExpressRequest`, and the Express-only `webhook()` middleware (don't use with Fastify).

### 16. BRD §5.4 line-by-line audit — all four bullets **CONFIRMED** with two refinements

1. TwiML shape ✓ (exact XML verified by generating with `twilio@6.0.2`, §Impl A). Query-string prohibition ✓.
2. Inbound events ✓ — with additions: `connected` carries `protocol`/`version`; `start` also has `accountSid` + `tracks`; `media` also has `sequenceNumber`/`chunk`/`track`; `dtmf` exists; all numerics are strings.
3. Outbound events ✓ — refinement: **mark echo also fires on `clear`** (not only "when played"); the barge-in mark-queue flush (BRD §5.6 step 4) must tolerate late mark echoes arriving *after* the flush without corrupting state.
4. Security ✓ pattern-wise — refinement: WS-upgrade validation is *possible* (scheme rewrite), not impossible; see claim 10.

---

## Implementation-grade detail

### A. TwiML generation (verified by execution against twilio@6.0.2)

```ts
import twilio from 'twilio';

const vr = new twilio.twiml.VoiceResponse();
const connect = vr.connect();
const stream = connect.stream({ url: `wss://${host}/twilio-media` });
stream.parameter({ name: 'token', value: perCallToken });
reply.type('text/xml').send(vr.toString());
```
Produces exactly:
```xml
<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://example.com/twilio-media"><Parameter name="token" value="abc123"/></Stream></Connect></Response>
```
(Hand-writing the XML string is equally acceptable — it's static apart from host+token; escape nothing exotic in the token: use hex/base64url.)

### B. Webhook validation on Fastify (no Express middleware — do it manually)

Twilio voice webhooks POST `application/x-www-form-urlencoded` with standard params (`CallSid`, `AccountSid`, `From`, `To`, `CallStatus`, `Direction`, `ApiVersion`, `CallToken`, …). Fastify does not parse form bodies by default → **add `@fastify/formbody`**.

```ts
import formbody from '@fastify/formbody';
import { validateRequest } from 'twilio';   // top-level named export, verified

await app.register(formbody);

app.post('/twiml', (req, reply) => {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN ?? process.env.PUBLIC_HOST!;
  const url = `https://${host}/twiml`;               // EXACTLY what you configured in the Twilio console
  const signature = req.headers['x-twilio-signature'] as string | undefined;  // Node lowercases headers
  const ok = signature && validateRequest(
    process.env.TWILIO_AUTH_TOKEN!, signature, url,
    req.body as Record<string, string>,
  );
  if (!ok) return reply.code(403).send('invalid signature');
  // mint token, store { token -> { callSid, expiresAt } }, kick off gateway getToken(), return TwiML (§A)
});
```
Rules baked into the SDK (source-verified, so you don't re-derive them):
- Algorithm: `base64(HMAC-SHA1(authToken, url + concat(sortedByName(name+value))))`; comparison is timing-safe.
- The SDK already retries with/without explicit `:443` port and with legacy querystring encoding — do NOT normalize the URL yourself; pass the exact configured URL.
- Build the URL from the **configured public host env var**, never from `req.hostname`/`req.protocol` (Railway's proxy view may differ from what Twilio signed). This sidesteps every proxy pitfall.
- A trailing slash, different path, or added query param = validation failure by design.

### C. Optional defense-in-depth: validate the WS upgrade too

Twilio signs the upgrade request over the **`wss://` URL from the TwiML** with **no params**; the header arrives lowercase:

```ts
// In the HTTP 'upgrade' handler / fastify-websocket connection hook:
const sig = req.headers['x-twilio-signature'] as string | undefined;
const wssUrl = `wss://${host}/twilio-media`;          // scheme MUST be wss, not https
const upgradeOk = !!sig && validateRequest(process.env.TWILIO_AUTH_TOKEN!, sig, wssUrl, {});
// Treat as advisory (log + optionally reject); the <Parameter> token check in `start` remains the gate.
```
Root cause of the "known pitfall": servers see the upgrade as `https://…` and compute the signature over the wrong scheme (twilio-aspnet #162). Rewriting the scheme fixes it.

### D. Per-call state machine on the Twilio WS (message order contract)

1. WS open → expect `connected` (no streamSid yet — do nothing but arm a timeout).
2. `start` → read `streamSid`, `callSid`, `customParameters.token`. **Verify token (constant-time, single-use) BEFORE forwarding any audio or opening/attaching the gateway leg to this stream.** On bad token: `ws.close()` (which ends the call, claim 1).
3. `media` (only `track:"inbound"` will arrive) → update `latestMediaTimestamp = Number(media.timestamp)`; forward payload to the gateway (`input-audio-append`), transcoding if Path B.
4. Outbound: on each gateway `audio-delta` → send `{event:'media', streamSid, media:{payload}}` immediately, then `{event:'mark', streamSid, mark:{name:<unique>}}`; push name onto markQueue.
5. `mark` echo → pop from markQueue. **A mark echo after you sent `clear` means "flushed", not "played"** — if you flushed the queue at barge-in (BRD §5.6 step 4), ignore unknown/late mark names instead of throwing.
6. Barge-in: send `{event:'clear', streamSid}` (buffered audio discarded instantly, marks come back).
7. `stop` (or WS close) → tear down gateway leg, log call summary. Hangup initiated by bridge = close the WS.
8. `dtmf` → log only (PoC).

Timeout guards worth adding (all cheap): no `start` within 5 s of upgrade → close; token map entry not claimed within 60 s of `/twiml` → expire.

### E. `<Stream>` attributes (complete)

| Attribute | Values | Default | Notes |
|---|---|---|---|
| `url` | relative or absolute, `wss` only, **no query string** | — | required |
| `name` | unique per call | — | optional stream identifier |
| `track` | `inbound_track` \| `outbound_track` \| `both_tracks` | `inbound_track` | **unidirectional only**; bidirectional receives inbound only |
| `statusCallback` | absolute URL | — | POSTs `StreamEvent` (`stream-started`/`stream-stopped`/`stream-error`) + `StreamError`, `AccountSid`, `CallSid`, `StreamSid`, `StreamName`, `Timestamp` |
| `statusCallbackMethod` | GET \| POST | POST | |

Recommendation not in the BRD: set `statusCallback` to a `/stream-status` route that just logs — it is the ONLY way to see `StreamError` detail (e.g., handshake failures where your WS handler never runs), and it directly serves M1 debugging and FR-7 evidence. Cost: one tiny route.

### F. Numbers for sanity checks

- Inbound cadence (observed convention, not contract): 160 B mu-law = 20 ms @ 8 kHz → base64 ≈ 216 chars; whole `media` message ≈ 400 B; ≈ 50 msg/s per call inbound.
- 5 concurrent calls ≈ 250 inbound WS msgs/s + similar outbound — trivial for Node; reinforces the BRD's "log per event, never per frame" rule (Railway 500 lines/s cap).
- Outbound: any chunk size accepted; Twilio buffers unboundedly for practical purposes and plays in order.

---

## Gotchas & pitfalls

1. **Query string on the `<Stream>` url can hard-fail the handshake** (error 31920) — it's not merely ignored. Never append `?token=...`.
2. **WS-upgrade signature scheme mismatch**: Twilio signs `wss://…`; your server sees `https://…`. Validate with the `wss` URL + empty params, or skip and rely on the `<Parameter>` token (BRD default). Header name arrives lowercase.
3. **`clear` flushes marks back**: mark echoes after a `clear` do NOT mean the audio played. Barge-in code that uses marks for `audioEndMs` accounting must flush its queue on barge-in and ignore late/unknown mark names (BRD §5.6 step 4 is correct; make the handler tolerant).
4. **All numeric fields are strings** (`timestamp`, `sequenceNumber`, `chunk`) — `Number()` them; naive TypeScript typings that declare `timestamp: number` will lie at runtime.
5. **No audio headers in outbound payload** — raw mu-law bytes only; a WAV header = garbled audio (documented explicitly).
6. **`connected` ≠ ready**: you have no `streamSid` until `start`; you cannot send `media`/`mark`/`clear` before it, and you must not bridge audio before the token check.
7. **Closing the Twilio WS ends the call** (with the BRD's TwiML) — that's a feature (clean hangup) but also means an unhandled exception that kills the socket hangs up on the caller. Catch per-session errors; only close deliberately.
8. **Signature validation URL must be the configured public URL**, not reconstructed from proxied request headers — behind Railway's proxy, `req.protocol`/host may not match what Twilio signed. Use `RAILWAY_PUBLIC_DOMAIN`/`PUBLIC_HOST`.
9. **Fastify needs `@fastify/formbody`** to parse the webhook body; without it `req.body` is undefined and validation always fails.
10. **Trial accounts**: inbound restricted to verified caller IDs + a trial announcement before the call — upgrade first (BRD §6 step 1 already says this; FR-3's parallel-call test from arbitrary phones is impossible on trial).
11. **One bidirectional stream per call** — never emit TwiML with two `<Stream>` nouns under `<Connect>`; also relevant if later adding `<Start><Stream>` recording taps (those draw from the 4-track unidirectional budget, separate from the bidirectional one).
12. **`<Parameter>` combined name+value < 500 chars** — fine for tokens; don't stuff JSON blobs in one parameter.
13. **ngrok for local dev**: the `wss://<ngrok>/twilio-media` upgrade goes through ngrok's edge; signature validation of the upgrade will additionally see ngrok's host — one more reason the token pattern is primary. (BRD §8's "latency not representative" claim unaffected.)

---

## Open questions (need runtime spike)

1. **Call-flow after stream failure**: docs confirm error 31920 + `stream-error` callback + `<Connect>` fall-through on normal close, but nobody documents the *caller experience timing* on (a) handshake failure and (b) mid-call WS drop — how many seconds until fall-through/hangup, and whether any dead air occurs. → M1 kill-test with `statusCallback` attached (FR-7 evidence).
2. **Whether `X-Twilio-Signature` is present on every Media Streams upgrade request** in the current API version (community-confirmed for aspnet/ConversationRelay-era; log the header in M1 to confirm before relying on §Impl C).
3. **Handshake timeout** (how long Twilio waits for the 101) and **max inbound message size** Twilio accepts on `media` sends — both undocumented; irrelevant at PoC sizes but worth one log line.
4. **Exact inbound frame cadence** on this account/region (expect 20 ms/160 B; verify from `media.timestamp` deltas in M1 logs — feeds DSP chunk assumptions if any creep in).
5. **Account state**: is the target Twilio account upgraded (non-trial) with an approved profile? Determines whether claim 12's "no inbound limit" applies as stated.
6. Help-center article body (inbound concurrency) could not be fetched directly (403) — paraphrase via search index; a human with console access can confirm in one glance at account limits.

---

## BRD corrections (delta vs. §5.4/§6)

1. **§5.4 Security** — "Do NOT try to validate the WS upgrade … known pitfall" is **overstated**: validation is feasible by computing over the `wss://` URL with empty params (twilio-aspnet #162 shows exactly this fix). The token pattern remains the right primary gate; suggest re-wording to "upgrade-validation requires a wss-scheme rewrite; we use the token instead (optionally both)."
2. **§5.4 Outbound events** — "mark … echoed when played" is **incomplete**: marks are also echoed when `clear` flushes the buffer. Barge-in accounting must not treat post-clear mark echoes as playback.
3. **§6 step 4** — "no Twilio-side concurrency limit" should carry the qualifier: applies to upgraded accounts with an approved profile; trial/unapproved accounts are limited (and trial blocks unverified inbound callers entirely).
4. **§5.1** — `twilio: latest` resolves to **6.0.2** (2026-07-16, engines node ≥ 20). Recommend exact-pinning `twilio@6.0.2` for consistency with the rest of the pinned stack.
5. **§5.4 addition (omission, not error)** — `<Stream statusCallback>` is the only channel that surfaces `StreamError` detail (e.g., handshake failures); recommend adding a log-only `/stream-status` route for M1/FR-7.

---

## Sources

- TwiML `<Stream>` (attributes, Parameter, query-string prohibition, bidirectional semantics, statusCallback): https://www.twilio.com/docs/voice/twiml/stream
- TwiML `<Connect>` (fall-through/end-call contract, action attribute): https://www.twilio.com/docs/voice/twiml/connect
- Media Streams WebSocket messages (all schemas, buffering, clear/mark semantics, "any size", "no header bytes"): https://www.twilio.com/docs/voice/media-streams/websocket-messages
- Media Streams overview (1 bidirectional stream/call, 4 unidirectional tracks, regions, X-Twilio-Signature guidance): https://www.twilio.com/docs/voice/media-streams
- Webhook security (HMAC-SHA1 scheme, lowercase WS header note, URL-exactness): https://www.twilio.com/docs/usage/webhooks/webhooks-security
- Error 31920 Stream WebSocket Handshake Error (query-string cause, "stream fails to start"): https://www.twilio.com/docs/api/errors/31920
- WS-upgrade scheme mismatch (wss vs https) fix: https://github.com/twilio-labs/twilio-aspnet/issues/162
- Inbound call limits (support article, via search index — direct fetch 403): https://help.twilio.com/articles/223180028-How-fast-can-I-place-or-receive-phone-calls-with-Twilio-
- `twilio@6.0.2` npm registry metadata (`npm view twilio`, 2026-07-18; modified 2026-07-16) and installed source:
  - `node_modules/twilio/lib/webhooks/webhooks.d.ts` (validateRequest & co. signatures)
  - `node_modules/twilio/lib/webhooks/webhooks.js` (HMAC-SHA1 + 4-variant URL retry + scmp implementation)
  - Live execution test: TwiML generation (`VoiceResponse().connect().stream().parameter()`) and sign/validate round-trip — both passed.

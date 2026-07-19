# Findings 18 — "Stream - Websocket - Protocol Error" (31924) killing live calls

**Date:** 2026-07-19
**Researcher:** Claude (investigation agent), read-only audit of `src/twilio-media.ts`, `src/server.ts`,
`src/session.ts`, `src/fallback.ts`, `src/sessions.ts`, `src/bargein.ts`, `src/dsp.ts`, `src/gateway.ts`,
cross-checked against `docs/findings/03/06/08/10`, plus live web research (July 2026).
**Scope:** Diagnose Twilio Voice Insights `streamEvent: "stream-error"` / "Stream - Websocket - Protocol
Error" (Twilio error code **31924**) observed on 2 of 4 monitored calls (2026-07-19 Railway logs), each
ending in a caller-perceived silent hangup.

**Evidence supplied:**
- `CAc63bcb7dc02a7ab0a947be631b33ddc8` — greeting played fine (mark-echoed ~17:25:52), caller mostly
  silent afterward, Twilio reported 31924 at 17:25:58 (**~6 s** after our last outbound audio). Our own
  `stream-stop` log (code **1006**, `abnormal: true`, no prior `stop` event) didn't fire until **17:26:43
  — 45 s later**.
- `CA1d8438cf5ca147723d14207549d9977a` — crisis flow worked; a long uninterrupted resource read-back
  finished (mark-echoed) ~17:26:32; Twilio reported 31924 at 17:26:38 (again **~6 s** later). An earlier
  greeting barge-in `clear`+truncate in the same call succeeded normally.
- Clean calls: `CA3581...` (3 turns incl. a knowledge-tool round trip + 2 barge-ins, clean caller hangup)
  and the first portion of `CAd9fff...` (died differently, not 31924).

---

## Part 1 — What Twilio's error taxonomy actually says (numbered claims)

1. **31924 "Stream - Websocket - Protocol Error" is a raw WebSocket-framing violation, not a JSON-schema
   violation.** Twilio's own doc (https://www.twilio.com/docs/api/errors/31924) attributes it to
   (a) fragmented control frames, (b) "a message sent by your server did not conform to the WebSocket
   protocol," and (c), only as a fallback bullet, unsupported/malformed `media`/`mark`/`clear` messages.
   Fragmented control frames and generic protocol non-conformance are frame/transport-layer defects —
   the kind an intermediary (proxy/TLS terminator) introduces, not something a well-formed
   `JSON.stringify({event:...})` call can trigger on its own.

2. **Twilio has a *separate*, softer error for bad JSON/schema content: 31951 "Stream - Protocol -
   Invalid Message"** (https://www.twilio.com/docs/api/errors/31951) — fires on non-JSON text, unknown
   event names, missing/extra fields, or a `streamSid` mismatch. Twilio explicitly documents this as a
   **warning**, once per Stream, not a connection-killing error. Because the two failing calls got 31924
   and not 31951, the defect is very unlikely to be in the *content* of our JSON messages (which is
   schema-correct, see Part 2) — it points at the *framing/transport*, corroborating claim 1.

3. **31903 "Stream - WebSocket - Connection Broken Pipe"**
   (https://www.twilio.com/docs/api/errors/31903) is Twilio's code for "the WS connection was abruptly
   closed while active," explicitly called out as caused by "a firewall, proxy, load balancer, or other
   intermediate network element" interrupting traffic, with idle timeouts and TCP resets named directly.
   Twilio did **not** report 31903 in our evidence — it reported 31924 followed, 45 s later, by a bare
   1006 on our side with no corresponding Twilio-side signal at all. That 45 s gap between "Twilio's
   parser detects something wrong" and "our socket actually dies" is the single most diagnostic fact in
   this incident (see Part 3).

4. **Twilio's outbound message schema is exactly what `src/twilio-media.ts` sends.**
   https://www.twilio.com/docs/voice/media-streams/websocket-messages documents `media`
   (`{event,streamSid,media:{payload}}`), `mark` (`{event,streamSid,mark:{name}}`), and `clear`
   (`{event,streamSid}`) — all camelCase, no extra fields, payload = raw base64 `audio/x-mulaw`@8000 with
   **no file-header bytes**, and **"the audio can be of any size."** `sendMedia`/`sendMark`/`sendClear`
   in `src/twilio-media.ts:400-436` match this schema field-for-field (verified by direct read). This is
   also independently confirmed by the team's own prior research in `docs/findings/03` claim 4 and
   `docs/findings/06` claim C11 — this is not new information, but it rules out a schema typo as the
   cause.

5. **`ws` (the library both Fastify's WS plugin and our own gateway leg use) disables permessage-deflate
   compression by default on the *server* side**, and only negotiates it if the server explicitly opts
   in (https://github.com/websockets/ws — "ws" README, "the extension is disabled by default on the
   server and enabled by default on the client"). Twilio does **not** support WebSocket compression
   extensions on Media Streams (undocumented officially, but consistent with Twilio's error taxonomy
   never mentioning `permessage-deflate` and with community guidance to disable it defensively). Our own
   `src/server.ts:52` sets `perMessageDeflate: false` explicitly on the `@fastify/websocket` options
   passed to the underlying `ws.Server` — i.e., **this specific pitfall is already closed** in our
   codebase (and was previously identified in `docs/findings/08` claim V5 / `docs/findings/10` claim
   C15). This is ruled OUT as the direct cause, with one caveat noted in Part 3 claim 9.

6. **Railway's edge proxy has a documented, reproducible failure mode for long-lived WebSocket
   connections under bursty/compressed writes**, manifesting as `TCP_OVERWIN` proxy-level windowing
   errors and connections that silently die (Railway Station threads:
   https://station.railway.com/questions/web-socket-connections-timing-out-tcp-o-ac2a2b8b and
   https://station.railway.com/questions/web-socket-connections-are-suddenly-closi-dd2e6c1b). The fix
   reported by other Railway users for the `TCP_OVERWIN` case was, again, disabling
   `perMessageDeflate` server-side — which this codebase already does (claim 5) — but the broader lesson
   (Railway's edge proxy can desync a raw byte stream under bursty write patterns on long-lived WS
   connections, and the resulting failure surfaces to the *remote* peer, not to us, until a much later
   timeout) generalizes beyond just compression. One thread reports sockets going abnormal/1006 after
   only 20-30 s of otherwise-normal-looking activity on Railway; Railway support's own response in that
   thread called it "an application-level issue," but did not identify what in the traffic pattern
   triggered it.

7. **General WS heartbeat guidance**: most reverse proxies recognize ping/pong control frames as
   liveness and reset idle timers around 30-60 s; without any frames at all for that long, a proxy may
   silently reap the connection (https://websocket.org/guides/heartbeat/,
   https://websocket.org/guides/troubleshooting/timeout/). This is a plausible contributor to *why* a
   fully-idle post-response call eventually dies, but it does not by itself explain a **protocol** error
   (31924) reported by Twilio specifically **6 seconds**, not 30-60 seconds, after our last frame.

---

## Part 2 — Audit of our outbound path (what we actually send)

8. **Every outbound frame we ever send to Twilio, enumerated:**
   - `sendMedia` (`src/twilio-media.ts:400`): `{event:'media', streamSid, media:{payload}}`. Guarded by
     `readyState === OPEN`; backpressure-checked (`bufferedAmount > 1_000_000` → `socket.close(1011,
     'backpressure')`) *before* sending. No re-framing, no chunk-size cap — deliberate design decision
     recorded in `docs/findings/06` claim C11 ("Twilio accepts outbound media of any size... no
     pacing/re-framing loop needed").
   - `sendMark` (`:418`): `{event:'mark', streamSid, mark:{name}}`, name = `r<responseId>:<seq>`
     (`nextMarkName`, `:466`), always ASCII/short.
   - `sendClear` (`:431`): `{event:'clear', streamSid}`.
   - `hangup`/`teardownSession` (`:444`, `sessions.ts:167`): `socket.close(code, reason)` with codes
     1000/1001/1008/1011 and short reason strings (`'bye'`, `'no start'`, `'bad token'`,
     `'backpressure'`, `'call ended'`, `'server shutdown'`) — all well under the RFC 6455 125-byte
     control-frame payload limit, so a close-frame-size violation is ruled out.
   - `fallback.ts` sends `clear` → `media` (full clip) → `mark`, same helpers, same schema — no separate
     send path.
   - **No WS-level `ping()`/`pong()` is ever sent on the Twilio socket.** The only `ping()` call in the
     codebase is `src/gateway.ts:394`, and it targets the *gateway* (AI provider) leg's own WebSocket,
     not the Twilio leg — irrelevant to Twilio-side protocol errors. `GATEWAY_PING_SECONDS` defaults to
     `0` (disabled) per `src/config.ts:27` anyway.

9. **`@fastify/websocket` server options** (`src/server.ts:50-59`): `perMessageDeflate: false` (explicit,
   matches claim 5), `maxPayload: 1 MiB` (governs *inbound* frames we receive from Twilio, not outbound —
   irrelevant to 31924, and would produce a **1009** close on our side if ever hit, not a Twilio-side
   31924).

10. **Outbound frame size is provider-controlled and explicitly unbounded by design.** In `AUDIO_MODE=
    transcode` (the **default** per `src/config.ts:16`), `gatewayToTwilio` (`src/dsp.ts:240-251`) runs
    every gateway `audio-delta` through a persistent `Downsampler3x` and forwards the result as ONE
    `media` message per delta, whatever size that turns out to be — the codebase's own comment says "any
    size is fine for Twilio (C11)." **Critically, `docs/findings/06`'s own "Open Questions" section
    (item 4) flags "real gateway `audio-delta` chunk sizes (bytes per delta, even/odd, cadence)" as
    *never actually measured against a live Vercel AI Gateway / OpenAI Realtime connection* — the "any
    size is fine" conclusion was derived purely from Twilio's documented contract, not from observing
    what a live long response's delta cadence/size actually looks like in production.** This is the one
    genuinely open, unverified assumption in the whole outbound path.

11. **No pacing/rate-limiting anywhere in the outbound path** (deliberate, per `docs/findings/06`
    claim C11 and the `twilio-media.ts:389` file-header comment: "no pacing, re-framing, or
    timers/chunking/batching anywhere below — Twilio is the pacer, forward immediately"). Every
    `audio-delta` the model/gateway emits is forwarded to the Twilio socket **the instant it arrives**,
    with zero rate governance beyond the 1 MB `bufferedAmount` backpressure circuit-breaker. If the
    gateway/model ever emits deltas in a tight burst (e.g., TTS generating faster than 8 kHz realtime,
    which is normal and expected for these APIs), our code will call `socket.send()` back-to-back with
    no gap between calls, for as many deltas as the burst contains.

---

## Part 3 — Correlating the ~6 s / 45 s timing pattern

12. **What we send in the 6 s window after the last outbound audio in the failing calls: nothing.**
    There is no timer, interval, or delayed send anywhere in `src/twilio-media.ts`, `src/session.ts`,
    `src/bargein.ts`, or `src/fallback.ts` that fires unconditionally ~6 s after a response completes.
    The only timers in the whole outbound-adjacent surface are: the 5 s pre-`start` auth timeout
    (`START_TIMEOUT_MS`, fires only before a `start` event — irrelevant mid-call), the fallback clip's
    mark-echo poll/timeout (only runs when `playFallbackAndClose` is invoked, which requires a *gateway*
    failure — not evidenced here), and the gateway keepalive ping (targets the gateway leg, disabled by
    default, and even if enabled would ping the *wrong* socket). **This rules out "we sent a delayed,
    malformed frame during the silence" as the trigger** — whatever Twilio's parser choked on, it choked
    on it *before* the 6 s gap began, not during it.

13. **The 6 s gap is therefore the time between "we finished sending an already-successfully-played
    response" and "Twilio's WS layer reports the stream as protocol-broken."** Since the last mark of
    that response *did* echo back successfully (both calls: greeting played fine / read-back finished),
    the frames belonging to that specific response were correctly parsed and played by Twilio at the
    time they were sent. The most consistent explanation is that the *connection itself* — not any one
    JSON message — entered a corrupted state sometime **during** that burst of rapid, unpaced sends
    (claim 11), and Twilio's WS/media-processing layer only surfaces "protocol error" once it next tries
    to do *something* with the connection after the burst ends (e.g., process the next expected frame,
    or run an internal liveness/framing check) — which lines up with "shortly after the burst of traffic
    stops," i.e., a roughly fixed few seconds, rather than with any specific frame content.

14. **The correlating variable across all four calls is burst length/uninterrupted-ness, not frame
    content:** both 31924 calls involved a long, uninterrupted, rapid-fire sequence of outbound sends —
    a greeting (single long utterance, no barge-in) and a "long resource read-back" (explicitly
    described as long and uninterrupted). The clean call (`CA3581`) had **2 barge-ins**, each of which
    calls `sendClear` and truncates mid-stream (`bargein.ts:82`) — an interruption that empties
    `markQueue`, resets the downsampler, and naturally breaks up any burst into shorter runs. If a
    sustained high-rate write burst is what desyncs the connection (Railway edge proxy TCP-window/framing
    issue, claim 6), calls that never sustain a burst long enough would never trip it — exactly the
    pattern observed.

15. **The 45 s gap between Twilio's 31924 report and our own 1006 stream-stop is the other half of the
    signature.** This is *not* a normal WS close handshake (1006 explicitly means "no close frame was
    received" — an abnormal closure, not a code Twilio would set on purpose). The most parsimonious
    explanation: Twilio's edge, on detecting the protocol violation, tears down *its own* view of the
    stream and fires the `stream-error` statusCallback immediately (17:25:58 / 17:26:38) — but the
    underlying TCP connection between Twilio and Railway's edge, and/or between Railway's edge and our
    container, is left in a half-open state that isn't reaped until a much longer proxy-level idle/dead-
    peer timeout expires (Railway's own community reports document exactly this shape of problem:
    connections that "drop silently" or only resolve after a proxy-specific timeout — claim 6). This is
    consistent with claim 3's framing of 31903-class issues ("firewall/proxy/load balancer... idle
    timeouts, resets") even though the *reported* code here is 31924, not 31903 — i.e., the front-end
    symptom (protocol error) and the back-end symptom (delayed 1006) can have two different immediate
    triggers while sharing the same underlying cause: an intermediary mishandling this specific
    connection's byte stream.

---

## Ranked hypotheses

**H1 (highest confidence, primary): Unpaced outbound audio bursts destabilize the Railway
edge-proxy/Twilio WS connection during long, uninterrupted model responses.** The codebase deliberately
forwards every gateway `audio-delta` to Twilio the instant it arrives with zero pacing (claim 11) and
never measured real production delta size/burst cadence (claim 10). Long, uninterrupted responses
(greeting, long resource read-back) are exactly the two calls that failed; the one call with frequent
barge-ins (which interrupt/pace the stream every time) did not. Railway's edge proxy has independently
documented failure modes for exactly this shape of traffic on long-lived WebSockets (claim 6), and the
"error reported well after the triggering burst, socket doesn't fully die until much later" signature
(claims 13-15) matches a proxy-level desync more than an application-level schema bug (claim 2 rules the
schema out; our messages are correct, claim 4/8).

**H2 (medium): Railway's edge proxy (or another intermediary) reintroduces WebSocket compression or
otherwise mangles framing independently of our `perMessageDeflate: false` server option.** We only
control the `ws.Server` constructed inside our own process; if Railway's edge does any WS-aware
re-terminating/re-proxying (rather than a raw TCP passthrough) it could behave differently under load
irrespective of what we negotiate with Twilio. Unverified from inside this read-only investigation —
would require a packet capture or Railway support ticket to confirm/deny.

**H3 (low): Twilio-side transient/regional issue unrelated to our traffic pattern.** Possible but doesn't
explain why only long-uninterrupted-response calls are affected while short/interrupted-response calls
in the same window are clean — the correlation with our own send pattern is too clean to be coincidence
across 2 independent calls.

## Recommended fix (verify before shipping)

**Pace outbound `media` sends to (approximately) real-time cadence instead of forwarding every gateway
`audio-delta` the instant it arrives.** Concretely: in `src/session.ts`'s `audio-delta` case (currently
calling `sendMedia(s, payload)` synchronously at line 141), buffer the transcoded mu-law bytes and drain
them to Twilio in ~20 ms/160-byte increments (or coarser, e.g. 100 ms chunks) via a per-session interval,
rather than one `socket.send()` per delta with no gap. This is a deviation from the currently-documented
"Twilio accepts any size, no pacing needed" design (`docs/findings/06` C11) — that conclusion was correct
about Twilio's *application-level* contract but never accounted for what a sustained, unpaced burst does
to the Railway↔Twilio transport underneath it (claim 10's flagged-but-never-measured gap). This is a
targeted code change, not a one-liner, because `sendMedia`'s current contract assumes "call it once per
delta, forward now."

If a same-day mitigation is wanted before the pacing change is built/tested, a cheaper partial mitigation
is capping/splitting any single outbound `media` payload above a conservative size threshold (e.g.
~4 KB, well under typical proxy TCP window sizes) into multiple sequential `media` messages sent on
successive event-loop ticks — this reduces single-frame burst size without a full pacing scheduler, at
the cost of more messages.

**Confidence: medium.** The correlation (burst-heavy calls fail, interrupted calls don't; error reported
well after the triggering traffic stops; final close delayed far beyond the reported error) is strong
circumstantial evidence for a proxy-level burst/windowing issue, but this investigation could not capture
raw packets or reproduce the failure live, and Twilio's own documentation explicitly (and seemingly
contrary to this theory) states no pacing is required — so H1 asserts an *infrastructure-layer* side
effect that sits outside what Twilio's application-level docs promise, which is inherently harder to
verify without live traffic.

## How to verify live

1. **Instrument burst detection before changing anything:** add a debug-level log line in `sendMedia`
   (or a wrapper around it) recording the inter-send gap (`Date.now() - lastSendAt`) and running count of
   sends with gap < 5 ms. Deploy, make a test call that forces a long uninterrupted response (e.g. ask
   the crisis flow to read a long resource list without interrupting), and confirm a burst of near-zero-
   gap sends occurs right before the response's final mark echo.
2. **Cross-reference with Twilio Debugger:** pull the Voice Insights / Error Debugger event detail for a
   reproduced 31924 call (Twilio Console → Monitor → Debugger, or `GET
   /2010-04-01/Accounts/{Sid}/Calls/{CallSid}.json` + the call's `Insights` correlate) — Twilio's
   debugger sometimes attaches more raw context (byte offset, frame info) than the webhook `streamEvent`
   payload alone; confirm whether the timestamp of the underlying WS anomaly (not just the reported
   error) lines up with the tail of the burst identified in step 1, not with the 6-second-later report
   time.
2b. Also check the account's Media Streams region/edge (Voice Insights call summary) for whether all
   31924 calls share a Twilio media-processing region — if the failing calls cluster on one Twilio edge
   region, that further supports an edge/proxy-hop cause over an application bug (which would be
   region-independent).
3. **Confirm the fix:** after adding pacing (or the coarser payload-size cap), re-run the same
   burst-triggering test call several times; success is zero 31924s across repeated long, uninterrupted
   responses, with the debug burst-gap log now showing no near-zero-gap runs. Keep monitoring
   `stream-stop` `abnormal:true` (1006) counts in Railway logs for at least a few days post-fix — H1
   predicts both the 31924 rate and the delayed-1006 rate drop together (they're the same underlying
   event pair), whereas if only one of the two disappears, H1 is likely wrong and H2/H3 need a second
   look.

## Sources

- [31924: Stream - Websocket - Protocol Error](https://www.twilio.com/docs/api/errors/31924)
- [31951: Stream - Protocol - Invalid Message](https://www.twilio.com/docs/api/errors/31951)
- [31903: Stream - WebSocket - Connection Broken Pipe](https://www.twilio.com/docs/api/errors/31903)
- [31920: Stream - WebSocket - Handshake Error](https://www.twilio.com/docs/api/errors/31920)
- [Media Streams - WebSocket Messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
- [ws: a Node.js WebSocket library (npm)](https://www.npmjs.com/package/ws)
- [ws GitHub repository](https://github.com/websockets/ws)
- [RFC 7692: Compression Extensions for WebSocket](https://www.rfc-editor.org/rfc/rfc7692)
- [Railway Station: WebSocket connections timing out - TCP_OVERWIN errors](https://station.railway.com/questions/web-socket-connections-timing-out-tcp-o-ac2a2b8b)
- [Railway Station: WebSocket Connections Are Suddenly Closing with Error Code 1006](https://station.railway.com/questions/web-socket-connections-are-suddenly-closi-dd2e6c1b)
- [Railway Station: WebSocket connections dropping silently after ~50 minutes](https://station.railway.com/questions/web-socket-connections-dropping-silently-da8600df)
- [WebSocket.org: Fix WebSocket Timeout and Silent Dropped Connections](https://websocket.org/guides/troubleshooting/timeout/)
- [WebSocket.org: WebSocket Heartbeat guide](https://websocket.org/guides/heartbeat/)
- Cross-referenced internal: `docs/findings/03-twilio-media-streams.md` (claims 4, 5, 7),
  `docs/findings/06-audio-dsp-transcoding.md` (claim C11, Open Questions item 4),
  `docs/findings/08-fastify-ws-server-architecture.md` (claim V5, gotcha 14),
  `docs/findings/10-gap-analysis-and-contradictions.md` (claim C8, C15)

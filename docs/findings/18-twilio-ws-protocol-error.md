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

---

## Addendum (2026-07-19 18:05-18:10 UTC) — production recurrence data, re-ranking

**New evidence (build `0d12077`, three calls, instrumentation from the "how to verify live" section
above now deployed and capturing per-delta/burst stats):**

- `CAb9974f` (65 s): clean. Bursts: greeting 32 deltas / 101,600 B / 2409 ms; other turns 9-26 deltas.
- `CA2aa862` (110 s): **survived the single largest burst of the day** — 70 deltas / 223,600 B / 5228 ms
  (a long `route_call` handoff blurb) — followed by 27 s of caller silence with **no error**, then a
  clean caller hangup.
- `CAf40e09` (58 s): 31924 at 18:09:38.4, **~1.1 s** after its final response burst (42 deltas /
  131,600 B / 2994 ms) ended. Socket died 1006 abnormal **~30 s later** (18:10:08). This call had 2
  barge-ins (clear+truncate) earlier in the call, both handled cleanly by our own logs.
- Every delta across **all three calls, in both surviving and failing bursts**, is exactly
  `maxDeltaBytes = 3200` — i.e. the gateway/transcoder path emits perfectly uniform 3,200-byte decoded
  μ-law frames (400 ms of audio each at 8 kHz), not variable-sized chunks.

### Re-audit of the mark schema against Twilio's spec (fresh eyes)

16. **Re-reading `src/twilio-media.ts:418-424` and `src/bargein.ts:38-43` against
    https://www.twilio.com/docs/voice/media-streams/websocket-messages finds no schema defect.** Every
    `mark` frame is `{event:'mark', streamSid, mark:{name}}`, one per delta, name = `r<responseId>:<seq>`
    (short, ASCII, monotonic). Twilio's own doc describes exactly this pattern as the intended use: send
    a mark after each media message, Twilio echoes it back once that segment finishes playing, sequenced
    in send order. A 42-70 count over one response is high relative to earlier calls but is not, on the
    documented contract, an unsupported shape — Twilio explicitly designs mark to be sent per chunk for
    fine-grained playback tracking.

17. **No Twilio documentation, help-center article, or error-code page found stating any hard cap on
    outstanding/unacknowledged marks per Stream.** A dedicated search for a mark-queue/backlog limit
    turned up nothing beyond the same `websocket-messages` page's general description (searched July
    2026: "Twilio Media Streams mark queue limit outstanding marks protocol error backlog" — no
    corroborating hits). This doesn't prove no such internal limit exists, but there is no positive
    evidence for one either.

18. **The new data directly falsifies a mark-volume/backlog-depth trigger as a standalone cause: the
    call with the LARGEST mark backlog (70 outstanding marks, `CA2aa862`) is the one that survived**,
    while a call with a smaller backlog (42 marks, `CAf40e09`) failed. If Twilio enforced any outstanding-
    mark ceiling, the 70-mark call should have failed at least as readily as the 42-mark call. Mark
    volume alone is not the discriminator.

### H1 (unpaced burst / overspeed) is refuted by the new data

19. **Frame size is uniform and tiny (3,200 B) and instantaneous byte rate is trivial (~13 frames/s ≈
    42 KB/s) in every call, successful or not** — far below any plausible proxy/TCP-window stress
    threshold, and identical across outcomes. This directly falsifies the original Part-3 "bursty writes
    overwhelm Railway's edge proxy" framing of H1 as stated: there is no meaningful burst-size or
    byte-rate difference between the calls that failed and the ones that didn't.

20. **The audio-duration-vs-wall-clock overspeed ratio (how much faster than realtime deltas arrive) is
    also constant across all three calls (~5.3-5.6x realtime)** — recomputed from the new counts
    (32×400 ms/2409 ms ≈ 5.3x; 70×400 ms/5228 ms ≈ 5.35x; 42×400 ms/2994 ms ≈ 5.6x). This ratio is a
    fixed characteristic of the gateway's own delta emission cadence, not a per-call anomaly, and it is
    *higher*, not lower, for the survived call than for the failed one. **H1, in both its "raw bandwidth
    burst" and "overspeed backlog" framings, is refuted.**

### Re-ranked hypotheses

**H2' (NEW top hypothesis, medium-high confidence): random, per-connection Railway-edge/Twilio-edge
transport flakiness, with any nontrivial burst of traffic acting only as the *detector* of a
pre-existing fault, not its cause.** Under this model, a minority of the long-lived TCP/WS connections
between Twilio and Railway's edge (or Railway's edge and our container) intermittently develop a
corrupted or half-open transport state for reasons unrelated to our application's message content, size,
or cadence (matching claim 6's documented Railway edge-proxy WS flakiness reports). Because our outbound
traffic is otherwise idle between responses, the fault only becomes *visible* to Twilio's WS parser once
enough application traffic flows through the already-bad connection (any response burst gives it that
opportunity) — explaining why 31924 always follows "a long-ish response," without any burst *property*
(size, rate, mark count) actually driving the failure. The variable 1-6 s detection lag and ~30-45 s
delayed real close (1006) are consistent with a proxy/edge-level fault being detected and reported on
different timelines by different components, not a fixed applic­ation-level timer.
- **Supporting evidence:** incidence ~3 of 8 calls today with no reliable content/size/rate discriminator
  found (claims 18-20); the single largest burst of the day survived cleanly; and — most tellingly —
  the *same* traffic shape ("one long-ish response, then extended caller silence, then either an error or
  a clean hangup") produced **both outcomes** on different calls (`CAc63bcb` in the original evidence
  failed in exactly this shape; `CA2aa862` survived it here). Two calls with materially identical
  application-level behavior diverging in outcome is the classic signature of a per-connection/random
  infrastructure fault, not a deterministic bug in our send path.

**H3 (demoted, kept open, low-medium confidence): mark-echo/clear interaction residue from earlier
barge-ins.** Weakened by claim 18 (raw mark volume doesn't predict failure) but not fully closed: 2 of
the 3 calls that have ever failed with 31924 (`CA1d8438`, `CAf40e09`) had an earlier barge-in
(`clear`+truncate) mid-call before the fatal burst, while the survived big-burst call's barge-in history
is unrecorded in the new evidence. `CAc63bcb`, however, failed with **no** barge-in anywhere in the call,
which is the piece of evidence keeping this hypothesis at low-medium rather than promoting it — a clean
trigger would need to explain a barge-in-free failure too. Recorded as open, not pursued further without
more barge-in-history data on the survived calls.

**H4 (further demoted, very low confidence): permessage-deflate / compression mismatch.** No new evidence
either supports or refutes this; already closed on our side (claim 5), and a connection-level flakiness
model (H2') does not require it, so it drops in priority rather than being newly implicated.

### The single cheapest discriminating experiment

21. **Proposed experiment: add a lightweight WS ping/pong heartbeat on the *Twilio* leg itself** — a
    small, `gateway.ts:391-396`-style addition (a few lines, no protocol/schema change, fully
    G9-reviewable): on the Twilio socket, `setInterval(() => { if (socket.readyState === OPEN)
    socket.ping(); }, 5000)`, logging the round-trip time on each `pong` and a warning if a `pong` is
    missing before the next `ping` fires. This is deliberately NOT a mark-batching change — the new data
    (claim 18) makes mark volume an unlikely lever, so a mark-batching experiment would probably show no
    effect either way and cost a schema-adjacent code change for a low-value answer. A ping/pong probe on
    the Twilio leg directly tests H2' at minimal cost and with zero risk to call behavior (`ping()`
    frames are protocol-legal, invisible to the application layer, and Twilio's `ws`-based client
    auto-pongs).
22. **What the next occurrence would tell us:** if a 31924 event is preceded (within the same connection,
    looking back a few ping intervals) by a missed pong, an elevated RTT, or any ping/pong irregularity,
    that is strong, near-direct confirmation of H2' (the transport was already unhealthy before the
    application-level symptom surfaced). If pongs remain fast and unbroken right up to the moment 31924
    fires, with no anomaly at all, H2' loses support and the investigation should pivot to a Twilio-side
    or gateway-side trigger not yet identified (a genuine App content/protocol edge case would need
    fresh evidence at that point, since H1 and mark-volume are both now weak per claims 19-20 and 18).
23. **Secondary, lower-cost signal to collect in parallel at zero code cost:** for every future 31924,
    pull the call's Twilio Voice Insights edge/media-region metadata and barge-in history (both already
    loggable/queryable today) and check whether failing calls cluster on a specific Twilio media region
    or specifically require a prior barge-in — either finding would sharpen H2' (region clustering) or
    partially rehabilitate H3 (barge-in requirement), respectively, without waiting for the heartbeat
    deploy.

---

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

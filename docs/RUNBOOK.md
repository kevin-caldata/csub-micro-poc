# CSUB-RIO Voice PoC — Operational Runbook

This is the single document every human/console step of this project runs
from: one-time Railway + Twilio setup, the deploy-between-calls rule, Log
Explorer usage, the 7-day extraction rule, an incident quick-reference, the
local-dev/ngrok loop, and the cost-tracking procedure. It paraphrases
`docs/specs/09-deployment-and-operations.md` (Spec 09) — **Spec 09 is the
requirements authority; nothing here overrides it.** Every operational claim
below traces to a Spec 09 requirement (R-number) or a findings/07 / findings/03
section, and every unresolved runtime question is tagged with its spike
number (S-number) from Spec 09's "Open items deferred to runtime spikes".

---

## 1. One-time setup checklist (executable order)

Spec 09 R11.5 / R3 / R4 / R7. Run these steps in order, once, before M1.

**Never do** (standing prohibitions — Spec 09 R2.3, R2.6, R4.1, R2.10, R5.5):
- **No Dockerfile in the repo.** "Railway will always build with a Dockerfile
  if it finds one" — it silently overrides `builder: RAILPACK` (R2.3).
- **No manual `PORT` variable on the Railway service.** Railway injects
  `PORT` automatically; defining your own breaks domain→port targeting and
  healthchecks (R2.6).
- **No `watchPatterns`.** Commits touching only excluded paths are silently
  `SKIPPED` — a confusing FR-8 "failure" (R4.1).
- **No `sleepApplication`.** A slept service adds cold-start latency to the
  first webhook and defeats the ~2 s greet target. Default is off — leave it
  off (R2.10).
- **No WS-level keepalives added for Railway's benefit.** Railway WebSocket
  connections are exempt from all duration/inactivity limits and "can stay
  open indefinitely, even while idle" (R5.5, C6). Only the Twilio leg is
  relevant here; the gateway leg's separate idle timer is out of scope.

Steps:

1. **Twilio account: upgrade if still trial** (card-swipe). Trial restricts
   inbound callers to verified numbers and plays a trial announcement — FR-3's
   parallel-call test from arbitrary phones is impossible on trial (R7.1).
   **Qualifier (C16/S20):** "no Twilio-side inbound concurrency limit" holds
   only for upgraded accounts with an **approved Business Profile**; new or
   unapproved accounts may have limited concurrency. Verify account state +
   Business Profile approval in the console BEFORE M1 (S20); if the profile
   is pending, record it as a risk against the M4 parallel-call test.
2. **Buy one US local number** (~$1.15/mo): Console → Phone Numbers → Buy a
   Number (US, Voice) (R7.2).
3. **Record `TWILIO_AUTH_TOKEN`** (Console dashboard) → password manager
   FIRST → then into the Railway sealed variable (step 7 below) and local
   `.env` (R7.3).
4. **Push the repo to GitHub.**
5. **Railway: New Project → Deploy from GitHub repo** → select this repo,
   branch `main`. Auto-deploy on push to the connected branch is the platform
   default — verify the Enable/Disable toggle in Service Settings is
   Enabled. Requires ≥1 project member with a connected GitHub account
   having contributor access, and the Railway GitHub App installed with repo
   access. Leave **"PR Environments"** and **"Wait for CI"** off — no GitHub
   Actions workflow exists in this repo, so Wait-for-CI would strand deploys
   (R4 steps 1–3).
6. **Service → Settings → Networking → Generate Domain** →
   `RAILWAY_PUBLIC_DOMAIN` starts being injected (R4.4).
7. **Set + SEAL variables** on the Railway service Variables tab (R3):
   - `AI_GATEWAY_API_KEY` (Vercel dashboard → AI Gateway → API Keys)
   - `TWILIO_AUTH_TOKEN` (Twilio console — recorded in step 3)
   - `MODEL_ID=openai/gpt-realtime-2.1` (non-secret)
   - `AUDIO_MODE=transcode` (non-secret; flip to `pcmu` after the M1 spike)
   - `VOICE=marin` (non-secret; fallback `alloy` per G3)

   **Seal is irreversible.** Seal `AI_GATEWAY_API_KEY` and
   `TWILIO_AUTH_TOKEN` via each variable's 3-dot menu → "Seal". Once sealed,
   the value can never be viewed again in UI or API, only overwritten —
   store canonical copies in a password manager **before** sealing (R3.1).
   **Sealed values are NOT provided to `railway variables` or `railway
   run`** — local dev must use the `.env` file, never `railway run` (R3.2,
   R8). **Every variable change triggers a redeploy, which severs live
   calls** — set all variables before any demo/test window (R3.3).
8. **First deploy + boot-log check.** Watch the deploy build → healthcheck →
   Active. Verify the boot log line shows `region: us-east4-eqdc4a`, the new
   commit SHA (`RAILWAY_GIT_COMMIT_SHA`), and `RAILWAY_DEPLOYMENT_ID` — this
   proves region pinning worked (R2.8).
9. **Twilio number → Voice Configuration → "A call comes in" → Webhook →
   `https://<RAILWAY_PUBLIC_DOMAIN>/twiml` → HTTP POST → Save** (R7.4). Media
   Streams itself needs no separate console config — the TwiML response
   creates the stream per call (R7.5).
10. **M1 smoke call.** Place one call. Confirm the boot log's region line,
    then follow §3 (Log Explorer) to confirm the call's events are queryable.

---

## 2. Deploy-between-calls checklist (run before every push to `main` or variable change)

Spec 09 R11.3. **Operating rule, stated as absolute: every deploy and every
variable change is call-fatal. Deploy between test calls only.** (R5.2)

Rationale: the verified deploy lifecycle is new deploy builds → healthcheck
until 200 (≤120 s) → new deploy Active → both deployments live for
`overlapSeconds` (10 s) → old gets SIGTERM → `drainingSeconds` (60 s) to exit
→ SIGKILL. **Default SIGTERM grace is 0 s** — `drainingSeconds: 60` in
`railway.json` is what creates the drain window at all; the SIGTERM handler
is useless without it and vice versa (R5.1). 60 s is still shorter than a
5–10 minute call, and **whether the Railway edge keeps routing an established
Twilio WS to the SIGTERM'd replica during overlap/draining is undocumented
(S25)** — until that spike is resolved, this rule is absolute, not a
suggestion softened by `overlapSeconds`/`drainingSeconds` existing. Also
accepted risk: Twilio's retry/fallback-URL behavior when `/twiml` 503s during
drain is untested by design (S28) — "deploy between calls" sidesteps it
rather than resolving it.

The five steps (Spec 09 R11.3, exactly):

1. Confirm no test call is in progress (check Log Explorer for a
   `stream-start` without a matching `stream-stop`).
2. Push / change the variable (either triggers a redeploy — R3.3, R5.2).
3. Watch the deploy: build → healthcheck → Active. If the healthcheck fails,
   the old deploy keeps serving (R1.4) — fix and re-push; nothing is down.
4. Verify the boot log line: `region: us-east4-eqdc4a` + new commit SHA
   (R2.8).
5. Place one smoke call before resuming measurement calls.

---

## 3. Reading Log Explorer

Spec 09 R11.1.

**Structured-line contract:** one minified JSON object per stdout line;
`message` (string) is required, `level` (string) is one of
`debug|info|warn|error`; every other top-level key becomes a queryable
attribute. Keep `callSid`/`event`/all metric fields **flat top-level** —
nested-attribute querying is undocumented, do not rely on it.

**Filter cheat-sheet** (verbatim from R11.1):
```
@callSid:CAxxxx                                    # per-call trace
@level:error                                       # all errors
@event:first-audio-delta AND @callSid:CAxxxx       # boolean AND
-@event:media                                      # negation
replica:<id>                                       # scope to one replica
```

**Rate cap:** hard cap **500 lines/s/replica**; overflow is silently dropped
after one warning line. This is per-event logging only, **never per-frame**
— 5 concurrent calls × 50 fps × 2 directions = exactly 500/s, so per-frame
logging would sit exactly at the drop threshold.

**S33 — first-deployed-build verification (mandatory before any measurement
session counts):** on the FIRST deployed build, verify that custom-attribute
filters (`@callSid:`, `@event:`) actually return results before relying on
them for M2+ measurement. Checklist (Spec 08 R15, reproduced in
`docs/measurements/README.md` with date fill-ins):

1. A `stream-start` line renders as parsed JSON (level colorization), not
   plain text. Result: ____ Date: ____
2. `@callSid:<sid>` returns exactly that call's lines. Result: ____ Date: ____
3. `@event:turn` and `@event:stream-stop` filter correctly. Result: ____ Date: ____
4. Numeric filter works: `@ttfbMs:>0` and `@ttfbMs:>800`. Result: ____ Date: ____
5. Boolean combos work (`AND`/`OR`/`-`). Result: ____ Date: ____
6. Burst check: `@callSid` query completeness within ~a minute of call end
   (indexing lag). Result: ____ Date: ____
7. The 500/s warning line does NOT appear during a normal call. Result: ____ Date: ____

If item 4 fails, the fallback is documented in `docs/measurements/README.md`:
export `@event:turn` and filter offline — `scripts/aggregate-latency.mjs`
doesn't depend on Railway's numeric filter working.

---

## 4. The 7-day extraction rule

Spec 09 R11.2.

Railway Hobby log retention is **7 days**. After every milestone test
session, extract the relevant log lines (per-call summaries, latency events
per the Spec 08 event schema) out of Railway into the repo the **same day** —
hard deadline **72 hours** (leaves buffer for indexing lag and re-pulls).
**Data left only in Railway WILL be lost** once the retention window closes
— this repo is the durable store, Railway is a 7-day cache, nothing more.

The full extraction procedure (query list, destination directory
convention, aggregation command) lives in `docs/measurements/README.md` —
this runbook does not duplicate it; follow that document verbatim for every
test session. Summary of the shape: export `@event:turn`,
`@event:stream-stop`, `@event:tool-call`, `@event:greeting`,
`@event:session-updated`, and `@level:error OR @event:custom OR
@event:gateway-close` into `docs/measurements/<YYYY-MM-DD>-<label>/*.jsonl`,
commit, then run `node scripts/aggregate-latency.mjs
docs/measurements/<dir>/turns.jsonl` for cross-call p50/p95/max/n.

---

## 5. Incident quick-reference

Spec 09 R11.4. Three rows, plus the R6.5 trigger list so operators know which
failures route to the spoken fallback.

| Symptom | Cause / what to check | Log evidence |
|---|---|---|
| Gateway leg dies mid-call | Caller hears the apology clip (`playFallbackAndClose`, Spec 09 R6) then hangup — this is gated on **spike S23** (whether the clip reliably plays right before `close()`); if S23 fails, the accepted degradation is a clean hangup only (never dead air), per R6.6. | `fallback-played` event line (`reason`, `echoed`, `waitedMs`) |
| Twilio webhook returns 403 | Signature/host mismatch. Check `PUBLIC_HOST`/`RAILWAY_PUBLIC_DOMAIN` (config) against the URL actually configured in the Twilio console — signature validation and TwiML generation must build URLs from the configured host, never from `req.hostname`/`req.protocol` (R8.3). | `twiml-bad-signature` warn line |
| Stream never starts, call drops | Check `/stream-status` logs for `StreamEvent=stream-error` and the `StreamError` detail — commonly error **31920** (WebSocket handshake failure, e.g. a query string leaked onto the `<Stream>` `url`). This is the S19 kill-test evidence channel. | `stream-status` log line (`streamEvent`, `streamError`) |

**R6.5 trigger list — which failures route to `playFallbackAndClose`:**
- gateway `getToken` throw (any `GatewayError`, including a concurrency
  rejection at mint time — the `/twiml` webhook path).
- gateway WS `unexpected-response` / `error` on upgrade.
- gateway WS unexpected `close` mid-call.
- gateway in-band fatal `error` event (the session's `onGatewayFailure`
  hook).

Both mint-time and WS-open-time concurrency rejections must reach this path
(exactly where the gateway concurrency limit manifests — mint vs WS-open —
is spike **S24**).

---

## 6. Local dev loop

Spec 09 R8/R9.

### `.env` summary (non-normative copy — Spec 01 R8 owns `.env.example`)

```
AI_GATEWAY_API_KEY=        # Vercel dashboard -> AI Gateway -> API Keys
TWILIO_AUTH_TOKEN=         # Twilio console dashboard
PORT=3000                  # local only; Railway injects PORT — never set it there
PUBLIC_HOST=               # local only: bare ngrok hostname, e.g. abc123.ngrok-free.app
MODEL_ID=openai/gpt-realtime-2.1
AUDIO_MODE=transcode       # 'pcmu' after the M1 spike passes
VOICE=marin                # fallback 'alloy' (G3)
```

If this block ever diverges from the committed `.env.example`, `.env.example`
wins — fix this file, not the other way around.

### Env loading (G2)

Node does not auto-load `.env`, and neither does `tsx`. Use the flag-based
loader — the `dev` script is `tsx watch --env-file=.env src/server.ts` (Node
≥ 20.6 native, zero deps, no `dotenv` package). Production (Railway) reads
real injected env vars; the flag is harmless there but unused since
`startCommand` is `node dist/server.js` (R8.2).

### The ngrok flow (R9.1)

1. `npm run dev` (listens on port 3000).
2. `ngrok http 3000`.
3. Set the Twilio number's Voice webhook to `https://<ngrok-host>/twiml`.
4. Set `PUBLIC_HOST=<ngrok-host>` in `.env` (so TwiML emits
   `wss://<ngrok-host>/twilio-media`).
5. Restart the dev server.
6. Call the number.

### Mandatory 10-minute G5 WS smoke test (R9.2)

No findings doc verified that ngrok's free tier forwards the Twilio Media
Streams WS upgrade cleanly. The first local milestone is therefore this
10-minute smoke test: place one call, confirm in local logs `connected` →
`start` (with `customParameters.token`) → `media` frames arriving.

- **Pass/fail fill-in:** Result: ____ Date: ____
- **On failure:** fall back to deploying to Railway for all testing —
  acceptable, since deploys are one push. Record the outcome in the
  Spike/verification ledger (§8) regardless of pass/fail.

### ngrok signature note (R9.3)

The WS upgrade through ngrok sees ngrok's host, not the real Twilio-configured
host — one more reason the `<Parameter>` token check in `start` is the
primary stream gate; upgrade-signature validation stays advisory-only and is
not expected to pass cleanly through ngrok.

### Latency validity rule (R9.4)

**Latency numbers are only valid from Railway.** ngrok adds a tunnel hop on
the media path. Use local dev for functional development only; every latency
measurement that feeds the M5 findings report must be taken from Railway
(us-east4).

---

## 7. Cost tracking

Spec 09 R10.

**Before/after each test batch**, run:

```
npx tsx --env-file=.env scripts/check-credits.ts
```

This prints one JSON line — `{"timestamp":"...","balance":"...","totalUsed":"..."}`
— from `gateway.getCredits()` (T09.4's script contract). Record the
before/after values for every milestone test batch and compute the delta
(R10.1/R10.2). This is the load-bearing cost procedure because **`/v1/report`
is 403 on Hobby** — the gateway spend-report endpoint is unavailable on this
plan, so the credits-delta from this script is the fallback proof of spend.

**First-billed-call dashboard inspection (M1):** after the first billed call,
inspect the Vercel dashboard → AI Gateway → Requests log to attempt to
resolve:
- **S30** — audio-token pricing: the listed $4/$24 per-M rate has no
  audio-token field; whether the gateway bills OpenAI's higher audio rates
  is unobservable before the first real bill.
- **S31** — how realtime sessions appear in the dashboard: per-session rows?
  generation IDs surfacing in the logged `session-created.raw`?
- **Optional S32 tag note:** if `providerOptions: { gateway: { tags:
  ['voice-poc'] } }` was set on a call's `session-update`, check whether the
  dashboard actually attributes spend by that tag (whether the realtime route
  honors it at all is unresolved).

**Railway usage check (M4):** check the Railway dashboard usage page against
the ~$3/mo prediction (Node RSS ~0.2–0.3 GB ⇒ $2–3 RAM, near-idle CPU,
pennies of egress — inside the $5 Hobby credit) and record the actual burn
(**S27**).

---

## 8. Spike/verification ledger

Fill-in table for the spikes this runbook's procedures resolve. Populate
during milestone execution (T10); do not backfill results speculatively.

| Spike | Procedure section | Result | Date |
|---|---|---|---|
| S19 — caller-experience timing on handshake failure / mid-call WS drop | §5 Incident quick-reference (stream-status kill test) | | |
| S20 — Twilio account upgraded + Business Profile approved | §1 step 1 | | |
| S23 — canned μ-law clip reliably plays right before `close()` | §5 Incident quick-reference (gateway-leg-dies row) | | |
| S25 — WS connection routing during overlap/draining | §2 Deploy-between-calls checklist | | |
| S27 — actual Railway Hobby usage burn vs ~$3/mo prediction | §7 Cost tracking (Railway usage check) | | |
| S30 — audio-token billing rates | §7 Cost tracking (first-billed-call dashboard inspection) | | |
| S31 — realtime-session representation in the dashboard | §7 Cost tracking (first-billed-call dashboard inspection) | | |
| S32 — `providerOptions.gateway` tag attribution | §7 Cost tracking (optional tag note) | | |
| S33 — Log Explorer custom-attribute filtering on first deployed build | §3 Reading Log Explorer (checklist) | | |

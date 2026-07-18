---
# Spec 09 — Deployment & Operations: Railway, Twilio Console, Local Dev, Runbook
Date: 2026-07-18 · Project: CSUB-RIO Voice PoC · Status: Draft for review
Depends on: 01 (repo scaffold: package.json/tsconfig/config.ts), 02 (session/server boot & SIGTERM drain hooks), 08 (logging/instrumentation events this runbook reads) · Enables: M1 first deployed call, M4 (FR-3/FR-7/FR-8), M5 findings report
Findings referenced: findings/07 (all sections — primary), findings/03 (§claims 1, 10–14, §Impl B/C/E, gotchas 10/13), findings/01 (§claim 14, §detail 9/11, gotchas 5/14), findings/10 (C6, C16, C17, C18, G2, G4, G5, S19, S20, S23, S25, S27, S30, S31, S33)
---

## Objective

When this spec is done, the repo contains the final `railway.json`, `.env.example`, the FR-7 spoken-fallback assets/helper, and an operational runbook (`docs/RUNBOOK.md`); the Railway service, GitHub auto-deploy pipeline, and Twilio number are configured per the verified July-2026 platform behavior in findings/07 and findings/03; and the local-dev loop (`.env` + ngrok) is specified with its known caveats. This spec also **resolves gap G4** (FR-7 spoken fallback): a pre-rendered μ-law apology clip stored in the repo, played on gateway-death-during-a-live-call before closing the Twilio WS, with clean hangup as the fallback-of-the-fallback.

## Deliverables

Files to create/modify in the repo:

- `railway.json` (repo root) — final content per R1 (identical to Spec 01 R10; this spec verifies, it does not fork).
- `.env.example` (repo root) — per R8 (exact content owned by Spec 01 R8 + Spec 04 R2 additive keys; this spec verifies/documents).
- `assets/fallback-apology.ulaw` — pre-rendered raw μ-law/8000 apology clip (R6) + `assets/README.md` one-paragraph provenance note (source text, how regenerated).
- `scripts/make-fallback-clip.sh` — the ffmpeg one-liner that (re)generates the clip from a WAV (R6.3).
- `src/fallback.ts` — `playFallbackAndClose(session)` helper (R6.4) consumed by the Session teardown path (Spec 05 wires it via its `onGatewayFailure` hook; the mint-time trigger sits in Spec 02's webhook).
- `scripts/check-credits.ts` — cost-tracking helper hitting `gateway.getCredits()` (R10.2).
- `docs/RUNBOOK.md` — the operational runbook (R11), containing: Twilio console setup checklist (R7), Railway setup checklist (R2–R5), deploy-between-calls checklist, Log Explorer cheat-sheet, log-extraction rule, cost-tracking procedure.

Console-side setup (documented in RUNBOOK, performed by a human once): Railway project + GitHub auto-deploy (R4), sealed variables (R3), Twilio number + webhook (R7).

## Requirements

### R1. `railway.json` — exact final content

Commit exactly this at repo root [findings/07 §1, §Implementation "Final recommended railway.json"]:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "RAILPACK" },
  "deploy": {
    "startCommand": "node dist/server.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3,
    "overlapSeconds": 10,
    "drainingSeconds": 60,
    "multiRegionConfig": { "us-east4-eqdc4a": { "numReplicas": 1 } }
  }
}
```

Rules:
- R1.1 `drainingSeconds` and `overlapSeconds` are **numbers, not strings** — the JSON schema types both as `number`; the docs-page string examples are wrong [findings/07 §1 note, gotcha 14].
- R1.2 `overlapSeconds: 10` is an ADDITION over the BRD (BRD omits it) per findings/07's recommendation [findings/10 C17]: it lets a new deploy take over new-connection routing while old calls get the 60 s drain window. **Caveat: whether established Twilio WS connections keep routing to the SIGTERM'd replica during overlap/draining is undocumented — S25.** The value is harmless if routing turns out to be atomic; do NOT weaken the deploy-severs-calls operating rule (R5) on the strength of this field.
- R1.3 `multiRegionConfig: {"us-east4-eqdc4a": {"numReplicas": 1}}` pins US East Metal (Virginia) — same metro as Twilio US1 (Ashburn) [findings/07 §3–4]. Without the pin the service lands in the account's "preferred region" (could be `us-west2`, +60–70 ms RTT on every leg) [findings/07 gotcha 13]. Config-as-code always overrides the dashboard, so the BRD §7.2 dashboard Region step is redundant — skip it [findings/10 C17].
- R1.4 Healthcheck semantics: Railway polls `GET /health` on `$PORT` until HTTP 200, with a 120 s window; **a failed healthcheck marks the deploy failed and the OLD deployment stays live and keeps traffic** — a boot-crash push can never take down the running service [findings/07 §11]. Healthchecks arrive with Host `healthcheck.railway.app` — no host allow-listing, no Twilio signature validation on `/health`, and `/health` must be registered before any async boot work (gateway warmup etc.) so a slow boot can't eat the window [findings/07 gotcha 5].
- R1.5 Healthchecks are deploy-time only — Railway does not monitor `/health` after the deploy goes live [findings/07 §11]. Runtime crash recovery is `restartPolicyType: ON_FAILURE` (max 3 retries).

### R2. Railpack build facts (constraints on the repo the build agent must honor)

- R2.1 `package.json` must contain `"engines": {"node": "22.x"}` and scripts `"build": "tsc -p tsconfig.json"` (Spec 01 R2 exact form), `"start": "node dist/server.js"`, `"dev": "tsx watch --env-file=.env src/server.ts"` (dev script per R8.2). Railpack detects Node via `package.json`, honors `engines.node`, and **runs the `build` script automatically** — no `buildCommand` needed in railway.json [findings/07 §5].
- R2.2 **devDependencies ARE installed at build time** (`NPM_CONFIG_PRODUCTION=false`), so `typescript` and `tsx` belong in `devDependencies` and `tsc` works during the build. They also remain in the runtime image (no pruning by default) — acceptable for the PoC; do not set `RAILPACK_PRUNE_DEPS` [findings/07 §5, gotcha 10].
- R2.3 **Never add a Dockerfile to the repo** — "Railway will always build with a Dockerfile if it finds one", silently overriding `builder: RAILPACK` [findings/07 §5, gotcha 9]. Add a comment in the RUNBOOK; consider a CI-free convention note in the repo README.
- R2.4 Avoid `preinstall`/`postinstall` scripts in package.json (they disable Railpack's install-layer cache) [findings/07 §5].
- R2.5 Commit `package-lock.json` (npm is selected via lockfile detection) [findings/07 §5, §Implementation].
- R2.6 `PORT` is auto-injected by Railway; the server MUST listen `{ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }`. **Never define a PORT service variable manually** (breaks domain→port targeting and healthchecks); never listen on `localhost`/`127.0.0.1`. The MCP client's in-process `http://127.0.0.1:${PORT}/mcp` loopback call (Spec 07 R7 uses `127.0.0.1`, not `localhost`) is fine — that's egress, not inbound routing [findings/07 §8, gotcha 6].
- R2.7 `RAILWAY_PUBLIC_DOMAIN` is injected as a **bare hostname, no scheme** (e.g. `csub-rio-poc-production.up.railway.app`) once a domain is generated. Build the webhook URL as `https://${RAILWAY_PUBLIC_DOMAIN}/twiml` and the TwiML stream URL as `wss://${RAILWAY_PUBLIC_DOMAIN}/twilio-media`; `wss://` works out of the box, plain `ws://` is impossible [findings/07 §7]. Read it at runtime only, never at build time (presence at build time is unverified and irrelevant) [findings/07 open Q5].
- R2.8 Boot log requirement: on startup, emit one structured line containing `RAILWAY_REPLICA_REGION` (expect `us-east4-eqdc4a`), `RAILWAY_GIT_COMMIT_SHA`, and `RAILWAY_DEPLOYMENT_ID` — this **proves region pinning worked** on every deploy [findings/07 §15]. Example: `{"message":"boot","level":"info","event":"boot","region":"us-east4-eqdc4a","commit":"abc123","deploymentId":"..."}`.
- R2.9 `NODE_ENV=production` and `CI=true` are set by Railpack at runtime — any NODE_ENV-branching library behaves as production on Railway vs local dev [findings/07 §5, gotcha 11].
- R2.10 Do NOT enable `sleepApplication` — a slept service adds cold-start latency to the first webhook and defeats FR-1's ~2 s greet target. Default is off; leave it off [findings/07 §13].

### R3. Sealed variables

On the Railway service Variables tab set: `AI_GATEWAY_API_KEY` (Vercel dashboard → AI Gateway → API Keys), `TWILIO_AUTH_TOKEN` (Twilio console), plus non-secret `MODEL_ID=openai/gpt-realtime-2.1`, `AUDIO_MODE=transcode` (flip to `pcmu` after the M1 spike), `VOICE=marin` (fallback `alloy` per G3 — Spec 01 owns the boot validation).

- R3.1 Seal `AI_GATEWAY_API_KEY` and `TWILIO_AUTH_TOKEN` via the variable's 3-dot menu → "Seal". **Sealing is irreversible** — the value can never be viewed again in UI or API, only overwritten. Store canonical copies in a password manager BEFORE sealing [findings/07 §14].
- R3.2 **Sealed values are NOT provided to `railway variables` or `railway run`** — local dev must use the `.env` file, never `railway run` [findings/07 §14, gotcha 4]. State this in the RUNBOOK.
- R3.3 **Every variable change triggers a redeploy, which severs live calls** — set all variables before any demo/test window [findings/07 §Implementation step 3, gotcha 2].
- R3.4 Missing `AI_GATEWAY_API_KEY` fails late and obscurely (SDK falls back to Vercel OIDC, which throws off-Vercel with a confusing message) — this is why Spec 01's `config.ts` validates required vars at boot [findings/01 gotcha 5; findings/10 G2].

### R4. GitHub auto-deploy (FR-8)

One-time setup sequence [findings/07 §6, §Implementation "Deploy pipeline"]:

1. Push the repo to GitHub.
2. Railway: New Project → **Deploy from GitHub repo** → select repo, branch `main`. Auto-deploy on push to the connected branch is the platform default; verify the Enable/Disable toggle in Service Settings is Enabled. Requires ≥1 project member with a connected GitHub account having contributor access, and the Railway GitHub App installed with repo access.
3. Leave "PR Environments" and "Wait for CI" **off** (BRD §7.1; no GitHub Actions workflow exists, so Wait-for-CI would strand deploys).
4. Service → Settings → Networking → **Generate Domain** → `RAILWAY_PUBLIC_DOMAIN` starts being injected.
5. Set variables per R3 (before the first real test window).
6. Manual fallback if a push doesn't deploy: Command Palette (Cmd+K) → "Deploy Latest Commit".

- R4.1 Do NOT configure watch paths (`watchPatterns`): commits touching only excluded paths are silently `SKIPPED` — a confusing FR-8 "failure" [findings/07 gotcha 12].
- R4.2 FR-8 acceptance = commit to `main` → live deployment with no manual action (A5).

### R5. Deploy lifecycle & the deploy-severs-calls operating rule

- R5.1 Verified lifecycle: new deploy builds → healthcheck until 200 (≤120 s) → new deploy Active → both deployments live for `overlapSeconds` (10 s) → old gets SIGTERM → `drainingSeconds` (60 s) to exit → SIGKILL. **Default SIGTERM grace is 0 s** — `drainingSeconds: 60` is what creates the window; the SIGTERM handler is useless without it and vice versa [findings/07 §9, gotcha 2].
- R5.2 **Operating rule: every deploy and every variable change is call-fatal. Deploy between test calls only.** 60 s < a 5–10 min call, and whether the edge keeps routing the established Twilio WS to the SIGTERM'd replica during the drain window is undocumented (S25) [findings/07 §9, gotcha 3].
- R5.3 The SIGTERM handler (implemented in Spec 02, restated here because it's the operational contract): set `draining = true` (new `/twiml` requests get 503), refuse new `/twilio-media` upgrades, let active sessions finish, exit at ≤55 s via an unref'd timer so the process beats the 60 s SIGKILL [findings/07 §Implementation "Server boot + SIGTERM drain"]. **Ordering constraint C18: the drain must run BEFORE `fastify.close()`** — `@fastify/websocket`'s default `preClose` severs all live WS connections in ~2 ms [findings/10 C18].
- R5.4 During drain, a still-live call whose gateway leg dies gets the R6 spoken fallback, not dead air.
- R5.5 WS idle-timeout non-issue, stated to prevent "fixes": Railway WebSocket connections are **exempt from all duration/inactivity limits** ("can stay open indefinitely, even while idle"); the 60 s timeout applies only to idle HTTP/1.1 connections between requests. Do not add WS-level keepalives to the Twilio leg for Railway's benefit [findings/07 §10, gotcha 1; findings/10 C6]. (The gateway leg's 5-min idle timer is a Vercel limit, out of scope here — Spec 04.)

### R6. FR-7 spoken fallback — DECISION (resolves G4)

**Decision:** the spoken fallback is a **pre-rendered μ-law apology clip stored in the repo**, sent over the already-open Twilio WS when the gateway leg dies mid-call, followed by a clean WS close (which ends the call — verified `<Connect>` fall-through [findings/03 claim 1]). Clean hangup alone is the fallback-of-the-fallback. Rationale: the alternative (`action`-URL TwiML branch with `<Say>`) executes on EVERY stream close including normal hangups unless an action handler branches on close cause — more moving parts, no findings verification either way [findings/10 G4]. The clip approach works identically in both audio modes because Twilio outbound is always raw μ-law/8000 regardless of `AUDIO_MODE`.

- R6.1 **Clip content:** ~4 s, e.g. "I'm sorry — I'm having a technical problem and have to hang up. Please call back in a moment." Stored as `assets/fallback-apology.ulaw`: raw μ-law bytes, 8000 Hz, mono, **no container/header** — header bytes cause garbled playback, documented explicitly [findings/03 claim 5].
- R6.2 **Size sanity:** 4 s × 8000 B/s = 32 KB raw ≈ 43 KB base64 — a single Twilio `media` message is fine ("The audio can be of any size" [findings/03 claim 5]), no 256 KB concern (that cap is the gateway leg, not Twilio).
- R6.3 **Generation** (`scripts/make-fallback-clip.sh`): record or TTS a WAV once, then:
  ```sh
  ffmpeg -i apology.wav -ar 8000 -ac 1 -f mulaw assets/fallback-apology.ulaw
  ```
  Commit the `.ulaw` output; the WAV source need not be committed. Document the spoken text in `assets/README.md`.
- R6.4 **`src/fallback.ts` contract:**
  ```ts
  // Loaded once at boot: readFileSync('assets/fallback-apology.ulaw') → base64 string cached in module scope.
  export async function playFallbackAndClose(s: Session): Promise<void>;
  ```
  Behavior: (1) no-op close if the Twilio WS is not OPEN or `streamSid` is unset (pre-`start` failure ⇒ clean hangup only); (2) send `{event:'media', streamSid, media:{payload: <clip base64>}}`; (3) send `{event:'mark', streamSid, mark:{name:'fallback-apology'}}`; (4) await the `fallback-apology` mark echo OR a hard timeout of clip-duration + 2000 ms (mark echo = played [findings/03 claim 4/5]; the timeout covers the case where the echo never comes); (5) `twilioWs.close()` — which ends the call [findings/03 claim 1]; (6) log `{"event":"fallback-played","reason":...}` (Spec 08 event schema).
- R6.5 **Triggers** (wired in Specs 02/05, listed here as the FR-7 contract): gateway `getToken` throw (any `GatewayError`, incl. concurrency rejection at mint — Spec 02's webhook path), gateway WS `unexpected-response`/`error` on upgrade, gateway WS unexpected `close` mid-call, gateway in-band fatal `error` event (Spec 05's `onGatewayFailure` hook). Both mint-time and WS-open-time concurrency rejections must reach this path (where the limit manifests is S24) [findings/01 detail 9, gotcha 9].
- R6.6 **Spike gate S23:** whether a clip sent immediately before `close()` reliably plays is unverified — the mark-echo wait in R6.4(4) is the mitigation. The 10-minute M1 playback check (kill the gateway WS mid-call, listen on the phone) is mandatory before FR-7 is declared passing; record the result in the README. If the clip does NOT play reliably, the accepted fallback is clean hangup only (never dead air) and the README records that finding.
- R6.7 Barge-in state is irrelevant here (call is ending), but send Twilio `{event:'clear'}` before the clip if model audio may still be buffered, so the apology isn't queued behind stale speech.

### R7. Twilio console runbook (BRD §6, corrected per findings/03)

One-time, human-performed; goes in `docs/RUNBOOK.md`:

1. **Upgrade the account if still trial** (card-swipe). Trial restricts inbound callers to verified numbers and plays a trial announcement; FR-3's parallel-call test from arbitrary phones is impossible on trial [findings/03 gotcha 10]. **Qualifier (C16/S20):** "no Twilio-side inbound concurrency limit" holds only for upgraded accounts with an **approved Business Profile**; new/unapproved accounts may have limited concurrency. Verify account state + profile approval in the console BEFORE M1 (S20); if the profile is pending, note it as a risk against the M4 parallel-call test [findings/03 claim 12; findings/10 C16, S20].
2. **Buy one US local number** (~$1.15/mo): Console → Phone Numbers → Buy a Number (US, Voice).
3. **Record `TWILIO_AUTH_TOKEN`** (Console dashboard) → password manager → Railway sealed variable (R3) + local `.env`.
4. After the first Railway deploy: number → **Voice Configuration** → "A call comes in" → **Webhook** → `https://<RAILWAY_PUBLIC_DOMAIN>/twiml` → HTTP POST → Save. (Local dev: point at the ngrok URL instead, R9.)
5. Media Streams needs no console config — the TwiML response creates the stream per call.
6. **statusCallback noting (delta vs BRD):** the TwiML `<Stream>` emitted by the bridge must set `statusCallback` to `https://<host>/stream-status` (log-only route; owned by the Twilio-leg spec). This is the ONLY channel that surfaces `StreamError` detail — e.g. handshake failures (error 31920) where the WS handler never runs — and it is the FR-7/S19 kill-test evidence channel [findings/03 §Impl E, claim 14]. The RUNBOOK's M1 checklist includes the kill test with statusCallback attached (S19).

### R8. `.env` and local environment loading

- R8.1 `.env.example` (committed; `.env` is git-ignored and never committed). **Spec 01 R8 owns the file's exact content** (plus Spec 04 R2's additive keys); the block below is the operator-facing summary and must not diverge from it:
  ```
  AI_GATEWAY_API_KEY=        # Vercel dashboard -> AI Gateway -> API Keys
  TWILIO_AUTH_TOKEN=         # Twilio console dashboard
  PORT=3000                  # local only; Railway injects PORT — never set it there
  PUBLIC_HOST=               # local only: bare ngrok hostname, e.g. abc123.ngrok-free.app
  MODEL_ID=openai/gpt-realtime-2.1
  AUDIO_MODE=transcode       # 'pcmu' after the M1 spike passes
  VOICE=marin                # fallback 'alloy' (G3)
  ```
- R8.2 **Env loading (G2 resolution, restated from Spec 01 for self-containment):** Node does not auto-load `.env` and neither does tsx. Use the flag-based loader — dev script `tsx watch --env-file=.env src/server.ts` (Node ≥ 20.6 native, zero deps, no `dotenv` package) [findings/10 G2]. Production (Railway) reads real env vars; the flag is harmless there but unused since `startCommand` is `node dist/server.js` (vars injected by Railway).
- R8.3 Host resolution rule: `PUBLIC_HOST` (when set) wins over `RAILWAY_PUBLIC_DOMAIN`; both are bare hostnames. Signature validation and TwiML must build URLs from this configured host, **never** from `req.hostname`/`req.protocol` (proxy view differs from what Twilio signed) [findings/03 §Impl B, gotcha 8; findings/07 §Implementation "URLs constructed"].

### R9. Local dev loop: ngrok (G5)

- R9.1 Flow: `npm run dev` (port 3000) → `ngrok http 3000` → set the Twilio number's webhook to `https://<ngrok-host>/twiml` → set `PUBLIC_HOST=<ngrok-host>` in `.env` (so TwiML emits `wss://<ngrok-host>/twilio-media`) → restart dev server → call the number.
- R9.2 **G5 caveat — unverified WS path:** no findings doc verified that ngrok's free tier forwards the Twilio Media Streams WS upgrade cleanly (the browser interstitial should not affect API/WS clients, but that is unstated anywhere). **The first local milestone is therefore a 10-minute ngrok smoke test**: one call, confirm in logs `connected` → `start` (with `customParameters.token`) → `media` frames arriving; on failure fall back to deploying to Railway for all testing (acceptable — deploys are one push). Record the smoke-test outcome in the README [findings/10 G5].
- R9.3 Signature note: the WS upgrade through ngrok sees ngrok's host, one more reason the `<Parameter>` token check is the primary stream gate and upgrade-signature validation stays advisory-only [findings/03 gotcha 13, claim 10].
- R9.4 **Latency numbers are only valid from Railway.** ngrok adds a tunnel hop on the media path (media transits the bridge in this architecture); use local for functional dev only, Railway (us-east4) for every latency measurement that feeds M5 (BRD §8; findings/07 §4).

### R10. Cost tracking (M1 first-billed-call check, M4/M5 accounting)

- R10.1 **Gateway spend:** `/v1/report` is 403 on Hobby [findings/01 gotcha 14] — the procedure is: (a) record `GET /v1/credits` (`gateway.getCredits()` → `{balance, totalUsed}` USD strings) before and after each test batch and log the delta; (b) inspect the Vercel dashboard → AI Gateway → Requests log after the **first billed call** (M1) to resolve S30 (audio-token pricing: listed $4/$24/M has no audio-token field; whether the gateway bills OpenAI's higher audio rates is unobservable pre-billing) and S31 (how realtime sessions appear — per-session rows? generation IDs in `session-created.raw`?) [findings/01 detail 11, claim 12].
- R10.2 `scripts/check-credits.ts`: standalone script (run via `tsx --env-file=.env scripts/check-credits.ts`) that imports `{ gateway }` from `@ai-sdk/gateway@4.0.23`, calls `await gateway.getCredits()`, and prints `{balance, totalUsed}` with a timestamp. Used before/after every M-milestone test batch; deltas recorded in the README findings table.
- R10.3 **Railway spend:** at M4, check the Railway dashboard usage page against the prediction (~$3/mo — Node RSS ~0.2–0.3 GB ⇒ $2–3 RAM, near-idle CPU, pennies of egress — inside the $5 Hobby credit) and record the actual burn (S27) [findings/07 §13].
- R10.4 Optionally set `providerOptions: { gateway: { tags: ['voice-poc'] } }` in the `session-update` config for spend attribution — whether the realtime route honors it is S32; check the dashboard after one tagged call [findings/01 detail 11].

### R11. Ops runbook content (`docs/RUNBOOK.md`)

The RUNBOOK must contain, at minimum:

- R11.1 **Reading Log Explorer:** logs are one minified JSON object per stdout line; `message` required, `level` ∈ debug|info|warn|error, all other top-level keys queryable. Filter cheat-sheet: `@callSid:CAxxxx` (per-call trace), `@level:error`, `@event:first-audio-delta AND @callSid:CAxxxx`, `-@event:media`, `replica:<id>`. Keep `callSid`/`event` **top-level** — nested-attribute querying is undocumented [findings/07 §12, §Implementation "Structured log line contract"]. Hard cap 500 lines/s/replica, overflow silently dropped after one warning — per-event logging only, never per-frame (5 calls × 50 fps × 2 directions = exactly 500/s) [findings/07 gotcha 7]. On the **first deployed build**, verify that custom-attribute filters (`@callSid:`, `@event:`) actually return results before M5 relies on them (S33).
- R11.2 **The 7-day extraction rule:** Hobby log retention is **7 days** [findings/07 gotcha 8]. After every milestone test session, extract the relevant log lines (per-call summaries, latency events per Spec 08's event schema) out of Railway into the repo (README findings section or `docs/measurements/`) the same day. M1–M5 measurement data left only in Railway WILL be lost.
- R11.3 **Deploy-between-calls checklist** (run before every push to `main` or variable change):
  1. Confirm no test call is in progress (check Log Explorer for a `stream-start` without matching `stream-stop`).
  2. Push / change the variable (either triggers a redeploy — R3.3, R5.2).
  3. Watch the deploy: build → healthcheck → Active. If the healthcheck fails, the old deploy keeps serving (R1.4) — fix and re-push; nothing is down.
  4. Verify the boot log line: `region: us-east4-eqdc4a` + new commit SHA (R2.8).
  5. Place one smoke call before resuming measurement calls.
- R11.4 **Incident quick-reference:** gateway leg dies mid-call → caller hears the R6 apology then hangup, log shows `fallback-played`; Twilio webhook 403s → signature/host mismatch, check `PUBLIC_HOST`/`RAILWAY_PUBLIC_DOMAIN` vs the console-configured URL (R8.3); stream never starts + call drops → check `/stream-status` logs for error 31920 detail (R7.6).
- R11.5 **Setup checklists** from R3, R4, R7 in executable order (Twilio account → repo push → Railway project → domain → variables → first deploy → Twilio webhook → M1 smoke call).

## Acceptance criteria

- A1. `railway.json` in the repo is byte-equivalent to R1 (numeric `drainingSeconds`/`overlapSeconds`; `us-east4-eqdc4a`; RAILPACK; `/health` with timeout 120) and the deployed service's boot log shows `region: us-east4-eqdc4a` (R2.8).
- A2. A commit pushed to `main` auto-deploys with no manual action; a deliberately broken commit (boot-crash) fails the healthcheck and the previous deployment keeps serving traffic (verifiable by placing a call during the failed deploy). Maps to **FR-8 / M4**.
- A3. `AI_GATEWAY_API_KEY` and `TWILIO_AUTH_TOKEN` are sealed on Railway (UI shows sealed state); copies exist in the password manager; RUNBOOK documents that sealed values are unavailable to `railway run`/`railway variables` and that local dev uses `.env`.
- A4. Kill test (gateway WS killed mid-call): caller hears the apology clip then the call ends — no dead air; logs contain `fallback-played` and the `/stream-status` route logged the stream lifecycle. If S23 shows the clip cannot play pre-close, acceptance degrades to: clean hangup with no dead air + README records the finding. Maps to **FR-7 / M1+M4**.
- A5. `assets/fallback-apology.ulaw` is raw headerless μ-law/8000 mono (checkable: file size ≈ 8000 × duration bytes; first bytes are not `RIFF`), regenerable via `scripts/make-fallback-clip.sh`.
- A6. Twilio number configured: webhook `https://<RAILWAY_PUBLIC_DOMAIN>/twiml` POST; account upgraded and Business Profile state recorded in the RUNBOOK (S20). A call from an arbitrary (unverified) phone reaches the bridge. Maps to **FR-1 precondition**.
- A7. Local dev: `npm run dev` + ngrok completes the 10-minute smoke test (R9.2) — `connected`/`start`/`media` observed in local logs from a real phone call — or the README records ngrok-WS failure and the Railway-only fallback. Maps to **G5 closure**.
- A8. `scripts/check-credits.ts` prints `{balance, totalUsed}` from live `/v1/credits`; RUNBOOK's cost procedure produced a recorded credits-delta for the first billed call plus a dashboard note resolving/attempting S30–S31; Railway usage recorded at M4 (S27). Maps to **M5**.
- A9. `docs/RUNBOOK.md` contains all five R11 sections; the Log Explorer `@callSid:` filter was verified working on the first deployed build (S33 noted as resolved or failed).
- A10. No Dockerfile exists in the repo; no `PORT` variable is set on the Railway service; no `watchPatterns` configured (R2.3, R2.6, R4.1).

## Out of scope

- The SIGTERM drain handler implementation (Spec 02), session teardown ordering (Spec 05), and gateway-leg error state machine (Spec 04) — this spec only fixes the operational contract R5.3 and the fallback trigger list R6.5.
- The `/twiml`, `/twilio-media`, `/stream-status`, `/mcp`, `/health` route implementations (Twilio-leg / server specs); this spec constrains only their deploy-facing behavior (health-before-async-boot, 503-during-drain, statusCallback URL value).
- Logging event schema and latency instrumentation (Spec 08); this spec only consumes it in the RUNBOOK.
- tsconfig/ESM decisions, dependency pinning, `config.ts` boot validation (Spec 01 / G1, G2 owner — R8.2 restates the dev-script consequence only).
- Barge-in, DSP, MCP tooling, gateway protocol handling.
- Any multi-environment/PR-environment Railway setup, custom domains, or scaling beyond 1 replica.

## Open items deferred to runtime spikes (S-numbers from findings/10)

- **S25** — WS connection routing during overlap/draining (does the established Twilio WS keep flowing to the SIGTERM'd replica; are new connections switched atomically at Active?). Probe at M4: deploy mid-call with `overlapSeconds:10, drainingSeconds:60`, observe whether the call survives. Until resolved, R5.2's deploy-between-calls rule is absolute.
- **S23** — canned μ-law clip sent right before `twilioWs.close()` reliably plays (10-minute M1 playback check; gates R6/A4's spoken-fallback claim).
- **S19** — caller-experience timing on handshake failure and mid-call WS drop (M1 kill test with `statusCallback` attached; FR-7 evidence).
- **S20** — Twilio account upgraded + Business Profile approved (human console check pre-M1; gates FR-3 parallel testing and the "no inbound concurrency limit" claim).
- **S27** — actual Railway Hobby usage burn vs ~$3/mo prediction (dashboard check at M4).
- **S30 / S31 / S32** — audio-token billing rates, realtime-session representation in the dashboard / generation IDs, and `providerOptions.gateway` tag attribution (first billed call at M1 + dashboard; `/v1/credits` delta is the plan-proof fallback since `/v1/report` is 403 on Hobby).
- **S33** — Log Explorer custom-attribute filtering (`@callSid:`, `@event:`) verified on the first deployed build; indexing lag under burst noted if observed.
- **S24** (shared with Spec 02) — where the gateway concurrency rejection manifests (mint vs WS-open); both paths must reach `playFallbackAndClose` (R6.5).

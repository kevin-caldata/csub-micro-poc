// src/fallback.ts — FR-7 spoken fallback: playFallbackAndClose (Spec 09 R6.4-R6.7, A4).
//
// Decision (Spec 09 R6): when the gateway leg dies mid-call, play a pre-rendered mu-law apology
// clip over the already-open Twilio WS, then close it — closing the WS ends the call via the
// PoC TwiML's `<Connect>` fall-through [findings/03 claim 1]. Clean hangup alone is the
// fallback-of-the-fallback if the clip never plays.
//
// R6.5 trigger list (wired in Specs 02/05 — NOT this file): gateway `getToken` throw (any
// `GatewayError`, incl. concurrency rejection at mint — Spec 02's webhook path), gateway WS
// `unexpected-response`/`error` on upgrade, gateway WS unexpected `close` mid-call, gateway
// in-band fatal `error` event (Spec 05's `onGatewayFailure` hook). Both mint-time and
// WS-open-time concurrency rejections must reach this path [findings/01 detail 9, gotcha 9].
//
// R6.6 spike gate S23: whether a clip sent immediately before close() reliably plays is
// unverified — the mark-echo wait below is the mitigation. The mandatory M1 kill-test (kill the
// gateway WS mid-call, listen on the phone) decides this before FR-7 is declared passing; if the
// clip does NOT play reliably, the accepted fallback degrades to clean hangup only (never dead
// air), recorded in the README — that is a finding, not a code change here.
//
// Wiring note: this module is intentionally NOT wired into src/session.ts / src/sessions.ts /
// src/server.ts. Plugging playFallbackAndClose into Spec 05's onGatewayFailure hook is a
// one-line change applied at the Wave D merge point (00-master-build-plan.md §Wave D, T09 row),
// gated on spike S23 — do not wire it from this task.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws'; // default-export namespace; used here only for the OPEN readyState constant
import type { Session } from './sessions.js';
import { sendMedia, sendMark, sendClear } from './twilio-media.js';
import { now } from './logger.js';

// Findings review (Minor — boot CWD fragility): a bare `'assets/fallback-apology.ulaw'` is
// resolved by Node relative to `process.cwd()`, NOT relative to this module — `node dist/server.js`
// boot-crashes (`ENOENT`) the instant it's launched from any directory other than the repo root
// (Railway's start command, a systemd unit, `npm start` invoked from elsewhere, etc). Resolve from
// `import.meta.url` instead: this file compiles 1:1 from `src/fallback.ts` to `dist/fallback.js`
// (tsconfig `rootDir: 'src'`/`outDir: 'dist'`), and `assets/` is a sibling of both `src/` and
// `dist/` at the repo root — so `../assets/...` relative to THIS module's own URL is correct in
// both the dev (tsx, running straight off `src/`) and built (`dist/`) layouts, regardless of cwd.
const CLIP_PATH = fileURLToPath(new URL('../assets/fallback-apology.ulaw', import.meta.url));
const MARK_NAME = 'fallback-apology';

/** Loaded once at boot: raw mu-law clip bytes → base64, cached in module scope (Spec 09 R6.4). */
const defaultClipB64: string = readFileSync(CLIP_PATH).toString('base64');

/** Default poll cadence for the mark-echo wait below (R6.4-4). */
const DEFAULT_POLL_MS = 50;

export interface PlayFallbackOptions {
  /** Test seam: override the clip payload instead of reading assets/fallback-apology.ulaw. */
  clipB64?: string;
  /** Test seam: override the hard timeout (default = clip duration + 2000 ms, R6.4-4). */
  timeoutMs?: number;
  /** Test seam: override the mark-queue poll interval (default 50 ms). */
  pollMs?: number;
  /** Additive clarification fed into the `fallback-played` log line's `reason` field. */
  reason?: string;
}

/**
 * Resolves once `markName` is no longer in `s.markQueue` (echoed — remove-by-name, Spec 03 R4)
 * or once `timeoutMs` elapses, whichever comes first. Polls rather than hooking
 * `onPlaybackDrained` deliberately: that hook is Spec 05's barge-in epoch-reset seam, and this
 * helper must not touch it (would risk a cross-spec ordering coupling for no benefit — the raw
 * markQueue array is a stable enough read-only observation point on its own).
 */
function waitForMarkEcho(
  s: Session,
  markName: string,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (echoed: boolean): void => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timer);
      resolve(echoed);
    };
    const interval = setInterval(() => {
      if (!s.markQueue.includes(markName)) finish(true);
    }, pollMs);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Test seam (T09.3 plan §Interfaces): same behavior as `playFallbackAndClose`, with injectable
 * clip bytes/timing so the test suite never needs the mandatory ~9 s real timeout to observe the
 * happy/timeout paths. The public function below delegates here with defaults.
 */
export async function playFallbackAndCloseWith(
  s: Session,
  opts: PlayFallbackOptions = {},
): Promise<void> {
  const clip = opts.clipB64 ?? defaultClipB64;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  // Default timeout = clip duration (8000 bytes/s raw mu-law) + 2000 ms (R6.4-4), derived from
  // whichever clip is actually in play (real asset or a test override).
  const clipDurationMs = (Buffer.from(clip, 'base64').length / 8000) * 1000;
  const timeoutMs = opts.timeoutMs ?? clipDurationMs + 2000;

  const startedAt = now();
  let echoed = false;

  try {
    // R6.4-1: no-op close if the Twilio WS is not OPEN or streamSid is unset (pre-`start`
    // failure ⇒ clean hangup only, below, is still attempted).
    const ready = s.streamSid !== '' && s.twilioWs.readyState === WebSocket.OPEN;
    if (ready) {
      // R6.7: flush any stale buffered audio before the clip so it isn't queued behind it.
      if (s.markQueue.length > 0) sendClear(s);
      sendMedia(s, clip); // R6.4-2
      sendMark(s, MARK_NAME); // R6.4-3
      echoed = await waitForMarkEcho(s, MARK_NAME, timeoutMs, pollMs); // R6.4-4
    }
  } catch (err) {
    // Never let a failing fallback throw out of this function — a crash here must not skip the
    // close() below (would leave a dead-air call hanging on the caller's end).
    s.log('error', 'fallback playback failed', {
      event: 'fallback-error',
      callSid: s.callSid,
      streamSid: s.streamSid,
      err: String(err),
    });
  } finally {
    try {
      // R6.4-5: closing the Twilio WS ends the call (verified `<Connect>` fall-through).
      if (s.twilioWs.readyState === WebSocket.OPEN) s.twilioWs.close();
    } catch (err) {
      s.log('error', 'fallback close failed', {
        event: 'fallback-close-error',
        callSid: s.callSid,
        streamSid: s.streamSid,
        err: String(err),
      });
    }
    // R6.4-6 (Spec 08 line contract — flat scalar fields only).
    s.log('info', 'fallback-played', {
      event: 'fallback-played',
      reason: opts.reason,
      callSid: s.callSid,
      streamSid: s.streamSid,
      waitedMs: now() - startedAt,
      echoed,
    });
  }
}

/** Spec 09 R6.4 public contract. `reason` is additive: feeds the `fallback-played` log line. */
export async function playFallbackAndClose(s: Session, reason?: string): Promise<void> {
  return playFallbackAndCloseWith(s, { reason });
}

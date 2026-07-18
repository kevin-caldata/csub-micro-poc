import { test, expect } from 'vitest';
import type { LogFields } from '../src/logger.js';
import { pct, TurnRecorder, startLoopMonitor, loopP99Ms } from '../src/latency.js';

function makeRecorder(): { recorder: TurnRecorder; lines: LogFields[] } {
  const lines: LogFields[] = [];
  const recorder = new TurnRecorder({ callSid: 'CA1', streamSid: 'MZ1' }, (fields) => {
    lines.push(fields);
  });
  return { recorder, lines };
}

function findLines(lines: LogFields[], event: string): LogFields[] {
  return lines.filter((l) => l.event === event);
}

// 1. pct
test('pct: empty array is undefined', () => {
  expect(pct([], 50)).toBe(undefined);
});

test('pct: single value returns that value for any percentile', () => {
  expect(pct([42], 50)).toBe(42);
  expect(pct([42], 95)).toBe(42);
  expect(pct([42], 0)).toBe(42);
});

test('pct: nearest-rank over a known 20-element array', () => {
  const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  // nearest-rank: index = ceil(p/100 * n) - 1
  // p50: ceil(0.5*20)-1 = 9 -> sorted[9] = 10
  expect(pct(values, 50)).toBe(10);
  // p95: ceil(0.95*20)-1 = 18 -> sorted[18] = 19
  expect(pct(values, 95)).toBe(19);
});

// 2. Happy turn
test('happy turn: full sequence emits exactly one turn line with correct derived fields', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  const first = recorder.onAudioDelta('r1');
  expect(first).toBe(true);
  recorder.onFirstTwilioSend('r1');
  recorder.onFirstTwilioFlush('r1');
  recorder.onMarkEcho('rr1:0');
  recorder.onResponseDone('r1', 'completed');

  const turnLines = findLines(lines, 'turn');
  expect(turnLines.length).toBe(1);
  const line = turnLines[0]!;
  expect(line.turn).toBe(1);
  expect(line.responseId).toBe('r1');
  expect(typeof line.ttfbMs).toBe('number');
  expect(typeof line.bridgeMs).toBe('number');
  expect(typeof line.turnMs).toBe('number');
  expect(typeof line.playbackConfirmMs).toBe('number');
  expect(line.bargedIn).toBe(false);
  expect(line.status).toBe('completed');
  const ttfbMs = line.ttfbMs as number;
  const bridgeMs = line.bridgeMs as number;
  const turnMs = line.turnMs as number;
  expect(Math.abs(turnMs - (ttfbMs + bridgeMs)) <= 0.2).toBeTruthy();
});

// 3. Second delta on same response
test('second audio-delta on same response returns false and emits nothing', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  expect(recorder.onAudioDelta('r1')).toBe(true);
  lines.length = 0; // clear the first-audio-delta line
  const second = recorder.onAudioDelta('r1');
  expect(second).toBe(false);
  expect(findLines(lines, 'first-audio-delta').length).toBe(0);
});

// 4. Lazy attach (S16)
test('lazy attach: delta before response-created still returns true and keys the turn', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  // no onResponseCreated call
  const first = recorder.onAudioDelta('r2');
  expect(first).toBe(true);
  recorder.onFirstTwilioSend('r2');
  recorder.onResponseDone('r2', 'completed');
  const turnLines = findLines(lines, 'turn');
  expect(turnLines.length).toBe(1);
  expect(turnLines[0]!.responseId).toBe('r2');
});

// 5. Foreign responseId
test('foreign responseId: onAudioDelta for an untracked response returns false, emits nothing', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  const result = recorder.onAudioDelta('rX');
  expect(result).toBe(false);
  expect(findLines(lines, 'first-audio-delta').length).toBe(0);
});

// 6. Barge-in after first delta
test('barge-in after first delta: tags bargedIn:true, keeps ttfbMs, emits barge-in line', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  recorder.onAudioDelta('r1');
  recorder.onFirstTwilioSend('r1');

  recorder.onSpeechStarted(); // barge-in mid-response
  recorder.onBargeIn({ audioEndMs: 1234 });

  recorder.onResponseDone('r1', 'cancelled');

  const turnLines = findLines(lines, 'turn');
  expect(turnLines.length).toBe(1);
  expect(turnLines[0]!.bargedIn).toBe(true);
  expect(typeof turnLines[0]!.ttfbMs).toBe('number');

  const bargeLines = findLines(lines, 'barge-in');
  expect(bargeLines.length).toBe(1);
  expect(typeof bargeLines[0]!.msSinceFirstSend).toBe('number');
  expect(bargeLines[0]!.audioEndMs).toBe(1234);
});

// 7. Barge-in before first delta
test('barge-in before first delta: turn closes with no ttfbMs', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  recorder.onSpeechStarted(); // barge-in before any audio-delta
  recorder.onResponseDone('r1', 'cancelled');

  const turnLines = findLines(lines, 'turn');
  expect(turnLines.length).toBe(1);
  expect(turnLines[0]!.ttfbMs).toBe(undefined);
  expect(turnLines[0]!.bargedIn).toBe(true);
});

// 8. Mark echo tolerance
test('mark echo tolerance: unknown/duplicate/malformed names never throw or restamp', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  recorder.onAudioDelta('r1');
  recorder.onFirstTwilioSend('r1');

  expect(() => recorder.onMarkEcho('garbage')).not.toThrow();
  expect(() => recorder.onMarkEcho('rUNKNOWN:0')).not.toThrow();
  expect(() => recorder.onMarkEcho('rr1:0')).not.toThrow();
  expect(() => recorder.onMarkEcho('rr1:0')).not.toThrow(); // duplicate
  expect(() => recorder.onMarkEcho('rr1:1')).not.toThrow(); // post-clear echo storm member
  expect(() => recorder.onMarkEcho('')).not.toThrow();

  recorder.onResponseDone('r1', 'completed');
  const turnLines = findLines(lines, 'turn');
  expect(typeof turnLines[0]!.playbackConfirmMs).toBe('number');
});

// 9. Dangling turn
test('dangling turn: a second speech-stopped before response-done closes turn 1 as incomplete', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  // no response-done for turn 1
  expect(() => recorder.onSpeechStopped()).not.toThrow();

  expect(recorder.turns.length).toBe(1);
  expect(recorder.turns[0]!.turn).toBe(1);
  expect(recorder.turns[0]!.ttfbMs).toBe(undefined);
  expect(recorder.turns[0]!.turnMs).toBe(undefined);

  // no 'turn' log line was emitted for the dangling turn (only response-done emits it)
  expect(findLines(lines, 'turn').length).toBe(0);

  // turn 2 is open and usable
  recorder.onResponseCreated('r2');
  recorder.onAudioDelta('r2');
  recorder.onFirstTwilioSend('r2');
  recorder.onResponseDone('r2', 'completed');
  expect(recorder.turns.length).toBe(2);
  expect(recorder.turns[1]!.turn).toBe(2);
});

// Every emitted line carries the constant field set
test('every emitted line carries callSid, streamSid, event, level, message', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStarted();
  recorder.onSpeechStopped();
  for (const line of lines) {
    expect(line.callSid).toBe('CA1');
    expect(line.streamSid).toBe('MZ1');
    expect(typeof line.event).toBe('string');
    expect(typeof line.level).toBe('string');
    expect(typeof line.message).toBe('string');
  }
});

// ── T08.3: greeting record, tool round-trip decomposition, stream-stop summary ────────────

// 1. Greeting flow (A7, A9)
test('greeting flow: emits ONE greeting line with all R7 deltas, no turn line for g1', () => {
  const { recorder, lines } = makeRecorder();
  recorder.seedGreeting({ tTwimlPost: 0, getTokenMs: 87.2, tokenExpiresAt: '2026-07-18T18:00:00Z' });
  recorder.onWsStart();
  recorder.onGatewayOpen();
  recorder.onSessionUpdateSent();
  recorder.onSessionUpdated();
  recorder.onGreetingCreateSent();
  recorder.onResponseCreated('g1');
  const first = recorder.onAudioDelta('g1');
  expect(first).toBe(true);
  recorder.onFirstTwilioSend('g1');
  recorder.onMarkEcho('rg1:0');

  const greetingLines = findLines(lines, 'greeting');
  expect(greetingLines.length).toBe(1);
  const g = greetingLines[0]!;
  for (const field of [
    'webhookToStartMs',
    'gatewayOpenMs',
    'sessionUpdateAckMs',
    'greetingTtfbMs',
    'greetingBridgeMs',
    'greetingPlaybackConfirmMs',
    'greetingTotalMs',
  ]) {
    expect(typeof g[field], `${field} should be numeric`).toBe('number');
  }
  expect(g.getTokenMs).toBe(87.2);
  expect(g.tokenExpiresAt).toBe('2026-07-18T18:00:00Z');

  expect(findLines(lines, 'turn').length).toBe(0);
});

// 2. Greeting fallback (R7 emission rule: never lost)
test('greeting fallback: no mark echo -> greeting line emitted at response-done, no playbackConfirmMs', () => {
  const { recorder, lines } = makeRecorder();
  recorder.seedGreeting({ tTwimlPost: 0, getTokenMs: 50, tokenExpiresAt: '2026-07-18T18:00:00Z' });
  recorder.onWsStart();
  recorder.onGatewayOpen();
  recorder.onSessionUpdateSent();
  recorder.onSessionUpdated();
  recorder.onGreetingCreateSent();
  recorder.onResponseCreated('g1');
  recorder.onAudioDelta('g1');
  recorder.onFirstTwilioSend('g1');
  // no onMarkEcho
  recorder.onResponseDone('g1', 'completed');

  const greetingLines = findLines(lines, 'greeting');
  expect(greetingLines.length).toBe(1);
  expect(greetingLines[0]!.greetingPlaybackConfirmMs).toBe(undefined);
});

// 3. Tool follow-up attribution (A5, A6)
test('tool follow-up attribution: follow-up first delta stamps tFollowupFirstDelta, emits tool-call, no new turn', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  recorder.onToolArgsDone('call_1', 'get_current_time');
  recorder.onToolResolved('call_1');
  recorder.onToolOutputSent('call_1');
  recorder.onResponseDone('r1', 'completed');
  recorder.onToolResponseCreateSent('call_1');
  recorder.onResponseCreated('r2');
  const first = recorder.onAudioDelta('r2');
  expect(first).toBe(true);

  const toolLines = findLines(lines, 'tool-call');
  expect(toolLines.length).toBe(1);
  const t = toolLines[0]!;
  expect(typeof t.mcpMs).toBe('number');
  expect(typeof t.gateWaitMs).toBe('number');
  expect(typeof t.secondTtfbMs).toBe('number');
  expect(typeof t.toolTotalMs).toBe('number');
  expect(t.callId).toBe('call_1');

  // No new turn opened for r2 — still exactly one turn (r1), keyed by responseId r1.
  expect(recorder.turns.length).toBe(1);
  expect(recorder.turns[0]!.responseId).toBe('r1');
  const turnLines = findLines(lines, 'turn');
  expect(turnLines.length).toBe(1);
  expect(turnLines[0]!.turn).toBe(1);
});

// 4. Tool failure, no follow-up audio
test('tool failure: no follow-up audio -> tool-call line carries isError:true, no secondTtfbMs', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  recorder.onToolArgsDone('call_1', 'get_current_time');
  recorder.onToolResolved('call_1', true);
  recorder.onResponseDone('r1', 'failed');

  const toolLines = findLines(lines, 'tool-call');
  expect(toolLines.length).toBe(1);
  expect(toolLines[0]!.isError).toBe(true);
  expect(toolLines[0]!.secondTtfbMs).toBe(undefined);
});

// 5. Summary (A8, A9)
test('stream-stop summary: n excludes barged-no-audio turn and the greeting', () => {
  startLoopMonitor(); // production boots this once; the summary reads the process-wide histogram
  const { recorder, lines } = makeRecorder();

  // Greeting — must never enter turns[] or the percentiles.
  recorder.seedGreeting({ tTwimlPost: 0, getTokenMs: 40 });
  recorder.onWsStart();
  recorder.onGreetingCreateSent();
  recorder.onResponseCreated('g1');
  recorder.onAudioDelta('g1');
  recorder.onFirstTwilioSend('g1');
  recorder.onMarkEcho('rg1:0');

  // 3 complete turns.
  for (const id of ['r1', 'r2', 'r3']) {
    recorder.onSpeechStopped();
    recorder.onResponseCreated(id);
    recorder.onAudioDelta(id);
    recorder.onFirstTwilioSend(id);
    recorder.onResponseDone(id, 'completed');
  }

  // 1 barged-before-first-audio turn.
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r4');
  recorder.onSpeechStarted();
  recorder.onResponseDone('r4', 'cancelled');

  recorder.onStreamStop();

  const summaryLines = findLines(lines, 'stream-stop');
  expect(summaryLines.length).toBe(1);
  const s = summaryLines[0]!;
  expect(s.turns).toBe(4);
  expect(s.n).toBe(3);
  expect(s.bargeIns).toBe(1);
  for (const field of ['ttfbP50', 'ttfbP95', 'ttfbMax', 'bridgeP50', 'bridgeP95', 'turnP50', 'turnP95', 'turnMax']) {
    expect(typeof s[field], `${field} should be numeric`).toBe('number');
  }
  expect(s.toolCalls).toBe(0);
  expect(typeof s.loopP99Ms).toBe('number');
});

// 6. Idempotent stream-stop
test('onStreamStop() twice emits exactly one summary', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onWsStart();
  recorder.onStreamStop();
  recorder.onStreamStop();
  expect(findLines(lines, 'stream-stop').length).toBe(1);
});

// 7. Event-loop guard
test('loopP99Ms() after startLoopMonitor() returns a finite number >= 0', () => {
  startLoopMonitor();
  const v = loopP99Ms();
  expect(typeof v).toBe('number');
  expect(Number.isFinite(v)).toBeTruthy();
  expect((v as number) >= 0).toBeTruthy();
});

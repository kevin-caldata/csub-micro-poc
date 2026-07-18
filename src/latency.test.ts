import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogFields } from './logger.js';
import { pct, TurnRecorder, startLoopMonitor, loopP99Ms } from './latency.js';

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
  assert.equal(pct([], 50), undefined);
});

test('pct: single value returns that value for any percentile', () => {
  assert.equal(pct([42], 50), 42);
  assert.equal(pct([42], 95), 42);
  assert.equal(pct([42], 0), 42);
});

test('pct: nearest-rank over a known 20-element array', () => {
  const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  // nearest-rank: index = ceil(p/100 * n) - 1
  // p50: ceil(0.5*20)-1 = 9 -> sorted[9] = 10
  assert.equal(pct(values, 50), 10);
  // p95: ceil(0.95*20)-1 = 18 -> sorted[18] = 19
  assert.equal(pct(values, 95), 19);
});

// 2. Happy turn
test('happy turn: full sequence emits exactly one turn line with correct derived fields', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  const first = recorder.onAudioDelta('r1');
  assert.equal(first, true);
  recorder.onFirstTwilioSend('r1');
  recorder.onFirstTwilioFlush('r1');
  recorder.onMarkEcho('rr1:0');
  recorder.onResponseDone('r1', 'completed');

  const turnLines = findLines(lines, 'turn');
  assert.equal(turnLines.length, 1);
  const line = turnLines[0]!;
  assert.equal(line.turn, 1);
  assert.equal(line.responseId, 'r1');
  assert.equal(typeof line.ttfbMs, 'number');
  assert.equal(typeof line.bridgeMs, 'number');
  assert.equal(typeof line.turnMs, 'number');
  assert.equal(typeof line.playbackConfirmMs, 'number');
  assert.equal(line.bargedIn, false);
  assert.equal(line.status, 'completed');
  const ttfbMs = line.ttfbMs as number;
  const bridgeMs = line.bridgeMs as number;
  const turnMs = line.turnMs as number;
  assert.ok(Math.abs(turnMs - (ttfbMs + bridgeMs)) <= 0.2);
});

// 3. Second delta on same response
test('second audio-delta on same response returns false and emits nothing', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  assert.equal(recorder.onAudioDelta('r1'), true);
  lines.length = 0; // clear the first-audio-delta line
  const second = recorder.onAudioDelta('r1');
  assert.equal(second, false);
  assert.equal(findLines(lines, 'first-audio-delta').length, 0);
});

// 4. Lazy attach (S16)
test('lazy attach: delta before response-created still returns true and keys the turn', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  // no onResponseCreated call
  const first = recorder.onAudioDelta('r2');
  assert.equal(first, true);
  recorder.onFirstTwilioSend('r2');
  recorder.onResponseDone('r2', 'completed');
  const turnLines = findLines(lines, 'turn');
  assert.equal(turnLines.length, 1);
  assert.equal(turnLines[0]!.responseId, 'r2');
});

// 5. Foreign responseId
test('foreign responseId: onAudioDelta for an untracked response returns false, emits nothing', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  const result = recorder.onAudioDelta('rX');
  assert.equal(result, false);
  assert.equal(findLines(lines, 'first-audio-delta').length, 0);
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
  assert.equal(turnLines.length, 1);
  assert.equal(turnLines[0]!.bargedIn, true);
  assert.equal(typeof turnLines[0]!.ttfbMs, 'number');

  const bargeLines = findLines(lines, 'barge-in');
  assert.equal(bargeLines.length, 1);
  assert.equal(typeof bargeLines[0]!.msSinceFirstSend, 'number');
  assert.equal(bargeLines[0]!.audioEndMs, 1234);
});

// 7. Barge-in before first delta
test('barge-in before first delta: turn closes with no ttfbMs', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  recorder.onSpeechStarted(); // barge-in before any audio-delta
  recorder.onResponseDone('r1', 'cancelled');

  const turnLines = findLines(lines, 'turn');
  assert.equal(turnLines.length, 1);
  assert.equal(turnLines[0]!.ttfbMs, undefined);
  assert.equal(turnLines[0]!.bargedIn, true);
});

// 8. Mark echo tolerance
test('mark echo tolerance: unknown/duplicate/malformed names never throw or restamp', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  recorder.onAudioDelta('r1');
  recorder.onFirstTwilioSend('r1');

  assert.doesNotThrow(() => recorder.onMarkEcho('garbage'));
  assert.doesNotThrow(() => recorder.onMarkEcho('rUNKNOWN:0'));
  assert.doesNotThrow(() => recorder.onMarkEcho('rr1:0'));
  assert.doesNotThrow(() => recorder.onMarkEcho('rr1:0')); // duplicate
  assert.doesNotThrow(() => recorder.onMarkEcho('rr1:1')); // post-clear echo storm member
  assert.doesNotThrow(() => recorder.onMarkEcho(''));

  recorder.onResponseDone('r1', 'completed');
  const turnLines = findLines(lines, 'turn');
  assert.equal(typeof turnLines[0]!.playbackConfirmMs, 'number');
});

// 9. Dangling turn
test('dangling turn: a second speech-stopped before response-done closes turn 1 as incomplete', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStopped();
  recorder.onResponseCreated('r1');
  // no response-done for turn 1
  assert.doesNotThrow(() => recorder.onSpeechStopped());

  assert.equal(recorder.turns.length, 1);
  assert.equal(recorder.turns[0]!.turn, 1);
  assert.equal(recorder.turns[0]!.ttfbMs, undefined);
  assert.equal(recorder.turns[0]!.turnMs, undefined);

  // no 'turn' log line was emitted for the dangling turn (only response-done emits it)
  assert.equal(findLines(lines, 'turn').length, 0);

  // turn 2 is open and usable
  recorder.onResponseCreated('r2');
  recorder.onAudioDelta('r2');
  recorder.onFirstTwilioSend('r2');
  recorder.onResponseDone('r2', 'completed');
  assert.equal(recorder.turns.length, 2);
  assert.equal(recorder.turns[1]!.turn, 2);
});

// Every emitted line carries the constant field set
test('every emitted line carries callSid, streamSid, event, level, message', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onSpeechStarted();
  recorder.onSpeechStopped();
  for (const line of lines) {
    assert.equal(line.callSid, 'CA1');
    assert.equal(line.streamSid, 'MZ1');
    assert.equal(typeof line.event, 'string');
    assert.equal(typeof line.level, 'string');
    assert.equal(typeof line.message, 'string');
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
  assert.equal(first, true);
  recorder.onFirstTwilioSend('g1');
  recorder.onMarkEcho('rg1:0');

  const greetingLines = findLines(lines, 'greeting');
  assert.equal(greetingLines.length, 1);
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
    assert.equal(typeof g[field], 'number', `${field} should be numeric`);
  }
  assert.equal(g.getTokenMs, 87.2);
  assert.equal(g.tokenExpiresAt, '2026-07-18T18:00:00Z');

  assert.equal(findLines(lines, 'turn').length, 0);
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
  assert.equal(greetingLines.length, 1);
  assert.equal(greetingLines[0]!.greetingPlaybackConfirmMs, undefined);
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
  assert.equal(first, true);

  const toolLines = findLines(lines, 'tool-call');
  assert.equal(toolLines.length, 1);
  const t = toolLines[0]!;
  assert.equal(typeof t.mcpMs, 'number');
  assert.equal(typeof t.gateWaitMs, 'number');
  assert.equal(typeof t.secondTtfbMs, 'number');
  assert.equal(typeof t.toolTotalMs, 'number');
  assert.equal(t.callId, 'call_1');

  // No new turn opened for r2 — still exactly one turn (r1), keyed by responseId r1.
  assert.equal(recorder.turns.length, 1);
  assert.equal(recorder.turns[0]!.responseId, 'r1');
  const turnLines = findLines(lines, 'turn');
  assert.equal(turnLines.length, 1);
  assert.equal(turnLines[0]!.turn, 1);
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
  assert.equal(toolLines.length, 1);
  assert.equal(toolLines[0]!.isError, true);
  assert.equal(toolLines[0]!.secondTtfbMs, undefined);
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
  assert.equal(summaryLines.length, 1);
  const s = summaryLines[0]!;
  assert.equal(s.turns, 4);
  assert.equal(s.n, 3);
  assert.equal(s.bargeIns, 1);
  for (const field of ['ttfbP50', 'ttfbP95', 'ttfbMax', 'bridgeP50', 'bridgeP95', 'turnP50', 'turnP95', 'turnMax']) {
    assert.equal(typeof s[field], 'number', `${field} should be numeric`);
  }
  assert.equal(s.toolCalls, 0);
  assert.equal(typeof s.loopP99Ms, 'number');
});

// 6. Idempotent stream-stop
test('onStreamStop() twice emits exactly one summary', () => {
  const { recorder, lines } = makeRecorder();
  recorder.onWsStart();
  recorder.onStreamStop();
  recorder.onStreamStop();
  assert.equal(findLines(lines, 'stream-stop').length, 1);
});

// 7. Event-loop guard
test('loopP99Ms() after startLoopMonitor() returns a finite number >= 0', () => {
  startLoopMonitor();
  const v = loopP99Ms();
  assert.equal(typeof v, 'number');
  assert.ok(Number.isFinite(v));
  assert.ok((v as number) >= 0);
});

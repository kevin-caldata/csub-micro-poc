import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogFields } from './logger.js';
import { pct, TurnRecorder } from './latency.js';

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

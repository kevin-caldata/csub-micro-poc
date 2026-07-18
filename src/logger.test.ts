import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { log, logEvent, ms, now, safeRaw } from './logger.js';

/** Monkey-patches process.stdout/stderr.write for the duration of fn and returns what was written. */
function withCapturedOutput(fn: () => void): { stdoutLines: string[]; stderrWrites: unknown[] } {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const stdoutLines: string[] = [];
  const stderrWrites: unknown[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  return { stdoutLines, stderrWrites };
}

describe('logger', () => {
  it('log() emits exactly one single-line JSON line to stdout, never stderr', () => {
    const { stdoutLines, stderrWrites } = withCapturedOutput(() => {
      log('info', 'hi', { callSid: 'CA1', n: 5 });
    });
    assert.equal(stdoutLines.length, 1);
    const line = stdoutLines[0]!;
    assert.equal(line.endsWith('\n'), true);
    assert.equal(line.slice(0, -1).includes('\n'), false); // no embedded newlines besides the trailing one
    const parsed = JSON.parse(line);
    assert.equal(typeof parsed.message, 'string');
    assert.equal(parsed.message, 'hi');
    assert.equal(typeof parsed.level, 'string');
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.callSid, 'CA1');
    assert.equal(stderrWrites.length, 0);
  });

  it('numeric fields survive as JSON numbers; undefined fields are dropped', () => {
    const { stdoutLines, stderrWrites } = withCapturedOutput(() => {
      log('info', 'nums', { n: 5, missing: undefined });
    });
    const parsed = JSON.parse(stdoutLines[0]!);
    assert.equal(typeof parsed.n, 'number');
    assert.equal(parsed.n, 5);
    assert.equal('missing' in parsed, false);
    assert.equal(stderrWrites.length, 0);
  });

  it('log() below the default LOG_LEVEL (info) is rank-filtered and silent', () => {
    const { stdoutLines, stderrWrites } = withCapturedOutput(() => {
      log('debug', 'should not appear');
    });
    assert.equal(stdoutLines.length, 0);
    assert.equal(stderrWrites.length, 0);
  });

  it('logEvent() produces the same flat single-line shape with event top-level (Spec 01 R12)', () => {
    const { stdoutLines, stderrWrites } = withCapturedOutput(() => {
      logEvent({ level: 'info', message: 'boot', event: 'boot', port: 3000 });
    });
    assert.equal(stdoutLines.length, 1);
    const parsed = JSON.parse(stdoutLines[0]!);
    assert.equal(parsed.message, 'boot');
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.event, 'boot');
    assert.equal(parsed.port, 3000);
    assert.equal(stderrWrites.length, 0);
  });

  it('ms() rounds the delta to 1 decimal place', () => {
    assert.equal(ms(100, 233.456), 133.5);
  });

  it('now() returns a finite, monotonic number', () => {
    const a = now();
    const b = now();
    assert.equal(Number.isFinite(a), true);
    assert.equal(Number.isFinite(b), true);
    assert.equal(b >= a, true);
  });

  it('safeRaw() serializes a plain object to JSON', () => {
    const raw = safeRaw({ a: 1, b: 'two' });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.a, 1);
    assert.equal(parsed.b, 'two');
  });

  it('safeRaw() on a cyclic object does not throw and returns a string (A12)', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    let result = '';
    assert.doesNotThrow(() => {
      result = safeRaw(obj);
    });
    assert.equal(typeof result, 'string');
  });

  it('a warn/error line still never goes to stderr', () => {
    const { stderrWrites } = withCapturedOutput(() => {
      log('error', 'err-line', { code: 'X' });
    });
    assert.equal(stderrWrites.length, 0);
  });
});

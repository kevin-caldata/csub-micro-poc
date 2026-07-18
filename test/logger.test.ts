import { describe, it, expect } from 'vitest';
import { log, logEvent, ms, now, safeRaw } from '../src/logger.js';
import { pct } from '../src/latency.js';

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
    expect(stdoutLines.length).toBe(1);
    const line = stdoutLines[0]!;
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false); // no embedded newlines besides the trailing one
    const parsed = JSON.parse(line);
    expect(typeof parsed.message).toBe('string');
    expect(parsed.message).toBe('hi');
    expect(typeof parsed.level).toBe('string');
    expect(parsed.level).toBe('info');
    expect(parsed.callSid).toBe('CA1');
    expect(stderrWrites.length).toBe(0);
  });

  it('numeric fields survive as JSON numbers; undefined fields are dropped', () => {
    const { stdoutLines, stderrWrites } = withCapturedOutput(() => {
      log('info', 'nums', { n: 5, missing: undefined });
    });
    const parsed = JSON.parse(stdoutLines[0]!);
    expect(typeof parsed.n).toBe('number');
    expect(parsed.n).toBe(5);
    expect('missing' in parsed).toBe(false);
    expect(stderrWrites.length).toBe(0);
  });

  it('log() below the default LOG_LEVEL (info) is rank-filtered and silent', () => {
    const { stdoutLines, stderrWrites } = withCapturedOutput(() => {
      log('debug', 'should not appear');
    });
    expect(stdoutLines.length).toBe(0);
    expect(stderrWrites.length).toBe(0);
  });

  it('logEvent() produces the same flat single-line shape with event top-level (Spec 01 R12)', () => {
    const { stdoutLines, stderrWrites } = withCapturedOutput(() => {
      logEvent({ level: 'info', message: 'boot', event: 'boot', port: 3000 });
    });
    expect(stdoutLines.length).toBe(1);
    const parsed = JSON.parse(stdoutLines[0]!);
    expect(parsed.message).toBe('boot');
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('boot');
    expect(parsed.port).toBe(3000);
    expect(stderrWrites.length).toBe(0);
  });

  it('ms() rounds the delta to 1 decimal place', () => {
    expect(ms(100, 233.456)).toBe(133.5);
  });

  it('now() returns a finite, monotonic number', () => {
    const a = now();
    const b = now();
    expect(Number.isFinite(a)).toBe(true);
    expect(Number.isFinite(b)).toBe(true);
    expect(b >= a).toBe(true);
  });

  it('safeRaw() serializes a plain object to JSON', () => {
    const raw = safeRaw({ a: 1, b: 'two' });
    const parsed = JSON.parse(raw);
    expect(parsed.a).toBe(1);
    expect(parsed.b).toBe('two');
  });

  it('safeRaw() on a cyclic object does not throw and returns a string (A12)', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    let result = '';
    expect(() => {
      result = safeRaw(obj);
    }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('a warn/error line still never goes to stderr', () => {
    const { stderrWrites } = withCapturedOutput(() => {
      log('error', 'err-line', { code: 'X' });
    });
    expect(stderrWrites.length).toBe(0);
  });
});

// R8.3: pct() nearest-rank helper (src/latency.ts). test/latency.test.ts already covers the
// empty/single-value/20-element cases against the recorder's own consumption of pct(); these
// two are the R8.3 items not exercised there.
describe('pct() nearest-rank (Spec 08 R8.3)', () => {
  it('p95 of n=10 exhibits max-adjacent behavior (ceil(0.95*10)-1 = 9 -> the last/max element)', () => {
    const values = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10
    expect(pct(values, 95)).toBe(10); // same as the max at this n — the findings/09 §7 caveat
    expect(pct(values, 95)).toBe(Math.max(...values));
  });

  it('does not mutate the input array (order and contents preserved)', () => {
    const values = [30, 10, 20, 50, 40];
    const snapshot = [...values];
    pct(values, 50);
    pct(values, 95);
    expect(values).toEqual(snapshot);
  });
});

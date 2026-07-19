// test/corpus.test.ts
//
// Loader + content-shape tests for assets/csub-corpus.md / src/corpus.ts (Demo Spec 04 R8).
// Follows the test/fallback-asset.test.ts asset-test house style: vitest node environment,
// describe/it, one assertion concern per it().

import { describe, it, expect } from 'vitest';
import { CSUB_CORPUS } from '../src/corpus.js';

// R4 — the twelve section headings, byte-exact, in R4 order.
const R4_HEADINGS = [
  '## Campus directory and department hours',
  '## ITS Service Center help desk',
  '## NetID, MyID password reset, and Duo 2-Step',
  '## Financial aid dates and disbursement',
  '## Registration and the fall 2026 academic calendar',
  '## Runner Rundown new student orientation',
  '## Parking and permits',
  '## Academic advising by college',
  '## Counseling and crisis resources',
  '## Campus events, late summer 2026',
  '## NextTech Kern conference',
  '## About RIO and CSUB basics',
];

// master plan §4 — KNOWLEDGE_TOPICS enum, identical to the corpus <!-- topic: ... --> vocabulary.
const KNOWLEDGE_TOPICS = [
  'directory_hours',
  'financial_aid',
  'registration',
  'orientation',
  'it_help',
  'parking',
  'events',
  'other',
] as const;

// R2 — the four SIMULATED-DATA banner lines, byte-exact.
const R2_BANNER = [
  '# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA',
  '# All content below is FABRICATED for the RIO proof-of-concept. It imitates',
  "# CSUB's real vocabulary but specific hours, dates, fees, and names may be",
  '# fictional. Never present this as verified CSUB information outside the demo.',
];

// R3 — the complete phone allowlist's 16 paren-form entries (988/911/838255 are short codes,
// not matched by the /\(\d{3}\) \d{3}-\d{4}/g regex, so they are excluded from this set).
const PAREN_ALLOWLIST = new Set([
  '(661) 654-2782',
  '(661) 654-3036',
  '(661) 654-3016',
  '(661) 654-3225',
  '(661) 654-4357',
  '(661) 654-2394',
  '(661) 654-2677',
  '(661) 654-3988',
  '(661) 654-2266',
  '(661) 654-3360',
  '(661) 654-3172',
  '(661) 654-3231',
  '(661) 654-2111',
  '(661) 654-3366',
  '(661) 654-3425',
  '(800) 700-4417',
]);

describe('assets/csub-corpus.md (Demo Spec 04 R8)', () => {
  it('is between 30,000 and 51,200 bytes (utf8)', () => {
    const size = Buffer.byteLength(CSUB_CORPUS, 'utf8');
    expect(size >= 30_000 && size <= 51_200, `expected 30000-51200 bytes, got ${size}`).toBeTruthy();
  });

  it('begins with the R2 SIMULATED-DATA banner, byte-exact, first four lines', () => {
    const lines = CSUB_CORPUS.split('\n');
    expect(lines[0]).toBe('# CSUB CAMPUS KNOWLEDGE — SIMULATED DEMO DATA');
    expect(lines.slice(0, 4)).toEqual(R2_BANNER);
  });

  it('contains all twelve R4 headings, in R4 order, and exactly twelve lines start with "## "', () => {
    const lines = CSUB_CORPUS.split('\n');
    const headingLines = lines.filter((l) => l.startsWith('## '));
    expect(headingLines.length).toBe(12);

    let lastIndex = -1;
    for (const heading of R4_HEADINGS) {
      const idx = CSUB_CORPUS.indexOf(heading);
      expect(idx, `heading not found: ${heading}`).toBeGreaterThan(-1);
      expect(idx, `heading out of order: ${heading}`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('tags each heading with its next non-empty line as a valid <!-- topic: ... --> tag', () => {
    const lines = CSUB_CORPUS.split('\n');
    for (const heading of R4_HEADINGS) {
      const headingLineIdx = lines.findIndex((l) => l === heading);
      expect(headingLineIdx, `heading line not found: ${heading}`).toBeGreaterThan(-1);

      let nextIdx = headingLineIdx + 1;
      while (nextIdx < lines.length && lines[nextIdx]!.trim() === '') nextIdx++;
      const tagLine = lines[nextIdx];
      const match = tagLine?.match(/^<!-- topic: (\w+) -->$/);
      expect(match, `next non-empty line after "${heading}" is not a topic tag: ${String(tagLine)}`).toBeTruthy();

      const value = match![1]!;
      expect(
        (KNOWLEDGE_TOPICS as readonly string[]).includes(value),
        `topic tag value "${value}" for heading "${heading}" is not in the eight-value enum`,
      ).toBeTruthy();
    }
  });

  it('contains the safety-number and Duo-warning spot-check strings', () => {
    expect(CSUB_CORPUS).toContain('(661) 654-3366');
    expect(CSUB_CORPUS).toContain('(661) 654-2111');
    expect(CSUB_CORPUS).toContain('988');
    expect(CSUB_CORPUS).toContain('(661) 654-2782');
    expect(CSUB_CORPUS).toContain('NEVER share your Duo code');
  });

  it('contains only allowlisted paren-form phone numbers (R3 allowlist)', () => {
    const matches = CSUB_CORPUS.match(/\(\d{3}\) \d{3}-\d{4}/g) ?? [];
    expect(matches.length, 'expected at least one paren-form phone number in the corpus').toBeGreaterThan(0);
    for (const num of matches) {
      expect(PAREN_ALLOWLIST.has(num), `phone number not in R3 allowlist: ${num}`).toBeTruthy();
    }
  });

  it('contains the en-dash-exact ITS summer-hours anchors', () => {
    expect(CSUB_CORPUS).toContain('7 AM–6 PM');
    expect(CSUB_CORPUS).toContain('closed noon–1 PM');
  });
});

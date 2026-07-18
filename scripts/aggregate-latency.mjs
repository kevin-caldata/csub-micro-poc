#!/usr/bin/env node
// scripts/aggregate-latency.mjs
//
// Offline cross-call aggregation over exported `event:turn` / `event:tool-call`
// JSONL log lines (Spec 08 R16, findings/09 §7). Plain Node ESM, zero
// dependencies beyond node:fs/node:process, no imports from src/ — must stay
// runnable by bare `node`.
//
// Aggregates raw per-turn (or per-tool-call) metric values pooled across ALL
// input files, never per-file/per-call percentiles-of-percentiles
// (findings/09 gotcha 13; Spec 08 R12/R16).
//
// Usage:
//   node scripts/aggregate-latency.mjs [--tools] [--metric <name>] <file.jsonl> [more.jsonl...]

import { readFileSync } from 'node:fs';

// Spec 08 R12 nearest-rank percentile helper, reimplemented verbatim here so
// this script has zero imports from src/ and stays runnable by bare `node`.
function pct(values, p) {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const TURN_METRICS = ['ttfbMs', 'bridgeMs', 'turnMs', 'playbackConfirmMs'];
const TOOL_METRICS = ['mcpMs', 'gateWaitMs', 'secondTtfbMs', 'toolTotalMs'];

function usage() {
  process.stderr.write(
    'Usage: node scripts/aggregate-latency.mjs [--tools] [--metric <name>] <file.jsonl> [more.jsonl...]\n',
  );
}

function parseArgs(argv) {
  let tools = false;
  let metric;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tools') {
      tools = true;
    } else if (arg === '--metric') {
      metric = argv[++i];
    } else {
      files.push(arg);
    }
  }
  return { tools, metric, files };
}

function readLines(files) {
  const lines = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) lines.push(trimmed);
    }
  }
  return lines;
}

// Parses lines as JSON, skipping (and counting) any line that isn't valid
// JSON, then keeps only objects whose `event` field matches `wantEvent`.
function parseLines(lines, wantEvent) {
  const records = [];
  let skipped = 0;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (obj === null || typeof obj !== 'object' || obj.event !== wantEvent) continue;
    records.push(obj);
  }
  return { records, skipped };
}

function numericValues(records, metric) {
  return records.map((r) => r[metric]).filter((v) => typeof v === 'number' && Number.isFinite(v));
}

function formatNum(n) {
  return n === undefined ? '—' : String(Math.round(n * 10) / 10);
}

// Builds markdown table rows (header + one row per metric) with nearest-rank
// p50/p95, max, and n — pooled raw values only, never per-call percentiles.
function tableForMetrics(records, metrics) {
  const rows = [['metric', 'p50', 'p95', 'max', 'n']];
  for (const metric of metrics) {
    const values = numericValues(records, metric);
    const max = values.length ? Math.max(...values) : undefined;
    rows.push([metric, formatNum(pct(values, 50)), formatNum(pct(values, 95)), formatNum(max), String(values.length)]);
  }
  return rows;
}

function renderMarkdownTable(rows) {
  const [header, ...body] = rows;
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function main() {
  const { tools, metric, files } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const lines = readLines(files);
  const wantEvent = tools ? 'tool-call' : 'turn';
  const { records, skipped } = parseLines(lines, wantEvent);
  const allMetrics = tools ? TOOL_METRICS : TURN_METRICS;
  const metrics = metric ? allMetrics.filter((m) => m === metric) : allMetrics;

  const output = [];
  output.push(`Skipped: ${skipped} non-JSON line(s).`);
  output.push('');

  if (tools) {
    output.push('## tool-call metrics');
    output.push('');
    output.push(renderMarkdownTable(tableForMetrics(records, metrics)));
  } else {
    // Partitions per Spec 08 R16 (adjudicated scope, Spec 08 R16 — no
    // audio-mode partition here; that comparison is done by running this
    // script once per measurement-session directory):
    //   - all turns (per metric, pooled wherever that metric field is present)
    //   - bargedIn:false only (excludes barge-in-contaminated turns)
    //   - turns-with-ttfbMs only (excludes turns barged before first audio,
    //     i.e. no audio ever produced — findings/09 §2 edge case)
    const partitions = [
      ['all turns', records],
      ['bargedIn:false', records.filter((r) => r.bargedIn === false)],
      ['has-ttfbMs', records.filter((r) => typeof r.ttfbMs === 'number' && Number.isFinite(r.ttfbMs))],
    ];
    for (const [name, partitionRecords] of partitions) {
      output.push(`## ${name}`);
      output.push('');
      output.push(renderMarkdownTable(tableForMetrics(partitionRecords, metrics)));
      output.push('');
    }
  }

  process.stdout.write(output.join('\n') + '\n');
}

main();

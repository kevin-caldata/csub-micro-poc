// scripts/build-fallback-clip.ts
//
// Regenerates assets/fallback-apology.ulaw (Spec 09 R6.1-R6.3, A5) from an
// 8 kHz / 16-bit / mono PCM WAV.
//
// DEV-04 route (ledger amendment): this host has no ffmpeg, so the original
// Spec 09 R6.3 `ffmpeg -ar 8000 -ac 1 -f mulaw` one-liner is replaced end to
// end with repo-native tooling:
//   1. Produce the source WAV with Windows System.Speech (see assets/README.md
//      for the exact PowerShell command and spoken text) — already renders at
//      8000 Hz / 16-bit / mono, so no resampling step is needed here.
//   2. Run this script to parse the WAV's RIFF chunks (never assume a fixed
//      44-byte header — some encoders insert extra chunks such as 'fact'
//      before 'data'), mu-law encode the PCM16 samples with this repo's own
//      MULAW_ENC table (src/dsp.ts, vendored per Spec 06 R5/A2 — no ffmpeg,
//      no third-party codec package), and write the raw headerless .ulaw
//      bytes Twilio's Media Streams expects (findings/03 claim 5).
//
// Usage: npx tsx scripts/build-fallback-clip.ts <input.wav>

import { readFileSync, writeFileSync } from 'node:fs';
import { MULAW_ENC } from '../src/dsp.js';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx tsx scripts/build-fallback-clip.ts <input.wav>');
  process.exit(1);
}

const outputPath = 'assets/fallback-apology.ulaw';

const wav = readFileSync(inputPath);

if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
  throw new Error(`${inputPath} is not a RIFF/WAVE file`);
}

// Walk RIFF sub-chunks looking for 'fmt ' and 'data' — do NOT assume the
// canonical 44-byte header layout; chunks are word-aligned (padded to an
// even size) and their order/count is not guaranteed.
let offset = 12;
let dataOffset = -1;
let dataLength = -1;
let sampleRate = -1;
let bitsPerSample = -1;
let channels = -1;

while (offset + 8 <= wav.length) {
  const chunkId = wav.toString('ascii', offset, offset + 4);
  const chunkSize = wav.readUInt32LE(offset + 4);
  const bodyStart = offset + 8;
  if (chunkId === 'fmt ') {
    channels = wav.readUInt16LE(bodyStart + 2);
    sampleRate = wav.readUInt32LE(bodyStart + 4);
    bitsPerSample = wav.readUInt16LE(bodyStart + 14);
  } else if (chunkId === 'data') {
    dataOffset = bodyStart;
    dataLength = chunkSize;
  }
  offset = bodyStart + chunkSize + (chunkSize % 2);
}

if (dataOffset < 0) throw new Error(`${inputPath}: no 'data' chunk found`);
if (sampleRate !== 8000) {
  throw new Error(`${inputPath}: expected 8000 Hz sample rate, got ${sampleRate}`);
}
if (channels !== 1) throw new Error(`${inputPath}: expected mono (1 channel), got ${channels}`);
if (bitsPerSample !== 16) {
  throw new Error(`${inputPath}: expected 16-bit PCM, got ${bitsPerSample}-bit`);
}

// Clamp to the bytes actually present (some encoders write a 'data' chunk
// size that runs slightly past EOF) and to a whole number of 16-bit samples.
const dataEnd = Math.min(dataOffset + dataLength, wav.length);
const sampleCount = Math.floor((dataEnd - dataOffset) / 2);

const ulaw = new Uint8Array(sampleCount);
for (let i = 0; i < sampleCount; i++) {
  const pcm = wav.readInt16LE(dataOffset + i * 2);
  ulaw[i] = MULAW_ENC[pcm & 0xffff]!; // index = uint16 reinterpretation of the PCM16 sample
}

writeFileSync(outputPath, ulaw);
console.log(
  `Wrote ${outputPath}: ${ulaw.length} bytes (~${(ulaw.length / 8000).toFixed(2)} s @ 8000 B/s)`,
);

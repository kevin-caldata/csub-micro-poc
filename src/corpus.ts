// src/corpus.ts — module-scope corpus load (demo Spec 04 R6).
// Path resolved from import.meta.url, NOT cwd — `assets/` is a sibling of both `src/` (tsx dev)
// and `dist/` (built), so '../assets/...' is correct in both layouts regardless of launch dir.
// Precedent: src/fallback.ts:40-44 (CLIP_PATH / defaultClipB64) and its cwd-fragility comment.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CORPUS_PATH = fileURLToPath(new URL('../assets/csub-corpus.md', import.meta.url));

/**
 * Loaded ONCE at module scope. buildMcpServer() constructs a fresh McpServer per request
 * (src/mcp-server.ts:8), so a read inside the tool handler or builder would re-run per call —
 * the read MUST stay here [findings/16 C15]. Includes the SIMULATED-DATA banner; consumers
 * must never strip it [findings/17 §3].
 */
export const CSUB_CORPUS: string = readFileSync(CORPUS_PATH, 'utf8');

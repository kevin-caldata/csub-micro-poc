// src/knowledge.ts — ask_campus_knowledge delegated-intelligence handler (Demo Spec 03).
// The ONLY module in the repo importing from 'ai' (master plan §4 / Spec 03 Interfaces).
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { now, ms } from './logger.js';
import type { LogFields } from './logger.js';
import { CSUB_CORPUS } from './corpus.js';

/** Identical to the corpus <!-- topic: ... --> tag vocabulary (Spec 04 R4 / master §4). */
export const KNOWLEDGE_TOPICS = [
  'directory_hours',
  'financial_aid',
  'registration',
  'orientation',
  'it_help',
  'parking',
  'events',
  'other',
] as const;

// ── Envelope contract (Spec 03 R8 — exact values) ───────────────────────────────────────────
export const KNOWLEDGE_ENVELOPE_SCHEMA = z.object({
  status: z.enum(['ok', 'not_found', 'error']),
  response_text: z.string(),
});
export type KnowledgeEnvelope = z.infer<typeof KNOWLEDGE_ENVELOPE_SCHEMA>;
export const NOT_FOUND_SENTINEL = 'NOT_FOUND';
export const NOT_FOUND_SPOKEN =
  "I don't have that information. Offer to connect the caller to the right department instead.";
export const KNOWLEDGE_ERROR_SPOKEN = "I couldn't reach the campus knowledge base just now.";

// ── Grounding prompt (Spec 03 R10 — corpus-first, question-last) ───────────────────────────
export function buildKnowledgeSystemPrompt(corpus: string): string {
  return `You answer questions for RIO, a phone operator at CSUB. Answer ONLY from the
documents below. Never use outside knowledge, even about the real CSUB.

Rules:
- Answer in 2-3 short sentences, spoken-style: plain words, no markdown, no
  lists, no headings. Phone numbers as digits like (661) 654-3036.
- If the documents contain the answer, set status to "ok" and put the answer
  in response_text.
- If the documents do not contain the answer, set status to "not_found" and
  set response_text to exactly: NOT_FOUND
- Never guess, never partially answer from memory, even if the question insists.

<documents>
${corpus}
</documents>`;
}

// G5 — computed once at module scope; buildMcpServer runs fresh per request.
const SYSTEM = buildKnowledgeSystemPrompt(CSUB_CORPUS);

// ── Generate seam (Spec 03 R9) ──────────────────────────────────────────────────────────────
export interface KnowledgeGenerateArgs {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
}
export interface KnowledgeGenerateResult {
  object: unknown; // validated by generateObject against KNOWLEDGE_ENVELOPE_SCHEMA in the real impl
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
}
export type KnowledgeGenerateFn = (args: KnowledgeGenerateArgs) => Promise<KnowledgeGenerateResult>;

/** askCampusKnowledge(args, deps) — Spec 03 R9's exact six-step flow. Never throws. */
export async function askCampusKnowledge(
  args: { question: string; topic?: (typeof KNOWLEDGE_TOPICS)[number] },
  deps: {
    cfg: AppConfig;
    corpus: string;
    generate: KnowledgeGenerateFn;
    signal: AbortSignal; // the SDK-provided extra.signal
    log: (fields: LogFields) => void; // logEvent in production
  },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
  const { question, topic } = args;
  const system = deps.corpus === CSUB_CORPUS ? SYSTEM : buildKnowledgeSystemPrompt(deps.corpus);
  const prompt = `Question: ${question}`;
  const abortSignal = AbortSignal.any([deps.signal, AbortSignal.timeout(deps.cfg.mcpToolTimeoutMs)]);
  const t0 = now();

  try {
    const { object, usage } = await deps.generate({
      system,
      prompt,
      maxOutputTokens: deps.cfg.mcpModelMaxTokens,
      abortSignal,
    });
    const t1 = now();

    const parsed = KNOWLEDGE_ENVELOPE_SCHEMA.safeParse(object);
    if (!parsed.success) {
      throw new Error('knowledge envelope schema validation failed');
    }
    const envelope = parsed.data;
    const trimmed = envelope.response_text.trim();
    const resultEnvelope: KnowledgeEnvelope =
      envelope.status !== 'ok' ||
      trimmed === '' ||
      trimmed === NOT_FOUND_SENTINEL ||
      trimmed.startsWith(NOT_FOUND_SENTINEL)
        ? { status: 'not_found', response_text: NOT_FOUND_SPOKEN }
        : { status: 'ok', response_text: trimmed };

    deps.log({
      level: 'info',
      message: `knowledge ${resultEnvelope.status}`,
      event: 'knowledge-call',
      status: resultEnvelope.status,
      topic,
      questionChars: question.length,
      answerChars: resultEnvelope.response_text.length,
      knowledgeMs: ms(t0, t1),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      reasoningTokens: usage?.reasoningTokens,
      modelId: deps.cfg.mcpModelId,
    });

    return { content: [{ type: 'text', text: JSON.stringify(resultEnvelope) }] };
  } catch (err) {
    const t1 = now();
    const errName = err instanceof Error ? err.name : undefined;

    deps.log({
      level: 'info',
      message: 'knowledge error',
      event: 'knowledge-call',
      status: 'error',
      topic,
      questionChars: question.length,
      answerChars: KNOWLEDGE_ERROR_SPOKEN.length,
      knowledgeMs: ms(t0, t1),
      modelId: deps.cfg.mcpModelId,
      errName,
    });

    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ status: 'error', response_text: KNOWLEDGE_ERROR_SPOKEN }) }],
    };
  }
}

// makeGatewayGenerate is implemented in Part 2 (below this line is intentionally the end of
// Part 1 — see test/knowledge.test.ts's makeGatewayGenerate describe block).

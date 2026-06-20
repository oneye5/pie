import { countTokens as bpeCountTokens } from 'gpt-tokenizer/encoding/cl100k_base';

/**
 * Real BPE token counting via `gpt-tokenizer` (cl100k_base).
 *
 * cl100k_base is the GPT-4 / text-embedding encoding and a reasonable
 * token-count approximation for the other BPE model families this project
 * targets (Claude, GLM, Llama, Qwen, ...) — far closer than the chars/4
 * heuristic it replaces. It is NOT the active model's exact tokenizer:
 * provider `usage` blocks remain the source of truth where available
 * (see `src/backend/context-usage.ts`). Callers that previously divided
 * character counts by 4 should call this instead.
 */
export function countTextTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return bpeCountTokens(text);
}

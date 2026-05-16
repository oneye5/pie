import type { ChatMessage, SystemPromptEntry } from '../../../shared/protocol';

interface TranscriptHydrationState {
  transcript: readonly ChatMessage[];
  systemPrompts: readonly SystemPromptEntry[];
}

/**
 * Newly opened sessions hydrate their transcript rows and system prompt cards
 * asynchronously. Until either arrives, keep the transcript surface quiet and
 * render a lightweight loader instead of onboarding copy.
 */
export function isTranscriptHydrating({ transcript, systemPrompts }: TranscriptHydrationState): boolean {
  return transcript.length === 0 && systemPrompts.length === 0;
}

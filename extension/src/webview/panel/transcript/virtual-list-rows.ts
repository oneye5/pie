import type { ChatMessage } from '../../../shared/protocol';

export type TranscriptRow =
  | { kind: 'systemPrompts'; key: string }
  | { kind: 'topGap'; key: string }
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'typingIndicator'; key: string }
  | { kind: 'bottomGap'; key: string };

interface BuildTranscriptRowsOptions {
  transcript: readonly ChatMessage[];
  systemPromptCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
  busy: boolean;
}

export function buildTranscriptRows({
  transcript,
  systemPromptCount,
  hasOlder,
  hasNewer,
  busy,
}: BuildTranscriptRowsOptions): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  if (systemPromptCount > 0) {
    rows.push({ kind: 'systemPrompts', key: 'system-prompts' });
  }
  if (hasOlder) {
    rows.push({ kind: 'topGap', key: 'gap:older' });
  }
  for (const message of transcript) {
    rows.push({ kind: 'message', key: `message:${message.id}`, message });
  }
  // Show a typing indicator when the backend is processing but hasn't started
  // streaming a response yet (i.e. the last message is not already streaming).
  if (busy) {
    const lastMessage = transcript[transcript.length - 1];
    const alreadyStreaming = lastMessage?.role === 'assistant' && lastMessage.status === 'streaming';
    if (!alreadyStreaming) {
      rows.push({ kind: 'typingIndicator', key: 'typing-indicator' });
    }
  }
  if (hasNewer) {
    rows.push({ kind: 'bottomGap', key: 'gap:newer' });
  }
  return rows;
}

export function estimateTranscriptRowSize(row: TranscriptRow): number {
  if (row.kind === 'systemPrompts') {
    return 140;
  }
  if (row.kind === 'topGap' || row.kind === 'bottomGap') {
    return 56;
  }
  if (row.kind === 'typingIndicator') {
    return 48;
  }
  return row.message.role === 'user' ? 120 : 180;
}

import type { ChatMessage } from '../../../shared/protocol';

export type TranscriptRow =
  | { kind: 'systemPrompts'; key: string }
  | { kind: 'topGap'; key: string }
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'bottomGap'; key: string };

interface BuildTranscriptRowsOptions {
  transcript: readonly ChatMessage[];
  systemPromptCount: number;
  hasOlder: boolean;
  hasNewer: boolean;
}

export function buildTranscriptRows({
  transcript,
  systemPromptCount,
  hasOlder,
  hasNewer,
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
  return row.message.role === 'user' ? 120 : 180;
}

import type { ToolCall } from '../../../../shared/protocol';
import { textFromToolResult } from '../highlight';

export function formatToolCallResultForDisplay(toolCall: Pick<ToolCall, 'name' | 'result'>): string {
  if (toolCall.result === undefined) {
    return '';
  }

  const readableText = textFromToolResult(toolCall.result);
  return readableText ?? JSON.stringify(toolCall.result, null, 2);
}

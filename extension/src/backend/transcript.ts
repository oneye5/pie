import type { ChatMessage, SessionSummary, ToolCall } from '../shared/protocol';

type MessageRole =
  | 'user'
  | 'assistant'
  | 'toolResult'
  | 'bashExecution'
  | 'custom'
  | 'branchSummary'
  | 'compactionSummary';

interface ContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface MessageLike {
  role: MessageRole;
  content?: string | ContentPart[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  customType?: string;
  display?: boolean;
  summary?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface SessionInfoLike {
  path: string;
  cwd: string;
  name?: string;
  modified: Date;
  messageCount: number;
}

export interface SessionEntryLike {
  id: string;
  timestamp: string;
  type: string;
  summary?: string;
  tokensBefore?: number;
  message?: MessageLike;
  customType?: string;
  display?: boolean;
  content?: unknown;
}

function isoDate(entryTimestamp: string, messageTimestamp?: number): string {
  if (typeof messageTimestamp === 'number') {
    return new Date(messageTimestamp).toISOString();
  }
  return new Date(entryTimestamp).toISOString();
}

function textFromParts(parts: ContentPart[] | undefined): string {
  if (!parts) {
    return '';
  }

  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

function thinkingFromParts(parts: ContentPart[] | undefined): string | undefined {
  if (!parts) return undefined;
  const thinking = parts
    .filter((part) => part.type === 'thinking' && typeof part.thinking === 'string')
    .map((part) => part.thinking ?? '')
    .join('');
  return thinking || undefined;
}

function toolCallsFromParts(parts: ContentPart[] | undefined): ToolCall[] | undefined {
  if (!parts) {
    return undefined;
  }

  const toolCalls = parts
    .filter((part) => part.type === 'toolCall' && part.id && part.name)
    .map(
      (part): ToolCall => ({
        id: part.id!,
        name: part.name!,
        input: part.arguments ?? {},
        status: 'running',
      }),
    );

  return toolCalls.length > 0 ? toolCalls : undefined;
}

function formatToolResult(message: MessageLike): unknown {
  if (message.details !== undefined) {
    return message.details;
  }

  if (Array.isArray(message.content)) {
    const text = textFromParts(message.content);
    return text || message.content;
  }

  return message.content ?? null;
}

function assistantStatus(message: MessageLike): ChatMessage['status'] {
  if (message.stopReason === 'aborted') {
    return 'interrupted';
  }

  if (message.stopReason === 'error' || message.errorMessage) {
    return 'error';
  }

  return 'completed';
}

function systemMessage(id: string, createdAt: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'system',
    createdAt,
    markdown,
    status: 'completed',
  };
}

export function summarizeSession(info: SessionInfoLike, modelId?: string): SessionSummary {
  const hasName = !!info.name;
  return {
    path: info.path,
    cwd: info.cwd,
    name: hasName ? info.name! : 'New Session',
    isPlaceholder: !hasName,
    modifiedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
    modelId,
  };
}

export function mapAssistantMessage(messageId: string, message: MessageLike, durationMs?: number): ChatMessage {
  const parts = Array.isArray(message.content) ? message.content : undefined;
  const rawToolCalls = toolCallsFromParts(parts);
  // toolCallsFromParts always emits 'running'; clamp to 'completed' for finished messages.
  const toolCalls = rawToolCalls?.map((tc) =>
    tc.status === 'running' ? { ...tc, status: 'completed' as const } : tc,
  );
  return {
    id: messageId,
    role: 'assistant',
    createdAt: new Date(message.timestamp ?? Date.now()).toISOString(),
    markdown: textFromParts(parts),
    thinking: thinkingFromParts(parts),
    status: assistantStatus(message),
    toolCalls,
    durationMs,
  };
}

export function mapTranscript(entries: SessionEntryLike[]): ChatMessage[] {
  const transcript: ChatMessage[] = [];
  let currentAssistant: ChatMessage | undefined;

  for (const entry of entries) {
    if (entry.type === 'message' && entry.message) {
      const message = entry.message;

      if (message.role === 'user') {
        transcript.push({
          id: entry.id,
          role: 'user',
          createdAt: isoDate(entry.timestamp, message.timestamp),
          markdown:
            typeof message.content === 'string'
              ? message.content
              : textFromParts(message.content),
          status: 'completed',
        });
        currentAssistant = undefined;
        continue;
      }

      if (message.role === 'assistant') {
        const parts = Array.isArray(message.content) ? message.content : undefined;
        const entryTs = new Date(entry.timestamp).getTime();
        const durationMs = typeof message.timestamp === 'number' && entryTs > message.timestamp
          ? entryTs - message.timestamp
          : undefined;

        if (currentAssistant) {
          // Merge continuation turn into the existing assistant message bubble.
          const newText = parts ? textFromParts(parts) : '';
          const newThinking = parts ? thinkingFromParts(parts) : undefined;
          const newToolCalls = parts ? toolCallsFromParts(parts) : undefined;

          if (newThinking) {
            currentAssistant.thinking = currentAssistant.thinking
              ? `${currentAssistant.thinking}\n\n${newThinking}`
              : newThinking;
          }
          if (newText) {
            currentAssistant.markdown = currentAssistant.markdown
              ? `${currentAssistant.markdown}\n\n${newText}`
              : newText;
          }
          if (newToolCalls) {
            currentAssistant.toolCalls = [...(currentAssistant.toolCalls ?? []), ...newToolCalls];
          }
          currentAssistant.status = assistantStatus(message);
          if (durationMs !== undefined) {
            currentAssistant.durationMs = (currentAssistant.durationMs ?? 0) + durationMs;
          }
        } else {
          currentAssistant = {
            id: entry.id,
            role: 'assistant',
            createdAt: isoDate(entry.timestamp, message.timestamp),
            markdown: parts ? textFromParts(parts) : '',
            thinking: parts ? thinkingFromParts(parts) : undefined,
            status: assistantStatus(message),
            toolCalls: parts ? toolCallsFromParts(parts) : undefined,
            durationMs,
          };
          transcript.push(currentAssistant);
        }
        continue;
      }

      if (message.role === 'toolResult' && currentAssistant?.toolCalls) {
        const toolCall = currentAssistant.toolCalls.find((item) => item.id === message.toolCallId);
        if (toolCall) {
          toolCall.result = formatToolResult(message);
          toolCall.status = message.isError ? 'failed' : 'completed';
          continue;
        }
      }

      if (message.role === 'bashExecution') {
        transcript.push(
          systemMessage(
            entry.id,
            isoDate(entry.timestamp, message.timestamp),
            ['```powershell', message.command ?? '', message.output ?? '', '```'].join('\n'),
          ),
        );
        currentAssistant = undefined;
        continue;
      }

      if (message.role === 'custom' && message.display !== false) {
        transcript.push(
          systemMessage(
            entry.id,
            isoDate(entry.timestamp, message.timestamp),
            typeof message.content === 'string'
              ? message.content
              : textFromParts(message.content),
          ),
        );
        currentAssistant = undefined;
      }

      continue;
    }

    if (entry.type === 'branch_summary' && entry.summary) {
      transcript.push(
        systemMessage(
          entry.id,
          new Date(entry.timestamp).toISOString(),
          `Branch summary\n\n${entry.summary}`,
        ),
      );
      currentAssistant = undefined;
      continue;
    }

    if (entry.type === 'compaction' && entry.summary) {
      transcript.push(
        systemMessage(
          entry.id,
          new Date(entry.timestamp).toISOString(),
          `Compaction summary\n\n${entry.summary}`,
        ),
      );
      currentAssistant = undefined;
    }
  }

  return transcript;
}

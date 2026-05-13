import { NEW_SESSION_NAME } from '../shared/session-name';
import type {
  ChatMessage,
  ChatMessagePart,
  SessionSummary,
  ThinkingLevel,
  ToolCall,
  UserContentPart,
} from '../shared/protocol';

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
  data?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

interface MessageLike {
  role: MessageRole;
  content?: string | ContentPart[];
  timestamp?: number;
  provider?: string;
  model?: string;
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
  thinkingLevel?: string;
  modelId?: string;
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

function userPartsFromContent(content: string | ContentPart[] | undefined): UserContentPart[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const userParts: UserContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      userParts.push({ kind: 'text', text: part.text });
      continue;
    }

    if (
      part.type === 'image'
      && typeof part.data === 'string'
      && part.data.length > 0
      && typeof part.mimeType === 'string'
      && part.mimeType.length > 0
    ) {
      userParts.push({
        kind: 'image',
        mimeType: part.mimeType,
        dataBase64: part.data,
        name: typeof part.name === 'string' ? part.name : undefined,
        width: typeof part.width === 'number' ? part.width : undefined,
        height: typeof part.height === 'number' ? part.height : undefined,
      });
    }
  }

  return userParts.length > 0 ? userParts : undefined;
}

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  switch (value) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return { ...toolCall };
}

function appendAssistantTextPart(
  parts: ChatMessagePart[],
  kind: 'text' | 'reasoning',
  text: string,
): void {
  if (!text) {
    return;
  }

  const last = parts[parts.length - 1];
  if (last?.kind === kind) {
    last.text += text;
    return;
  }

  parts.push({ kind, text });
}

function upsertAssistantToolPart(parts: ChatMessagePart[], toolCall: ToolCall): void {
  const nextToolCall = cloneToolCall(toolCall);
  const existingIndex = parts.findIndex(
    (part) => part.kind === 'toolCall' && part.toolCall.id === nextToolCall.id,
  );

  if (existingIndex === -1) {
    parts.push({ kind: 'toolCall', toolCall: nextToolCall });
    return;
  }

  parts[existingIndex] = { kind: 'toolCall', toolCall: nextToolCall };
}

function assistantPartsFromContent(
  parts: ContentPart[] | undefined,
  toolCallStatus: ToolCall['status'] = 'running',
): ChatMessagePart[] | undefined {
  if (!parts) {
    return undefined;
  }

  const orderedParts: ChatMessagePart[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      appendAssistantTextPart(orderedParts, 'text', part.text);
      continue;
    }

    if (part.type === 'thinking' && typeof part.thinking === 'string') {
      appendAssistantTextPart(orderedParts, 'reasoning', part.thinking);
      continue;
    }

    if (part.type === 'toolCall' && part.id && part.name) {
      upsertAssistantToolPart(orderedParts, {
        id: part.id,
        name: part.name,
        input: part.arguments ?? {},
        status: toolCallStatus,
      });
    }
  }

  return orderedParts.length > 0 ? orderedParts : undefined;
}

function toolCallsFromMessageParts(parts: ChatMessagePart[] | undefined): ToolCall[] | undefined {
  if (!parts) {
    return undefined;
  }

  const toolCalls = parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => cloneToolCall(part.toolCall));

  return toolCalls.length > 0 ? toolCalls : undefined;
}

function appendAssistantParts(
  target: ChatMessage,
  incoming: ChatMessagePart[] | undefined,
  preserveLeadingBoundary = false,
): void {
  if (!incoming || incoming.length === 0) {
    return;
  }

  const targetParts = (target.parts ??= []);
  let shouldPreserveBoundary = preserveLeadingBoundary;
  for (const part of incoming) {
    if (part.kind === 'toolCall') {
      upsertAssistantToolPart(targetParts, part.toolCall);
      shouldPreserveBoundary = false;
      continue;
    }

    const last = targetParts[targetParts.length - 1];
    const text =
      shouldPreserveBoundary && last?.kind === part.kind && !part.text.startsWith('\n\n')
        ? `\n\n${part.text}`
        : part.text;

    appendAssistantTextPart(targetParts, part.kind, text);
    shouldPreserveBoundary = false;
  }
}

function applyToolResultToParts(
  parts: ChatMessagePart[] | undefined,
  toolCallId: string | undefined,
  result: unknown,
  status: ToolCall['status'],
): void {
  if (!parts || !toolCallId) {
    return;
  }

  const part = parts.find(
    (item): item is Extract<ChatMessagePart, { kind: 'toolCall' }> =>
      item.kind === 'toolCall' && item.toolCall.id === toolCallId,
  );
  if (!part) {
    return;
  }

  part.toolCall.result = result;
  part.toolCall.status = status;
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
    name: hasName ? info.name! : NEW_SESSION_NAME,
    isPlaceholder: !hasName,
    modifiedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
    modelId,
  };
}

export function mapAssistantMessage(
  messageId: string,
  message: MessageLike,
  durationMs?: number,
  metadata?: { modelId?: string; thinkingLevel?: ThinkingLevel },
): ChatMessage {
  const parts = Array.isArray(message.content) ? message.content : undefined;
  const messageParts = assistantPartsFromContent(parts, 'completed');
  return {
    id: messageId,
    role: 'assistant',
    createdAt: new Date(message.timestamp ?? Date.now()).toISOString(),
    markdown: textFromParts(parts),
    parts: messageParts,
    thinking: thinkingFromParts(parts),
    modelId: message.model ?? metadata?.modelId,
    thinkingLevel: metadata?.thinkingLevel,
    status: assistantStatus(message),
    toolCalls: toolCallsFromMessageParts(messageParts),
    durationMs,
  };
}

export function mapTranscript(entries: SessionEntryLike[]): ChatMessage[] {
  const transcript: ChatMessage[] = [];
  let currentAssistant: ChatMessage | undefined;
  let currentModelId: string | undefined;
  let currentThinkingLevel: ThinkingLevel | undefined;

  for (const entry of entries) {
    if (entry.type === 'model_change') {
      currentModelId = entry.modelId;
      currentAssistant = undefined;
      continue;
    }

    if (entry.type === 'thinking_level_change') {
      currentThinkingLevel = normalizeThinkingLevel(entry.thinkingLevel);
      currentAssistant = undefined;
      continue;
    }

    if (entry.type === 'message' && entry.message) {
      const message = entry.message;

      if (message.role === 'user') {
        const userParts = userPartsFromContent(message.content);
        const hasImageParts = userParts?.some((part) => part.kind === 'image') ?? false;
        transcript.push({
          id: entry.id,
          role: 'user',
          createdAt: isoDate(entry.timestamp, message.timestamp),
          markdown:
            typeof message.content === 'string'
              ? message.content
              : textFromParts(message.content),
          userParts: hasImageParts ? userParts : undefined,
          status: 'completed',
        });
        currentAssistant = undefined;
        continue;
      }

      if (message.role === 'assistant') {
        const parts = Array.isArray(message.content) ? message.content : undefined;
        const messageParts = assistantPartsFromContent(parts);
        const entryTs = new Date(entry.timestamp).getTime();
        const durationMs = typeof message.timestamp === 'number' && entryTs > message.timestamp
          ? entryTs - message.timestamp
          : undefined;
        const assistantModelId = message.model ?? currentModelId;
        const assistantThinkingLevel = currentThinkingLevel;
        if (message.model) {
          currentModelId = message.model;
        }

        if (currentAssistant) {
          // Merge continuation turn into the existing assistant message bubble.
          const newText = parts ? textFromParts(parts) : '';
          const newThinking = parts ? thinkingFromParts(parts) : undefined;

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
          appendAssistantParts(currentAssistant, messageParts, true);
          currentAssistant.toolCalls = toolCallsFromMessageParts(currentAssistant.parts);
          currentAssistant.status = assistantStatus(message);
          if (assistantModelId) {
            currentAssistant.modelId = assistantModelId;
          }
          if (assistantThinkingLevel) {
            currentAssistant.thinkingLevel = assistantThinkingLevel;
          }
          if (durationMs !== undefined) {
            currentAssistant.durationMs = (currentAssistant.durationMs ?? 0) + durationMs;
          }
        } else {
          currentAssistant = {
            id: entry.id,
            role: 'assistant',
            createdAt: isoDate(entry.timestamp, message.timestamp),
            markdown: parts ? textFromParts(parts) : '',
            parts: messageParts,
            thinking: parts ? thinkingFromParts(parts) : undefined,
            modelId: assistantModelId,
            thinkingLevel: assistantThinkingLevel,
            status: assistantStatus(message),
            toolCalls: toolCallsFromMessageParts(messageParts),
            durationMs,
          };
          transcript.push(currentAssistant);
        }
        continue;
      }

      if (message.role === 'toolResult' && currentAssistant) {
        applyToolResultToParts(
          currentAssistant.parts,
          message.toolCallId,
          formatToolResult(message),
          message.isError ? 'failed' : 'completed',
        );
        currentAssistant.toolCalls = toolCallsFromMessageParts(currentAssistant.parts);
        continue;
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

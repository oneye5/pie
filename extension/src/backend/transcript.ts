import type {
  ChatMessage,
  SessionSummary,
  ThinkingLevel,
} from '../shared/protocol';
import { NEW_SESSION_NAME } from '../shared/session-name';
import { formatToolResult } from '../shared/tool-result-format';

import {
  addAssistantUsage,
  applyToolResultToParts,
  appendAssistantParts,
  assistantPartsFromContent,
  assistantStatus,
  isoDate,
  normalizeThinkingLevel,
  systemMessage,
  textFromParts,
  thinkingFromParts,
  toolCallsFromMessageParts,
  usageFromMessage,
  userPartsFromContent,
} from './transcript/content';
import type { MessageLike } from './transcript/types';

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
  details?: unknown;
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
    errorDetail: message.errorMessage,
    toolCalls: toolCallsFromMessageParts(messageParts),
    durationMs,
    usage: usageFromMessage(message),
  };
}

function customMessageMarkdown(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return textFromParts(content);
  }
  return content == null ? '' : String(content);
}

export function mapCustomMessage(
  messageId: string,
  message: {
    content?: unknown;
    timestamp?: string | number;
    customType?: string;
    display?: boolean;
    details?: unknown;
  },
): ChatMessage | null {
  if (message.display === false) {
    return null;
  }

  const markdown = customMessageMarkdown(message.content);
  if (!markdown) {
    return null;
  }

  const mapped = systemMessage(
    messageId,
    new Date(message.timestamp ?? Date.now()).toISOString(),
    markdown,
  );
  if (message.customType) {
    mapped.customType = message.customType;
  }
  if (message.details !== undefined) {
    mapped.customDetails = message.details;
  }
  return mapped;
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
        const turnUsage = usageFromMessage(message);
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
          if (message.errorMessage) {
            currentAssistant.errorDetail = message.errorMessage;
          }
          if (assistantModelId) {
            currentAssistant.modelId = assistantModelId;
          }
          if (assistantThinkingLevel) {
            currentAssistant.thinkingLevel = assistantThinkingLevel;
          }
          if (durationMs !== undefined) {
            currentAssistant.durationMs = (currentAssistant.durationMs ?? 0) + durationMs;
          }
          currentAssistant.usage = addAssistantUsage(currentAssistant.usage, turnUsage);
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
            errorDetail: message.errorMessage,
            toolCalls: toolCallsFromMessageParts(messageParts),
            durationMs,
            usage: turnUsage,
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

      if (message.role === 'custom') {
        const customMessage = mapCustomMessage(entry.id, {
          content: message.content,
          timestamp: message.timestamp,
          customType: message.customType,
          display: message.display,
          details: message.details,
        });
        if (customMessage) {
          transcript.push(customMessage);
          currentAssistant = undefined;
        }
      }

      continue;
    }

    // Custom-type entries (e.g. pruning-result) from pi.sendMessage() — stored with type 'custom_message'.
    if (entry.type === 'custom_message' || entry.type === 'custom') {
      const customMessage = mapCustomMessage(entry.id, {
        content: entry.content,
        timestamp: entry.timestamp,
        customType: entry.customType,
        display: entry.display,
        details: (entry as { details?: unknown }).details,
      });
      if (customMessage) {
        transcript.push(customMessage);
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

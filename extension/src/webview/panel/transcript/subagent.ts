import type { ChatMessage, ChatMessagePart, ToolCall } from '../../../shared/protocol';
import { formatToolResult } from '../../../shared/tool-result-format';

import {
  appendAssistantTextPart,
  assistantPartsFromMessage,
  mergeAssistantParts,
  reasoningFromMessageParts,
  textFromMessageParts,
  toolCallsFromMessageParts,
  upsertAssistantToolPart,
} from './parts';

interface RawContentPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
}

interface RawMessage {
  role: 'user' | 'assistant' | 'toolResult';
  content?: string | RawContentPart[];
  timestamp?: number;
  toolCallId?: string;
  details?: unknown;
  isError?: boolean;
}

export interface SubagentSingleResult {
  agent: string;
  task: string;
  /** `-1` while the subagent is still running. */
  exitCode: number;
  messages: RawMessage[];
  model?: string;
  stderr?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Tool names currently executing inside this subagent run. */
  runningTools?: string[];
  /** The model chosen by scored selection. */
  selectedModel?: string;
  /** Thinking level applied to this run. */
  thinkingLevel?: string;
  /** Merged task scores used for selection. */
  taskScores?: Record<string, number>;
  /** Top-K candidate models. */
  selectionPool?: string[];
  /** Fit scores for each pool candidate. */
  selectionFitScores?: number[];
}

export interface SubagentResult {
  mode: 'single' | 'parallel' | 'chain';
  results: SubagentSingleResult[];
}

interface RawToolResultSnapshot {
  result: unknown;
  status: ToolCall['status'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rawMessageParts(message: RawMessage): RawContentPart[] {
  return Array.isArray(message.content) ? message.content : [];
}

function rawMessageText(message: RawMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return rawMessageParts(message)
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n\n');
}

function collectRawToolResults(rawMessages: RawMessage[]): Map<string, RawToolResultSnapshot> {
  const toolResultMap = new Map<string, RawToolResultSnapshot>();

  for (const msg of rawMessages) {
    if (msg.role === 'toolResult' && msg.toolCallId) {
      toolResultMap.set(String(msg.toolCallId), {
        result: formatToolResult(msg),
        status: msg.isError ? 'failed' : 'completed',
      });
      continue;
    }

    if (msg.role !== 'user') {
      continue;
    }

    for (const part of rawMessageParts(msg)) {
      if (part.type === 'toolResult' && part.id !== undefined) {
        toolResultMap.set(String(part.id), {
          result: part.result,
          status: 'completed',
        });
      }
    }
  }

  return toolResultMap;
}

export function rawMessagesToChatMessages(rawMessages: RawMessage[], idPrefix: string): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];
  const toolResultMap = collectRawToolResults(rawMessages);

  let idx = 0;
  let currentAssistant: ChatMessage | undefined;

  for (const msg of rawMessages) {
    if (msg.role === 'toolResult') {
      continue;
    }

    const contentParts = rawMessageParts(msg);

    // Skip legacy user messages that only carried tool result payloads.
    if (msg.role === 'user' && contentParts.length > 0 && contentParts.every((part) => part.type === 'toolResult')) {
      continue;
    }

    if (msg.role === 'user') {
      currentAssistant = undefined;
      chatMessages.push({
        id: `${idPrefix}-${idx++}`,
        role: 'user',
        createdAt: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
        markdown: rawMessageText(msg),
        status: 'completed',
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const orderedParts: ChatMessagePart[] = [];

      if (typeof msg.content === 'string') {
        appendAssistantTextPart(orderedParts, 'text', msg.content);
      }

      for (const part of contentParts) {
        if (part.type === 'text') {
          appendAssistantTextPart(orderedParts, 'text', part.text ?? '');
          continue;
        }

        if (part.type === 'thinking') {
          appendAssistantTextPart(orderedParts, 'reasoning', part.thinking ?? '');
          continue;
        }

        if (part.type === 'toolCall' && part.id && part.name) {
          const toolResult = toolResultMap.get(String(part.id));
          upsertAssistantToolPart(orderedParts, {
            id: part.id,
            name: part.name,
            input: part.arguments ?? {},
            result: toolResult?.result,
            status: toolResult?.status ?? 'running',
          });
        }
      }

      const markdown = textFromMessageParts(orderedParts);
      const thinking = reasoningFromMessageParts(orderedParts);
      const toolCalls = toolCallsFromMessageParts(orderedParts);

      if (currentAssistant) {
        const mergedParts = mergeAssistantParts(assistantPartsFromMessage(currentAssistant), orderedParts);
        currentAssistant.parts = mergedParts;
        currentAssistant.markdown = textFromMessageParts(mergedParts);
        currentAssistant.thinking = reasoningFromMessageParts(mergedParts);
        currentAssistant.toolCalls = toolCallsFromMessageParts(mergedParts);
      } else {
        currentAssistant = {
          id: `${idPrefix}-${idx++}`,
          role: 'assistant',
          createdAt: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
          markdown,
          parts: orderedParts.length > 0 ? orderedParts : undefined,
          thinking,
          status: 'completed',
          toolCalls,
        };
        chatMessages.push(currentAssistant);
      }
    }
  }

  return chatMessages;
}

function isSubagentSingleResultRunning(result: SubagentSingleResult): boolean {
  return result.exitCode === -1 || (result.runningTools?.length ?? 0) > 0;
}

function isSubagentSingleResultFailed(result: SubagentSingleResult): boolean {
  if (isSubagentSingleResultRunning(result)) {
    return false;
  }

  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

function nonEmptyText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function subagentSingleResultFallbackMarkdown(result: SubagentSingleResult): string {
  if (!isSubagentSingleResultFailed(result)) {
    return '(no output)';
  }

  const detail = nonEmptyText(result.errorMessage) ?? nonEmptyText(result.stderr);
  const failureLabel =
    result.stopReason === 'aborted' ? 'Aborted'
    : result.stopReason === 'error' ? 'Error'
    : result.exitCode > 0 ? `Exit code ${result.exitCode}`
    : 'Failed';

  return detail ? `${failureLabel}: ${detail}` : `${failureLabel}: agent failed before producing any output.`;
}

function placeholderSingleResult(agent: unknown, task: unknown): SubagentSingleResult | undefined {
  const agentName = typeof agent === 'string' ? agent.trim() : '';
  const taskText = typeof task === 'string' ? task.trim() : '';
  if (!agentName || !taskText) {
    return undefined;
  }

  return {
    agent: agentName,
    task: taskText,
    exitCode: -1,
    messages: [],
  };
}

function synthesizeRenderableSubagentResult(input: unknown): SubagentResult | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const single = placeholderSingleResult(input.agent, input.task);
  if (single) {
    return {
      mode: 'single',
      results: [single],
    };
  }

  if (Array.isArray(input.tasks)) {
    const results = input.tasks
      .map((task) => (isRecord(task) ? placeholderSingleResult(task.agent, task.task) : undefined))
      .filter((task): task is SubagentSingleResult => Boolean(task));

    if (results.length > 0) {
      return {
        mode: 'parallel',
        results,
      };
    }
  }

  if (Array.isArray(input.chain) && input.chain.length > 0) {
    const firstStep = input.chain[0];
    const result = isRecord(firstStep) ? placeholderSingleResult(firstStep.agent, firstStep.task) : undefined;
    if (result) {
      return {
        mode: 'chain',
        results: [result],
      };
    }
  }

  return undefined;
}

function normalizeRenderableSubagentResult(
  result: SubagentResult,
  toolStatus: ToolCall['status'],
): SubagentResult {
  if (toolStatus !== 'running') {
    return result;
  }

  return {
    ...result,
    results: result.results.map((current) => {
      if (current.exitCode !== 0 || current.stopReason || current.errorMessage) {
        return current;
      }

      const hasRunningTools = (current.runningTools?.length ?? 0) > 0;
      const hasMessages = Array.isArray(current.messages) && current.messages.length > 0;
      if (!hasRunningTools && hasMessages) {
        return current;
      }

      return {
        ...current,
        exitCode: -1,
      };
    }),
  };
}

export function getRenderableSubagentResult(rawResult: unknown): SubagentResult | undefined {
  const raw = rawResult as { details?: unknown; results?: unknown } | undefined;

  if (raw && typeof raw === 'object' && Array.isArray(raw.results) && raw.results.length > 0) {
    return raw as SubagentResult;
  }

  const nested = raw?.details as { results?: unknown } | undefined;
  if (nested && typeof nested === 'object' && Array.isArray(nested.results) && nested.results.length > 0) {
    return nested as SubagentResult;
  }

  return undefined;
}

export function getRenderableSubagentResultFromToolCall(
  toolCall: Pick<ToolCall, 'input' | 'result' | 'status'>,
): SubagentResult | undefined {
  const renderableResult = getRenderableSubagentResult(toolCall.result);
  if (renderableResult) {
    return normalizeRenderableSubagentResult(renderableResult, toolCall.status);
  }

  if (toolCall.status === 'running') {
    return synthesizeRenderableSubagentResult(toolCall.input);
  }

  return undefined;
}

function subagentTaskMessage(result: SubagentSingleResult, idPrefix: string): ChatMessage | undefined {
  const task = nonEmptyText(result.task);
  if (!task) {
    return undefined;
  }

  return {
    id: `${idPrefix}-task`,
    role: 'user',
    createdAt: '',
    markdown: task,
    status: 'completed',
  };
}

export function subagentSingleResultToChatMessages(result: SubagentSingleResult, idPrefix: string): ChatMessage[] {
  const chatMessages = rawMessagesToChatMessages(Array.isArray(result.messages) ? result.messages : [], idPrefix);
  const hasExplicitUserTask = chatMessages.some((message) => message.role === 'user');
  const taskMessage = hasExplicitUserTask ? undefined : subagentTaskMessage(result, idPrefix);

  if (chatMessages.length > 0) {
    return taskMessage ? [taskMessage, ...chatMessages] : chatMessages;
  }

  if (isSubagentSingleResultRunning(result)) {
    return taskMessage ? [taskMessage] : [];
  }

  return [
    ...(taskMessage ? [taskMessage] : []),
    {
      id: `${idPrefix}-fallback`,
      role: 'assistant',
      createdAt: '',
      markdown: subagentSingleResultFallbackMarkdown(result),
      status: isSubagentSingleResultFailed(result) ? 'error' : 'completed',
      ...(result.model ? { modelId: result.model } : {}),
    },
  ];
}

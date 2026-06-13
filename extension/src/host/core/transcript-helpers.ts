import type {
  ChatMessage,
  ChatMessagePart,
  ToolCall,
  UserContentPart,
} from '../../shared/protocol';
import { cloneToolCall } from '../../shared/chat-message-parts';

export function ensureAssistantParts(message: ChatMessage): ChatMessagePart[] {
  if (message.parts) {
    return message.parts;
  }

  const parts: ChatMessagePart[] = [];

  if (message.thinking) {
    parts.push({ kind: 'reasoning', text: message.thinking });
  }
  for (const toolCall of message.toolCalls ?? []) {
    parts.push({ kind: 'toolCall', toolCall: cloneToolCall(toolCall) });
  }
  if (message.markdown) {
    parts.push({ kind: 'text', text: message.markdown });
  }

  message.parts = parts;
  return parts;
}

export function withAssistantParts(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant' || message.parts) {
    return message;
  }

  const nextMessage = { ...message };
  ensureAssistantParts(nextMessage);
  return nextMessage;
}

export function markdownFromUserParts(
  userParts: UserContentPart[] | undefined,
  fallbackText: string,
): string {
  if (!userParts || userParts.length === 0) {
    return fallbackText;
  }

  const text = userParts
    .filter((part): part is Extract<UserContentPart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('');

  return text || fallbackText;
}

export function appendAssistantTextPart(
  message: ChatMessage,
  kind: 'text' | 'reasoning',
  text: string,
): void {
  if (!text) {
    return;
  }

  const parts = ensureAssistantParts(message);
  const last = parts[parts.length - 1];
  const currentAggregate = kind === 'text' ? message.markdown ?? '' : message.thinking ?? '';
  const needsSeparator =
    currentAggregate.endsWith('\n\n') &&
    last?.kind === kind &&
    !last.text.endsWith('\n\n');
  const partText = needsSeparator ? `\n\n${text}` : text;

  if (last?.kind === kind) {
    last.text += partText;
  } else {
    parts.push({ kind, text: partText });
  }

  if (kind === 'text') {
    message.markdown = (message.markdown ?? '') + text;
  } else {
    message.thinking = (message.thinking ?? '') + text;
  }
}

/**
 * Append a paragraph separator ('\n\n') between continuation turns in an
 * assistant message. Updates both the aggregate fields (markdown, thinking)
 * and the parts array so they stay consistent.
 *
 * When the last part is a text or reasoning part, '\n\n' is appended to it.
 * When the last part is a tool call (or there are no parts), a minimal
 * separator is appended to the markdown/thinking aggregate only — the next
 * delta will use `needsSeparator` in `appendAssistantTextPart` to inject the
 * separator into the new part when the kind changes.
 *
 * Note: only the LAST text/reasoning part is updated. If a mixed turn has
 * reasoning followed by text (e.g. "think → answer") and the continuation
 * starts with more reasoning, the reasoning aggregate will carry the '\n\n'
 * separator but the reasoning PART won't. This is a pre-existing limitation
 * of the single-part patch strategy; `appendAssistantTextPart`'s
 * `needsSeparator` logic does not currently handle kind-crossing separators.
 */
export function appendContinuationSeparator(message: ChatMessage): void {
  if (message.markdown) {
    message.markdown += '\n\n';
  }
  if (message.thinking) {
    message.thinking += '\n\n';
  }

  // Keep parts in sync with the aggregate separator.
  const parts = message.parts;
  if (!parts || parts.length === 0) {
    return;
  }

  // Find the last text or reasoning part and append the separator to it.
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.kind === 'text' || part.kind === 'reasoning') {
      if (!part.text.endsWith('\n\n')) {
        part.text += '\n\n';
      }
      return;
    }
  }
}

export function upsertAssistantToolCall(message: ChatMessage, toolCall: ToolCall): void {
  const parts = ensureAssistantParts(message);
  const nextToolCall = cloneToolCall(toolCall);
  const existingToolCalls = message.toolCalls ?? [];
  const toolIndex = existingToolCalls.findIndex((item) => item.id === nextToolCall.id);

  if (toolIndex === -1) {
    message.toolCalls = [...existingToolCalls, nextToolCall];
  } else {
    message.toolCalls = existingToolCalls.map((item) =>
      item.id === nextToolCall.id ? nextToolCall : item,
    );
  }

  const partIndex = parts.findIndex(
    (part) => part.kind === 'toolCall' && part.toolCall.id === nextToolCall.id,
  );
  if (partIndex === -1) {
    parts.push({ kind: 'toolCall', toolCall: nextToolCall });
    return;
  }

  parts[partIndex] = { kind: 'toolCall', toolCall: nextToolCall };
}

export function mergeContinuationToolCalls(message: ChatMessage, incoming: ChatMessage): void {
  const incomingToolCalls = incoming.parts
    ?.filter((part): part is Extract<ChatMessagePart, { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => part.toolCall)
    ?? incoming.toolCalls
    ?? [];

  for (const toolCall of incomingToolCalls) {
    upsertAssistantToolCall(message, toolCall);
  }
}

export function assistantToolCallsFromMessage(message: ChatMessage): ToolCall[] {
  if (message.role !== 'assistant') {
    return [];
  }

  const partToolCalls = message.parts
    ?.filter((part): part is Extract<ChatMessagePart, { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => cloneToolCall(part.toolCall));

  if (partToolCalls && partToolCalls.length > 0) {
    return partToolCalls;
  }

  return (message.toolCalls ?? []).map((toolCall) => cloneToolCall(toolCall));
}

export function mergeAssistantToolCallsPreservingResolvedState(
  target: ChatMessage,
  previous: ChatMessage,
): void {
  if (target.role !== 'assistant' || previous.role !== 'assistant') {
    return;
  }

  const currentById = new Map(assistantToolCallsFromMessage(target).map((toolCall) => [toolCall.id, toolCall]));

  for (const previousToolCall of assistantToolCallsFromMessage(previous)) {
    const currentToolCall = currentById.get(previousToolCall.id);

    if (!currentToolCall) {
      upsertAssistantToolCall(target, previousToolCall);
      currentById.set(previousToolCall.id, previousToolCall);
      continue;
    }

    const mergedToolCall: ToolCall = {
      ...currentToolCall,
      name: currentToolCall.name || previousToolCall.name,
      input: currentToolCall.input !== undefined ? currentToolCall.input : previousToolCall.input,
      result: currentToolCall.result !== undefined ? currentToolCall.result : previousToolCall.result,
      status:
        currentToolCall.status === 'failed' || previousToolCall.status !== 'failed'
          ? currentToolCall.status
          : previousToolCall.status,
    };

    const mergedStartedAt = currentToolCall.startedAt ?? previousToolCall.startedAt;
    if (mergedStartedAt !== undefined) {
      mergedToolCall.startedAt = mergedStartedAt;
    }
    const mergedDurationMs = currentToolCall.durationMs ?? previousToolCall.durationMs;
    if (mergedDurationMs !== undefined) {
      mergedToolCall.durationMs = mergedDurationMs;
    }

    upsertAssistantToolCall(target, mergedToolCall);
    currentById.set(mergedToolCall.id, mergedToolCall);
  }
}

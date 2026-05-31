import type {
  CustomMessagePayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '../shared/protocol';
import type { SdkSessionEvent } from './sdk';
import { mapAssistantMessage, mapCustomMessage } from './transcript';
import type { SessionContext } from './server-types';

export interface BackendSessionEventHandlerDeps {
  emit(event: string, payload?: unknown): void;
  emitBusyChanged(context: SessionContext, busy: boolean): void;
  emitContextUsageChanged(context: SessionContext): void;
  emitSessionOpened(sessionPath: string, selectionToken?: string): Promise<void>;
  emitSessionListChanged(): Promise<void>;
}

export function handleSdkSessionEvent(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  event: SdkSessionEvent,
): void {
  switch (event.type) {
    case 'agent_start': {
      deps.emitBusyChanged(context, true);
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'message_start': {
      if (event.message?.role !== 'assistant' || !context.activeRequest) {
        return;
      }
      context.activeRequest.messageIndex += 1;
      context.activeRequest.currentMessageId = `${context.activeRequest.id}:${context.activeRequest.messageIndex}`;
      context.activeRequest.lastAssistantMessageId = context.activeRequest.currentMessageId;
      context.activeRequest.currentMessageStartedAt = Date.now();

      deps.emit('message.started', {
        requestId: context.activeRequest.id,
        messageId: context.activeRequest.currentMessageId,
        sessionPath: context.sessionPath,
        modelId: context.activeRequest.modelId,
        thinkingLevel: context.activeRequest.thinkingLevel,
      } satisfies MessageStartedPayload);
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'message_update': {
      if (event.message?.role !== 'assistant' || !context.activeRequest?.currentMessageId) {
        return;
      }

      if (event.assistantMessageEvent?.type === 'text_delta') {
        deps.emit('message.delta', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          messageId: context.activeRequest.currentMessageId,
          delta: event.assistantMessageEvent.delta ?? '',
        } satisfies MessageDeltaPayload);
      }

      if (event.assistantMessageEvent?.type === 'thinking_delta') {
        const thinkingContent: string =
          event.assistantMessageEvent.thinking ?? event.assistantMessageEvent.delta ?? '';
        if (thinkingContent) {
          deps.emit('message.thinking', {
            requestId: context.activeRequest.id,
            sessionPath: context.sessionPath,
            messageId: context.activeRequest.currentMessageId,
            thinking: thinkingContent,
          } satisfies MessageThinkingPayload);
        }
      }

      deps.emitContextUsageChanged(context);
      return;
    }

    case 'tool_execution_start': {
      if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
        return;
      }

      // Diagnostic: log tool execution start to stderr for debugging file-changes tracking
      process.stderr.write(`[pie:backend] tool_execution_start: ${event.toolName} args=${JSON.stringify(event.args)?.slice(0, 200)}\n`);

      const toolCallId = event.toolCallId ?? '';
      const startedAt = Date.now();
      const toolStartTimes = context.activeRequest.toolStartTimes ?? new Map<string, number>();
      toolStartTimes.set(toolCallId, startedAt);
      context.activeRequest.toolStartTimes = toolStartTimes;

      deps.emit('tool.started', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId,
        name: event.toolName ?? '',
        input: event.args,
        startedAt,
      } satisfies ToolStartedPayload);
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'tool_execution_update': {
      if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
        return;
      }

      deps.emit('tool.progress', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId: event.toolCallId ?? '',
        partialResult: event.partialResult,
      } satisfies ToolProgressPayload);
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'tool_execution_end': {
      if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
        return;
      }

      deps.emit('tool.finished', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        messageId: context.activeRequest.lastAssistantMessageId,
        toolCallId: event.toolCallId ?? '',
        result: event.result,
        status: event.isError ? 'failed' : 'completed',
        durationMs: resolveToolDurationMs(context, event.toolCallId ?? ''),
      } satisfies ToolFinishedPayload);
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'message_end': {
      if (!context.activeRequest || !event.message) {
        return;
      }

      if (event.message.role === 'custom') {
        // before_agent_start extensions (like skill-pruner) surface transcript
        // entries as message_end/custom events. Forward them live so the webview
        // can render pruning summaries before the assistant turn starts.
        const customMessageIndex = (context.activeRequest.customMessageIndex ?? 0) + 1;
        context.activeRequest.customMessageIndex = customMessageIndex;
        const message = mapCustomMessage(
          `${context.activeRequest.id}:custom:${customMessageIndex}`,
          event.message,
        );
        if (!message) {
          deps.emitContextUsageChanged(context);
          return;
        }

        deps.emit('message.custom', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          message,
        } satisfies CustomMessagePayload);
        deps.emitContextUsageChanged(context);
        return;
      }

      if (event.message.role !== 'assistant') {
        return;
      }

      const messageId =
        context.activeRequest.currentMessageId
        ?? context.activeRequest.lastAssistantMessageId
        ?? `${context.activeRequest.id}:${context.activeRequest.messageIndex + 1}`;

      context.activeRequest.lastAssistantMessageId = messageId;
      context.activeRequest.currentMessageId = undefined;

      const durationMs = context.activeRequest.currentMessageStartedAt !== undefined
        ? Date.now() - context.activeRequest.currentMessageStartedAt
        : undefined;
      context.activeRequest.currentMessageStartedAt = undefined;
      const message = mapAssistantMessage(messageId, event.message as any, durationMs, {
        modelId: context.activeRequest.modelId,
        thinkingLevel: context.activeRequest.thinkingLevel,
      });
      deps.emit('message.finished', {
        requestId: context.activeRequest.id,
        sessionPath: context.sessionPath,
        message,
      } satisfies MessageFinishedPayload);

      if (message.status === 'interrupted') {
        deps.emit('message.aborted', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          messageId,
        } satisfies MessageAbortedPayload);
      }

      deps.emitContextUsageChanged(context);
      return;
    }

    case 'agent_end': {
      const requestId = context.activeRequest?.id;
      const messageId = context.activeRequest?.lastAssistantMessageId;
      const abortedWithoutMessage = context.activeRequest?.aborted && !messageId;

      deps.emitBusyChanged(context, false);
      deps.emitContextUsageChanged(context);

      void deps.emitSessionOpened(context.sessionPath);
      void deps.emitSessionListChanged();

      if (requestId && abortedWithoutMessage) {
        deps.emit('message.aborted', {
          requestId,
          sessionPath: context.sessionPath,
        } satisfies MessageAbortedPayload);
      }

      context.activeRequest = undefined;
      return;
    }

    default:
      return;
  }
}

/**
 * Resolve the wall-clock execution time for a finished tool call using the
 * start timestamp recorded at `tool_execution_start`. Falls back to 0 when the
 * start was never seen (e.g. an end event arrives without a matching start).
 */
function resolveToolDurationMs(context: SessionContext, toolCallId: string): number {
  const startedAt = context.activeRequest?.toolStartTimes?.get(toolCallId);
  context.activeRequest?.toolStartTimes?.delete(toolCallId);
  if (startedAt === undefined) {
    return 0;
  }
  return Math.max(0, Date.now() - startedAt);
}

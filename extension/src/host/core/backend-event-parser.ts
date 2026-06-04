/**
 * Backend event parser for the CQRS migration.
 *
 * Parses raw JSON event lines from the PI backend into typed `BackendEvent`
 * objects. This is the replacement for `SessionServiceEvents` — a simple
 * pure function instead of a class with mutable state and side-effects.
 *
 * The parser is intentionally stateless: it takes a raw JSON string and
 * returns a typed event (or null for unknown/unparseable events). All
 * state mutations happen in the reducer, all side-effects in the EffectRunner.
 */

import type {
  BackendEvent,
  MessageStartedEvent,
  MessageDeltaEvent,
  MessageThinkingEvent,
  MessageAbortedEvent,
  ToolCallEvent,
  MessageFinishedEvent,
  BusyChangedEvent,
  ContextUsageChangedEvent,
  SessionListChangedEvent,
  CustomMessageEvent,
  ExtensionUIRequestEvent,
  ErrorEvent,
  SessionOpenedEvent,
  SessionClosedEvent,
} from './events';
import type {
  ChatMessage,
  ContextWindowUsage,
  ExtensionUIRequestPayload,
  MessageStartedPayload,
  SessionOpenedPayload,
  SessionSummary,
  ToolCall,
} from '../../shared/protocol';

/** Raw JSON event envelope from the PI backend. */
interface RawBackendEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionPath?: string;
  payload?: Record<string, unknown>;
  id?: string;
}

/**
 * Parse a raw JSON string from the PI backend into a typed BackendEvent.
 *
 * Returns `null` for unknown event types or unparseable input.
 * The caller is responsible for routing the event to the reducer.
 */
export function parseBackendEvent(raw: string): BackendEvent | null {
  let parsed: RawBackendEvent;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const eventName = parsed.method;
  if (!eventName) return null;

  // Extract sessionPath from top level or params
  const sessionPath = (parsed.sessionPath ?? parsed.params?.sessionPath ?? '') as string;

  switch (eventName) {
    case 'message.started': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'MessageStarted',
        sessionPath,
        messageId: payload.messageId as string,
        requestId: payload.requestId as string | undefined,
        modelId: payload.modelId as string | undefined,
        thinkingLevel: payload.thinkingLevel as ChatMessage['thinkingLevel'] | undefined,
      } satisfies MessageStartedEvent;
    }

    case 'message.delta': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'MessageDelta',
        sessionPath,
        messageId: payload.messageId as string,
        delta: payload.delta as string,
      } satisfies MessageDeltaEvent;
    }

    case 'message.thinking': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'MessageThinking',
        sessionPath,
        messageId: payload.messageId as string,
        thinking: payload.thinking as string,
      } satisfies MessageThinkingEvent;
    }

    case 'message.aborted': {
      return {
        kind: 'MessageAborted',
        sessionPath,
        messageId: (parsed.payload?.messageId ?? parsed.params?.messageId) as string | undefined,
      } satisfies MessageAbortedEvent;
    }

    case 'message.finished': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'MessageFinished',
        sessionPath,
        message: payload.message as ChatMessage,
      } satisfies MessageFinishedEvent;
    }

    case 'tool.started':
    case 'tool.finished':
    case 'tool.progress': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'ToolCall',
        sessionPath,
        messageId: payload.messageId as string,
        toolCall: payload.toolCall as ToolCall,
      } satisfies ToolCallEvent;
    }

    case 'busy.changed': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'BusyChanged',
        sessionPath,
        running: payload.running as boolean,
      } satisfies BusyChangedEvent;
    }

    case 'session.opened': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'SessionOpened',
        sessionPath,
        payload: payload as unknown as SessionOpenedPayload,
      } satisfies SessionOpenedEvent;
    }

    case 'session.list_changed': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'SessionListChanged',
        sessionSummaries: (payload.sessions ?? payload.sessionSummaries ?? []) as SessionSummary[],
      } satisfies SessionListChangedEvent;
    }

    case 'session.closed': {
      return {
        kind: 'SessionClosed',
        sessionPath,
      } satisfies SessionClosedEvent;
    }

    case 'context.usage.changed': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'ContextUsageChanged',
        sessionPath,
        contextUsage: (payload.contextUsage ?? payload.usage ?? null) as ContextWindowUsage | null,
      } satisfies ContextUsageChangedEvent;
    }

    case 'extension_ui.request': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'ExtensionUIRequest',
        sessionPath,
        request: payload as ExtensionUIRequestPayload,
      } satisfies ExtensionUIRequestEvent;
    }

    case 'custom': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'CustomMessage',
        sessionPath,
        message: payload.message as ChatMessage,
      } satisfies CustomMessageEvent;
    }

    case 'error': {
      const payload = parsed.payload ?? parsed.params ?? {};
      return {
        kind: 'Error',
        sessionPath,
        error: (payload.error ?? payload.message ?? 'Unknown error') as string,
      } satisfies ErrorEvent;
    }

    default:
      // Unknown event type — skip
      return null;
  }
}
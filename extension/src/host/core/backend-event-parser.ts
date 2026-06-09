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

function getSessionPath(parsed: RawBackendEvent): string {
  return (parsed.sessionPath ?? parsed.params?.sessionPath ?? '') as string;
}

function getPayload(parsed: RawBackendEvent): Record<string, unknown> {
  return parsed.payload ?? parsed.params ?? {};
}

type EventParser = (parsed: RawBackendEvent) => BackendEvent | null;

function parseToolCall(parsed: RawBackendEvent): BackendEvent {
  const payload = getPayload(parsed);
  return {
    kind: 'ToolCall',
    sessionPath: getSessionPath(parsed),
    messageId: payload.messageId as string,
    toolCall: payload.toolCall as ToolCall,
  } satisfies ToolCallEvent;
}

const eventParsers: Record<string, EventParser> = {
  'message.started'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'MessageStarted',
      sessionPath: getSessionPath(parsed),
      messageId: payload.messageId as string,
      requestId: payload.requestId as string | undefined,
      modelId: payload.modelId as string | undefined,
      thinkingLevel: payload.thinkingLevel as ChatMessage['thinkingLevel'] | undefined,
    } satisfies MessageStartedEvent;
  },

  'message.delta'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'MessageDelta',
      sessionPath: getSessionPath(parsed),
      messageId: payload.messageId as string,
      delta: payload.delta as string,
    } satisfies MessageDeltaEvent;
  },

  'message.thinking'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'MessageThinking',
      sessionPath: getSessionPath(parsed),
      messageId: payload.messageId as string,
      thinking: payload.thinking as string,
    } satisfies MessageThinkingEvent;
  },

  'message.aborted'(parsed) {
    return {
      kind: 'MessageAborted',
      sessionPath: getSessionPath(parsed),
      messageId: (parsed.payload?.messageId ?? parsed.params?.messageId) as string | undefined,
    } satisfies MessageAbortedEvent;
  },

  'message.finished'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'MessageFinished',
      sessionPath: getSessionPath(parsed),
      message: payload.message as ChatMessage,
    } satisfies MessageFinishedEvent;
  },

  'tool.started': parseToolCall,
  'tool.finished': parseToolCall,
  'tool.progress': parseToolCall,

  'busy.changed'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'BusyChanged',
      sessionPath: getSessionPath(parsed),
      running: payload.running as boolean,
    } satisfies BusyChangedEvent;
  },

  'session.opened'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'SessionOpened',
      sessionPath: getSessionPath(parsed),
      payload: payload as unknown as SessionOpenedPayload,
    } satisfies SessionOpenedEvent;
  },

  'session.list_changed'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'SessionListChanged',
      sessionSummaries: (payload.sessions ?? payload.sessionSummaries ?? []) as SessionSummary[],
    } satisfies SessionListChangedEvent;
  },

  'session.closed'(parsed) {
    return {
      kind: 'SessionClosed',
      sessionPath: getSessionPath(parsed),
    } satisfies SessionClosedEvent;
  },

  'context.usage.changed'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'ContextUsageChanged',
      sessionPath: getSessionPath(parsed),
      contextUsage: (payload.contextUsage ?? payload.usage ?? null) as ContextWindowUsage | null,
    } satisfies ContextUsageChangedEvent;
  },

  'extension_ui.request'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'ExtensionUIRequest',
      sessionPath: getSessionPath(parsed),
      request: payload as ExtensionUIRequestPayload,
    } satisfies ExtensionUIRequestEvent;
  },

  'custom'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'CustomMessage',
      sessionPath: getSessionPath(parsed),
      message: payload.message as ChatMessage,
    } satisfies CustomMessageEvent;
  },

  'error'(parsed) {
    const payload = getPayload(parsed);
    return {
      kind: 'Error',
      sessionPath: getSessionPath(parsed),
      error: (payload.error ?? payload.message ?? 'Unknown error') as string,
    } satisfies ErrorEvent;
  },
};

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

  const parser = eventParsers[eventName];
  if (!parser) return null;

  return parser(parsed);
}

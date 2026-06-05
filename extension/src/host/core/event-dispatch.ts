import type {
  BusyChangedPayload,
  ContextUsageChangedPayload,
  CustomMessagePayload,
  ErrorPayload,
  EventEnvelope,
  ExtensionUIRequestPayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  SessionListChangedPayload,
  SessionOpenedPayload,
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '../../shared/protocol';

export interface SessionBackendEventHandlers {
  onSessionOpened(payload: SessionOpenedPayload): void;
  onSessionListChanged(payload: SessionListChangedPayload): void;
  onMessageStarted(payload: MessageStartedPayload): void;
  onMessageDelta(payload: MessageDeltaPayload): void;
  onMessageThinking(payload: MessageThinkingPayload): void;
  onToolStarted(payload: ToolStartedPayload): void;
  onToolFinished(payload: ToolFinishedPayload): void;
  onToolProgress(payload: ToolProgressPayload): void;
  onMessageFinished(payload: MessageFinishedPayload): void;
  onCustomMessage(payload: CustomMessagePayload): void;
  onMessageAborted(payload: MessageAbortedPayload): void;
  onBusyChanged(payload: BusyChangedPayload): void;
  onContextUsageChanged(payload: ContextUsageChangedPayload): void;
  onExtensionUIRequest(payload: ExtensionUIRequestPayload): void;
  onError(payload: ErrorPayload): void;
}

export function dispatchSessionBackendEvent(
  event: EventEnvelope,
  handlers: SessionBackendEventHandlers,
): void {
  switch (event.event) {
    case 'session.opened':
      handlers.onSessionOpened(event.payload as SessionOpenedPayload);
      return;
    case 'session.list.changed':
      handlers.onSessionListChanged(event.payload as SessionListChangedPayload);
      return;
    case 'message.started':
      handlers.onMessageStarted(event.payload as MessageStartedPayload);
      return;
    case 'message.delta':
      handlers.onMessageDelta(event.payload as MessageDeltaPayload);
      return;
    case 'message.thinking':
      handlers.onMessageThinking(event.payload as MessageThinkingPayload);
      return;
    case 'tool.started':
      handlers.onToolStarted(event.payload as ToolStartedPayload);
      return;
    case 'tool.finished':
      handlers.onToolFinished(event.payload as ToolFinishedPayload);
      return;
    case 'tool.progress':
      handlers.onToolProgress(event.payload as ToolProgressPayload);
      return;
    case 'message.finished':
      handlers.onMessageFinished(event.payload as MessageFinishedPayload);
      return;
    case 'message.custom':
      handlers.onCustomMessage(event.payload as CustomMessagePayload);
      return;
    case 'message.aborted':
      handlers.onMessageAborted(event.payload as MessageAbortedPayload);
      return;
    case 'busy.changed':
      handlers.onBusyChanged(event.payload as BusyChangedPayload);
      return;
    case 'contextUsage.changed':
      handlers.onContextUsageChanged(event.payload as ContextUsageChangedPayload);
      return;
    case 'extension_ui.request':
      handlers.onExtensionUIRequest(event.payload as ExtensionUIRequestPayload);
      return;
    case 'error':
      handlers.onError(event.payload as ErrorPayload);
      return;
  }
}

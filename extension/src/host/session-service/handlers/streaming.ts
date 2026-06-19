import type { RunObserver } from '../../stats-service';
import type { ArchState } from '../../core/arch-state';
import { recordStreamEvent } from '../../util/stream-telemetry';
import type { SessionServiceState } from '../state';
import type { Event } from '../../core/events';
import type {
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
} from '../../../shared/protocol';
import type { TurnThroughputStatus } from '../../run-analytics';

/**
 * Map a finished assistant message's status onto the throughput-sample
 * status. `streaming` should not occur at `message_end` and is treated as a
 * normal completion.
 */
function toTurnThroughputStatus(status: string | undefined): TurnThroughputStatus {
  if (status === 'error') {
    return 'error';
  }
  if (status === 'interrupted') {
    return 'interrupted';
  }
  return 'completed';
}

interface HandlerDeps {
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  runObserver: RunObserver;
  state: SessionServiceState;
  scheduleRender: () => void;
  requireEventSessionPath: (eventName: string, sessionPath: string | undefined) => string | null;
}

export function onMessageDelta(payload: MessageDeltaPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.delta', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'MessageDelta',
    sessionPath,
    messageId: payload.messageId,
    delta: payload.delta,
  });
  recordStreamEvent('delta');
}

export function onMessageThinking(payload: MessageThinkingPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.thinking', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'MessageThinking',
    sessionPath,
    messageId: payload.messageId,
    thinking: payload.thinking,
  });
  recordStreamEvent('thinking');
}

export function onMessageStarted(payload: MessageStartedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.started', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'MessageStarted',
    sessionPath,
    messageId: payload.messageId,
    requestId: payload.requestId,
    modelId: payload.modelId,
    thinkingLevel: payload.thinkingLevel,
    timestamp: Date.now(),
  });

  deps.state.bindRequestSessionPath(payload.requestId, sessionPath);
  deps.runObserver.onAssistantTurnStarted(sessionPath, payload.messageId);

  if (payload.modelId) {
    const archState = deps.getArchState();
    const session = archState.sessions.sessions.find((s: any) => s.path === sessionPath);
    if (session && (session.modelId !== payload.modelId || session.thinkingLevel !== payload.thinkingLevel)) {
      deps.dispatchArch({
        kind: 'SessionMetadataChanged',
        sessionPath,
        modelId: payload.modelId,
        thinkingLevel: payload.thinkingLevel,
      });
    }
  }

  deps.state.touchSessionTranscript(sessionPath);
}

export function onMessageFinished(payload: MessageFinishedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.finished', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // Stamp errorDetail on error messages so the webview can display the reason.
  const message = payload.message;
  if (message.status === 'error' && !message.errorDetail) {
    const notice = deps.getArchState().settings.notice;
    if (notice) {
      message.errorDetail = notice;
    }
  }

  deps.dispatchArch({
    kind: 'MessageFinished',
    sessionPath,
    message,
  });
  deps.runObserver.onAssistantTurnEnded(
    sessionPath,
    message.id,
    message.durationMs ?? 0,
    message.usage,
    toTurnThroughputStatus(message.status),
    message.turnLatencyMs !== undefined || message.overheadMs !== undefined || message.providerLatencyMs !== undefined
      ? {
          turnLatencyMs: message.turnLatencyMs,
          overheadMs: message.overheadMs,
          providerLatencyMs: message.providerLatencyMs,
        }
      : undefined,
  );
  deps.state.unbindRequestSessionPath(payload.requestId);

  // MessageFinished replaces the streaming entry with its authoritative form.
  // The next snapshot diff naturally produces the content replacement.
  deps.state.touchSessionTranscript(sessionPath);
}

export function onMessageAborted(payload: MessageAbortedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.aborted', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'MessageAborted',
    sessionPath,
    messageId: payload.messageId,
  });

  deps.runObserver.onInterrupted(sessionPath);
  deps.state.touchSessionTranscript(sessionPath);
}

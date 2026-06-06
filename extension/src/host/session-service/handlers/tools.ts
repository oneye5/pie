import type { RunObserver } from '../../stats-service';
import type { ArchState } from '../../core/arch-state';
import type { SessionServiceState } from '../state';
import type { BackendEvent } from '../../core/events';
import { deriveFileChangeFromToolCall } from '../../core/file-change-derivation';
import type {
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
} from '../../../shared/protocol';

interface HandlerDeps {
  getArchState: () => ArchState;
  mutateArchState: (recipe: (draft: ArchState) => void) => void;
  dispatchArch: (event: BackendEvent) => void;
  runObserver: RunObserver;
  state: SessionServiceState;
  scheduleRender: () => void;
  requireEventSessionPath: (eventName: string, sessionPath: string | undefined) => string | null;
}

export function onToolStarted(payload: ToolStartedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('tool.started', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  const toolCall = {
    id: payload.toolCallId,
    name: payload.name,
    input: payload.input,
    status: 'running' as const,
    startedAt: payload.startedAt,
  };

  deps.dispatchArch({
    kind: 'ToolCall',
    sessionPath,
    messageId: payload.messageId,
    toolCall,
  });
  deps.runObserver.onToolStarted(sessionPath, toolCall);

  // Track file changes from file-modifying tools
  const fileChange = deriveFileChangeFromToolCall(
    { id: payload.toolCallId, name: payload.name, input: payload.input },
    payload.messageId,
    new Date().toISOString(),
  );
  console.log('[pie:fileChanges] onToolStarted', { name: payload.name, hasInput: !!payload.input, inputType: typeof payload.input, fileChange: fileChange ? fileChange.path : null });
  if (fileChange) {
    deps.mutateArchState((draft) => {
      const list = (draft.fileChanges.bySession[sessionPath] ??= []);
      const existingIdx = list.findIndex((entry: any) => entry.path === fileChange.path);
      if (existingIdx !== -1) {
        const existing = list[existingIdx];
        const change = fileChange;
        if (change.kind === 'deleted' && existing.kind === 'created') {
          list.splice(existingIdx, 1);
          return;
        }
        const additions = (existing.additions ?? 0) + (change.additions ?? 0);
        const deletions = (existing.deletions ?? 0) + (change.deletions ?? 0);
        list[existingIdx] = {
          ...change,
          ...(additions > 0 && { additions }),
          ...(deletions > 0 && { deletions }),
        };
      } else {
        list.push(fileChange);
      }
    });
    deps.scheduleRender();
  }

  deps.state.touchSessionTranscript(sessionPath);
}

export function onToolFinished(payload: ToolFinishedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('tool.finished', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // Look up existing tool call by toolCallId to carry forward name/input.
  const existing = deps.getArchState()
    .transcript.bySession[sessionPath]
    ?.flatMap((message: any) => message.toolCalls ?? [])
    .find((toolCall: any) => toolCall.id === payload.toolCallId);

  const toolCall = {
    id: payload.toolCallId,
    name: existing?.name ?? '',
    input: existing?.input,
    result: payload.result,
    status: payload.status,
    startedAt: existing?.startedAt,
    durationMs: payload.durationMs,
  };

  deps.dispatchArch({
    kind: 'ToolCall',
    sessionPath,
    messageId: payload.messageId,
    toolCall,
  });
  deps.runObserver.onToolFinished(sessionPath, toolCall);

  deps.state.touchSessionTranscript(sessionPath);
}

export function onToolProgress(payload: ToolProgressPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('tool.progress', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // Look up existing tool call by toolCallId to carry forward name/input.
  const existing = deps.getArchState()
    .transcript.bySession[sessionPath]
    ?.flatMap((message: any) => message.toolCalls ?? [])
    .find((toolCall: any) => toolCall.id === payload.toolCallId);

  const toolCall = {
    id: payload.toolCallId,
    name: existing?.name ?? '',
    input: existing?.input,
    result: payload.partialResult,
    status: 'running' as const,
    startedAt: existing?.startedAt,
  };

  deps.dispatchArch({
    kind: 'ToolCall',
    sessionPath,
    messageId: payload.messageId,
    toolCall,
  });

  deps.state.touchSessionTranscript(sessionPath);
}

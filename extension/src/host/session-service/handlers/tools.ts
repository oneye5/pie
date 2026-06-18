import type { RunObserver } from '../../stats-service';
import type { ArchState } from '../../core/arch-state';
import type { SessionServiceState } from '../state';
import type { Event } from '../../core/events';
import { deriveFileChangesFromToolCall, deriveFileChangesFromSubagentResult } from '../../core/file-change-derivation';
import { isRecord } from '../../../shared/type-guards';
import type {
  ToolFinishedPayload,
  ToolProgressPayload,
  ToolStartedPayload,
  FileChangeEntry,
} from '../../../shared/protocol';

/** Upsert a file-change entry into a session's file-changes list, accumulating
 *  stats and removing create-then-delete pairs. */
function upsertFileChange(list: FileChangeEntry[], change: FileChangeEntry): void {
  const existingIdx = list.findIndex((entry) => entry.path === change.path);
  if (existingIdx !== -1) {
    const existing = list[existingIdx];
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
    list.push(change);
  }
}

interface HandlerDeps {
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
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
  const fileChanges = deriveFileChangesFromToolCall(
    { id: payload.toolCallId, name: payload.name, input: payload.input },
    payload.messageId,
    new Date().toISOString(),
  );
  if (fileChanges.length > 0) {
    const existing = deps.getArchState().fileChanges.bySession[sessionPath] ?? [];
    const next = [...existing];
    for (const change of fileChanges) {
      upsertFileChange(next, change);
    }
    deps.dispatchArch({ kind: 'FileChangesUpdated', sessionPath, fileChanges: next });
    deps.scheduleRender();
  }

  deps.state.touchSessionTranscript(sessionPath);
}

export function onToolFinished(payload: ToolFinishedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('tool.finished', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // Look up the existing tool call to carry forward name/input. The owner
  // message is identified by payload.messageId, so locate that one message
  // (no array allocation across the whole transcript) and find the tool call
  // within its toolCalls. Use the cached streaming-turn index for O(1) when
  // it still points at this message; otherwise fall back to a find.
  const archState = deps.getArchState();
  const transcript = archState.transcript.bySession[sessionPath];
  const cachedIdx = archState.pending.currentTurnBySession[sessionPath]?.firstMessageIndex;
  const ownerMessage =
    cachedIdx !== undefined && transcript?.[cachedIdx]?.id === payload.messageId
      ? transcript?.[cachedIdx]
      : transcript?.find((message) => message.id === payload.messageId);
  const existing = ownerMessage?.toolCalls?.find((toolCall) => toolCall.id === payload.toolCallId);

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

  // Track file changes from subagent inner tool calls
  if (existing?.name === 'subagent' && isRecord(payload.result)) {
    const subagentChanges = deriveFileChangesFromSubagentResult(
      payload.result,
      payload.messageId,
      new Date().toISOString(),
      payload.toolCallId,
    );
    if (subagentChanges.length > 0) {
      const existingChanges = deps.getArchState().fileChanges.bySession[sessionPath] ?? [];
      const next = [...existingChanges];
      for (const change of subagentChanges) {
        upsertFileChange(next, change);
      }
      deps.dispatchArch({ kind: 'FileChangesUpdated', sessionPath, fileChanges: next });
      deps.scheduleRender();
    }
  }

  deps.state.touchSessionTranscript(sessionPath);
}

export function onToolProgress(payload: ToolProgressPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('tool.progress', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // Look up the existing tool call to carry forward name/input. The owner
  // message is identified by payload.messageId, so locate that one message
  // (no array allocation across the whole transcript) and find the tool call
  // within its toolCalls. Use the cached streaming-turn index for O(1) when
  // it still points at this message; otherwise fall back to a find.
  const archState = deps.getArchState();
  const transcript = archState.transcript.bySession[sessionPath];
  const cachedIdx = archState.pending.currentTurnBySession[sessionPath]?.firstMessageIndex;
  const ownerMessage =
    cachedIdx !== undefined && transcript?.[cachedIdx]?.id === payload.messageId
      ? transcript?.[cachedIdx]
      : transcript?.find((message) => message.id === payload.messageId);
  const existing = ownerMessage?.toolCalls?.find((toolCall) => toolCall.id === payload.toolCallId);

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

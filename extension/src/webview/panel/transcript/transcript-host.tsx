/** @jsxRuntime automatic */
/** @jsxImportSource preact */

/**
 * TranscriptHost renders one TranscriptView per open tab path.
 * Only the active surface is visible/interactive; inactive surfaces remain
 * mounted but hidden via visibility:hidden + position:absolute to preserve
 * virtualizer measurements, scroll position, and disclosure state.
 */

import type {
  ChatPrefs,
  PruningResult,
  PruningSettings,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
  ChatMessage,
} from '../../../shared/protocol';
import type { TranscriptContextMenuHandler } from './types';
import { TranscriptView } from '.';

interface TranscriptSurfaceProps {
  sessionPath: string;
  isActive: boolean;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  transcriptLoaded: boolean;
  busy: boolean;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
  workingDirectory: string | null;
  editingId: string | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onJumpToLatest: () => void;
}

function TranscriptSurface({
  sessionPath,
  isActive,
  transcript,
  transcriptWindow,
  transcriptLoaded,
  busy,
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
  workingDirectory,
  editingId,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  onLoadOlder,
  onLoadNewer,
  onJumpToLatest,
}: TranscriptSurfaceProps) {
  const style = isActive
    ? 'position:relative;flex:1;min-height:0;display:flex;flex-direction:column;visibility:visible;z-index:0;pointer-events:auto'
    : 'visibility:hidden;position:absolute;inset:0;z-index:-1;pointer-events:none;display:flex;flex-direction:column';

  return (
    <div
      class="transcript-surface"
      style={style}
      aria-hidden={!isActive}
      data-session-path={sessionPath}
    >
      <TranscriptView
        sessionKey={sessionPath}
        transcript={transcript}
        transcriptWindow={transcriptWindow}
        transcriptLoaded={transcriptLoaded}
        busy={busy}
        prefs={prefs}
        pruningSettings={pruningSettings}
        systemPrompts={systemPrompts}
        pruningResult={pruningResult}
        pendingAssistantModelId={pendingAssistantModelId}
        pendingAssistantThinkingLevel={pendingAssistantThinkingLevel}
        workingDirectory={workingDirectory}
        editingId={editingId}
        onEditRequest={onEditRequest}
        onEditConfirm={onEditConfirm}
        onEditCancel={onEditCancel}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        onLoadOlder={onLoadOlder}
        onLoadNewer={onLoadNewer}
        onJumpToLatest={onJumpToLatest}
      />
    </div>
  );
}

export interface TranscriptHostProps {
  openTabPaths: string[];
  activeSessionPath: string | null;
  // For now, these are shared from the active session's viewState.
  // Per-tab data will come from session stores in later phases.
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  transcriptLoaded: boolean;
  busy: boolean;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  systemPrompts: SystemPromptEntry[];
  pruningResult: PruningResult | null;
  pendingAssistantModelId?: string;
  pendingAssistantThinkingLevel?: ThinkingLevel;
  workingDirectory: string | null;
  editingId: string | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  postMessage: (msg: any) => void;
}

export function TranscriptHost({
  openTabPaths,
  activeSessionPath,
  transcript,
  transcriptWindow,
  transcriptLoaded,
  busy,
  prefs,
  pruningSettings,
  systemPrompts,
  pruningResult,
  pendingAssistantModelId,
  pendingAssistantThinkingLevel,
  workingDirectory,
  editingId,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  postMessage,
}: TranscriptHostProps) {
  return (
    <div class="transcript-host" style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column">
      {activeSessionPath && openTabPaths.includes(activeSessionPath) && (
        <TranscriptSurface
          sessionPath={activeSessionPath}
          isActive
          transcript={transcript}
          transcriptWindow={transcriptWindow}
          transcriptLoaded={transcriptLoaded}
          busy={busy}
          prefs={prefs}
          pruningSettings={pruningSettings}
          systemPrompts={systemPrompts}
          pruningResult={pruningResult}
          pendingAssistantModelId={pendingAssistantModelId}
          pendingAssistantThinkingLevel={pendingAssistantThinkingLevel}
          workingDirectory={workingDirectory}
          editingId={editingId}
          onEditRequest={onEditRequest}
          onEditConfirm={onEditConfirm}
          onEditCancel={onEditCancel}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
          onLoadOlder={() => postMessage({
            type: 'loadOlderTranscript',
            sessionPath: activeSessionPath,
          })}
          onLoadNewer={() => postMessage({
            type: 'loadNewerTranscript',
            sessionPath: activeSessionPath,
          })}
          onJumpToLatest={() => postMessage({
            type: 'jumpToLatestTranscript',
            sessionPath: activeSessionPath,
          })}
        />
      )}
    </div>
  );
}

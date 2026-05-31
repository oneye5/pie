/** @jsxRuntime automatic */
/** @jsxImportSource preact */

// Side-effect: register all built-in row and tool renderers
import './register-builtins';

import type {
  ChatMessage,
  ChatPrefs,
  PruningResult,
  PruningSettings,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
} from '../../../shared/protocol';
import { isTranscriptHydrating } from './state';

import { MessageItem, ReasoningBlock } from './message-item';
export {
  formatToolCallResultForDisplay,
  splitSummaryPath,
  ToolCallCard,
} from './tool-call-card';
export {
  getRenderableUserParts,
  messageHasUserImages,
} from './parts';
export {
  getRenderableSubagentResult,
  getRenderableSubagentResultFromToolCall,
  rawMessagesToChatMessages,
  subagentSingleResultToChatMessages,
} from './subagent';
export type {
  SubagentResult,
  SubagentSingleResult,
} from './subagent';
import type { TranscriptContextMenuHandler } from './types';
import { TranscriptVirtualList } from './virtual-list';

export { MessageItem, ReasoningBlock };

interface TranscriptViewProps {
  sessionKey: string | null;
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

export function TranscriptView({
  sessionKey,
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
}: TranscriptViewProps) {
  const transcriptHydrating = isTranscriptHydrating({ transcript, systemPrompts, transcriptLoaded });

  if (transcriptHydrating) {
    return (
      <div class="transcript">
        <div class="transcript-loading" role="status" aria-label="Loading conversation">
          <div class="loading-wheel" aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <TranscriptVirtualList
      sessionKey={sessionKey}
      transcript={transcript}
      transcriptWindow={transcriptWindow}
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
  );
}

/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type {
  ChatMessage,
  ChatPrefs,
  SystemPromptEntry,
  TranscriptWindow,
} from '../../../shared/protocol';
import type { Overlay } from '../overlay';
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
  busy: boolean;
  overlay: Overlay;
  prefs: ChatPrefs;
  systemPrompts: SystemPromptEntry[];
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
  busy,
  overlay,
  prefs,
  systemPrompts,
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
  const transcriptHydrating = isTranscriptHydrating({ transcript, systemPrompts });

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
      overlay={overlay}
      prefs={prefs}
      systemPrompts={systemPrompts}
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

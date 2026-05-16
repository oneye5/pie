/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, SystemPromptEntry, ToolCall } from '../../../shared/protocol';
import type { Overlay } from '../overlay';
import { SystemPromptMessage } from '../system-prompts';

import { MessageItem } from './message-item';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import type { TranscriptRow } from './virtual-list-rows';

interface TranscriptVirtualRowProps {
  row: TranscriptRow;
  busy: boolean;
  overlay: Overlay;
  prefs: ChatPrefs;
  systemPrompts: SystemPromptEntry[];
  workingDirectory: string | null;
  editingId: string | null;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  isLastRow: boolean;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  onRequestOlder: () => void;
  onRequestNewer: () => void;
  renderToolCall: RenderToolCall;
}

export function TranscriptVirtualRow({
  row,
  busy,
  overlay,
  prefs,
  systemPrompts,
  workingDirectory,
  editingId,
  isLoadingOlder,
  isLoadingNewer,
  isLastRow,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
  onRequestOlder,
  onRequestNewer,
  renderToolCall,
}: TranscriptVirtualRowProps) {
  if (row.kind === 'systemPrompts') {
    return <SystemPromptMessage prompts={systemPrompts} />;
  }

  if (row.kind === 'topGap') {
    return (
      <div class="transcript-gap-row">
        <button
          type="button"
          class="transcript-gap-btn"
          disabled={isLoadingOlder}
          onClick={onRequestOlder}
        >
          {isLoadingOlder ? 'Loading older messages…' : 'Load older messages'}
        </button>
      </div>
    );
  }

  if (row.kind === 'bottomGap') {
    return (
      <div class="transcript-gap-row transcript-gap-row-bottom">
        <button
          type="button"
          class="transcript-gap-btn"
          disabled={isLoadingNewer}
          onClick={onRequestNewer}
        >
          {isLoadingNewer ? 'Loading newer messages…' : 'Load newer messages'}
        </button>
      </div>
    );
  }

  const overlayParts = overlay.partsByMessage.get(row.message.id);
  const isStreaming = busy && row.message.role === 'assistant' && row.message.status === 'streaming';
  const isLastAssistantMessage = busy && row.message.role === 'assistant' && isLastRow;

  return (
    <MessageItem
      key={row.message.id}
      message={row.message}
      overlayParts={overlayParts}
      isStreaming={isStreaming}
      prefs={prefs}
      readonly={busy}
      workingDirectory={workingDirectory}
      editingId={editingId}
      onEditRequest={onEditRequest}
      onEditConfirm={onEditConfirm}
      onEditCancel={onEditCancel}
      onOpenFile={onOpenFile}
      onContextMenu={onContextMenu}
      renderToolCall={renderToolCall}
      isLastAssistantMessage={isLastAssistantMessage}
    />
  );
}

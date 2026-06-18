/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { RefObject } from 'preact';

import type { ChatMessage, ChatPrefs } from '../../../../shared/protocol';
import { renderMarkdown } from '../../markdown';
import { BufferedTextPart } from '../buffered-text-part';
import {
  assistantPartsFromMessage,
  getRenderableUserParts,
  userImageSrc,
} from '../parts';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../types';
import { ReasoningBlock } from './reasoning-block';

interface AssistantPartsProps {
  messageId: string;
  parts: NonNullable<ReturnType<typeof assistantPartsFromMessage>>;
  prefs: ChatPrefs;
  isCurrentlyStreaming: boolean;
  renderToolCall: RenderToolCall;
  onContextMenu: TranscriptContextMenuHandler;
  getMessageRaw: () => string;
}

function AssistantParts({
  messageId,
  parts,
  prefs,
  isCurrentlyStreaming,
  renderToolCall,
  onContextMenu,
  getMessageRaw,
}: AssistantPartsProps) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === 'reasoning') {
          return (
            <ReasoningBlock
              key={`reasoning-${messageId}-${index}`}
              text={part.text}
              autoExpand={prefs.autoExpandReasoning}
              disclosureKey={`reasoning:${messageId}:${index}`}
              onContextMenu={(e) => onContextMenu('reasoning', part.text, e)}
            />
          );
        }

        if (part.kind === 'toolCall') {
          return (
            <div class="tool-call-list" key={`tool-${part.toolCall.id}-${index}`}>
              {renderToolCall(part.toolCall, onContextMenu)}
            </div>
          );
        }

        return (
          <BufferedTextPart
            key={`text-${messageId}-${index}`}
            messageId={messageId}
            index={index}
            text={part.text}
            // Only the last part is actively streaming (new text is appended
            // there); earlier text parts are complete. Passing streaming=true
            // to every part would spin up a never-stopping rAF loop per part
            // for the whole streaming duration (see use-buffered-text).
            streaming={isCurrentlyStreaming && index === parts.length - 1}
            onContextMenu={(e) => {
              onContextMenu('message', getMessageRaw(), e as unknown as MouseEvent);
            }}
          />
        );
      })}
    </>
  );
}

interface UserPartsProps {
  messageId: string;
  parts: NonNullable<ReturnType<typeof getRenderableUserParts>>;
  messageBodyRef: RefObject<HTMLDivElement>;
}

function UserParts({
  messageId,
  parts,
  messageBodyRef,
}: UserPartsProps) {
  return (
    <>
      {parts.map((part, index) => (
        part.kind === 'text' ? (
          <div
            key={`user-text-${messageId}-${index}`}
            class="message-body"
            ref={index === 0 ? messageBodyRef : undefined}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }}
          />
        ) : (
          <figure key={`user-image-${messageId}-${index}`} class="message-user-image">
            <img
              class="message-user-image-element"
              src={userImageSrc(part)}
              alt={part.name || 'Attached image'}
            />
            {(part.name || (part.width && part.height)) && (
              <figcaption class="message-user-image-caption">
                {part.name || 'Image'}
                {part.width && part.height ? ` · ${part.width}×${part.height}` : ''}
              </figcaption>
            )}
          </figure>
        )
      ))}
    </>
  );
}

interface MessageContentProps {
  messageId: string;
  role: ChatMessage['role'];
  combinedParts: ReturnType<typeof assistantPartsFromMessage> | undefined;
  renderableUserParts: ReturnType<typeof getRenderableUserParts> | undefined;
  html: string;
  isCurrentlyStreaming: boolean;
  messageBodyRef: RefObject<HTMLDivElement>;
  prefs: ChatPrefs;
  renderToolCall: RenderToolCall;
  onContextMenu: TranscriptContextMenuHandler;
  getMessageRaw: () => string;
}

export function MessageContent({
  messageId,
  role,
  combinedParts,
  renderableUserParts,
  html,
  isCurrentlyStreaming,
  messageBodyRef,
  prefs,
  renderToolCall,
  onContextMenu,
  getMessageRaw,
}: MessageContentProps) {
  if (role === 'assistant' && combinedParts) {
    return (
      <AssistantParts
        messageId={messageId}
        parts={combinedParts}
        prefs={prefs}
        isCurrentlyStreaming={isCurrentlyStreaming}
        renderToolCall={renderToolCall}
        onContextMenu={onContextMenu}
        getMessageRaw={getMessageRaw}
      />
    );
  }
  if (role === 'user' && renderableUserParts) {
    return (
      <UserParts
        messageId={messageId}
        parts={renderableUserParts}
        messageBodyRef={messageBodyRef}
      />
    );
  }
  return (
    <div
      class="message-body"
      ref={role === 'user' ? messageBodyRef : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
      onContextMenu={role === 'assistant' ? (e) => {
        e.preventDefault();
        onContextMenu('message', getMessageRaw(), e as unknown as MouseEvent);
      } : undefined}
    />
  );
}

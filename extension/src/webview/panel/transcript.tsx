/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

import type { ChatMessage, ChatMessagePart, ChatPrefs, SystemPromptEntry, ToolCall } from '../../shared/protocol';
import type { Overlay } from './overlay';
import { renderMarkdown, reasoningSummary } from './markdown';
import { SystemPromptMessage } from './system-prompts';
import { getToolCallPresentation, summarizeToolCall } from './tool-call-summary';

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function formatTimestamp(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return timeFormatter.format(date);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function roleLabel(role: ChatMessage['role']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'PI';
  return 'System';
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return { ...toolCall };
}

function cloneMessagePart(part: ChatMessagePart): ChatMessagePart {
  if (part.kind === 'toolCall') {
    return { kind: 'toolCall', toolCall: cloneToolCall(part.toolCall) };
  }

  return { kind: part.kind, text: part.text };
}

function appendAssistantTextPart(parts: ChatMessagePart[], kind: 'text' | 'reasoning', text: string): void {
  if (!text) {
    return;
  }

  const last = parts[parts.length - 1];
  if (last?.kind === kind) {
    last.text += text;
    return;
  }

  parts.push({ kind, text });
}

function upsertAssistantToolPart(parts: ChatMessagePart[], toolCall: ToolCall): void {
  const nextToolCall = cloneToolCall(toolCall);
  const index = parts.findIndex(
    (part) => part.kind === 'toolCall' && part.toolCall.id === nextToolCall.id,
  );

  if (index === -1) {
    parts.push({ kind: 'toolCall', toolCall: nextToolCall });
    return;
  }

  parts[index] = { kind: 'toolCall', toolCall: nextToolCall };
}

function legacyAssistantParts(message: ChatMessage): ChatMessagePart[] {
  const parts: ChatMessagePart[] = [];

  if (message.thinking) {
    parts.push({ kind: 'reasoning', text: message.thinking });
  }
  for (const toolCall of message.toolCalls ?? []) {
    parts.push({ kind: 'toolCall', toolCall: cloneToolCall(toolCall) });
  }
  if (message.markdown) {
    parts.push({ kind: 'text', text: message.markdown });
  }

  return parts;
}

function mergeAssistantParts(
  baseParts: ChatMessagePart[] | undefined,
  appendedParts: ChatMessagePart[] | undefined,
): ChatMessagePart[] | undefined {
  const merged: ChatMessagePart[] = [];

  for (const part of baseParts ?? []) {
    const nextPart = cloneMessagePart(part);
    if (nextPart.kind === 'toolCall') {
      upsertAssistantToolPart(merged, nextPart.toolCall);
    } else {
      appendAssistantTextPart(merged, nextPart.kind, nextPart.text);
    }
  }

  for (const part of appendedParts ?? []) {
    const nextPart = cloneMessagePart(part);
    if (nextPart.kind === 'toolCall') {
      upsertAssistantToolPart(merged, nextPart.toolCall);
    } else {
      appendAssistantTextPart(merged, nextPart.kind, nextPart.text);
    }
  }

  return merged.length > 0 ? merged : undefined;
}

function textFromMessageParts(parts: ChatMessagePart[] | undefined): string {
  if (!parts) {
    return '';
  }

  return parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

function reasoningFromMessageParts(parts: ChatMessagePart[] | undefined): string | undefined {
  if (!parts) {
    return undefined;
  }

  const text = parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'reasoning' }> => part.kind === 'reasoning')
    .map((part) => part.text)
    .join('');

  return text || undefined;
}

function toolCallsFromMessageParts(parts: ChatMessagePart[] | undefined): ToolCall[] | undefined {
  if (!parts) {
    return undefined;
  }

  const toolCalls = parts
    .filter((part): part is Extract<ChatMessagePart, { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => cloneToolCall(part.toolCall));

  return toolCalls.length > 0 ? toolCalls : undefined;
}

function assistantPartsFromMessage(message: ChatMessage): ChatMessagePart[] | undefined {
  if (message.role !== 'assistant') {
    return undefined;
  }

  return message.parts && message.parts.length > 0 ? message.parts : legacyAssistantParts(message);
}

// ─── ReasoningBlock ──────────────────────────────────────────────────────────

interface ReasoningBlockProps {
  text: string;
  autoExpand: boolean;
  onContextMenu: (e: MouseEvent) => void;
}

export function ReasoningBlock({ text, autoExpand, onContextMenu }: ReasoningBlockProps) {
  const [open, setOpen] = useState(autoExpand);

  useEffect(() => {
    setOpen(autoExpand);
  }, [autoExpand]);

  const html = open ? renderMarkdown(text) : '';

  return (
    <div
      class={`thinking-block${open ? ' open' : ''}`}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onClick={() => setOpen((v) => !v)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <div class="thinking-block-header">
        <svg class={`thinking-block-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="thinking-block-label">Reasoning</span>
        {!open && (
          <span class="thinking-block-summary">{reasoningSummary(text)}</span>
        )}
      </div>
      {open && (
        <div
          class="thinking-block-body message-body"
          dangerouslySetInnerHTML={{ __html: html }}
          aria-live="polite"
        />
      )}
    </div>
  );
}

// ─── ToolCallCard ────────────────────────────────────────────────────────────

interface ToolCallCardProps {
  toolCall: ToolCall;
  autoExpand: boolean;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
}

interface ToolCallHeaderProps {
  open: boolean;
  name: string;
  status: ToolCall['status'];
  summary: string | null;
  summaryPath?: string;
  onOpenFile: (path: string) => void;
}

function ToolCallHeader({ open, name, status, summary, summaryPath, onOpenFile }: ToolCallHeaderProps) {
  const statusLabel =
    status === 'running' ? 'Running'
    : status === 'failed' ? 'Failed'
    : null;
  const showSummary = !open && !!summary;

  return (
    <div class="tool-call-header">
      <svg class={`thinking-block-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="tool-call-heading">
        <span class={`tool-call-name${showSummary ? ' with-summary' : ''}`}>{name}</span>
        {showSummary && summaryPath ? (
          <button
            type="button"
            class="tool-call-summary tool-call-summary-link"
            title={summaryPath}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenFile(summaryPath);
            }}
          >
            {summary}
          </button>
        ) : showSummary ? <span class="tool-call-summary">{summary}</span> : null}
      </div>
      {statusLabel && <span class={`tool-call-status ${status}`}>{statusLabel}</span>}
    </div>
  );
}

export function ToolCallCard({ toolCall, autoExpand, workingDirectory, onOpenFile, onContextMenu }: ToolCallCardProps) {
  const [open, setOpen] = useState(autoExpand || toolCall.status === 'running');
  const presentation = getToolCallPresentation(toolCall, { workingDirectory });
  const variantClass = presentation.variant ? ` tool-call-variant-${presentation.variant}` : '';

  useEffect(() => {
    setOpen(autoExpand || toolCall.status === 'running');
  }, [autoExpand, toolCall.status]);

  return (
    <div
      class={`tool-call ${toolCall.status}${variantClass}`}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onClick={() => setOpen((v) => !v)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <ToolCallHeader
        open={open}
        name={presentation.name}
        status={toolCall.status}
        summary={presentation.summary}
        summaryPath={presentation.summaryPath}
        onOpenFile={onOpenFile}
      />
      {open && (
        <div class="tool-call-body">
          <div class="tool-call-section">
            <div class="tool-call-section-label">Input</div>
            <pre class="tool-call-pre">{JSON.stringify(toolCall.input, null, 2)}</pre>
          </div>
          {toolCall.result !== undefined && (
            <div class="tool-call-section">
              <div class="tool-call-section-label">Result</div>
              <pre class="tool-call-pre">
                {typeof toolCall.result === 'string'
                  ? toolCall.result
                  : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Subagent types + message conversion ────────────────────────────────────

interface RawContentPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
}

interface RawMessage {
  role: 'user' | 'assistant';
  content: RawContentPart[];
  timestamp?: number;
}

interface SubagentSingleResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: RawMessage[];
  model?: string;
  /** Tool names currently executing inside this subagent run. */
  runningTools?: string[];
}

interface SubagentResult {
  mode: 'single' | 'parallel' | 'chain';
  results: SubagentSingleResult[];
}

function rawMessagesToChatMessages(rawMessages: RawMessage[], idPrefix: string): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];

  // Collect tool results by id for lookup across all user messages
  const toolResultMap = new Map<string, unknown>();
  for (const msg of rawMessages) {
    if (msg.role === 'user') {
      for (const part of msg.content) {
        if (part.type === 'toolResult' && part.id !== undefined) {
          toolResultMap.set(String(part.id), part.result);
        }
      }
    }
  }

  let idx = 0;
  let currentAssistant: ChatMessage | undefined;

  for (const msg of rawMessages) {
    // Skip user messages that are purely tool results
    if (msg.role === 'user' && msg.content.every((p) => p.type === 'toolResult')) {
      continue;
    }

    if (msg.role === 'user') {
      currentAssistant = undefined;
      const text = msg.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n\n');
      chatMessages.push({
        id: `${idPrefix}-${idx++}`,
        role: 'user',
        createdAt: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
        markdown: text,
        status: 'completed',
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const orderedParts: ChatMessagePart[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          appendAssistantTextPart(orderedParts, 'text', part.text ?? '');
          continue;
        }

        if (part.type === 'thinking') {
          appendAssistantTextPart(orderedParts, 'reasoning', part.thinking ?? '');
          continue;
        }

        if (part.type === 'toolCall' && part.id && part.name) {
          upsertAssistantToolPart(orderedParts, {
            id: part.id,
            name: part.name,
            input: part.arguments ?? {},
            result: toolResultMap.get(String(part.id)),
            status: toolResultMap.has(String(part.id)) ? 'completed' : 'running',
          });
        }
      }

      const markdown = textFromMessageParts(orderedParts);
      const thinking = reasoningFromMessageParts(orderedParts);
      const toolCalls = toolCallsFromMessageParts(orderedParts);

      if (currentAssistant) {
        const mergedParts = mergeAssistantParts(assistantPartsFromMessage(currentAssistant), orderedParts);
        currentAssistant.parts = mergedParts;
        currentAssistant.markdown = textFromMessageParts(mergedParts);
        currentAssistant.thinking = reasoningFromMessageParts(mergedParts);
        currentAssistant.toolCalls = toolCallsFromMessageParts(mergedParts);
      } else {
        currentAssistant = {
          id: `${idPrefix}-${idx++}`,
          role: 'assistant',
          createdAt: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
          markdown,
          parts: orderedParts.length > 0 ? orderedParts : undefined,
          thinking,
          status: 'completed',
          toolCalls,
        };
        chatMessages.push(currentAssistant);
      }
    }
  }

  return chatMessages;
}

// ─── SubagentBlock ───────────────────────────────────────────────────────────

interface SubagentBlockProps {
  toolCall: ToolCall;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
}

function SubagentBlock({ toolCall, prefs, workingDirectory, onOpenFile, onContextMenu }: SubagentBlockProps) {
  const [open, setOpen] = useState(prefs.autoExpandToolCalls || toolCall.status === 'running');

  useEffect(() => {
    setOpen(prefs.autoExpandToolCalls || toolCall.status === 'running');
  }, [prefs.autoExpandToolCalls, toolCall.status]);

  // The SDK wraps the tool result in AgentToolResult<SubagentDetails> = { content, details }.
  // Normalise both the nested shape and any legacy flat shape.
  const rawResult = toolCall.result as any;
  const result: SubagentResult | undefined =
    rawResult?.results ? rawResult
    : rawResult?.details?.results ? rawResult.details
    : undefined;

  if (!result?.results) {
    // No partial or final result yet — fall back to generic card
    return (
      <ToolCallCard
        toolCall={toolCall}
        autoExpand={prefs.autoExpandToolCalls}
        workingDirectory={workingDirectory}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
      />
    );
  }

  const agentNames = [...new Set(result.results.map((r) => r.agent))];
  const nameDisplay = agentNames.length === 1 ? agentNames[0] : `${agentNames.length} agents`;
  const multipleResults = result.results.length > 1;
  const summary = summarizeToolCall(toolCall);

  return (
    <div
      class={`tool-call ${toolCall.status}`}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onClick={() => setOpen((v) => !v)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <ToolCallHeader
        open={open}
        name={nameDisplay}
        status={toolCall.status}
        summary={summary}
        onOpenFile={onOpenFile}
      />
      {open && (
        <div class="subagent-messages" onClick={(e) => e.stopPropagation()}>
          {result.results.map((r, i) => {
            const msgs = rawMessagesToChatMessages(r.messages, `${toolCall.id}-${i}`);
            return (
              <div key={i} class={`subagent-result${multipleResults ? ' labeled' : ''}`}>
                {multipleResults && (
                  <div class="subagent-result-label">{r.agent}</div>
                )}
                {r.runningTools && r.runningTools.length > 0 && (
                  <div class="subagent-running-tools">
                    {r.runningTools.map((t, ti) => (
                      <span key={ti} class="subagent-running-tool">{t}…</span>
                    ))}
                  </div>
                )}
                {msgs.map((msg) => (
                  <MessageItem
                    key={msg.id}
                    message={msg}
                    overlayParts={undefined}
                    isStreaming={false}
                    prefs={prefs}
                    readonly
                    workingDirectory={workingDirectory}
                    editingId={null}
                    onEditRequest={() => {}}
                    onEditConfirm={() => {}}
                    onEditCancel={() => {}}
                    onOpenFile={onOpenFile}
                    onContextMenu={() => {}}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── ToolCallItem ─────────────────────────────────────────────────────────────

interface ToolCallItemProps {
  toolCall: ToolCall;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
}

function ToolCallItem({ toolCall, prefs, workingDirectory, onOpenFile, onContextMenu }: ToolCallItemProps) {
  if (toolCall.name === 'subagent') {
    return (
      <SubagentBlock
        toolCall={toolCall}
        prefs={prefs}
        workingDirectory={workingDirectory}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
      />
    );
  }
  return (
    <ToolCallCard
      toolCall={toolCall}
      autoExpand={prefs.autoExpandToolCalls}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={onContextMenu}
    />
  );
}

// ─── InlineEditor ────────────────────────────────────────────────────────────

interface InlineEditorProps {
  initialText: string;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

function InlineEditor({ initialText, onConfirm, onCancel }: InlineEditorProps) {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  const handleInput = useCallback((e: Event) => {
    const el = e.target as HTMLTextAreaElement;
    setText(el.value);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) onConfirm(text);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }, [text, onConfirm, onCancel]);

  return (
    <div class="inline-editor">
      <textarea
        ref={textareaRef}
        class="inline-editor-textarea"
        value={text}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        aria-label="Edit message"
        placeholder="Edit message…"
      />
      <div class="inline-editor-actions">
        <button
          class="action-btn secondary"
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          class="action-btn primary"
          type="button"
          disabled={!text.trim()}
          onClick={() => { if (text.trim()) onConfirm(text); }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ─── MessageItem ─────────────────────────────────────────────────────────────

interface MessageItemProps {
  message: ChatMessage;
  overlayParts?: ChatMessagePart[];
  isStreaming: boolean;
  prefs: ChatPrefs;
  readonly?: boolean;
  workingDirectory: string | null;
  editingId: string | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (type: 'reasoning' | 'toolCalls' | 'message', rawData: string, e: MouseEvent) => void;
}

export function MessageItem({
  message,
  overlayParts,
  isStreaming,
  prefs,
  readonly,
  workingDirectory,
  editingId,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onOpenFile,
  onContextMenu,
}: MessageItemProps) {
  const combinedParts = message.role === 'assistant'
    ? mergeAssistantParts(assistantPartsFromMessage(message), overlayParts)
    : undefined;
  const combinedMarkdown = message.role === 'assistant'
    ? textFromMessageParts(combinedParts)
    : message.markdown;
  const combinedThinking = message.role === 'assistant'
    ? reasoningFromMessageParts(combinedParts) ?? ''
    : message.thinking ?? '';
  const combinedToolCalls = message.role === 'assistant'
    ? toolCallsFromMessageParts(combinedParts)
    : message.toolCalls;
  const isCurrentlyStreaming = isStreaming && ((overlayParts?.length ?? 0) > 0 || message.status === 'streaming');
  const isEditing = editingId === message.id;
  const createdAtLabel = formatTimestamp(message.createdAt);
  const statusLabel =
    isCurrentlyStreaming ? 'Streaming'
    : message.status === 'interrupted' ? 'Interrupted'
    : message.status === 'error' ? 'Error'
    : null;
  const statusTone =
    isCurrentlyStreaming ? 'streaming'
    : message.status === 'interrupted' ? 'interrupted'
    : message.status === 'error' ? 'error'
    : '';

  const html = renderMarkdown(combinedMarkdown);
  const messageRaw = JSON.stringify({
    role: message.role,
    createdAt: message.createdAt,
    status: message.status,
    markdown: combinedMarkdown,
    ...(combinedThinking ? { thinking: combinedThinking } : {}),
    ...(combinedToolCalls?.length ? { toolCalls: combinedToolCalls } : {}),
    ...(combinedParts?.length ? { parts: combinedParts } : {}),
  }, null, 2);

  const isClickableUserMsg = message.role === 'user' && !isEditing && !isCurrentlyStreaming && !readonly;

  return (
    <div
      class={`message role-${message.role}`}
      data-message-id={message.id}
      data-role={message.role}
      onClick={isClickableUserMsg ? () => onEditRequest(message.id) : undefined}
      style={isClickableUserMsg ? { cursor: 'pointer' } : undefined}
      title={isClickableUserMsg ? 'Click to edit' : undefined}
    >
      <div class="message-head">
        <div class="message-head-main">
          {message.role !== 'user' && <span class="message-role">{roleLabel(message.role)}</span>}
          {createdAtLabel && <span class="message-time">{createdAtLabel}</span>}
          {message.role === 'assistant' && !isCurrentlyStreaming && message.durationMs !== undefined && (
            <span class="message-duration">{formatDuration(message.durationMs)}</span>
          )}
        </div>
        <div class="message-head-actions">
          {statusLabel && <span class={`message-status ${statusTone}`}>{statusLabel}</span>}
        </div>
      </div>

      {isEditing ? (
        <InlineEditor
          initialText={message.markdown}
          onConfirm={(text) => onEditConfirm(message.id, text)}
          onCancel={onEditCancel}
        />
      ) : (
        <>
          {message.role === 'assistant' && combinedParts ? (
            combinedParts.map((part, index) => {
              if (part.kind === 'reasoning') {
                return (
                  <ReasoningBlock
                    key={`reasoning-${message.id}-${index}`}
                    text={part.text}
                    autoExpand={prefs.autoExpandReasoning}
                    onContextMenu={(e) => onContextMenu('reasoning', part.text, e)}
                  />
                );
              }

              if (part.kind === 'toolCall') {
                return (
                  <div class="tool-call-list" key={`tool-${part.toolCall.id}-${index}`}>
                    <ToolCallItem
                      toolCall={part.toolCall}
                      prefs={prefs}
                      workingDirectory={workingDirectory}
                      onOpenFile={onOpenFile}
                      onContextMenu={(e) => onContextMenu('toolCalls', JSON.stringify(part.toolCall, null, 2), e)}
                    />
                  </div>
                );
              }

              return (
                <div
                  key={`text-${message.id}-${index}`}
                  class="message-body"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onContextMenu('message', messageRaw, e as unknown as MouseEvent);
                  }}
                />
              );
            })
          ) : (
            <div
              class="message-body"
              dangerouslySetInnerHTML={{ __html: html }}
              onClick={isClickableUserMsg ? (e) => e.stopPropagation() : undefined}
              onContextMenu={message.role === 'assistant' ? (e) => {
                e.preventDefault();
                onContextMenu('message', messageRaw, e as unknown as MouseEvent);
              } : undefined}
            />
          )}

          {isCurrentlyStreaming && <span class="streaming-cursor" aria-hidden="true" />}
        </>
      )}
    </div>
  );
}

// ─── TranscriptView ──────────────────────────────────────────────────────────

interface TranscriptViewProps {
  transcript: ChatMessage[];
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
  onContextMenu: (type: 'reasoning' | 'toolCalls' | 'message', rawData: string, e: MouseEvent) => void;
}

export function TranscriptView({
  transcript,
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
}: TranscriptViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      userScrolledUp.current = !atBottom;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ block: 'end', behavior: busy ? 'auto' : 'smooth' });
    }
  }, [transcript.length, busy, overlay]);

  if (transcript.length === 0 && systemPrompts.length === 0) {
    return (
      <div class="transcript">
        <div class="empty-state">
          <div class="empty-state-title">Start the conversation</div>
          <div class="empty-state-sub">Messages, reasoning, and tool steps will appear here.</div>
        </div>
      </div>
    );
  }

  return (
    <div class="transcript" ref={scrollRef}>
      <SystemPromptMessage prompts={systemPrompts} />
      {transcript.map((msg) => {
        const overlayParts = overlay.partsByMessage.get(msg.id);
        const isStreaming = busy && msg.status === 'streaming';

        return (
          <MessageItem
            key={msg.id}
            message={msg}
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
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

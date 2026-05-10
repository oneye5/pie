/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

import type { ChatMessage, ChatPrefs, ToolCall } from '../../shared/protocol';
import type { Overlay } from './overlay';

// ─── Markdown ────────────────────────────────────────────────────────────────

marked.setOptions({ breaks: true, gfm: true });

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string;
  return DOMPurify.sanitize(raw, { RETURN_DOM: false });
}

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

function reasoningSummary(text: string): string {
  const stripped = text
    .replace(/\*\*?(.*?)\*\*?/g, '$1')   // bold/italic
    .replace(/`{1,3}[^`]*`{1,3}/g, '')    // inline code
    .replace(/#{1,6}\s+/g, '')             // headings
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 80 ? stripped.slice(0, 80) + '...' : stripped;
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

  const html = renderMarkdown(text);

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
  onContextMenu: (e: MouseEvent) => void;
}

export function ToolCallCard({ toolCall, autoExpand, onContextMenu }: ToolCallCardProps) {
  const [open, setOpen] = useState(autoExpand || toolCall.status === 'running');

  useEffect(() => {
    setOpen(autoExpand || toolCall.status === 'running');
  }, [autoExpand, toolCall.status]);

  const statusLabel =
    toolCall.status === 'running' ? 'Running'
    : toolCall.status === 'failed' ? 'Failed'
    : 'Done';

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
      <div class="tool-call-header">
        <svg class={`thinking-block-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tool-call-name">{toolCall.name}</span>
        <span class={`tool-call-status ${toolCall.status}`}>{statusLabel}</span>
      </div>
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
      const textParts = msg.content.filter((p) => p.type === 'text');
      const thinkingParts = msg.content.filter((p) => p.type === 'thinking');
      const toolCallParts = msg.content.filter((p) => p.type === 'toolCall' && p.id && p.name);

      const markdown = textParts.map((p) => p.text ?? '').join('\n\n');
      const thinkingText = thinkingParts.map((p) => p.thinking ?? '').join('\n\n');
      const thinking = thinkingText || undefined;

      const toolCalls: ToolCall[] = toolCallParts.map((p) => ({
        id: p.id!,
        name: p.name!,
        input: p.arguments ?? {},
        result: toolResultMap.get(String(p.id)),
        status: toolResultMap.has(String(p.id)) ? 'completed' : 'running',
      }));

      if (currentAssistant) {
        // Merge continuation turn into existing bubble
        if (thinking) {
          currentAssistant.thinking = currentAssistant.thinking
            ? `${currentAssistant.thinking}\n\n${thinking}`
            : thinking;
        }
        if (markdown) {
          currentAssistant.markdown = currentAssistant.markdown
            ? `${currentAssistant.markdown}\n\n${markdown}`
            : markdown;
        }
        if (toolCalls.length > 0) {
          currentAssistant.toolCalls = [...(currentAssistant.toolCalls ?? []), ...toolCalls];
        }
      } else {
        currentAssistant = {
          id: `${idPrefix}-${idx++}`,
          role: 'assistant',
          createdAt: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
          markdown,
          thinking,
          status: 'completed',
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
  onContextMenu: (e: MouseEvent) => void;
}

function SubagentBlock({ toolCall, prefs, onContextMenu }: SubagentBlockProps) {
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
        onContextMenu={onContextMenu}
      />
    );
  }

  const statusLabel =
    toolCall.status === 'running' ? 'Running'
    : toolCall.status === 'failed' ? 'Failed'
    : 'Done';

  const agentNames = [...new Set(result.results.map((r) => r.agent))];
  const nameDisplay = agentNames.length === 1 ? agentNames[0] : `${agentNames.length} agents`;
  const multipleResults = result.results.length > 1;

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
      <div class="tool-call-header">
        <svg class={`thinking-block-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tool-call-name">{nameDisplay}</span>
        <span class={`tool-call-status ${toolCall.status}`}>{statusLabel}</span>
      </div>
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
                    overlayDelta=""
                    overlayThinking=""
                    isStreaming={false}
                    prefs={prefs}
                    readonly
                    editingId={null}
                    onEditRequest={() => {}}
                    onEditConfirm={() => {}}
                    onEditCancel={() => {}}
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
  onContextMenu: (e: MouseEvent) => void;
}

function ToolCallItem({ toolCall, prefs, onContextMenu }: ToolCallItemProps) {
  if (toolCall.name === 'subagent') {
    return <SubagentBlock toolCall={toolCall} prefs={prefs} onContextMenu={onContextMenu} />;
  }
  return (
    <ToolCallCard
      toolCall={toolCall}
      autoExpand={prefs.autoExpandToolCalls}
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
      const trimmed = text.trim();
      if (trimmed) onConfirm(trimmed);
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
          onClick={() => { const t = text.trim(); if (t) onConfirm(t); }}
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
  overlayDelta: string;
  overlayThinking: string;
  isStreaming: boolean;
  prefs: ChatPrefs;
  readonly?: boolean;
  editingId: string | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onContextMenu: (type: 'reasoning' | 'toolCalls' | 'message', rawData: string, e: MouseEvent) => void;
}

export function MessageItem({
  message,
  overlayDelta,
  overlayThinking,
  isStreaming,
  prefs,
  readonly,
  editingId,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
  onContextMenu,
}: MessageItemProps) {
  const combinedMarkdown = message.markdown + overlayDelta;
  const combinedThinking = (message.thinking ?? '') + overlayThinking;
  const isCurrentlyStreaming = isStreaming && (overlayDelta.length > 0 || message.status === 'streaming');
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
          {combinedThinking && (
            <ReasoningBlock
              text={combinedThinking}
              autoExpand={prefs.autoExpandReasoning}
              onContextMenu={(e) => onContextMenu('reasoning', combinedThinking, e)}
            />
          )}

          {message.toolCalls && message.toolCalls.length > 0 && (
            <div class="tool-call-list">
              {message.toolCalls.map((tc) => (
                <ToolCallItem
                  key={tc.id}
                  toolCall={tc}
                  prefs={prefs}
                  onContextMenu={(e) => onContextMenu('toolCalls', JSON.stringify(tc, null, 2), e)}
                />
              ))}
            </div>
          )}

          <div
            class="message-body"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={isClickableUserMsg ? (e) => e.stopPropagation() : undefined}
            onContextMenu={message.role === 'assistant' ? (e) => {
              e.preventDefault();
              const raw = JSON.stringify({
                role: message.role,
                createdAt: message.createdAt,
                status: message.status,
                markdown: combinedMarkdown,
                ...(combinedThinking ? { thinking: combinedThinking } : {}),
                ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
              }, null, 2);
              onContextMenu('message', raw, e as unknown as MouseEvent);
            } : undefined}
          />

          {isCurrentlyStreaming && <span class="streaming-cursor" aria-hidden="true" />}
        </>
      )}
    </div>
  );
}

// ─── SystemPromptBlock ───────────────────────────────────────────────────────

interface SystemPromptBlockProps {
  text: string;
}

function SystemPromptBlock({ text }: SystemPromptBlockProps) {
  const [open, setOpen] = useState(false);
  const html = renderMarkdown(text);

  return (
    <div class="message role-system">
      <div
        class={`thinking-block${open ? ' open' : ''}`}
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
      >
        <div class="thinking-block-header">
          <svg class={`thinking-block-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="thinking-block-label">System instructions</span>
          {!open && (
            <span class="thinking-block-summary">{reasoningSummary(text)}</span>
          )}
        </div>
        {open && (
          <div
            class="thinking-block-body message-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
}

// ─── TranscriptView ──────────────────────────────────────────────────────────

interface TranscriptViewProps {
  transcript: ChatMessage[];
  busy: boolean;
  overlay: Overlay;
  prefs: ChatPrefs;
  systemPrompt: string | null;
  editingId: string | null;
  onEditRequest: (messageId: string) => void;
  onEditConfirm: (messageId: string, text: string) => void;
  onEditCancel: () => void;
  onContextMenu: (type: 'reasoning' | 'toolCalls' | 'message', rawData: string, e: MouseEvent) => void;
}

export function TranscriptView({
  transcript,
  busy,
  overlay,
  prefs,
  systemPrompt,
  editingId,
  onEditRequest,
  onEditConfirm,
  onEditCancel,
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

  if (transcript.length === 0 && !systemPrompt) {
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
      {systemPrompt && <SystemPromptBlock text={systemPrompt} />}
      {transcript.map((msg) => {
        const overlayDelta = overlay.deltaByMessage.get(msg.id) ?? '';
        const overlayThinking = overlay.thinkingByMessage.get(msg.id) ?? '';
        const isStreaming = busy && msg.status === 'streaming';

        return (
          <MessageItem
            key={msg.id}
            message={msg}
            overlayDelta={overlayDelta}
            overlayThinking={overlayThinking}
            isStreaming={isStreaming}
            prefs={prefs}
            editingId={editingId}
            onEditRequest={onEditRequest}
            onEditConfirm={onEditConfirm}
            onEditCancel={onEditCancel}
            onContextMenu={onContextMenu}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

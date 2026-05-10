/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { SystemPromptEntry } from '../../shared/protocol';
import { renderMarkdown, reasoningSummary } from './markdown';
import {
  estimateSystemPromptTokens,
  formatSystemPromptTokenLabel,
  getSystemPromptTokenEstimateTitle,
} from './system-prompt-tokens';

interface SystemPromptCardProps {
  prompt: SystemPromptEntry;
}

function getCollapsedSummary(prompt: SystemPromptEntry): string {
  const summary = prompt.summary || reasoningSummary(prompt.text);
  if (!summary) {
    return '';
  }

  if (
    (prompt.source === 'provider' && prompt.availability === 'unknown') ||
    (prompt.availability !== 'available' && /^(unknown|unavailable|none configured)$/i.test(summary))
  ) {
    return '';
  }

  return summary;
}

function SystemPromptCard({ prompt }: SystemPromptCardProps) {
  const [open, setOpen] = useState(false);
  const summary = getCollapsedSummary(prompt);
  const html = open ? renderMarkdown(prompt.text) : '';
  const showSummary = !open && !!summary;

  return (
    <div
      class={`tool-call completed system-prompt-card system-prompt-${prompt.availability}`}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((value) => !value); } }}
    >
      <div class="tool-call-header">
        <svg class={`thinking-block-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div class="tool-call-heading system-prompt-heading">
          <span class={`tool-call-name${showSummary ? ' with-summary' : ''}`}>{prompt.title}</span>
          {showSummary && <span class="tool-call-summary system-prompt-summary">{summary}</span>}
        </div>
      </div>
      {open && (
        <div class="tool-call-body">
          <div
            class="message-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}

interface SystemPromptMessageProps {
  prompts: SystemPromptEntry[];
}

export function SystemPromptMessage({ prompts }: SystemPromptMessageProps) {
  if (prompts.length === 0) {
    return null;
  }

  const estimatedTokenCount = estimateSystemPromptTokens(prompts);
  const tokenLabel = estimatedTokenCount > 0
    ? formatSystemPromptTokenLabel(estimatedTokenCount)
    : null;
  const tokenTitle = tokenLabel
    ? getSystemPromptTokenEstimateTitle(prompts)
    : undefined;

  return (
    <div class="message role-assistant system-prompts-message" data-role="assistant">
      <div class="message-head">
        <div class="message-head-main">
          <span class="message-role">PI</span>
          <span class="message-time">System prompts</span>
          {tokenLabel && <span class="message-duration" title={tokenTitle}>{tokenLabel}</span>}
        </div>
      </div>
      <div class="tool-call-list">
        {prompts.map((prompt) => (
          <SystemPromptCard
            key={prompt.source}
            prompt={prompt}
          />
        ))}
      </div>
    </div>
  );
}

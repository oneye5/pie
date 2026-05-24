/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { PruningResult, SystemPromptEntry } from '../../shared/protocol';
import { renderMarkdown, reasoningSummary } from './markdown';
import {
  estimateSystemPromptTokens,
  formatSystemPromptTokenLabel,
  getSystemPromptTokenEstimateTitle,
} from './system-prompt-tokens';
import { ToolCallHeader } from './transcript/tool-call-card';
import { PruningBanner } from './pruning-banner';

interface SystemPromptCardProps {
  prompt: SystemPromptEntry;
}

function ignoreOpenFile(_path: string): void {}

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
      <ToolCallHeader
        open={open}
        name={prompt.title}
        nameTitle={prompt.tooltip ?? prompt.title}
        status="completed"
        summary={showSummary ? summary : null}
        sizeHint={undefined}
        onOpenFile={ignoreOpenFile}
      />
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
  pruningResult?: PruningResult | null;
}

export function SystemPromptMessage({ prompts, pruningResult }: SystemPromptMessageProps) {
  if (prompts.length === 0 && !pruningResult) {
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
    <div
      class="message role-assistant system-prompts-message"
      data-role="assistant"
      data-scroll-anchor-id="system-prompts"
    >
      {pruningResult && (
        <div class="pruning-banner-wrapper">
          <PruningBanner pruningResult={pruningResult} />
        </div>
      )}
      {prompts.length > 0 && (
        <>
          <div class="message-head">
            <div class="message-head-main">
              <span class="message-role">PI</span>
              <span class="message-time">System prompts</span>
              {tokenLabel && <span class="message-duration" title={tokenTitle}>{tokenLabel}</span>}
            </div>
          </div>
          <div class="tool-call-list">
            {prompts.map((prompt, index) => (
              <SystemPromptCard
                key={`${prompt.source}:${prompt.title}:${prompt.summary}:${index}`}
                prompt={prompt}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
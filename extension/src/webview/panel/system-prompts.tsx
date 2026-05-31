/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { SystemPromptEntry } from '../../shared/protocol';
import { renderMarkdown, reasoningSummary } from './markdown';
import { cx } from './utils/cx';
import {
  estimateSystemPromptTokens,
  formatSystemPromptTokenLabel,
  getSystemPromptTokenEstimateTitle,
} from './system-prompt-tokens';
import { MessageHeader } from './transcript/message-header';
import { ToolCallHeader } from './transcript/tool-call-card';

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
      class={cx(
        'cursor-pointer select-none overflow-hidden rounded-lg bg-control/40 transition-colors hover:bg-control-hover',
        'forced-colors:border forced-colors:border-[ButtonText]',
      )}
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
    <div
      class="flex w-auto min-w-0 self-stretch flex-col gap-1.5 rounded-xl border border-border-subtle/50 bg-surface px-3 py-2"
      data-role="assistant"
      data-scroll-anchor-id="system-prompts"
    >
      <MessageHeader
        label="PI"
        timestamp="System prompts"
        duration={tokenLabel}
        durationTitle={tokenTitle}
      />
      <div class="tool-call-list">
        {prompts.map((prompt, index) => (
          <SystemPromptCard
            key={`${prompt.source}:${prompt.title}:${prompt.summary}:${index}`}
            prompt={prompt}
          />
        ))}
      </div>
    </div>
  );
}
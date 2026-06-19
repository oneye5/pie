/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useMemo } from 'preact/hooks';

import type { SystemPromptEntry } from '../../shared/protocol';
import { renderMarkdown, reasoningSummary } from './markdown';
import { cx } from './utils/cx';
import { Disclosure } from './components/disclosure';
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
    <Disclosure
      open={open}
      onToggle={setOpen}
      ariaLabel="Toggle system prompt"
      class="system-prompt-card"
      headerClass="px-2 py-[5px]"
      bodyClass="px-2.5 pb-2.5 pt-1 leading-relaxed text-foreground"
      header={
        <>
          <span class="transcript-header-title-mono min-w-0 flex-1 truncate">{prompt.title}</span>
          {showSummary && (
            <span class="transcript-header-summary-mono min-w-0 max-w-[var(--tool-call-summary-column-width)] flex-[0_1_auto] truncate">{summary}</span>
          )}
        </>
      }
    >
      <div
        class="message-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </Disclosure>
  );
}

interface SystemPromptMessageProps {
  prompts: SystemPromptEntry[];
}

export function SystemPromptMessage({ prompts }: SystemPromptMessageProps) {
  if (prompts.length === 0) {
    return null;
  }

  const [groupOpen, setGroupOpen] = useState(false);

  const estimatedTokenCount = estimateSystemPromptTokens(prompts);
  const tokenLabel = estimatedTokenCount > 0
    ? formatSystemPromptTokenLabel(estimatedTokenCount)
    : null;
  const tokenTitle = tokenLabel
    ? getSystemPromptTokenEstimateTitle(prompts)
    : undefined;

  const label = prompts.length === 1
    ? `1 system prompt`
    : `${prompts.length} system prompts`;

  const collapsedSummary = useMemo(() => {
    const available = prompts.filter((p) => getCollapsedSummary(p));
    if (available.length === 0) return null;
    if (available.length <= 2) {
      return available.map((p) => p.title).join(' · ');
    }
    return `${available[0].title} + ${available.length - 1} more`;
  }, [prompts]);

  return (
    <Disclosure
      open={groupOpen}
      onToggle={setGroupOpen}
      ariaLabel="Toggle system prompts group"
      class="flex w-auto min-w-0 self-stretch flex-col rounded-xl bg-card shadow-sm forced-colors:border forced-colors:border-[ButtonText]"
      headerClass={cx('rounded-xl px-3 py-2', groupOpen && 'bg-control/60')}
      bodyClass="flex flex-col gap-0.5 px-2 pb-2"
      dataAttrs={{ 'data-role': 'system', 'data-scroll-anchor-id': 'system-prompts' }}
      header={
        <>
          <span class="transcript-header-label">{label}</span>
          {!groupOpen && collapsedSummary && (
            <span class="transcript-header-summary min-w-0 truncate">{collapsedSummary}</span>
          )}
          {tokenLabel && (
            <span class="ml-auto flex-none whitespace-nowrap font-mono text-[10px] text-muted/60" title={tokenTitle}>{tokenLabel}</span>
          )}
        </>
      }
    >
      {prompts.map((prompt, index) => (
        <SystemPromptCard
          key={`${prompt.source}:${prompt.title}:${prompt.summary}:${index}`}
          prompt={prompt}
        />
      ))}
    </Disclosure>
  );
}
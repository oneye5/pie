/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { PruningDetails } from '../../../shared/protocol';
import { cx } from '../utils/cx';

interface PruningInlineCardProps {
  details: PruningDetails;
  fallbackText: string;
  createdAt: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function diagnosticText(value: string | undefined, emptyLabel: string): string {
  return value && value.trim().length > 0 ? value : emptyLabel;
}

const detailRowClass = 'grid grid-cols-[minmax(82px,auto)_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 min-w-0 max-[520px]:grid-cols-1';
const detailHintClass = 'text-[10px] font-semibold uppercase tracking-wider text-muted whitespace-nowrap leading-normal';
const detailTextClass = 'text-[11px] leading-snug text-foreground/70 whitespace-normal break-words';
const rawPreClass = 'm-0 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words rounded-sm bg-code px-2 py-1.5 font-mono text-[10.5px] leading-normal text-foreground/80';

export function PruningInlineCard({ details, fallbackText, createdAt }: PruningInlineCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);

  const skillsTotal = details.includedSkills.length + details.excludedSkills.length;
  const toolsTotal = details.includedTools.length + details.excludedTools.length;
  const tokensSaved = (details.skillTokensSaved ?? 0) + (details.toolTokensSaved ?? 0);

  const summaryParts: string[] = [];
  if (skillsTotal > 0) {
    summaryParts.push(`${details.includedSkills.length}/${skillsTotal} skills kept`);
  }
  if (toolsTotal > 0) {
    summaryParts.push(`${details.includedTools.length}/${toolsTotal} tools kept`);
  }
  const summaryCore = summaryParts.join(' · ');
  const tokenSuffix = tokensSaved > 0
    ? `${summaryCore ? ' · ' : ''}~${tokensSaved} tokens saved`
    : '';
  const summary = summaryParts.length || tokensSaved > 0
    ? `${summaryCore}${tokenSuffix}`
    : fallbackText;

  const modeBadge = details.mode === 'shadow' ? ' (shadow)' : details.mode === 'off' ? ' (off)' : '';
  const prepassLabel = details.prepassModel
    ? ` via ${details.prepassModel}${details.prepassLatencyMs != null ? ` ${details.prepassLatencyMs}ms` : ''}`
    : '';
  const timeLabel = formatTime(createdAt);

  return (
    <div
      class="flex w-fit max-w-[88%] min-w-0 flex-col gap-2 self-start rounded-xl rounded-bl-sm bg-card px-3 py-2.5 shadow-sm forced-colors:border forced-colors:border-[ButtonText]"
      data-role="assistant"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 flex-wrap items-center gap-[5px]" title="skill-pruner diagnostics">
          <span class="text-[10px] font-bold uppercase tracking-wider text-muted">PI</span>
          {timeLabel && <span class="text-[11px] text-muted">{timeLabel}</span>}
          <span class="font-mono text-[10px] text-muted/60">
            skill-pruner{modeBadge}{prepassLabel}
          </span>
        </div>
      </div>
      <div class="rounded-lg bg-accent/5 p-2.5 text-xs leading-relaxed">
        <button
          class="flex w-full min-w-0 cursor-pointer select-none items-center gap-2 rounded-sm text-left text-foreground focus-visible:outline-1 focus-visible:outline-accent focus-visible:outline-offset-2"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span class="shrink-0 text-[10px] text-muted" aria-hidden="true">✂</span>
          <span class="min-w-0 flex-1 truncate text-[11px] text-foreground/90">{summary}</span>
          <span class="shrink-0 text-[9px] text-muted" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
        </button>
        {expanded && (
          <div class="mt-1.5 flex flex-col gap-1.5 border-t border-border/60 pt-1.5">
            {details.prepassModel && (
              <div class={detailRowClass}>
                <span class={detailHintClass}>Prepass</span>
                <span class={detailTextClass}>
                  {details.prepassModel}
                  {details.prepassThinkingLevel && details.prepassThinkingLevel !== 'off' ? ` · ${details.prepassThinkingLevel}` : ''}
                  {details.prepassLatencyMs != null ? ` · ${details.prepassLatencyMs}ms` : ''}
                </span>
              </div>
            )}
            <div class={detailRowClass}>
              <span class={detailHintClass}>Skills pruned</span>
              <span class={detailTextClass}>
                {details.excludedSkills.length > 0 ? details.excludedSkills.join(', ') : 'None'}
              </span>
            </div>
            <div class={detailRowClass}>
              <span class={detailHintClass}>Skills kept</span>
              <span class={detailTextClass}>
                {details.includedSkills.length > 0 ? details.includedSkills.join(', ') : 'None'}
              </span>
            </div>
            <div class={detailRowClass}>
              <span class={detailHintClass}>Tools pruned</span>
              <span class={detailTextClass}>
                {details.excludedTools.length > 0 ? details.excludedTools.join(', ') : 'None'}
              </span>
            </div>
            <div class={detailRowClass}>
              <span class={detailHintClass}>Tools kept</span>
              <span class={detailTextClass}>
                {details.includedTools.length > 0 ? details.includedTools.join(', ') : 'None'}
              </span>
            </div>
            {details.prepassFailOpenReason && (
              <div class={detailRowClass}>
                <span class={detailHintClass}>Fail-open reason</span>
                <span class={detailTextClass}>{details.prepassFailOpenReason}</span>
              </div>
            )}
            <div class="mt-1 rounded-sm">
              <button
                class="w-full rounded-sm px-1.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted hover:bg-control-hover focus-visible:outline-1 focus-visible:outline-accent focus-visible:outline-offset-1"
                type="button"
                aria-expanded={rawExpanded}
                onClick={(e) => { e.stopPropagation(); setRawExpanded((v) => !v); }}
              >
                {rawExpanded ? '▲' : '▶'} Prepass LLM output
              </button>
              {rawExpanded && (
                <div class="mt-1.5 flex flex-col gap-2 border-t border-border/60 pt-1.5">
                  <div class="flex flex-col gap-1">
                    <span class={detailHintClass}>System prompt</span>
                    <pre class={rawPreClass}>{diagnosticText(details.prepassSystemPrompt, '∅ No system prompt captured')}</pre>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class={detailHintClass}>User prompt</span>
                    <pre class={rawPreClass}>{diagnosticText(details.prepassUserMessage, '∅ No user prompt captured')}</pre>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class={detailHintClass}>Classification reasoning</span>
                    <pre class={rawPreClass}>{diagnosticText(details.prepassThinking, '∅ No reasoning returned')}</pre>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class={detailHintClass}>Raw LLM output</span>
                    <pre class={rawPreClass}>{diagnosticText(details.prepassResponse, '∅ Empty response')}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function isPruningDetails(value: unknown): value is PruningDetails {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.includedSkills) &&
    Array.isArray(v.excludedSkills) &&
    Array.isArray(v.includedTools) &&
    Array.isArray(v.excludedTools) &&
    typeof v.mode === 'string'
  );
}

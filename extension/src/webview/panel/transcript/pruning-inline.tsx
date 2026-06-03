/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { PruningDetails } from '../../../shared/protocol';
import { PruningDiagnostics } from './pruning-details';

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

export function PruningInlineCard({ details, fallbackText, createdAt }: PruningInlineCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);

  const skillsTotal = details.includedSkills.length + details.excludedSkills.length;
  const toolsTotal = details.includedTools.length + details.excludedTools.length;

  const summaryParts: string[] = [];
  if (skillsTotal > 0) {
    summaryParts.push(`${details.includedSkills.length}/${skillsTotal} skills kept`);
  }
  if (toolsTotal > 0) {
    summaryParts.push(`${details.includedTools.length}/${toolsTotal} tools kept`);
  }
  const summary = summaryParts.length > 0
    ? summaryParts.join(' · ')
    : fallbackText;

  const modeBadge = details.mode === 'shadow' ? ' (shadow)' : details.mode === 'off' ? ' (off)' : '';
  const prepassLabel = details.prepassModel
    ? ` via ${details.prepassModel}${details.prepassLatencyMs != null ? ` ${details.prepassLatencyMs}ms` : ''}`
    : '';
  const timeLabel = formatTime(createdAt);

  return (
    <div
      class="flex w-fit max-w-[88%] min-w-0 flex-col gap-2 self-start rounded-xl bg-card px-3 py-2.5 shadow-sm forced-colors:border forced-colors:border-[ButtonText]"
      data-role="assistant"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 flex-wrap items-center gap-[5px]" title="skill-pruner diagnostics">
          <span class="transcript-header-label">PI</span>
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
          <span class="transcript-header-summary min-w-0 flex-1 truncate">{summary}</span>
          <span class="shrink-0 text-[9px] text-muted" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
        </button>
        {expanded && (
          <PruningDiagnostics
            details={details}
            rawExpanded={rawExpanded}
            onRawToggle={(e) => { e.stopPropagation(); setRawExpanded((v) => !v); }}
            presentation="inline"
          />
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

/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { PruningDetails } from '../../../shared/protocol';

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
    <div class="message role-assistant pruning-inline" data-role="assistant">
      <div class="message-head">
        <div class="message-head-main">
          <span class="message-role">PI</span>
          {timeLabel && <span class="message-time">{timeLabel}</span>}
          <span class="message-duration">skill-pruner{modeBadge}{prepassLabel}</span>
        </div>
      </div>
      <div
        class={`pruning-banner${expanded ? ' pruning-banner-expanded' : ' pruning-banner-collapsed'}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <div class="pruning-banner-summary">
          <span class="pruning-banner-icon" aria-hidden="true">✂</span>
          <span class="pruning-banner-text">{summary}</span>
          <span class="pruning-banner-chevron" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
        </div>
        {expanded && (
          <div class="pruning-banner-detail">
            {details.prepassModel && (
              <div class="pruning-banner-detail-row">
                <span class="pruning-banner-hint">Prepass</span>
                <span class="pruning-banner-detail-text">
                  {details.prepassModel}
                  {details.prepassThinkingLevel && details.prepassThinkingLevel !== 'off' ? ` · ${details.prepassThinkingLevel}` : ''}
                  {details.prepassLatencyMs != null ? ` · ${details.prepassLatencyMs}ms` : ''}
                </span>
              </div>
            )}
            {details.excludedSkills.length > 0 && (
              <div class="pruning-banner-detail-row">
                <span class="pruning-banner-hint">Skills pruned</span>
                <span class="pruning-banner-detail-text">{details.excludedSkills.join(', ')}</span>
              </div>
            )}
            {details.includedSkills.length > 0 && (
              <div class="pruning-banner-detail-row">
                <span class="pruning-banner-hint">Skills kept</span>
                <span class="pruning-banner-detail-text">{details.includedSkills.join(', ')}</span>
              </div>
            )}
            {details.excludedTools.length > 0 && (
              <div class="pruning-banner-detail-row">
                <span class="pruning-banner-hint">Tools pruned</span>
                <span class="pruning-banner-detail-text">{details.excludedTools.join(', ')}</span>
              </div>
            )}
            {details.includedTools.length > 0 && (
              <div class="pruning-banner-detail-row">
                <span class="pruning-banner-hint">Tools kept</span>
                <span class="pruning-banner-detail-text">{details.includedTools.join(', ')}</span>
              </div>
            )}
            {details.prepassResponse && (
              <div class="pruning-banner-prepass-response">
                <span class="pruning-banner-hint">LLM reasoning</span>
                <pre class="pruning-banner-response-text">{details.prepassResponse}</pre>
              </div>
            )}
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

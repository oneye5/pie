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

function diagnosticText(value: string | undefined, emptyLabel: string): string {
  return value && value.trim().length > 0 ? value : emptyLabel;
}

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
    <div class="message role-assistant pruning-inline" data-role="assistant">
      <div class="message-head">
        <div class="message-head-main">
          <span class="message-role">PI</span>
          {timeLabel && <span class="message-time">{timeLabel}</span>}
          <span class="message-duration">
            skill-pruner{modeBadge}{prepassLabel}
          </span>
        </div>
      </div>
      <div class={`pruning-banner${expanded ? ' pruning-banner-expanded' : ' pruning-banner-collapsed'}`}>
        <button
          class="pruning-banner-summary"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span class="pruning-banner-icon" aria-hidden="true">✂</span>
          <span class="pruning-banner-text">{summary}</span>
          <span class="pruning-banner-chevron" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
        </button>
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
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Skills pruned</span>
              <span class="pruning-banner-detail-text">
                {details.excludedSkills.length > 0 ? details.excludedSkills.join(', ') : 'None'}
              </span>
            </div>
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Skills kept</span>
              <span class="pruning-banner-detail-text">
                {details.includedSkills.length > 0 ? details.includedSkills.join(', ') : 'None'}
              </span>
            </div>
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Tools pruned</span>
              <span class="pruning-banner-detail-text">
                {details.excludedTools.length > 0 ? details.excludedTools.join(', ') : 'None'}
              </span>
            </div>
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Tools kept</span>
              <span class="pruning-banner-detail-text">
                {details.includedTools.length > 0 ? details.includedTools.join(', ') : 'None'}
              </span>
            </div>
            {details.prepassFailOpenReason && (
              <div class="pruning-banner-detail-row">
                <span class="pruning-banner-hint">Fail-open reason</span>
                <span class="pruning-banner-detail-text">{details.prepassFailOpenReason}</span>
              </div>
            )}
            <div class="pruning-banner-raw-toggle">
              <button
                class="pruning-banner-raw-toggle-text"
                type="button"
                aria-expanded={rawExpanded}
                onClick={(e) => { e.stopPropagation(); setRawExpanded((v) => !v); }}
              >
                {rawExpanded ? '▲' : '▶'} Prepass LLM output
              </button>
              {rawExpanded && (
                <div class="pruning-banner-raw-content">
                  <div class="pruning-banner-raw-section">
                    <span class="pruning-banner-hint">System prompt</span>
                    <pre class="pruning-banner-raw-pre">{diagnosticText(details.prepassSystemPrompt, '∅ No system prompt captured')}</pre>
                  </div>
                  <div class="pruning-banner-raw-section">
                    <span class="pruning-banner-hint">User prompt</span>
                    <pre class="pruning-banner-raw-pre">{diagnosticText(details.prepassUserMessage, '∅ No user prompt captured')}</pre>
                  </div>
                  <div class="pruning-banner-raw-section">
                    <span class="pruning-banner-hint">Classification reasoning</span>
                    <pre class="pruning-banner-raw-pre">{diagnosticText(details.prepassThinking, '∅ No reasoning returned')}</pre>
                  </div>
                  <div class="pruning-banner-raw-section">
                    <span class="pruning-banner-hint">Raw LLM output</span>
                    <pre class="pruning-banner-raw-pre">{diagnosticText(details.prepassResponse, '∅ Empty response')}</pre>
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

/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

import type { PruningDetails } from '../../../shared/protocol';
import { AGENT_ACTIVITY_LABELS } from './activity';
import { AgentActivityLabel } from './activity-label';
import { formatPruningSummary, pruningTotals, type PruningHeaderState } from './pruning';

interface PruningHeaderChipProps {
  state: PruningHeaderState;
  expanded: boolean;
  onToggle: (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
}

interface PruningHeaderButtonProps {
  details: PruningDetails;
  expanded: boolean;
  fallbackText?: string;
  onToggle: (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
}

interface PruningHeaderPanelProps {
  details: PruningDetails;
  rawExpanded: boolean;
  onRawToggle: (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
}

function diagnosticText(value: string | undefined, emptyLabel: string): string {
  return value && value.trim().length > 0 ? value : emptyLabel;
}

function listText(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'None';
}

function modeLabel(mode: PruningDetails['mode']): string {
  switch (mode) {
    case 'shadow':
      return 'Shadow (measured only)';
    case 'off':
      return 'Off';
    case 'auto':
    default:
      return 'Auto';
  }
}

function tokenBreakdown(details: PruningDetails): string | null {
  const skillTokens = details.skillTokensSaved ?? 0;
  const toolTokens = details.toolTokensSaved ?? 0;
  const total = skillTokens + toolTokens;
  if (total <= 0) return null;

  const parts: string[] = [];
  if (skillTokens > 0) parts.push(`skills ~${skillTokens} tokens`);
  if (toolTokens > 0) parts.push(`tools ~${toolTokens} tokens`);
  parts.push(`total ~${total} tokens`);
  return parts.join(' · ');
}

function prepassLabel(details: PruningDetails): string | null {
  const parts: string[] = [];
  if (details.prepassModel) parts.push(details.prepassModel);
  if (details.prepassThinkingLevel && details.prepassThinkingLevel !== 'off') {
    parts.push(details.prepassThinkingLevel);
  }
  if (details.prepassLatencyMs != null) {
    parts.push(`${details.prepassLatencyMs}ms`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function PruningHeaderChip({ state, expanded, onToggle }: PruningHeaderChipProps) {
  if (state.kind === 'pending') {
    const label = state.label.trim().length > 0 ? state.label : AGENT_ACTIVITY_LABELS.pruning;

    return (
      <div
        class="assistant-pruning-chip pending"
        role="status"
        aria-live="polite"
        aria-label={label}
        title={label}
      >
        <span class="assistant-pruning-chip-text">
          <AgentActivityLabel label={label} />
        </span>
      </div>
    );
  }

  return (
    <PruningHeaderButton
      details={state.details}
      expanded={expanded}
      fallbackText={state.fallbackText}
      onToggle={onToggle}
    />
  );
}

export function PruningHeaderButton({ details, expanded, fallbackText, onToggle }: PruningHeaderButtonProps) {
  const summary = formatPruningSummary(details, fallbackText);
  const failed = !!details.prepassError;

  return (
    <button
      class={`assistant-pruning-chip${expanded ? ' open' : ''}${failed ? ' error' : ''}`}
      type="button"
      aria-expanded={expanded}
      aria-label={failed ? `Pruning failed: ${details.prepassError}` : summary}
      title={failed && details.prepassError ? details.prepassError : summary}
      onClick={onToggle}
    >
      {failed && <span class="assistant-pruning-chip-icon" aria-hidden="true">⚠</span>}
      <span class="assistant-pruning-chip-text">{summary}</span>
      <span class="assistant-pruning-chip-chevron" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
    </button>
  );
}

export function PruningHeaderPanel({ details, rawExpanded, onRawToggle }: PruningHeaderPanelProps) {
  const failed = !!details.prepassError;
  const totals = pruningTotals(details);
  const savedText = tokenBreakdown(details);
  const prepass = prepassLabel(details);

  return (
    <div
      class={`assistant-pruning-panel${failed ? ' error' : ''}`}
      role="region"
      aria-label="Pruning details"
    >
      <div class="pruning-banner-detail">
        {failed && (
          <div class="pruning-banner-detail-row">
            <span class="pruning-banner-hint">Error</span>
            <span class="pruning-banner-detail-text pruning-banner-error-text">{details.prepassError}</span>
          </div>
        )}
        {prepass && (
          <div class="pruning-banner-detail-row">
            <span class="pruning-banner-hint">Prepass</span>
            <span class="pruning-banner-detail-text">{prepass}</span>
          </div>
        )}
        <div class="pruning-banner-detail-row">
          <span class="pruning-banner-hint">Mode</span>
          <span class="pruning-banner-detail-text">{modeLabel(details.mode)}</span>
        </div>
        {savedText && (
          <div class="pruning-banner-detail-row">
            <span class="pruning-banner-hint">Saved</span>
            <span class="pruning-banner-detail-text">{savedText}</span>
          </div>
        )}
        {(totals.skillsTotal > 0 || details.excludedSkills.length > 0) && (
          <>
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Skills pruned</span>
              <span class="pruning-banner-detail-text">{listText(details.excludedSkills)}</span>
            </div>
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Skills kept</span>
              <span class="pruning-banner-detail-text">{listText(details.includedSkills)}</span>
            </div>
          </>
        )}
        {(totals.toolsTotal > 0 || details.excludedTools.length > 0) && (
          <>
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Tools pruned</span>
              <span class="pruning-banner-detail-text">{listText(details.excludedTools)}</span>
            </div>
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Tools kept</span>
              <span class="pruning-banner-detail-text">{listText(details.includedTools)}</span>
            </div>
          </>
        )}
        {details.prepassFailOpenReason && (
          <div class="pruning-banner-detail-row">
            <span class="pruning-banner-hint">Fail-open</span>
            <span class="pruning-banner-detail-text">{details.prepassFailOpenReason}</span>
          </div>
        )}
        <div class="pruning-banner-detail-row">
          <span class="pruning-banner-hint">Reasoning</span>
          <pre class="assistant-pruning-reasoning">{diagnosticText(details.prepassThinking, '∅ No reasoning returned')}</pre>
        </div>
        <div class="pruning-banner-raw-toggle">
          <button
            class="pruning-banner-raw-toggle-text"
            type="button"
            aria-expanded={rawExpanded}
            onClick={onRawToggle}
          >
            {rawExpanded ? '▲' : '▶'} Prepass prompts and output
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
                <span class="pruning-banner-hint">Raw LLM output</span>
                <pre class="pruning-banner-raw-pre">{diagnosticText(details.prepassResponse, '∅ Empty response')}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

import type { PruningDetails } from '../../../shared/protocol';
import { cx } from '../utils/cx';
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

const detailListClass = 'flex flex-col gap-1.5';
const detailRowClass = 'grid grid-cols-[minmax(82px,auto)_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 min-w-0 max-[520px]:grid-cols-1';
const detailHintClass = 'text-[10px] font-semibold uppercase tracking-wider text-muted whitespace-nowrap leading-normal';
const detailTextClass = 'text-[11px] leading-snug text-foreground/70 whitespace-normal break-words';
const rawPreClass = 'm-0 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words rounded-sm bg-code px-2 py-1.5 font-mono text-[10.5px] leading-normal text-foreground/80';

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
        class="inline-flex h-[18px] max-w-full items-center gap-1.5 rounded-full border border-transparent bg-control px-2 font-mono text-[10px] font-bold uppercase tracking-wider text-muted"
        role="status"
        aria-live="polite"
        aria-label={label}
        title={label}
      >
        <span class="min-w-0 truncate">
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
      class={cx(
        'inline-flex h-[18px] max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-transparent bg-control px-2 font-mono text-[10px] font-bold uppercase tracking-wider text-muted transition-colors duration-150',
        'hover:border-border-subtle hover:bg-control-hover hover:text-foreground',
        'focus-visible:outline-1 focus-visible:outline-accent focus-visible:outline-offset-2',
        expanded && 'border-accent/25 bg-accent/10 text-accent',
        failed && 'border-danger/25 bg-danger/10 text-danger',
      )}
      type="button"
      aria-expanded={expanded}
      aria-label={failed ? `Pruning failed: ${details.prepassError}` : summary}
      title={failed && details.prepassError ? details.prepassError : summary}
      onClick={onToggle}
    >
      {failed && <span aria-hidden="true">⚠</span>}
      <span class="max-w-[30ch] min-w-0 truncate">{summary}</span>
      <span class="shrink-0 text-[9px] opacity-70" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
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
      class={cx(
        'mt-2 rounded-lg bg-control/50 p-3 text-xs leading-relaxed',
        failed && 'border border-danger/15 bg-danger/5',
      )}
      role="region"
      aria-label="Pruning details"
    >
      <div class={detailListClass}>
        {failed && (
          <div class={detailRowClass}>
            <span class={detailHintClass}>Error</span>
            <span class="text-[11px] leading-snug text-danger whitespace-normal break-words">{details.prepassError}</span>
          </div>
        )}
        {prepass && (
          <div class={detailRowClass}>
            <span class={detailHintClass}>Prepass</span>
            <span class={detailTextClass}>{prepass}</span>
          </div>
        )}
        <div class={detailRowClass}>
          <span class={detailHintClass}>Mode</span>
          <span class={detailTextClass}>{modeLabel(details.mode)}</span>
        </div>
        {savedText && (
          <div class={detailRowClass}>
            <span class={detailHintClass}>Saved</span>
            <span class={detailTextClass}>{savedText}</span>
          </div>
        )}
        {(totals.skillsTotal > 0 || details.excludedSkills.length > 0) && (
          <>
            <div class={detailRowClass}>
              <span class={detailHintClass}>Skills pruned</span>
              <span class={detailTextClass}>{listText(details.excludedSkills)}</span>
            </div>
            <div class={detailRowClass}>
              <span class={detailHintClass}>Skills kept</span>
              <span class={detailTextClass}>{listText(details.includedSkills)}</span>
            </div>
          </>
        )}
        {(totals.toolsTotal > 0 || details.excludedTools.length > 0) && (
          <>
            <div class={detailRowClass}>
              <span class={detailHintClass}>Tools pruned</span>
              <span class={detailTextClass}>{listText(details.excludedTools)}</span>
            </div>
            <div class={detailRowClass}>
              <span class={detailHintClass}>Tools kept</span>
              <span class={detailTextClass}>{listText(details.includedTools)}</span>
            </div>
          </>
        )}
        {details.prepassFailOpenReason && (
          <div class={detailRowClass}>
            <span class={detailHintClass}>Fail-open</span>
            <span class={detailTextClass}>{details.prepassFailOpenReason}</span>
          </div>
        )}
        <div class={detailRowClass}>
          <span class={detailHintClass}>Reasoning</span>
          <pre class="mt-1 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-code p-2 font-mono text-[10.5px] leading-snug text-foreground/80">{diagnosticText(details.prepassThinking, '∅ No reasoning returned')}</pre>
        </div>
        <div class="mt-1 rounded-sm">
          <button
            class="w-full rounded-sm px-1.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted hover:bg-control-hover focus-visible:outline-1 focus-visible:outline-accent focus-visible:outline-offset-1"
            type="button"
            aria-expanded={rawExpanded}
            onClick={onRawToggle}
          >
            {rawExpanded ? '▲' : '▶'} Prepass prompts and output
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
                <span class={detailHintClass}>Raw LLM output</span>
                <pre class={rawPreClass}>{diagnosticText(details.prepassResponse, '∅ Empty response')}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

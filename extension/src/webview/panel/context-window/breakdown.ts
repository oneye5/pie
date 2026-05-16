import type {
  ChatMessage,
  ContextWindowUsage,
  SystemPromptEntry,
  ToolCall,
} from '../../../shared/protocol';
import { estimateTextTokens } from '../system-prompt-tokens';

const readableTokenFormatter = new Intl.NumberFormat('en-US');
const MAX_TOOLTIP_ENTRIES = 6;

export type ContextWindowBreakdownKind = 'exact' | 'estimated' | 'derived' | 'unknown';

export interface ContextWindowBreakdownEntry {
  key: string;
  /** Display label shown in the tooltip. Falls back to `key` when absent. */
  label?: string;
  value: string;
  kind: ContextWindowBreakdownKind;
  /** Subtitle text (file path, message preview) or explanatory note rendered below the row. */
  note?: string;
}

export interface ContextWindowSummary {
  usedTokens: number | null;
  usedKind: ContextWindowBreakdownKind;
  remainingTokens: number | null;
  remainingKind: ContextWindowBreakdownKind;
  totalWindow: number;
}

export interface ContextWindowBreakdown {
  /** Top contributor rows, sorted largest first. */
  entries: readonly ContextWindowBreakdownEntry[];
  /** Window summary rows (used / remaining / total). */
  footerEntries: readonly ContextWindowBreakdownEntry[];
  /** Structured summary used by the context badge/indicator. */
  summary: ContextWindowSummary;
  notes: readonly string[];
  title: string;
}

interface BuildContextWindowBreakdownOptions {
  contextUsage: ContextWindowUsage | null;
  effectiveContextWindow: number;
  systemPrompts: readonly SystemPromptEntry[];
  transcript: readonly ChatMessage[];
  isPartial: boolean;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function formatTokenCount(tokens: number): string {
  return readableTokenFormatter.format(tokens);
}

function formatTokenValue(tokens: number | null, kind: ContextWindowBreakdownKind): string {
  if (tokens === null) return 'unknown';
  const formatted = formatTokenCount(tokens);
  if (kind === 'estimated') return tokens === 0 ? '0' : `~${formatted}`;
  return formatted;
}

function formatTooltipEntry(entry: ContextWindowBreakdownEntry): string {
  const label = entry.label ?? entry.key;
  const kindSuffix = entry.kind === 'estimated'
    ? ' estimated'
    : entry.kind === 'derived'
      ? ' derived'
      : '';
  const line = `${label}: ${entry.value}${kindSuffix}`;
  return entry.note ? `${line} - ${entry.note}` : line;
}

function buildTooltipText(
  entries: readonly ContextWindowBreakdownEntry[],
  footerEntries: readonly ContextWindowBreakdownEntry[],
  notes: readonly string[],
): string {
  const lines = ['Context window usage'];
  const visibleEntries = entries.slice(0, MAX_TOOLTIP_ENTRIES);
  const hiddenEntryCount = entries.length - visibleEntries.length;

  for (const entry of footerEntries) {
    lines.push(formatTooltipEntry(entry));
  }

  if (visibleEntries.length > 0) {
    lines.push('', 'Breakdown:');
    for (const entry of visibleEntries) {
      lines.push(formatTooltipEntry(entry));
    }
    if (hiddenEntryCount > 0) {
      lines.push(`... ${hiddenEntryCount} more rows omitted.`);
    }
  }

  if (notes.length > 0) {
    lines.push('');
    for (const note of notes) {
      lines.push(`Note: ${note}`);
    }
  }

  return lines.join('\n');
}

function estimateSerializedTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateTextTokens(value);
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return estimateTextTokens(String(value));
  }
}

function estimateToolCallTokens(toolCall: ToolCall): number {
  return estimateTextTokens(toolCall.name)
    + estimateSerializedTokens(toolCall.input)
    + estimateSerializedTokens(toolCall.result);
}

function extractToolCallFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['filePath', 'path', 'fileUri']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }
  return undefined;
}

function extractSkillName(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i);
  return match?.[1] ?? null;
}

interface ContributorItem {
  label: string;
  note?: string;
  tokens: number;
  originalIndex: number;
}

function buildContributors(
  systemPrompts: readonly SystemPromptEntry[],
  transcript: readonly ChatMessage[],
): { items: ContributorItem[]; otherEstimated: number } {
  const items: ContributorItem[] = [];
  let otherEstimated = 0;
  let index = 0;

  // System prompts — combine all available prompt cards into one entry.
  const systemPromptTokens = systemPrompts.reduce((total, prompt) => {
    if (prompt.availability !== 'available') {
      return total;
    }

    return total + estimateTextTokens(prompt.text);
  }, 0);
  if (systemPromptTokens > 0) {
    items.push({ label: 'System prompt', tokens: systemPromptTokens, originalIndex: index++ });
  }

  // Transcript messages.
  for (const message of transcript) {
    if (message.role === 'user') {
      const tokens = estimateTextTokens(message.markdown);
      const raw = message.markdown.replace(/\n+/g, ' ').trim();
      const note = raw.length > 0
        ? truncateText(raw, 60)
        : undefined;
      items.push({ label: 'User message', note, tokens, originalIndex: index++ });
    } else if (message.role === 'assistant') {
      // Assistant prose and reasoning go to "other".
      otherEstimated += estimateTextTokens(message.markdown);
      otherEstimated += estimateTextTokens(message.thinking ?? '');

      for (const toolCall of message.toolCalls ?? []) {
        const toolName = toolCall.name.toLowerCase().trim();
        if (toolName === 'read_file' || toolName === 'read') {
          const path = extractToolCallFilePath(toolCall.input);
          if (path) {
            const skillName = extractSkillName(path);
            if (skillName) {
              items.push({ label: 'Skill', note: skillName, tokens: estimateToolCallTokens(toolCall), originalIndex: index++ });
            } else {
              items.push({
                label: 'Read file',
                note: truncateText(path.replace(/\\/g, '/'), 72),
                tokens: estimateToolCallTokens(toolCall),
                originalIndex: index++,
              });
            }
          } else {
            otherEstimated += estimateToolCallTokens(toolCall);
          }
        } else {
          otherEstimated += estimateToolCallTokens(toolCall);
        }
      }
    } else {
      otherEstimated += estimateTextTokens(message.markdown);
    }
  }

  // Sort largest first, using insertion order as a stable tiebreaker.
  items.sort((a, b) => b.tokens - a.tokens || a.originalIndex - b.originalIndex);

  return { items, otherEstimated };
}

export function buildContextWindowBreakdown({
  contextUsage,
  effectiveContextWindow,
  systemPrompts,
  transcript,
  isPartial,
}: BuildContextWindowBreakdownOptions): ContextWindowBreakdown {
  const reportedUsedTokens = contextUsage?.tokens ?? null;
  const totalWindow = contextUsage?.contextWindow ?? effectiveContextWindow;

  const notes: string[] = [];

  if (isPartial) {
    const usedTokens = reportedUsedTokens;
    const usedKind: ContextWindowBreakdownKind = reportedUsedTokens !== null ? 'exact' : 'unknown';
    const remainingTokens =
      totalWindow > 0 && usedTokens !== null
        ? Math.max(totalWindow - usedTokens, 0)
        : null;
    const remainingKind: ContextWindowBreakdownKind =
      totalWindow > 0 && usedTokens !== null
        ? 'exact'
        : 'unknown';

    notes.push('Only a partial transcript window is loaded; contributor rows are hidden to avoid misleading attribution.');
    if (reportedUsedTokens !== null) {
      notes.push('Used tokens come from PI’s live context-window snapshot, not just the loaded transcript window.');
    } else {
      notes.push('Exact used/remaining values are unavailable until PI reports a live context-window snapshot.');
    }

    const summary: ContextWindowSummary = {
      usedTokens,
      usedKind,
      remainingTokens,
      remainingKind,
      totalWindow,
    };

    const footerEntries: ContextWindowBreakdownEntry[] = [
      {
        key: 'window.used',
        label: 'Used',
        value: formatTokenValue(summary.usedTokens, summary.usedKind),
        kind: summary.usedKind,
      },
      {
        key: 'window.remaining',
        label: 'Remaining',
        value: formatTokenValue(summary.remainingTokens, summary.remainingKind),
        kind: summary.remainingKind,
      },
      {
        key: 'window.total',
        label: 'Total',
        value: totalWindow > 0 ? formatTokenValue(totalWindow, 'exact') : 'unknown',
        kind: totalWindow > 0 ? 'exact' : 'unknown',
      },
    ];

    return {
      entries: [],
      footerEntries,
      summary,
      notes,
      title: buildTooltipText([], footerEntries, notes),
    };
  }

  const { items: contributors, otherEstimated } = buildContributors(systemPrompts, transcript);
  const explicitTokens = contributors.reduce((sum, item) => sum + item.tokens, 0);
  const estimatedUsedTokens = explicitTokens + otherEstimated;

  const usedTokens = reportedUsedTokens ?? estimatedUsedTokens;
  const usedKind: ContextWindowBreakdownKind = reportedUsedTokens !== null ? 'exact' : 'estimated';
  const remainingTokens =
    totalWindow > 0
      ? Math.max(totalWindow - usedTokens, 0)
      : null;
  const remainingKind: ContextWindowBreakdownKind =
    totalWindow > 0
      ? (reportedUsedTokens !== null ? 'exact' : 'estimated')
      : 'unknown';

  const otherTokens = reportedUsedTokens !== null
    ? Math.max(reportedUsedTokens - explicitTokens, 0)
    : otherEstimated;
  const otherKind: ContextWindowBreakdownKind = reportedUsedTokens !== null ? 'derived' : 'estimated';
  const otherNote = reportedUsedTokens !== null
    ? 'Unattributed: assistant responses, tool schemas, provider prompt, tokenizer drift.'
    : 'Assistant responses, reasoning, and misc tool calls.';

  const entries: ContextWindowBreakdownEntry[] = [
    ...contributors.map((item, index) => ({
      key: `contributor:${index}`,
      label: item.label,
      value: formatTokenValue(item.tokens, 'estimated'),
      kind: 'estimated' as ContextWindowBreakdownKind,
      note: item.note,
    })),
    {
      key: 'other',
      label: 'Other',
      value: formatTokenValue(otherTokens, otherKind),
      kind: otherKind,
      note: otherNote,
    },
  ];

  const summary: ContextWindowSummary = {
    usedTokens,
    usedKind,
    remainingTokens,
    remainingKind,
    totalWindow,
  };

  const footerEntries: ContextWindowBreakdownEntry[] = [
    {
      key: 'window.used',
      label: 'Used',
      value: formatTokenValue(summary.usedTokens, summary.usedKind),
      kind: summary.usedKind,
    },
    {
      key: 'window.remaining',
      label: 'Remaining',
      value: formatTokenValue(summary.remainingTokens, summary.remainingKind),
      kind: summary.remainingKind,
    },
    {
      key: 'window.total',
      label: 'Total',
      value: totalWindow > 0 ? formatTokenValue(totalWindow, 'exact') : 'unknown',
      kind: totalWindow > 0 ? 'exact' : 'unknown',
    },
  ];

  if (reportedUsedTokens !== null) {
    notes.push('Used tokens come from PI’s live context-window snapshot, not just the next prompt.');
  } else if (totalWindow > 0) {
    notes.push('Used and remaining values are estimated until PI reports a live context-window snapshot.');
  }
  if (entries.some((entry) => entry.kind === 'estimated')) {
    notes.push('Estimated rows use the chars/4 heuristic where exact attribution is unavailable.');
  }
  if (entries.some((entry) => entry.kind === 'derived')) {
    notes.push('Derived rows are the PI-reported remainder after subtracting explicit rows.');
  }

  return {
    entries,
    footerEntries,
    summary,
    notes,
    title: buildTooltipText(entries, footerEntries, notes),
  };
}

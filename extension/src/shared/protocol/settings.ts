import type { ThinkingLevel } from './models.js';
import type { TranscriptWindow } from './sessions.js';

/** Webview-local UI preferences. Owned by the host so they survive teardown. */
/** Metadata describing a known pi extension (tool or hook). */
export interface ExtensionInfo {
  /** Machine-readable extension name (e.g. 'subagent', 'safeguard'). */
  id: string;
  /** Human-readable label shown in the settings UI. */
  label: string;
  /** Short description of what the extension does. */
  description: string;
}

/** Parsed pruning result emitted by the skill-pruner extension. */
export interface PruningResult {
  skillsKept: number;
  skillsTotal: number;
  toolsKept: number;
  toolsTotal: number;
  tokensSaved: number;
  hasSkillPruning: boolean;
  hasToolPruning: boolean;
  /** Legacy convenience aliases retained for older settings/menu call sites. */
  includedSkills?: string[];
  excludedSkills?: string[];
  includedTools?: string[];
  excludedTools?: string[];
  /** Error message if the pruning prepass failed. */
  error?: string;
  /** Full pruning details for expanded view in the banner. */
  details?: PruningDetails;
}

/** Rich details from skill-pruner's pruning-result custom message. */
export interface PruningDetails {
  includedSkills: string[];
  excludedSkills: string[];
  includedTools: string[];
  excludedTools: string[];
  mode: PruningMode;
  skillTokensSaved: number;
  toolTokensSaved: number;
  /** Model used for the prepass LLM call. */
  prepassModel?: string;
  /** Thinking level of the prepass call. */
  prepassThinkingLevel?: string;
  /** User prompt sent to the pruning prepass model. */
  prepassUserMessage?: string;
  /** Reasoning text returned by the pruning prepass model. */
  prepassThinking?: string;
  /** Raw LLM response text (the reasoning/JSON output). */
  prepassResponse?: string;
  /** System prompt sent to the pruning LLM. */
  prepassSystemPrompt?: string;
  /** Latency of the prepass LLM call in milliseconds. */
  prepassLatencyMs?: number;
  /** Error message if pruning prepass failed. */
  prepassError?: string;
  /** Explanation for fail-open behavior when pruning intentionally skipped exclusions. */
  prepassFailOpenReason?: string;
}

export type PruningMode = 'auto' | 'shadow' | 'off' | 'custom';

/** Subset of pruning config exposed in the settings UI. */
export interface PruningSettings {
  mode: PruningMode;
  skillCeiling: number;
  toolCeiling: number;
  /** Skills that should never be pruned. */
  skillAlwaysKeep: string[];
  /** Tools that should never be pruned. */
  toolAlwaysKeep: string[];
  /** Model used for the pruning prepass LLM call. */
  model: string;
  /** Provider for the pruning prepass model. */
  provider: string;
  /** Thinking level for the pruning prepass. */
  thinkingLevel: ThinkingLevel;
  /** Optional timeout override for the pruning prepass, in seconds. */
  prepassTimeoutSec?: number | null;
}

export interface PruningCatalog {
  skills: string[];
  tools: string[];
}

export interface ChatPrefs {
  autoExpandReasoning: boolean;
  autoExpandToolCalls: boolean;
  autoExpandSubagentCalls: boolean;
  suppressCompletionNotifications: boolean;
  showPruningMessages: boolean;
  completionSoundVolume: number;
  /** Per-extension enabled/disabled toggles. Keys are extension IDs. */
  extensionToggles: Record<string, boolean>;
  /** Per-provider enabled/disabled toggles. Keys are provider names. */
  providerToggles: Record<string, boolean>;
}

/** Environment key used to expose pie provider toggles to in-process pi extensions. */
export const PROVIDER_TOGGLES_ENV = 'PIE_PROVIDER_TOGGLES_JSON';

/** Environment key used to expose pie extension toggles to in-process pi extensions. */
export const EXTENSION_TOGGLES_ENV = 'PIE_EXTENSION_TOGGLES_JSON';

export type ActiveRunStatus = 'open' | 'scored' | 'closed_unscored';

export interface ActiveRunSummary {
  runId: string;
  status: ActiveRunStatus;
  scored: boolean;
  /** True when the next send is queued to start a new task group. */
  nextSendStartsNewTask?: boolean;
}

export type RunOutcomeResolution = 'resolved' | 'partially_resolved' | 'unresolved';

export interface RunOutcome {
  resolution: RunOutcomeResolution;
  /** Intended to be a user-facing ordinal score (e.g. 1–5). */
  satisfaction: number;
}

export const DEFAULT_CHAT_PREFS: ChatPrefs = {
  autoExpandReasoning: false,
  autoExpandToolCalls: false,
  autoExpandSubagentCalls: false,
  suppressCompletionNotifications: false,
  showPruningMessages: true,
  completionSoundVolume: 50,
  extensionToggles: {},
  providerToggles: {},
};

export const DEFAULT_PRUNING_SETTINGS: PruningSettings = {
  mode: 'auto',
  skillCeiling: 5,
  toolCeiling: 5,
  skillAlwaysKeep: [],
  toolAlwaysKeep: [],
  model: 'gpt-5.4-mini',
  provider: 'github-copilot',
  thinkingLevel: 'minimal',
  prepassTimeoutSec: null,
};

export const EMPTY_TRANSCRIPT_WINDOW: TranscriptWindow = {
  totalCount: 0,
  loadedStart: 0,
  loadedEnd: 0,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: false,
};

export function resolveChatPrefs(prefs?: Partial<ChatPrefs> | null): ChatPrefs {
  return {
    ...DEFAULT_CHAT_PREFS,
    ...prefs,
    extensionToggles: {
      ...DEFAULT_CHAT_PREFS.extensionToggles,
      ...(prefs?.extensionToggles ?? {}),
    },
    providerToggles: {
      ...DEFAULT_CHAT_PREFS.providerToggles,
      ...(prefs?.providerToggles ?? {}),
    },
    autoExpandSubagentCalls:
      prefs?.autoExpandSubagentCalls
      ?? prefs?.autoExpandToolCalls
      ?? DEFAULT_CHAT_PREFS.autoExpandSubagentCalls,
  };
}

// ─── Extension UI types ──────────────────────────────────────────────────────


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

export type UiDensity = 'compact' | 'comfortable' | 'spacious';

export interface ChatPrefs {
  autoExpandReasoning: boolean;
  autoExpandToolCalls: boolean;
  autoExpandSubagentCalls: boolean;
  suppressCompletionNotifications: boolean;
  showPruningMessages: boolean;
  /** When true, sub-agents always use the parent's active model (skip bucket selection). */
  subagentAlwaysParentModel: boolean;
  completionSoundVolume: number;
  /** Font size (px) for expanded collapsible sections — tool-call bodies,
   *  reasoning, system prompts, pruning raw output, and code blocks. Smaller
   *  than the 13px raw agent output since expanded text is lower priority. */
  expandedSectionFontSize: number;
  /** Override for the sans-serif UI font stack (sets --panel-font-sans).
   *  Empty string falls back to the bundled default (Inter / Segoe UI / system). */
  uiFontSans: string;
  /** Override for the monospace font stack (sets --panel-font-mono), used for
   *  code blocks and tool output. Empty string falls back to the bundled default. */
  uiFontMono: string;
  /** Override for the accent color (sets --panel-accent) as a CSS color string
   *  (e.g. '#d7a942'). Empty string falls back to the bundled default. */
  uiAccentColor: string;
  /** Max width (%) of chat bubbles (sets --message-assistant-width). Also
   *  scales the narrow variant up by 4 points (clamped to 100). The bundled
   *  default is 88. */
  uiMessageWidth: number;
  /** Base background color. Drives the whole --panel-ink ramp that every
   *  surface token (cards, inputs, hover, overlays) derives from. Empty string
   *  falls back to the bundled night palette. */
  uiBackground: string;
  /** Foreground text color (sets --panel-foreground; --panel-foreground-soft
   *  and --panel-muted are derived toward the background). Empty = default. */
  uiForeground: string;
  /** Border color (sets --panel-border; --panel-border-subtle is derived).
   *  Empty = bundled default. */
  uiBorder: string;
  /** Base corner radius in px. Drives the --panel-radius-* scale as r-2 / r /
   *  r+2 / r+4. Default 8 reproduces the bundled 6/8/10/12 ramp. */
  uiCornerRadius: number;
  /** Spacing density. Drives the --panel-gap-* scale. 'comfortable' reproduces
   *  the bundled defaults. */
  uiDensity: UiDensity;
  /** Per-extension enabled/disabled toggles. Keys are extension IDs. */
  extensionToggles: Record<string, boolean>;
  /** Per-provider enabled/disabled toggles. Keys are provider names. */
  providerToggles: Record<string, boolean>;
  /** When true, the file-changes rail auto-opens when the first change is
   *  reported for a session. Reset when the user sends a new message. */
  autoOpenFileChangesRail: boolean;
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
  subagentAlwaysParentModel: false,
  completionSoundVolume: 50,
  expandedSectionFontSize: 12,
  uiFontSans: '',
  uiFontMono: '',
  uiAccentColor: '',
  uiMessageWidth: 88,
  uiBackground: '',
  uiForeground: '',
  uiBorder: '',
  uiCornerRadius: 8,
  uiDensity: 'comfortable',
  extensionToggles: {},
  providerToggles: {},
  autoOpenFileChangesRail: false,
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

/**
 * Pure merge of a partial pruning-settings update into the current settings.
 *
 * Top-level scalars are replaced when present in `updates`; the
 * `skillAlwaysKeep`/`toolAlwaysKeep` arrays are replaced (and copied, so the
 * reducer never aliases the caller's array). `prepassTimeoutSec` uses an
 * explicit `undefined` check so a caller can set it to `null` (clearing the
 * override) rather than omitting it. This must produce the same shape as the
 * disk-write merge in `writePruningSettings` so the reducer's optimistic state
 * matches the persisted state.
 */
export function mergePruningSettings(
  current: PruningSettings,
  updates: Partial<PruningSettings>,
): PruningSettings {
  return {
    mode: updates.mode !== undefined ? updates.mode : current.mode,
    skillCeiling: updates.skillCeiling !== undefined ? updates.skillCeiling : current.skillCeiling,
    toolCeiling: updates.toolCeiling !== undefined ? updates.toolCeiling : current.toolCeiling,
    skillAlwaysKeep:
      updates.skillAlwaysKeep !== undefined ? [...updates.skillAlwaysKeep] : current.skillAlwaysKeep,
    toolAlwaysKeep:
      updates.toolAlwaysKeep !== undefined ? [...updates.toolAlwaysKeep] : current.toolAlwaysKeep,
    model: updates.model !== undefined ? updates.model : current.model,
    provider: updates.provider !== undefined ? updates.provider : current.provider,
    thinkingLevel:
      updates.thinkingLevel !== undefined ? updates.thinkingLevel : current.thinkingLevel,
    prepassTimeoutSec:
      updates.prepassTimeoutSec !== undefined ? updates.prepassTimeoutSec : current.prepassTimeoutSec,
  };
}

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


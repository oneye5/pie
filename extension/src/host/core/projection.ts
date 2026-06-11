/**
 * Pure projection: ArchState → ViewState
 *
 * Derives the webview-visible shape from the CQRS state tree.
 * No memoization here — that's a later optimisation. Every call recomputes
 * from scratch, which is fine for the initial migration.
 */

import type {
  ActiveRunSummary,
  ChatMessage,
  ComposerInput,
  ContextWindowUsage,
  FileChangeEntry,
  ModelInfo,
  PruningCatalog,
  PruningDetails,
  PruningResult,
  SessionSummary,
  SystemPromptEntry,
  TranscriptWindow,
  ViewState,
} from '../../shared/protocol';
import { EMPTY_TRANSCRIPT_WINDOW } from '../../shared/protocol';
import type { ArchState } from './arch-state';

// ─── Empty sentinels (stable references keep downstream shallow-equals cheap) ─

const EMPTY_TRANSCRIPT: ChatMessage[] = [];
const EMPTY_SYSTEM_PROMPTS: SystemPromptEntry[] = [];
const EMPTY_AVAILABLE_MODELS: ModelInfo[] = [];
const EMPTY_COMPOSER_INPUTS: ComposerInput[] = [];
const EMPTY_FILE_CHANGES: FileChangeEntry[] = [];
const EMPTY_PRUNING_CATALOG: PruningCatalog = { skills: [], tools: [] };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sortUniqueNames(names: readonly string[]): string[] {
  return [...new Set(
    names
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  )].sort((a, b) => a.localeCompare(b));
}

function selectActivePruningCatalog(
  activePath: string | null,
  analyticsFactorsBySession: Record<string, import('../../shared/protocol').SessionAnalyticsFactors | null>,
): PruningCatalog {
  if (!activePath) return EMPTY_PRUNING_CATALOG;
  const factors = analyticsFactorsBySession[activePath];
  if (!factors) return EMPTY_PRUNING_CATALOG;

  return {
    skills: sortUniqueNames(
      factors.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => skill.name),
    ),
    tools: sortUniqueNames(factors.selectedToolIds),
  };
}

/**
 * Derive a PruningResult summary from the most recent pruning-result custom
 * message in the transcript. Returns the latest pruning result regardless of
 * which turn it belongs to, so the banner stays visible between turns.
 */
export function derivePruningResult(transcript: ChatMessage[]): PruningResult | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i];
    if (message.customType !== 'pruning-result') continue;

    const details = message.customDetails as PruningDetails | undefined;
    if (!details) continue;

    // Handle error case — details may lack includedSkills when there's an error
    if (details.prepassError) {
      return {
        skillsKept: 0,
        skillsTotal: 0,
        toolsKept: 0,
        toolsTotal: 0,
        tokensSaved: 0,
        hasSkillPruning: false,
        hasToolPruning: false,
        error: details.prepassError,
        details,
      };
    }

    if (!Array.isArray(details.includedSkills)) continue;

    const skillsKept = details.includedSkills.length;
    const skillsTotal = details.includedSkills.length + details.excludedSkills.length;
    const toolsKept = details.includedTools.length;
    const toolsTotal = details.includedTools.length + details.excludedTools.length;
    const tokensSaved = (details.skillTokensSaved ?? 0) + (details.toolTokensSaved ?? 0);

    return {
      skillsKept,
      skillsTotal,
      toolsKept,
      toolsTotal,
      tokensSaved,
      hasSkillPruning: details.excludedSkills.length > 0,
      hasToolPruning: details.excludedTools.length > 0,
      details,
    };
  }
  return null;
}

// ─── Main projection ──────────────────────────────────────────────────────────

/**
 * Project the full CQRS `ArchState` into the `ViewState` consumed by the
 * webview. Pure function — no side effects, no memoization.
 */
export function selectViewState(state: ArchState): ViewState {
  const { sessions, transcript, settings, composer, fileChanges } = state;
  const activePath = sessions.activeSessionPath;

  // ── Active session derived from path + list ──
  const activeSession: SessionSummary | null =
    activePath
      ? sessions.sessions.find((s) => s.path === activePath) ?? null
      : null;

  // ── Per-active-session lookups ──
  const activeTranscript: ChatMessage[] =
    activePath ? transcript.bySession[activePath] ?? EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT;

  const activeTranscriptWindow: TranscriptWindow =
    activePath ? transcript.windowBySession[activePath] ?? EMPTY_TRANSCRIPT_WINDOW : EMPTY_TRANSCRIPT_WINDOW;

  const activeSystemPrompts: SystemPromptEntry[] =
    activePath ? transcript.systemPromptsBySession[activePath] ?? EMPTY_SYSTEM_PROMPTS : EMPTY_SYSTEM_PROMPTS;

  const activeTranscriptLoaded: boolean =
    activePath ? Object.prototype.hasOwnProperty.call(transcript.windowBySession, activePath) : false;

  const activePendingComposerInputs: ComposerInput[] =
    activePath ? composer.pendingComposerInputsBySession[activePath] ?? EMPTY_COMPOSER_INPUTS : EMPTY_COMPOSER_INPUTS;

  const activeRunSummary: ActiveRunSummary | null =
    activePath ? composer.activeRunSummaryBySession[activePath] ?? null : null;

  const activeAvailableModels: ModelInfo[] =
    activePath ? settings.availableModelsBySession[activePath] ?? EMPTY_AVAILABLE_MODELS : EMPTY_AVAILABLE_MODELS;

  const activeContextUsage: ContextWindowUsage | null =
    activePath ? settings.contextUsageBySession[activePath] ?? null : null;

  const activeFileChanges: FileChangeEntry[] =
    activePath ? fileChanges.bySession[activePath] ?? EMPTY_FILE_CHANGES : EMPTY_FILE_CHANGES;

  // ── Derived busy flag ──
  const busy = !!activePath && sessions.runningSessionPaths.includes(activePath);

  // ── Pruning projection ──
  const pruningResult = selectActivePruningResult(state);
  const pruningCatalog = selectActivePruningCatalog(activePath, sessions.analyticsFactorsBySession);

  return {
    sessions: sessions.sessions,
    openTabPaths: sessions.openTabPaths,
    runningSessionPaths: sessions.runningSessionPaths,
    unreadFinishedSessionPaths: sessions.unreadFinishedSessionPaths,
    activeSession,
    transcript: activeTranscript,
    transcriptWindow: activeTranscriptWindow,
    transcriptLoaded: activeTranscriptLoaded,
    pendingComposerInputs: activePendingComposerInputs,
    activeRunSummary,
    runSummariesBySession: composer.activeRunSummaryBySession,
    busy,
    notice: settings.notice,
    backendReady: settings.backendReady,
    workspaceCwd: sessions.workspaceCwd,
    systemPrompts: activeSystemPrompts,
    modelSettings: settings.modelSettings,
    availableModels: activeAvailableModels,
    contextUsage: activeContextUsage,
    prefs: settings.prefs,
    fileChanges: activeFileChanges,
    availableExtensions: settings.availableExtensions,
    pruningResult,
    pruningSettings: settings.pruningSettings,
    pruningCatalog,
    editingMessageId: transcript.editingMessageId,
    showOutcomeDialog: settings.showOutcomeDialog,
    pendingExtensionUIRequestsBySession: settings.pendingExtensionUIRequestsBySession,
    pendingExtensionUIRequest: activePath ? settings.pendingExtensionUIRequestsBySession[activePath] ?? null : null,
  };
}

// ─── Pruning result selector (extracted for readability) ──────────────────────

function selectActivePruningResult(state: ArchState): PruningResult | null {
  if (!state.settings.prefs.showPruningMessages) return null;
  // Hide the pruning banner entirely when the skill-pruner extension is
  // disabled (either via the per-extension toggle or pruning mode = 'off').
  // Stale pruning-result messages from prior runs would otherwise persist.
  if (state.settings.prefs.extensionToggles['skill-pruner'] === false) return null;
  if (state.settings.pruningSettings.mode === 'off') return null;

  const activePath = state.sessions.activeSessionPath;
  const transcript: ChatMessage[] =
    activePath ? state.transcript.bySession[activePath] ?? EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT;

  return derivePruningResult(transcript);
}
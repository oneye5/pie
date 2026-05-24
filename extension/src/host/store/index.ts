import { configureStore, createSelector } from '@reduxjs/toolkit';

import {
  EMPTY_TRANSCRIPT_WINDOW,
  type ActiveRunSummary,
  type ChatMessage,
  type ComposerInput,
  type ContextWindowUsage,
  type ExtensionInfo,
  type FileChangeEntry,
  type ModelInfo,
  type PruningDetails,
  type PruningResult,
  type PruningSettings,
  type SessionSummary,
  type SystemPromptEntry,
  type TranscriptWindow,
  type ViewState,
} from '../../shared/protocol';
import { sessionStateActions, sessionStateReducer } from './session-state-slice';
import { fileChangesActions, fileChangesReducer } from './file-changes-slice';
import { settingsActions, settingsReducer } from './settings-slice';
import { sessionsActions, sessionsReducer } from './sessions-slice';
import { transcriptActions, transcriptReducer } from './transcript-slice';
import { uiActions, uiReducer } from './ui-slice';

// ─── Store ─────────────────────────────────────────────────────────────────────

export function createAppStore() {
  return configureStore({
    reducer: {
      sessions: sessionsReducer,
      transcript: transcriptReducer,
      settings: settingsReducer,
      sessionState: sessionStateReducer,
      ui: uiReducer,
      fileChanges: fileChangesReducer,
    },
  });
}

export const store = createAppStore();

export type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore['getState']>;

// ─── Actions (re-exported) ────────────────────────────────────────────────────

export {
  sessionStateActions,
  settingsActions,
  sessionsActions,
  transcriptActions,
  uiActions,
  fileChangesActions,
};

export function getSessionByPath(
  state: RootState,
  sessionPath: string | null | undefined,
): SessionSummary | null {
  if (!sessionPath) {
    return null;
  }

  return state.sessions.sessions.find((session) => session.path === sessionPath) ?? null;
}

export const selectActiveSessionPath = (state: RootState): string | null =>
  state.sessions.activeSessionPath;

export const selectActiveSession = createSelector(
  [
    (state: RootState) => state.sessions.sessions,
    selectActiveSessionPath,
  ],
  (sessions, activeSessionPath): SessionSummary | null =>
    sessions.find((session) => session.path === activeSessionPath) ?? null,
);

// ─── ViewState selector ───────────────────────────────────────────────────────

const EMPTY_TRANSCRIPT: ChatMessage[] = [];
const EMPTY_SYSTEM_PROMPTS: SystemPromptEntry[] = [];
const EMPTY_AVAILABLE_MODELS: ModelInfo[] = [];
const EMPTY_COMPOSER_INPUTS: ComposerInput[] = [];
const EMPTY_FILE_CHANGES: FileChangeEntry[] = [];
const EMPTY_WINDOW: TranscriptWindow = EMPTY_TRANSCRIPT_WINDOW;

const selectActiveTranscript = (state: RootState): ChatMessage[] => {
  const path = selectActiveSessionPath(state);
  if (!path) return EMPTY_TRANSCRIPT;
  return state.transcript.bySession[path] ?? EMPTY_TRANSCRIPT;
};

const selectActiveSystemPrompts = (state: RootState): SystemPromptEntry[] => {
  const path = selectActiveSessionPath(state);
  if (!path) return EMPTY_SYSTEM_PROMPTS;
  return state.transcript.systemPromptsBySession[path] ?? EMPTY_SYSTEM_PROMPTS;
};

const selectActiveTranscriptWindow = (state: RootState): TranscriptWindow => {
  const path = selectActiveSessionPath(state);
  if (!path) return EMPTY_WINDOW;
  return state.transcript.windowBySession[path] ?? EMPTY_WINDOW;
};

const selectActiveAvailableModels = (state: RootState): ModelInfo[] => {
  const path = selectActiveSessionPath(state);
  if (!path) return EMPTY_AVAILABLE_MODELS;
  return state.settings.availableModelsBySession[path] ?? EMPTY_AVAILABLE_MODELS;
};

const selectActiveContextUsage = (state: RootState): ContextWindowUsage | null => {
  const path = selectActiveSessionPath(state);
  if (!path) return null;
  return state.settings.contextUsageBySession[path] ?? null;
};

const selectActivePendingComposerInputs = (state: RootState): ComposerInput[] => {
  const path = selectActiveSessionPath(state);
  if (!path) return EMPTY_COMPOSER_INPUTS;
  return state.sessionState.pendingComposerInputsBySession[path] ?? EMPTY_COMPOSER_INPUTS;
};

const selectActiveFileChanges = (state: RootState): FileChangeEntry[] => {
  const path = selectActiveSessionPath(state);
  if (!path) return EMPTY_FILE_CHANGES;
  return state.fileChanges.bySession[path] ?? EMPTY_FILE_CHANGES;
};

const selectAvailableExtensions = (state: RootState): ExtensionInfo[] => {
  return state.ui.availableExtensions;
};

const selectActiveRunSummary = (state: RootState): ActiveRunSummary | null => {
  const path = selectActiveSessionPath(state);
  if (!path) return null;
  return state.sessionState.activeRunSummaryBySession[path] ?? null;
};

/**
 * Derive a PruningResult summary from the most recent pruning-result custom
 * message in the transcript. Uses typed `customDetails` (PruningDetails)
 * rather than regex-parsing the markdown.
 */
export function derivePruningResult(transcript: ChatMessage[]): PruningResult | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i];
    if (message.customType !== 'pruning-result') continue;

    const details = message.customDetails as PruningDetails | undefined;
    if (!details || !Array.isArray(details.includedSkills)) continue;

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
    };
  }
  return null;
}

const selectActivePruningResult = (state: RootState): PruningResult | null => {
  if (!state.ui.prefs.showPruningMessages) return null;
  const transcript = selectActiveTranscript(state);
  return derivePruningResult(transcript);
};

/**
 * Memoised view-state projection. Recomputes only when an input slice changes
 * so equality-aware downstream consumers (the snapshot dispatcher) can
 * short-circuit identical renders.
 */
export const selectViewState = createSelector(
  [
    (s: RootState) => s.sessions.sessions,
    (s: RootState) => s.sessions.openTabPaths,
    (s: RootState) => s.sessions.runningSessionPaths,
    (s: RootState) => s.sessions.unreadFinishedSessionPaths,
    selectActiveSessionPath,
    selectActiveSession,
    (s: RootState) => s.sessions.workspaceCwd,
    selectActiveTranscript,
    selectActiveTranscriptWindow,
    selectActivePendingComposerInputs,
    selectActiveRunSummary,
    (s: RootState) => s.sessionState.activeRunSummaryBySession,
    selectActiveSystemPrompts,
    (s: RootState) => s.settings.modelSettings,
    selectActiveAvailableModels,
    selectActiveContextUsage,
    (s: RootState) => s.ui.notice,
    (s: RootState) => s.ui.backendReady,
    (s: RootState) => s.ui.prefs,
    selectActiveFileChanges,
    selectAvailableExtensions,
    selectActivePruningResult,
    (s: RootState) => s.settings.pruningSettings,
    (s: RootState) => s.ui.editingMessageId,
    (s: RootState) => s.ui.showOutcomeDialog,
  ],
  (
    sessions,
    openTabPaths,
    runningSessionPaths,
    unreadFinishedSessionPaths,
    activeSessionPath,
    activeSession,
    workspaceCwd,
    transcript,
    transcriptWindow,
    pendingComposerInputs,
    activeRunSummary,
    runSummariesBySession,
    systemPrompts,
    modelSettings,
    availableModels,
    contextUsage,
    notice,
    backendReady,
    prefs,
    fileChanges,
    availableExtensions,
    pruningResult,
    pruningSettings,
    editingMessageId,
    showOutcomeDialog,
  ): ViewState => {
    const busy = !!activeSessionPath && runningSessionPaths.includes(activeSessionPath);
    return {
      sessions,
      openTabPaths,
      runningSessionPaths,
      unreadFinishedSessionPaths,
      activeSession,
      transcript,
      transcriptWindow,
      pendingComposerInputs,
      activeRunSummary,
      runSummariesBySession,
      busy,
      notice,
      backendReady,
      workspaceCwd,
      systemPrompts,
      modelSettings,
      availableModels,
      contextUsage,
      prefs,
      fileChanges,
      availableExtensions,
      pruningResult,
      pruningSettings,
      editingMessageId,
      showOutcomeDialog,
    };
  },
);

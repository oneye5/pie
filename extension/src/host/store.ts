import { configureStore, createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';

import {
  DEFAULT_CHAT_PREFS,
  type ChatMessage,
  type ChatPrefs,
  type ModelInfo,
  type ModelSettings,
  type SessionSummary,
  type ToolCall,
  type ViewState,
} from '../shared/protocol';

// ─── Sessions slice ───────────────────────────────────────────────────────────

interface SessionsState {
  sessions: SessionSummary[];
  openTabPaths: string[];
  runningSessionPaths: string[];
  activeSessionPath: string | null;
  workspaceCwd: string | null;
}

function removeSessionsMatching(
  state: SessionsState,
  predicate: (session: SessionSummary) => boolean,
): void {
  const removedPaths = new Set(
    state.sessions.filter((session) => predicate(session)).map((session) => session.path),
  );
  if (removedPaths.size === 0) {
    return;
  }

  state.sessions = state.sessions.filter((session) => !removedPaths.has(session.path));
  state.openTabPaths = state.openTabPaths.filter((path) => !removedPaths.has(path));
  state.runningSessionPaths = state.runningSessionPaths.filter((path) => !removedPaths.has(path));
  if (state.activeSessionPath && removedPaths.has(state.activeSessionPath)) {
    state.activeSessionPath = null;
  }
}

/**
 * Merge an existing summary with an incoming one. We preserve a real local name
 * over a backend-emitted placeholder so that "New Session" doesn't clobber a
 * user-meaningful tab label after a list refresh.
 */
function mergeSessionSummary(
  existing: SessionSummary | undefined,
  incoming: SessionSummary,
): SessionSummary {
  if (!existing) return incoming;
  const keepExistingName =
    existing.name !== incoming.name &&
    !existing.isPlaceholder &&
    incoming.isPlaceholder === true;
  return { ...incoming, name: keepExistingName ? existing.name : incoming.name };
}

const sessionsSlice = createSlice({
  name: 'sessions',
  initialState: {
    sessions: [],
    openTabPaths: [],
    runningSessionPaths: [],
    activeSessionPath: null,
    workspaceCwd: null,
  } as SessionsState,
  reducers: {
    setWorkspaceCwd(state, action: PayloadAction<string | null>) {
      state.workspaceCwd = action.payload;
    },
    setOpenTabPaths(state, action: PayloadAction<string[]>) {
      state.openTabPaths = action.payload;
    },
    ensureOpenTab(state, action: PayloadAction<string>) {
      if (!state.openTabPaths.includes(action.payload)) {
        state.openTabPaths = [...state.openTabPaths, action.payload];
      }
    },
    removeOpenTab(state, action: PayloadAction<string>) {
      state.openTabPaths = state.openTabPaths.filter((p) => p !== action.payload);
    },
    replaceOpenTabPath(
      state,
      action: PayloadAction<{ oldPath: string; newPath: string }>,
    ) {
      const { oldPath, newPath } = action.payload;
      state.openTabPaths = state.openTabPaths.map((p) => (p === oldPath ? newPath : p));
    },
    upsertSession(state, action: PayloadAction<SessionSummary>) {
      const incoming = action.payload;
      const idx = state.sessions.findIndex((s) => s.path === incoming.path);
      const existing = idx === -1 ? undefined : state.sessions[idx];
      const merged = mergeSessionSummary(existing, incoming);
      if (idx === -1) {
        state.sessions = [merged, ...state.sessions];
      } else {
        state.sessions[idx] = merged;
      }
    },
    replaceSessionSummaries(state, action: PayloadAction<SessionSummary[]>) {
      const mergedByPath = new Map<string, SessionSummary>();
      for (const incoming of action.payload) {
        const existing = mergedByPath.get(incoming.path) ?? state.sessions.find((s) => s.path === incoming.path);
        mergedByPath.set(incoming.path, mergeSessionSummary(existing, incoming));
      }
      // Keep open-tab sessions not in the incoming list.
      for (const s of state.sessions) {
        if (!mergedByPath.has(s.path) && state.openTabPaths.includes(s.path)) {
          mergedByPath.set(s.path, s);
        }
      }
      // Keep the active session if it's not in the list.
      const activeSession = state.activeSessionPath
        ? state.sessions.find((session) => session.path === state.activeSessionPath)
        : undefined;
      if (activeSession && !mergedByPath.has(activeSession.path)) {
        mergedByPath.set(activeSession.path, activeSession);
      }
      state.sessions = [...mergedByPath.values()];
    },
    removePendingSessions(state) {
      removeSessionsMatching(state, (session) => session.path.startsWith('__pending__:'));
    },
    removeSession(state, action: PayloadAction<string>) {
      removeSessionsMatching(state, (session) => session.path === action.payload);
    },
    setSessionRunning(state, action: PayloadAction<{ sessionPath: string; running: boolean }>) {
      const { sessionPath, running } = action.payload;
      const set = new Set(state.runningSessionPaths);
      running ? set.add(sessionPath) : set.delete(sessionPath);
      state.runningSessionPaths = [...set];
    },
    clearRunningPaths(state) {
      state.runningSessionPaths = [];
    },
    setActiveSessionPath(state, action: PayloadAction<string | null>) {
      state.activeSessionPath = action.payload;
    },
    setActiveSession(state, action: PayloadAction<SessionSummary | null>) {
      state.activeSessionPath = action.payload?.path ?? null;
    },
    clearActiveSession(state) {
      state.activeSessionPath = null;
    },
  },
});

// ─── Transcript slice ─────────────────────────────────────────────────────────

interface TranscriptState {
  /** Per-session transcripts, keyed by session path. */
  bySession: Record<string, ChatMessage[]>;
  /** Per-session system prompts. */
  systemPromptBySession: Record<string, string | null>;
  /** Maps aliased message IDs to canonical IDs (for multi-turn tool-use merging). */
  messageIdAlias: Record<string, string>;
  /** Tracks the first message ID of the active streaming turn per session. */
  currentTurnBySession: Record<string, { requestId: string; firstMessageId: string }>;
}

function resolveAlias(aliasMap: Record<string, string>, messageId: string): string {
  return aliasMap[messageId] ?? messageId;
}

function clearSessionAliases(state: TranscriptState, sessionPath: string): void {
  const sessionMessageIds = new Set<string>();

  for (const message of state.bySession[sessionPath] ?? []) {
    sessionMessageIds.add(message.id);
  }

  const currentTurn = state.currentTurnBySession[sessionPath];
  if (currentTurn) {
    sessionMessageIds.add(currentTurn.firstMessageId);
  }

  if (sessionMessageIds.size === 0) {
    return;
  }

  for (const [aliasId, canonicalId] of Object.entries(state.messageIdAlias)) {
    if (sessionMessageIds.has(aliasId) || sessionMessageIds.has(canonicalId)) {
      delete state.messageIdAlias[aliasId];
    }
  }
}

const transcriptSlice = createSlice({
  name: 'transcript',
  initialState: {
    bySession: {},
    systemPromptBySession: {},
    messageIdAlias: {},
    currentTurnBySession: {},
  } as TranscriptState,
  reducers: {
    setTranscript(
      state,
      action: PayloadAction<{ sessionPath: string; transcript: ChatMessage[]; systemPrompt?: string }>,
    ) {
      clearSessionAliases(state, action.payload.sessionPath);
      state.bySession[action.payload.sessionPath] = action.payload.transcript;
      state.systemPromptBySession[action.payload.sessionPath] =
        action.payload.systemPrompt ?? null;
      delete state.currentTurnBySession[action.payload.sessionPath];
    },
    clearTranscript(state, action: PayloadAction<string>) {
      clearSessionAliases(state, action.payload);
      delete state.bySession[action.payload];
      delete state.systemPromptBySession[action.payload];
      delete state.currentTurnBySession[action.payload];
    },
    clearSessionState(state, action: PayloadAction<string>) {
      clearSessionAliases(state, action.payload);
      delete state.bySession[action.payload];
      delete state.systemPromptBySession[action.payload];
      delete state.currentTurnBySession[action.payload];
    },
    ensureAssistantMessage(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string; requestId?: string }>,
    ) {
      const { sessionPath, messageId, requestId } = action.payload;
      const list = (state.bySession[sessionPath] ??= []);
      if (list.find((m) => m.id === messageId)) return; // already exists

      if (requestId) {
        const currentTurn = state.currentTurnBySession[sessionPath];
        if (currentTurn?.requestId === requestId) {
          // Continuation of the same request — alias to the first message.
          state.messageIdAlias[messageId] = currentTurn.firstMessageId;
          // Prepend separator so the merged content reads naturally.
          const canonical = list.find((m) => m.id === currentTurn.firstMessageId);
          if (canonical) {
            if (canonical.markdown) canonical.markdown += '\n\n';
            if (canonical.thinking) canonical.thinking += '\n\n';
          }
          return;
        }
        state.currentTurnBySession[sessionPath] = { requestId, firstMessageId: messageId };
      }

      list.push({
        id: messageId,
        role: 'assistant',
        createdAt: new Date().toISOString(),
        markdown: '',
        status: 'streaming',
        toolCalls: [],
      });
    },
    appendDelta(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string; delta: string }>,
    ) {
      const { sessionPath, delta } = action.payload;
      const messageId = resolveAlias(state.messageIdAlias, action.payload.messageId);
      const msg = state.bySession[sessionPath]?.find((m) => m.id === messageId);
      if (msg) {
        msg.markdown = (msg.markdown ?? '') + delta;
        msg.status = 'streaming';
      }
    },
    appendThinking(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string; thinking: string }>,
    ) {
      const { sessionPath, thinking } = action.payload;
      const messageId = resolveAlias(state.messageIdAlias, action.payload.messageId);
      const msg = state.bySession[sessionPath]?.find((m) => m.id === messageId);
      if (msg) {
        msg.thinking = (msg.thinking ?? '') + thinking;
        msg.status = 'streaming';
      }
    },
    upsertToolCall(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string; toolCall: ToolCall }>,
    ) {
      const { sessionPath, toolCall } = action.payload;
      const messageId = resolveAlias(state.messageIdAlias, action.payload.messageId);
      const msg = state.bySession[sessionPath]?.find((m) => m.id === messageId);
      if (msg) {
        const existing = msg.toolCalls ?? [];
        const idx = existing.findIndex((tc) => tc.id === toolCall.id);
        if (idx === -1) {
          msg.toolCalls = [...existing, toolCall];
        } else {
          msg.toolCalls = existing.map((tc) => (tc.id === toolCall.id ? toolCall : tc));
        }
      }
    },
    upsertMessage(
      state,
      action: PayloadAction<{ sessionPath: string; message: ChatMessage }>,
    ) {
      const { sessionPath, message } = action.payload;
      const list = (state.bySession[sessionPath] ??= []);
      const canonicalId = resolveAlias(state.messageIdAlias, message.id);

      if (canonicalId !== message.id) {
        // Continuation message — merge only metadata into the canonical bubble.
        // The markdown/thinking text was already accumulated via appendDelta/appendThinking.
        const canonical = list.find((m) => m.id === canonicalId);
        if (canonical) {
          canonical.status = message.status;
          if (message.durationMs !== undefined) {
            canonical.durationMs = (canonical.durationMs ?? 0) + message.durationMs;
          }
          if (message.toolCalls?.length) {
            const existingIds = new Set((canonical.toolCalls ?? []).map((tc) => tc.id));
            const newTcs = message.toolCalls.filter((tc) => !existingIds.has(tc.id));
            if (newTcs.length) canonical.toolCalls = [...(canonical.toolCalls ?? []), ...newTcs];
          }
        }
        return;
      }

      const idx = list.findIndex((m) => m.id === message.id);
      if (idx === -1) {
        list.push(message);
      } else {
        list[idx] = message;
      }
    },
    setMessageStatus(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string; status: ChatMessage['status'] }>,
    ) {
      const { sessionPath, status } = action.payload;
      const messageId = resolveAlias(state.messageIdAlias, action.payload.messageId);
      const msg = state.bySession[sessionPath]?.find((m) => m.id === messageId);
      if (msg) msg.status = status;
    },
    appendLocalUserMessage(
      state,
      action: PayloadAction<{ sessionPath: string; id: string; text: string }>,
    ) {
      const { sessionPath, id, text } = action.payload;
      const list = (state.bySession[sessionPath] ??= []);
      list.push({
        id,
        role: 'user',
        createdAt: new Date().toISOString(),
        markdown: text,
        status: 'completed',
      });
    },
    removeMessage(
      state,
      action: PayloadAction<{ sessionPath: string; messageId: string }>,
    ) {
      const { sessionPath, messageId } = action.payload;
      const list = state.bySession[sessionPath];
      if (!list) {
        return;
      }
      state.bySession[sessionPath] = list.filter((message) => message.id !== messageId);
    },
  },
});

// ─── Settings slice ───────────────────────────────────────────────────────────

interface SettingsState {
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
}

const settingsSlice = createSlice({
  name: 'settings',
  initialState: { modelSettings: null, availableModels: [] } as SettingsState,
  reducers: {
    setModelSettings(state, action: PayloadAction<ModelSettings>) {
      state.modelSettings = action.payload;
    },
    setAvailableModels(state, action: PayloadAction<ModelInfo[]>) {
      if (action.payload.length > 0 || state.availableModels.length === 0) {
        state.availableModels = action.payload;
      }
    },
    setModelAndAvailable(
      state,
      action: PayloadAction<{ modelSettings: ModelSettings; availableModels: ModelInfo[] }>,
    ) {
      state.modelSettings = action.payload.modelSettings;
      if (action.payload.availableModels.length > 0 || state.availableModels.length === 0) {
        state.availableModels = action.payload.availableModels;
      }
    },
  },
});

// ─── UI slice ─────────────────────────────────────────────────────────────────

interface UiState {
  notice: string | null;
  backendReady: boolean;
  prefs: ChatPrefs;
}

const uiSlice = createSlice({
  name: 'ui',
  initialState: { notice: null, backendReady: false, prefs: DEFAULT_CHAT_PREFS } as UiState,
  reducers: {
    setNotice(state, action: PayloadAction<string | null>) {
      state.notice = action.payload;
    },
    setBackendReady(state, action: PayloadAction<boolean>) {
      state.backendReady = action.payload;
    },
    setPrefs(state, action: PayloadAction<Partial<ChatPrefs>>) {
      state.prefs = { ...state.prefs, ...action.payload };
    },
  },
});

// ─── Store ─────────────────────────────────────────────────────────────────────

export function createAppStore() {
  return configureStore({
    reducer: {
      sessions: sessionsSlice.reducer,
      transcript: transcriptSlice.reducer,
      settings: settingsSlice.reducer,
      ui: uiSlice.reducer,
    },
  });
}

export const store = createAppStore();

export type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore['getState']>;

// ─── Actions (re-exported) ────────────────────────────────────────────────────

export const sessionsActions = sessionsSlice.actions;
export const transcriptActions = transcriptSlice.actions;
export const settingsActions = settingsSlice.actions;
export const uiActions = uiSlice.actions;

/** Resolves a message ID through the alias map (for multi-turn tool-use merging). */
export function getCanonicalMessageId(messageId: string, state: RootState): string {
  return state.transcript.messageIdAlias[messageId] ?? messageId;
}

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

const selectActiveTranscript = (state: RootState): ChatMessage[] => {
  const path = selectActiveSessionPath(state);
  if (!path) return EMPTY_TRANSCRIPT;
  return state.transcript.bySession[path] ?? EMPTY_TRANSCRIPT;
};

const selectActiveSystemPrompt = (state: RootState): string | null => {
  const path = selectActiveSessionPath(state);
  if (!path) return null;
  return state.transcript.systemPromptBySession[path] ?? null;
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
    selectActiveSessionPath,
    selectActiveSession,
    (s: RootState) => s.sessions.workspaceCwd,
    selectActiveTranscript,
    selectActiveSystemPrompt,
    (s: RootState) => s.settings.modelSettings,
    (s: RootState) => s.settings.availableModels,
    (s: RootState) => s.ui.notice,
    (s: RootState) => s.ui.backendReady,
    (s: RootState) => s.ui.prefs,
  ],
  (
    sessions,
    openTabPaths,
    runningSessionPaths,
    activeSessionPath,
    activeSession,
    workspaceCwd,
    transcript,
    systemPrompt,
    modelSettings,
    availableModels,
    notice,
    backendReady,
    prefs,
  ): ViewState => {
    const busy = !!activeSessionPath && runningSessionPaths.includes(activeSessionPath);
    return {
      sessions,
      openTabPaths,
      runningSessionPaths,
      activeSession,
      transcript,
      busy,
      notice,
      backendReady,
      workspaceCwd,
      systemPrompt,
      modelSettings,
      availableModels,
      prefs,
    };
  },
);

import type {
  ChatMessage,
  ComposerInput,
  SessionSummary,
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getQueryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

export function applyTheme(rawTheme: string | null | undefined): void {
  const theme = rawTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function transcriptWindowFor(transcript: ChatMessage[], previous: ViewState['transcriptWindow']): ViewState['transcriptWindow'] {
  return {
    ...previous,
    totalCount: transcript.length,
    loadedEnd: transcript.length,
    hasUserMessages: transcript.some((message) => message.role === 'user'),
  };
}

export function activeSessionWithCount(state: ViewState, messageCount: number): SessionSummary | null {
  if (!state.activeSession) {
    return null;
  }

  return {
    ...state.activeSession,
    modifiedAt: new Date().toISOString(),
    messageCount,
  };
}

export function updateActiveSessionSummary(state: ViewState, nextActiveSession: SessionSummary | null): ViewState {
  if (!nextActiveSession) {
    return { ...state, activeSession: null };
  }

  return {
    ...state,
    activeSession: nextActiveSession,
    sessions: state.sessions.map((session) => (
      session.path === nextActiveSession.path ? nextActiveSession : session
    )),
  };
}

export function appendMessages(state: ViewState, messages: ChatMessage[]): ViewState {
  const transcript = [...state.transcript, ...messages];
  return updateActiveSessionSummary({
    ...state,
    transcript,
    transcriptWindow: transcriptWindowFor(transcript, state.transcriptWindow),
  }, activeSessionWithCount(state, transcript.length));
}

export function createAssistantResponse(text: string, status: ChatMessage['status'] = 'completed'): ChatMessage {
  return {
    id: createId('dev-assistant'),
    role: 'assistant',
    createdAt: new Date().toISOString(),
    markdown: text,
    parts: [{ kind: 'text', text }],
    modelId: 'gpt-5.4-mini',
    thinkingLevel: 'medium',
    status,
  };
}

export interface DevHostActions {
  mutate: (updater: (current: ViewState) => ViewState) => void;
  addComposerInput: (input: ComposerInput) => void;
  publishState: () => void;
}

function handleSend(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'send' }>): void {
  const text = msg.text || '(sent attachments)';
  const userMessage: ChatMessage = {
    id: msg.localId ?? createId('dev-user'),
    role: 'user',
    createdAt: new Date().toISOString(),
    markdown: text,
    status: 'completed',
  };
  const assistantMessage = createAssistantResponse('Browser dev host is simulating a response so layout changes can be inspected quickly.', 'streaming');

  actions.mutate((current) => ({
    ...appendMessages(current, [userMessage, assistantMessage]),
    busy: true,
    runningSessionPaths: msg.sessionPath ? [msg.sessionPath] : current.runningSessionPaths,
    pendingComposerInputs: [],
  }));

  window.setTimeout(() => {
    actions.mutate((current) => {
      const transcript = current.transcript.map((message) => (
        message.id === assistantMessage.id
          ? {
              ...message,
              markdown: 'Browser dev host response complete. Try `?state=long`, `?state=attachments`, or `?state=error` for other UI stress cases.',
              parts: [{ kind: 'text' as const, text: 'Browser dev host response complete. Try `?state=long`, `?state=attachments`, or `?state=error` for other UI stress cases.' }],
              status: 'completed' as const,
              durationMs: 850,
            }
          : message
      ));

      return {
        ...updateActiveSessionSummary({
          ...current,
          transcript,
          transcriptWindow: transcriptWindowFor(transcript, current.transcriptWindow),
        }, activeSessionWithCount(current, transcript.length)),
        busy: false,
        runningSessionPaths: [],
      };
    });
  }, 850);
}

function handleInterrupt(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'interrupt' }>): void {
  actions.mutate((current) => ({
    ...current,
    busy: false,
    runningSessionPaths: current.runningSessionPaths.filter((path) => path !== msg.sessionPath),
    transcript: current.transcript.map((message, index) => (
      index === current.transcript.length - 1 && message.role === 'assistant' && message.status === 'streaming'
        ? { ...message, status: 'interrupted' as const }
        : message
    )),
  }));
}

function handleOpenFilePicker(actions: DevHostActions): void {
  actions.addComposerInput({
    id: createId('input-path'),
    kind: 'filesystemPathRef',
    path: '/workspace/pi-config/docs/model-token-pricing-implementation-plan.md',
    name: 'model-token-pricing-implementation-plan.md',
    source: 'picker',
  });
}

function handleAddComposerInput(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'addComposerInput' }>): void {
  actions.addComposerInput({ ...msg.input, id: createId('input') } as ComposerInput);
}

function handleRemoveComposerInput(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'removeComposerInput' }>): void {
  actions.mutate((current) => ({
    ...current,
    pendingComposerInputs: current.pendingComposerInputs.filter((input) => input.id !== msg.inputId),
  }));
}

function handleOpenSession(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'openSession' }>): void {
  actions.mutate((current) => ({
    ...current,
    activeSession: current.sessions.find((session) => session.path === msg.sessionPath) ?? current.activeSession,
    openTabPaths: current.openTabPaths.includes(msg.sessionPath)
      ? current.openTabPaths
      : [...current.openTabPaths, msg.sessionPath],
  }));
}

function handleNewSession(actions: DevHostActions): void {
  const path = `/workspace/.pie/sessions/browser-dev-${Date.now()}.jsonl`;
  const session: SessionSummary = {
    path,
    name: 'Browser dev session',
    cwd: '/workspace/pi-config',
    modifiedAt: new Date().toISOString(),
    messageCount: 0,
    modelId: 'gpt-5.4-mini',
    thinkingLevel: 'medium',
  };
  actions.mutate((current) => ({
    ...current,
    sessions: [session, ...current.sessions],
    openTabPaths: [path, ...current.openTabPaths],
    activeSession: session,
    transcript: [],
    transcriptWindow: transcriptWindowFor([], current.transcriptWindow),
    transcriptLoaded: true,
  }));
}

function handleCloseSession(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'closeSession' }>): void {
  actions.mutate((current) => {
    const openTabPaths = current.openTabPaths.filter((path) => path !== msg.sessionPath);
    const activeSession = current.activeSession?.path === msg.sessionPath
      ? current.sessions.find((session) => session.path === openTabPaths[0]) ?? null
      : current.activeSession;
    return { ...current, openTabPaths, activeSession };
  });
}

function handleDuplicateSession(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'duplicateSession' }>): void {
  actions.mutate((current) => {
    const source = current.sessions.find((session) => session.path === msg.sessionPath);
    if (!source) return current;
    const duplicate = { ...source, path: `${source.path}.copy-${Date.now()}`, name: `${source.name} copy` };
    return {
      ...current,
      sessions: [duplicate, ...current.sessions],
      openTabPaths: [duplicate.path, ...current.openTabPaths],
      activeSession: duplicate,
    };
  });
}

function handleMoveSessionTab(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'moveSessionTab' }>): void {
  actions.mutate((current) => {
    const openTabPaths = [...current.openTabPaths];
    const [moved] = openTabPaths.splice(msg.fromIndex, 1);
    if (!moved) return current;
    openTabPaths.splice(msg.toIndex, 0, moved);
    return { ...current, openTabPaths };
  });
}

function handleSetModel(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'setModel' }>): void {
  actions.mutate((current) => updateActiveSessionSummary(current, current.activeSession
    ? { ...current.activeSession, modelId: msg.defaultModel, thinkingLevel: msg.defaultThinkingLevel }
    : null));
}

function handleSetPrefs(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'setPrefs' }>): void {
  actions.mutate((current) => ({
    ...current,
    prefs: {
      ...current.prefs,
      ...msg.prefs,
      extensionToggles: { ...current.prefs.extensionToggles, ...(msg.prefs.extensionToggles ?? {}) },
      providerToggles: { ...current.prefs.providerToggles, ...(msg.prefs.providerToggles ?? {}) },
    },
  }));
}

function handleSetPruningSettings(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'setPruningSettings' }>): void {
  actions.mutate((current) => ({
    ...current,
    pruningSettings: { ...current.pruningSettings, ...msg.settings },
  }));
}

function handleStartEdit(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'startEdit' }>): void {
  actions.mutate((current) => ({ ...current, editingMessageId: msg.messageId }));
}

function handleCancelEdit(actions: DevHostActions): void {
  actions.mutate((current) => ({ ...current, editingMessageId: null }));
}

function handleEditMessage(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'editMessage' }>): void {
  actions.mutate((current) => ({
    ...current,
    editingMessageId: null,
    transcript: current.transcript.map((message) => (
      message.id === msg.messageId ? { ...message, markdown: msg.text } : message
    )),
  }));
}

function handleDismissNotice(actions: DevHostActions): void {
  actions.mutate((current) => ({ ...current, notice: null }));
}

function handleOpenOutcomeDialog(actions: DevHostActions): void {
  actions.mutate((current) => ({ ...current, showOutcomeDialog: true }));
}

function handleCloseOutcomeDialog(actions: DevHostActions): void {
  actions.mutate((current) => ({ ...current, showOutcomeDialog: false }));
}

function handleRecordOutcome(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'recordOutcome' }>): void {
  actions.mutate((current) => ({
    ...current,
    showOutcomeDialog: false,
    notice: `Recorded ${msg.outcome.resolution} with satisfaction ${msg.outcome.satisfaction}.`,
  }));
}

function handleOpenFile(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'openFile' | 'openFileDiff' }>): void {
  actions.mutate((current) => ({ ...current, notice: `Browser dev host would open ${'filePath' in msg ? msg.filePath : msg.path}.` }));
}

function handleRevertFile(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'revertFile' }>): void {
  actions.mutate((current) => ({
    ...current,
    fileChanges: current.fileChanges.filter((change) => change.path !== msg.filePath),
    notice: `Browser dev host reverted ${msg.filePath}.`,
  }));
}

function handleExtensionUiResponse(actions: DevHostActions, msg: Extract<WebviewToHostMessage, { type: 'extensionUiResponse' }>): void {
  actions.mutate((current) => ({
    ...current,
    pendingExtensionUIRequest: null,
    notice: `Extension UI response captured for ${msg.response.id}.`,
  }));
}

const messageDispatch: Record<string, (actions: DevHostActions, msg: WebviewToHostMessage) => void> = {
  ready: (actions) => actions.publishState(),
  refreshState: (actions) => actions.publishState(),
  requestSnapshot: (actions) => actions.publishState(),
  send: (actions, msg) => handleSend(actions, msg as Extract<WebviewToHostMessage, { type: 'send' }>),
  interrupt: (actions, msg) => handleInterrupt(actions, msg as Extract<WebviewToHostMessage, { type: 'interrupt' }>),
  openFilePicker: (actions) => handleOpenFilePicker(actions),
  addComposerInput: (actions, msg) => handleAddComposerInput(actions, msg as Extract<WebviewToHostMessage, { type: 'addComposerInput' }>),
  removeComposerInput: (actions, msg) => handleRemoveComposerInput(actions, msg as Extract<WebviewToHostMessage, { type: 'removeComposerInput' }>),
  openSession: (actions, msg) => handleOpenSession(actions, msg as Extract<WebviewToHostMessage, { type: 'openSession' }>),
  newSession: (actions) => handleNewSession(actions),
  closeSession: (actions, msg) => handleCloseSession(actions, msg as Extract<WebviewToHostMessage, { type: 'closeSession' }>),
  duplicateSession: (actions, msg) => handleDuplicateSession(actions, msg as Extract<WebviewToHostMessage, { type: 'duplicateSession' }>),
  moveSessionTab: (actions, msg) => handleMoveSessionTab(actions, msg as Extract<WebviewToHostMessage, { type: 'moveSessionTab' }>),
  setModel: (actions, msg) => handleSetModel(actions, msg as Extract<WebviewToHostMessage, { type: 'setModel' }>),
  setPrefs: (actions, msg) => handleSetPrefs(actions, msg as Extract<WebviewToHostMessage, { type: 'setPrefs' }>),
  setPruningSettings: (actions, msg) => handleSetPruningSettings(actions, msg as Extract<WebviewToHostMessage, { type: 'setPruningSettings' }>),
  startEdit: (actions, msg) => handleStartEdit(actions, msg as Extract<WebviewToHostMessage, { type: 'startEdit' }>),
  cancelEdit: (actions) => handleCancelEdit(actions),
  editMessage: (actions, msg) => handleEditMessage(actions, msg as Extract<WebviewToHostMessage, { type: 'editMessage' }>),
  dismissNotice: (actions) => handleDismissNotice(actions),
  openOutcomeDialog: (actions) => handleOpenOutcomeDialog(actions),
  closeOutcomeDialog: (actions) => handleCloseOutcomeDialog(actions),
  recordOutcome: (actions, msg) => handleRecordOutcome(actions, msg as Extract<WebviewToHostMessage, { type: 'recordOutcome' }>),
  openFile: (actions, msg) => handleOpenFile(actions, msg as Extract<WebviewToHostMessage, { type: 'openFile' }>),
  openFileDiff: (actions, msg) => handleOpenFile(actions, msg as Extract<WebviewToHostMessage, { type: 'openFileDiff' }>),
  revertFile: (actions, msg) => handleRevertFile(actions, msg as Extract<WebviewToHostMessage, { type: 'revertFile' }>),
  extensionUiResponse: (actions, msg) => handleExtensionUiResponse(actions, msg as Extract<WebviewToHostMessage, { type: 'extensionUiResponse' }>),
};

export function dispatchMessage(actions: DevHostActions, msg: WebviewToHostMessage): void {
  console.info('[pie webview dev]', msg);
  const handler = messageDispatch[msg.type];
  if (handler) {
    handler(actions, msg);
  }
}

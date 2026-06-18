import { useCallback } from 'preact/hooks';
import type {
  ChatPrefs,
  ComposerInputDraft,
  PruningSettings,
  RunOutcome,
  ThinkingLevel,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { createLocalMessageId } from '../../shared/local-message-id';
import type { TranscriptContextMenuType } from './chat-prefs';
import type { ContextMenuState } from './components/context-menu';
import type { SessionTabRunAction } from './session-tabs/run-state';

export interface AppHandlers {
  handleSend: (text: string) => void;
  handleInterrupt: () => void;
  handleOpenFilePicker: () => void;
  handleOpenFile: (path: string) => void;
  handleNewSession: () => void;
  handleCloseTab: (path: string) => void;
  handleDuplicateTab: (path: string) => void;
  handleMarkComplete: () => void;
  handleCancelOutcome: () => void;
  handleCancelEdit: () => void;
  handleSetPrefs: (partial: Partial<ChatPrefs>) => void;
  handleSetPruningSettings: (partial: Partial<PruningSettings>) => void;
  handleEditRequest: (messageId: string) => void;
  handleAddComposerInput: (input: ComposerInputDraft) => void;
  handleRemoveComposerInput: (inputId: string) => void;
  handleSelectTab: (path: string) => void;
  handleMoveTab: (sessionPath: string | undefined, fromIndex: number, toIndex: number) => void;
  handleRecordOutcome: (outcome: RunOutcome) => void;
  handleTabRunAction: (action: SessionTabRunAction, tabPath: string) => void;
  handleModelChange: (model: string, thinkingLevel: ThinkingLevel) => void;
  handleEditSend: (messageId: string, text: string) => void;
  handleOpenFileDiff: (filePath: string) => void;
  handleOpenFileInEditor: (filePath: string) => void;
  handleRevertFile: (filePath: string) => void;
  handleOpenContextMenu: (type: TranscriptContextMenuType, rawData: string, e: MouseEvent) => void;
}

export function useAppHandlers(
  postMessage: (msg: WebviewToHostMessage) => void,
  activeSessionPathRef: { current: string | null },
  setDraftRestore: (value: null) => void,
  addOptimisticMessage: (msg: { localId: string; text: string; sessionPath: string }) => void,
  setContextMenu: (state: ContextMenuState | null) => void,
): AppHandlers {
  const handleSend = useCallback((text: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    setDraftRestore(null);

    const localId = createLocalMessageId();
    addOptimisticMessage({ localId, text, sessionPath });

    postMessage({ type: 'send', sessionPath, text, localId });
  }, [postMessage, activeSessionPathRef, setDraftRestore, addOptimisticMessage]);

  const handleInterrupt = useCallback(() => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'interrupt', sessionPath });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenFilePicker = useCallback(() => postMessage({ type: 'openFilePicker' }), [postMessage]);
  const handleOpenFile = useCallback((path: string) => postMessage({ type: 'openFile', path }), [postMessage]);
  const handleNewSession = useCallback(() => postMessage({ type: 'newSession' }), [postMessage]);
  const handleCloseTab = useCallback((path: string) => postMessage({ type: 'closeSession', sessionPath: path }), [postMessage]);
  const handleDuplicateTab = useCallback((path: string) => postMessage({ type: 'duplicateSession', sessionPath: path }), [postMessage]);
  const handleMarkComplete = useCallback(() => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'openOutcomeDialog', sessionPath });
  }, [postMessage, activeSessionPathRef]);
  const handleCancelOutcome = useCallback(() => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'closeOutcomeDialog', sessionPath });
  }, [postMessage, activeSessionPathRef]);
  const handleCancelEdit = useCallback(() => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'cancelEdit', sessionPath });
  }, [postMessage, activeSessionPathRef]);
  const handleSetPrefs = useCallback((partial: Partial<ChatPrefs>) => postMessage({ type: 'setPrefs', prefs: partial }), [postMessage]);
  const handleSetPruningSettings = useCallback((partial: Partial<PruningSettings>) => postMessage({ type: 'setPruningSettings', settings: partial }), [postMessage]);
  const handleEditRequest = useCallback((messageId: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'startEdit', sessionPath, messageId });
  }, [postMessage, activeSessionPathRef]);

  const handleAddComposerInput = useCallback((input: ComposerInputDraft) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'addComposerInput', sessionPath, input });
  }, [postMessage, activeSessionPathRef]);

  const handleRemoveComposerInput = useCallback((inputId: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'removeComposerInput', sessionPath, inputId });
  }, [postMessage, activeSessionPathRef]);

  const handleSelectTab = useCallback((path: string) => {
    activeSessionPathRef.current = path;
    postMessage({ type: 'openSession', sessionPath: path });
  }, [postMessage, activeSessionPathRef]);

  const handleMoveTab = useCallback((sessionPath: string | undefined, fromIndex: number, toIndex: number) => {
    postMessage({ type: 'moveSessionTab', sessionPath, fromIndex, toIndex });
  }, [postMessage]);

  const handleRecordOutcome = useCallback((outcome: RunOutcome) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'recordOutcome', sessionPath, outcome });
    // Close the outcome dialog before closing the session: closeSession may
    // null/swap the active session and unmount the dialog before
    // closeOutcomeDialog is applied, which can briefly re-render the dialog
    // against a different session.
    postMessage({ type: 'closeOutcomeDialog', sessionPath });
    postMessage({ type: 'closeSession', sessionPath });
  }, [postMessage, activeSessionPathRef]);

  // Tab context-menu task actions. The outcome dialog renders against the
  // active session, so selecting the tab first ensures the dialog (and any
  // follow-up) targets the session the user right-clicked.
  const handleTabRunAction = useCallback((action: SessionTabRunAction, tabPath: string) => {
    activeSessionPathRef.current = tabPath;
    postMessage({ type: 'openSession', sessionPath: tabPath });
    if (action === 'recordOutcome') {
      postMessage({ type: 'openOutcomeDialog', sessionPath: tabPath });
    } else if (action === 'startNewTask') {
      postMessage({ type: 'startNewTask', sessionPath: tabPath });
    } else if (action === 'continueTask') {
      postMessage({ type: 'continueTask', sessionPath: tabPath });
    }
  }, [postMessage, activeSessionPathRef]);

  const handleModelChange = useCallback((model: string, thinkingLevel: ThinkingLevel) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'setModel', sessionPath, defaultModel: model, defaultThinkingLevel: thinkingLevel });
  }, [postMessage, activeSessionPathRef]);

  const handleEditSend = useCallback((messageId: string, text: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    const localId = createLocalMessageId('edit');
    postMessage({ type: 'editMessage', sessionPath, messageId, text, localId });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenFileDiff = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'openFileDiff', sessionPath, filePath });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenFileInEditor = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'openFileInEditor', sessionPath, filePath });
  }, [postMessage, activeSessionPathRef]);

  const handleRevertFile = useCallback((filePath: string) => {
    const sessionPath = activeSessionPathRef.current;
    if (!sessionPath) return;
    postMessage({ type: 'revertFile', sessionPath, filePath });
  }, [postMessage, activeSessionPathRef]);

  const handleOpenContextMenu = useCallback((type: TranscriptContextMenuType, rawData: string, e: MouseEvent) => {
    setContextMenu({ type, rawData, x: e.clientX, y: e.clientY });
  }, [setContextMenu]);

  return {
    handleSend,
    handleInterrupt,
    handleOpenFilePicker,
    handleOpenFile,
    handleNewSession,
    handleCloseTab,
    handleDuplicateTab,
    handleMarkComplete,
    handleCancelOutcome,
    handleCancelEdit,
    handleSetPrefs,
    handleSetPruningSettings,
    handleEditRequest,
    handleAddComposerInput,
    handleRemoveComposerInput,
    handleSelectTab,
    handleMoveTab,
    handleRecordOutcome,
    handleTabRunAction,
    handleModelChange,
    handleEditSend,
    handleOpenFileDiff,
    handleOpenFileInEditor,
    handleRevertFile,
    handleOpenContextMenu,
  };
}

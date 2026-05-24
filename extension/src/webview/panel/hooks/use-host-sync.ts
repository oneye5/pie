/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

import type {
  HostToWebviewMessage,
  ViewState,
  WebviewToHostMessage,
} from '../../../shared/protocol';
import { DEFAULT_CHAT_PREFS, EMPTY_TRANSCRIPT_WINDOW } from '../../../shared/protocol';

export const EMPTY_VIEW_STATE: ViewState = {
  sessions: [],
  openTabPaths: [],
  runningSessionPaths: [],
  unreadFinishedSessionPaths: [],
  activeSession: null,
  transcript: [],
  transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
  pendingComposerInputs: [],
  activeRunSummary: null,
  runSummariesBySession: {},
  busy: false,
  notice: null,
  backendReady: false,
  workspaceCwd: null,
  systemPrompts: [],
  modelSettings: null,
  availableModels: [],
  contextUsage: null,
  prefs: { ...DEFAULT_CHAT_PREFS },
  availableExtensions: [],
  fileChanges: [],
  pruningResult: null,
  pruningSettings: { mode: 'auto', skillCeiling: 5, toolCeiling: 5 },
  editingMessageId: null,
  showOutcomeDialog: false,
};

const RATE_WINDOW_SECONDS = 10;

export interface HostSyncState {
  viewState: ViewState;
  draftRestore: { text: string; nonce: number } | null;
  tokenRateState: { tokensPerSecond: number | null; windowSeconds: number };
  activeSessionPathRef: { current: string | null };
  setDraftRestore: (v: { text: string; nonce: number } | null) => void;
}

/**
 * Encapsulates protocol-sync and transport bookkeeping between the webview and
 * host. This state is webview-local per the STATE_CONTRACT allowlist.
 */
export function useHostSync(
  postMessage: (msg: WebviewToHostMessage) => void,
  initialState?: ViewState,
): HostSyncState {
  const [viewState, setViewState] = useState<ViewState>(initialState ?? EMPTY_VIEW_STATE);
  const [draftRestore, setDraftRestore] = useState<{ text: string; nonce: number } | null>(null);

  const revisionMapRef = useRef<Map<string, number>>(new Map());
  const tokenRateRef = useRef<{ tokens: number; timestamp: number }[]>([]);
  const [tokenRateState, setTokenRateState] = useState<{ tokensPerSecond: number | null; windowSeconds: number }>({
    tokensPerSecond: null,
    windowSeconds: RATE_WINDOW_SECONDS,
  });

  const awaitingSnapshotRef = useRef(false);
  const hostInstanceIdRef = useRef('');
  const activeSessionPathRef = useRef<string | null>(null);
  const committedSessionPathRef = useRef<string | null>(null);
  const pendingDraftRestoreRef = useRef(new Map<string, { text: string }>());

  const clearTransientUi = useCallback(() => {
    setDraftRestore(null);
  }, []);

  const resetPerSessionState = useCallback(() => {
    revisionMapRef.current.clear();
  }, []);

  useEffect(() => {
    return () => resetPerSessionState();
  }, [resetPerSessionState]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data as HostToWebviewMessage;

      if (msg.type === 'state') {
        resetPerSessionState();
        const hostChanged = hostInstanceIdRef.current && msg.hostInstanceId !== hostInstanceIdRef.current;
        const nextActiveSessionPath = msg.state.activeSession?.path ?? null;
        const sessionChanged = committedSessionPathRef.current !== null && committedSessionPathRef.current !== nextActiveSessionPath;
        const queuedDraftRestore = nextActiveSessionPath
          ? pendingDraftRestoreRef.current.get(nextActiveSessionPath) ?? null
          : null;

        awaitingSnapshotRef.current = false;
        hostInstanceIdRef.current = msg.hostInstanceId;
        activeSessionPathRef.current = nextActiveSessionPath;
        committedSessionPathRef.current = nextActiveSessionPath;
        if (hostChanged || sessionChanged) {
          clearTransientUi();
          tokenRateRef.current = [];
          setTokenRateState({ tokensPerSecond: null, windowSeconds: RATE_WINDOW_SECONDS });
        }
        if (queuedDraftRestore && nextActiveSessionPath) {
          pendingDraftRestoreRef.current.delete(nextActiveSessionPath);
          setDraftRestore({ text: queuedDraftRestore.text, nonce: Date.now() });
        }
        setViewState(msg.state);
        return;
      }

      if (msg.type === 'sendRejected') {
        if (msg.sessionPath === activeSessionPathRef.current) {
          setDraftRestore({ text: msg.text, nonce: Date.now() });
        } else {
          pendingDraftRestoreRef.current.set(msg.sessionPath, { text: msg.text });
        }
      }
    };

    window.addEventListener('message', handleMessage);
    postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handleMessage);
  }, [clearTransientUi, postMessage, resetPerSessionState]);

  useEffect(() => {
    const refreshState = () => postMessage({ type: 'refreshState' });
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshState();
      }
    };

    window.addEventListener('focus', refreshState);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', refreshState);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [postMessage]);

  // Suppress unused refs (they participate in the transport protocol but
  // aren't surfaced to the caller yet — will be needed for token-rate).
  void awaitingSnapshotRef;
  void tokenRateRef;

  return { viewState, draftRestore, tokenRateState, activeSessionPathRef, setDraftRestore };
}

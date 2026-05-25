/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';

import type {
  ChatMessage,
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
  pruningSettings: { mode: 'auto', skillCeiling: 5, toolCeiling: 5, model: 'gpt-5.4-mini', provider: 'github-copilot', thinkingLevel: 'minimal' },
  editingMessageId: null,
  showOutcomeDialog: false,
  pendingExtensionUIRequest: null,
};

const RATE_WINDOW_SECONDS = 10;

/** An optimistic user message shown instantly before the host confirms it. */
export interface OptimisticUserMessage {
  localId: string;
  text: string;
  sessionPath: string;
}

export interface HostSyncState {
  viewState: ViewState;
  /** Transcript with optimistic user messages merged in. */
  mergedTranscript: ChatMessage[];
  draftRestore: { text: string; nonce: number } | null;
  tokenRateState: { tokensPerSecond: number | null; windowSeconds: number };
  activeSessionPathRef: { current: string | null };
  setDraftRestore: (v: { text: string; nonce: number } | null) => void;
  /** Add an optimistic user message to be shown instantly. */
  addOptimisticMessage: (msg: OptimisticUserMessage) => void;
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
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticUserMessage[]>([]);

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
    setOptimisticMessages([]);
  }, []);

  const resetPerSessionState = useCallback(() => {
    revisionMapRef.current.clear();
  }, []);

  useEffect(() => {
    return () => resetPerSessionState();
  }, [resetPerSessionState]);

  const addOptimisticMessage = useCallback((msg: OptimisticUserMessage) => {
    setOptimisticMessages((prev) => [...prev, msg]);
  }, []);

  /** Merge optimistic messages with the host transcript. */
  const mergedTranscript = useMemo(() => {
    if (optimisticMessages.length === 0) {
      return viewState.transcript;
    }

    const activeSessionPath = viewState.activeSession?.path;
    if (!activeSessionPath) {
      return viewState.transcript;
    }

    // Find which optimistic messages are NOT already in the host transcript.
    // The host uses the same localId we provide, so we match by id.
    const hostIds = new Set(viewState.transcript.map((m) => m.id));
    const pendingForSession = optimisticMessages.filter(
      (m) => m.sessionPath === activeSessionPath && !hostIds.has(m.localId),
    );

    if (pendingForSession.length === 0) {
      return viewState.transcript;
    }

    // Create ChatMessage objects for each pending message and append to transcript.
    const now = new Date().toISOString();
    const chatMessages: ChatMessage[] = pendingForSession.map((m) => ({
      id: m.localId,
      role: 'user' as const,
      createdAt: now,
      markdown: m.text,
      status: 'completed' as const,
    }));

    return [...viewState.transcript, ...chatMessages];
  }, [viewState.transcript, viewState.activeSession?.path, optimisticMessages]);

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

        // Reconcile optimistic messages: remove any that now appear in the host transcript.
        if (hostChanged || sessionChanged) {
          clearTransientUi();
          tokenRateRef.current = [];
          setTokenRateState({ tokensPerSecond: null, windowSeconds: RATE_WINDOW_SECONDS });
        } else {
          // Remove optimistic messages whose localId is now present in the host transcript.
          const hostIds = new Set(msg.state.transcript.map((m) => m.id));
          setOptimisticMessages((prev) => {
            if (prev.length === 0) return prev;
            const remaining = prev.filter((m) => !hostIds.has(m.localId));
            return remaining.length === prev.length ? prev : remaining;
          });
        }

        if (queuedDraftRestore && nextActiveSessionPath) {
          pendingDraftRestoreRef.current.delete(nextActiveSessionPath);
          setDraftRestore({ text: queuedDraftRestore.text, nonce: Date.now() });
        }
        setViewState(msg.state);
        return;
      }

      if (msg.type === 'sendRejected') {
        // Remove the rejected optimistic message from the local overlay.
        if (msg.localId) {
          setOptimisticMessages((prev) => prev.filter((m) => m.localId !== msg.localId));
        } else {
          // Legacy fallback: clear all optimistic messages for the session.
          setOptimisticMessages((prev) => prev.filter((m) => m.sessionPath !== msg.sessionPath));
        }

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

  return { viewState, mergedTranscript, draftRestore, tokenRateState, activeSessionPathRef, setDraftRestore, addOptimisticMessage };
}
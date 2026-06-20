/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'preact/hooks';

import { playCompletionSound } from '../completion-sound';
import { validateViewState } from '../state-validator';
import { clearCollapsibleCache } from '../transcript/use-collapsible-open';

import type {
  ChatMessage,
  ChatPrefs,
  HostToWebviewMessage,
  PruningCatalog,
  PruningSettings,
  ViewState,
  WebviewToHostMessage,
} from '../../../shared/protocol';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, EMPTY_TRANSCRIPT_WINDOW, WEBVIEW_PROTOCOL_VERSION } from '../../../shared/protocol';
import { pickStable } from '../utils/view-state-stabilize';

/**
 * Fill gaps in host-delivered state with safe defaults and log violations.
 * Prevents render crashes when the host omits newly-added nested fields.
 *
 * `prefs` / `pruningSettings` / `pruningCatalog` are reference-stabilised: the
 * host re-serialises the whole `ViewState` on every snapshot (fresh refs even
 * when content is unchanged), which would otherwise defeat every `memo()` /
 * `useMemo` / `useCallback` barrier downstream (notably `MessageItem = memo()`
 * and `useTranscriptRenderToolCall`'s `useCallback([prefs, ...])`). Reusing the
 * previous reference when content is unchanged keeps those barriers effective.
 * The cached refs live for the module's lifetime; `pickStable` compares content
 * so a genuinely different value (e.g. a pref toggle) still produces a new ref.
 */
let stablePrefs: ChatPrefs | null = null;
let stablePruningSettings: PruningSettings | null = null;
let stablePruningCatalog: PruningCatalog | null = null;

function hydrateViewState(raw: ViewState): ViewState {
  validateViewState(raw);
  const prefs = pickStable(stablePrefs, { ...DEFAULT_CHAT_PREFS, ...raw.prefs });
  stablePrefs = prefs;
  const pruningSettings = pickStable(stablePruningSettings, { ...DEFAULT_PRUNING_SETTINGS, ...raw.pruningSettings });
  stablePruningSettings = pruningSettings;
  const pruningCatalog = pickStable(stablePruningCatalog, { ...EMPTY_VIEW_STATE.pruningCatalog, ...raw.pruningCatalog });
  stablePruningCatalog = pruningCatalog;
  return {
    ...raw,
    prefs,
    pruningSettings,
    pruningCatalog,
  };
}

export const EMPTY_VIEW_STATE: ViewState = {
  sessions: [],
  openTabPaths: [],
  pinnedTabPaths: [],
  runningSessionPaths: [],
  unreadFinishedSessionPaths: [],
  activeSession: null,
  transcript: [],
  transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
  transcriptLoaded: false,
  draftText: '',
  pendingComposerInputs: [],
  activeRunSummary: null,
  runSummariesBySession: {},
  tokenRateBySession: {},
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
  fileChangesExpanded: false,
  pruningResult: null,
  pruningSettings: { ...DEFAULT_PRUNING_SETTINGS },
  pruningCatalog: {
    skills: [],
    tools: [],
  },
  editingMessageId: null,
  showOutcomeDialog: false,
  pendingExtensionUIRequestsBySession: {},
  pendingExtensionUIRequest: null,
};

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
  activeSessionPathRef: { current: string | null };
  setDraftRestore: (v: { text: string; nonce: number } | null) => void;
  /** Add an optimistic user message to be shown instantly. */
  addOptimisticMessage: (msg: OptimisticUserMessage) => void;
}

/* ------------------------------------------------------------------ */
//  Sub-hooks
/* ------------------------------------------------------------------ */

function useMergedTranscript(viewState: ViewState, optimisticMessages: OptimisticUserMessage[]): ChatMessage[] {
  return useMemo(() => {
    if (optimisticMessages.length === 0) {
      return viewState.transcript;
    }

    const activeSessionPath = viewState.activeSession?.path;
    if (!activeSessionPath) {
      return viewState.transcript;
    }

    const hostIds = new Set(viewState.transcript.map((m) => m.id));
    const pendingForSession = optimisticMessages.filter(
      (m) => m.sessionPath === activeSessionPath && !hostIds.has(m.localId),
    );

    if (pendingForSession.length === 0) {
      return viewState.transcript;
    }

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
}

interface PendingStateApplied {
  revision: number;
  backendReady: boolean;
  transcriptLoaded: boolean;
  openTabCount: number;
  transcriptCount: number;
  systemPromptCount: number;
}

function useStateAppliedDiagnostics(
  pendingStateApplied: PendingStateApplied | null,
  postMessage: (msg: WebviewToHostMessage) => void,
) {
  const sentStateAppliedRevisionRef = useRef<number>(-1);

  useLayoutEffect(() => {
    if (!pendingStateApplied) {
      return;
    }
    if (pendingStateApplied.revision === sentStateAppliedRevisionRef.current) {
      return;
    }

    sentStateAppliedRevisionRef.current = pendingStateApplied.revision;
    postMessage({
      type: 'stateApplied',
      payload: {
        revision: pendingStateApplied.revision,
        backendReady: pendingStateApplied.backendReady,
        transcriptLoaded: pendingStateApplied.transcriptLoaded,
        openTabCount: pendingStateApplied.openTabCount,
        transcriptCount: pendingStateApplied.transcriptCount,
        systemPromptCount: pendingStateApplied.systemPromptCount,
        domTranscriptLoaderPresent: document.querySelector('.transcript-loading') !== null,
        domTabsConnectingPresent: document.querySelector('.session-tabs-connecting') !== null,
      },
    });
  }, [pendingStateApplied, postMessage]);
}

function useFocusRefresh(postMessage: (msg: WebviewToHostMessage) => void) {
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
}

/* ------------------------------------------------------------------ */
//  Per-type message handlers
/* ------------------------------------------------------------------ */

interface OptimisticMessageOps {
  clear: () => void;
  reconcileWithHostIds: (hostIds: Set<string>) => void;
  removeByLocalId: (localId: string) => void;
  removeBySessionPath: (sessionPath: string) => void;
}

interface DraftRestoreOps {
  applyQueued: (sessionPath: string) => boolean;
  queueForSession: (sessionPath: string, text: string) => void;
  restoreNow: (text: string) => void;
}

interface HostMessageContext {
  resetPerSessionState: () => void;
  hostInstanceIdRef: { current: string };
  activeSessionPathRef: { current: string | null };
  committedSessionPathRef: { current: string | null };
  clearTransientUi: () => void;
  optimisticOps: OptimisticMessageOps;
  draftOps: DraftRestoreOps;
  setViewState: (v: ViewState) => void;
  setPendingStateApplied: (v: PendingStateApplied | null) => void;
}

/** Tracks whether the webview has already warned about a host/webview
 * protocol mismatch, so the warning fires once rather than on every state
 * message. */
let warnedProtocolMismatch = false;

/**
 * Warn (once) when the host posts a webview-channel protocol version that does
 * not match this build's compiled-in expectation. The webview does not refuse
 * to load — it ships together with the host, so a mismatch generally indicates
 * a stale hot-reload rather than a genuine incompatibility.
 */
function warnOnProtocolMismatch(hostProtocolVersion: number): void {
  if (warnedProtocolMismatch) {
    return;
  }
  if (hostProtocolVersion !== WEBVIEW_PROTOCOL_VERSION) {
    warnedProtocolMismatch = true;
    console.warn(
      `[pie] Webview protocol mismatch: host posted version ${hostProtocolVersion} but this webview build expects ${WEBVIEW_PROTOCOL_VERSION}. ` +
        'This usually means a stale hot-reload — rebuild and reload both sides together.',
    );
  }
}

function handleStateMessage(msg: HostToWebviewMessage, ctx: HostMessageContext) {
  const m = msg as Extract<HostToWebviewMessage, { type: 'state' }>;
  warnOnProtocolMismatch(m.protocolVersion);
  ctx.resetPerSessionState();
  const hostChanged = ctx.hostInstanceIdRef.current && m.hostInstanceId !== ctx.hostInstanceIdRef.current;
  const nextActiveSessionPath = m.state.activeSession?.path ?? null;
  const sessionChanged = ctx.committedSessionPathRef.current !== null && ctx.committedSessionPathRef.current !== nextActiveSessionPath;

  ctx.hostInstanceIdRef.current = m.hostInstanceId;
  ctx.activeSessionPathRef.current = nextActiveSessionPath;
  ctx.committedSessionPathRef.current = nextActiveSessionPath;

  if (hostChanged || sessionChanged) {
    ctx.clearTransientUi();
  } else {
    const hostIds = new Set(m.state.transcript.map((msgItem) => msgItem.id));
    ctx.optimisticOps.reconcileWithHostIds(hostIds);
  }

  if (nextActiveSessionPath) {
    ctx.draftOps.applyQueued(nextActiveSessionPath);
  }

  ctx.setViewState(hydrateViewState(m.state));
  ctx.setPendingStateApplied({
    revision: m.revision,
    backendReady: m.state.backendReady,
    transcriptLoaded: m.state.transcriptLoaded,
    openTabCount: m.state.openTabPaths.length,
    transcriptCount: m.state.transcript.length,
    systemPromptCount: m.state.systemPrompts.length,
  });
}

function handlePlayCompletionSound(msg: HostToWebviewMessage) {
  const m = msg as Extract<HostToWebviewMessage, { type: 'playCompletionSound' }>;
  playCompletionSound(m.volume);
}

function handleSendRejectedMessage(
  msg: HostToWebviewMessage,
  ctx: Pick<HostMessageContext, 'optimisticOps' | 'draftOps' | 'activeSessionPathRef'>,
) {
  const m = msg as Extract<HostToWebviewMessage, { type: 'sendRejected' }>;
  if (m.localId) {
    ctx.optimisticOps.removeByLocalId(m.localId);
  } else {
    ctx.optimisticOps.removeBySessionPath(m.sessionPath);
  }

  if (m.sessionPath === ctx.activeSessionPathRef.current) {
    ctx.draftOps.restoreNow(m.text);
  } else {
    ctx.draftOps.queueForSession(m.sessionPath, m.text);
  }
}

type HostMessageHandler = (msg: HostToWebviewMessage, ctx: HostMessageContext) => void;

const HOST_MESSAGE_HANDLERS: Record<string, HostMessageHandler | undefined> = {
  state: handleStateMessage,
  playCompletionSound: (msg, _ctx) => handlePlayCompletionSound(msg),
  sendRejected: handleSendRejectedMessage,
};

function dispatchHostMessage(msg: HostToWebviewMessage, ctx: HostMessageContext) {
  const handler = HOST_MESSAGE_HANDLERS[msg.type];
  if (handler) {
    handler(msg, ctx);
  }
}

/* ------------------------------------------------------------------ */
//  Main hook
/* ------------------------------------------------------------------ */

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
  const [pendingStateApplied, setPendingStateApplied] = useState<PendingStateApplied | null>(null);

  const hostInstanceIdRef = useRef('');
  const activeSessionPathRef = useRef<string | null>(null);
  const committedSessionPathRef = useRef<string | null>(null);
  const pendingDraftRestoreRef = useRef(new Map<string, { text: string }>());

  const clearTransientUi = useCallback(() => {
    setDraftRestore(null);
    setOptimisticMessages([]);
    pendingDraftRestoreRef.current.clear();
    clearCollapsibleCache();
  }, []);

  const resetPerSessionState = useCallback(() => {
    // no-op: per-session revision tracking removed
  }, []);

  useEffect(() => {
    return () => resetPerSessionState();
  }, [resetPerSessionState]);

  const addOptimisticMessage = useCallback((msg: OptimisticUserMessage) => {
    setOptimisticMessages((prev) => [...prev, msg]);
  }, []);

  const mergedTranscript = useMergedTranscript(viewState, optimisticMessages);

  const optimisticOpsRef = useRef<OptimisticMessageOps>({
    clear: () => setOptimisticMessages([]),
    reconcileWithHostIds: (hostIds) => {
      setOptimisticMessages((prev) => {
        if (prev.length === 0) return prev;
        const remaining = prev.filter((m) => !hostIds.has(m.localId));
        return remaining.length === prev.length ? prev : remaining;
      });
    },
    removeByLocalId: (localId) => {
      setOptimisticMessages((prev) => prev.filter((m) => m.localId !== localId));
    },
    removeBySessionPath: (sessionPath) => {
      setOptimisticMessages((prev) => prev.filter((m) => m.sessionPath !== sessionPath));
    },
  });

  const draftOpsRef = useRef<DraftRestoreOps>({
    applyQueued: (sessionPath) => {
      const queued = pendingDraftRestoreRef.current.get(sessionPath) ?? null;
      if (queued) {
        pendingDraftRestoreRef.current.delete(sessionPath);
        setDraftRestore({ text: queued.text, nonce: Date.now() });
        return true;
      }
      return false;
    },
    queueForSession: (sessionPath, text) => {
      pendingDraftRestoreRef.current.set(sessionPath, { text });
    },
    restoreNow: (text) => {
      setDraftRestore({ text, nonce: Date.now() });
    },
  });

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Guard against malformed messages from non-host sources (browser
      // extensions, devtools, etc.). The dispatchHostMessage handler
      // further validates the `type` field against known handlers.
      if (!event.data || typeof event.data.type !== 'string') return;
      dispatchHostMessage(event.data as HostToWebviewMessage, {
        resetPerSessionState,
        hostInstanceIdRef,
        activeSessionPathRef,
        committedSessionPathRef,
        clearTransientUi,
        optimisticOps: optimisticOpsRef.current,
        draftOps: draftOpsRef.current,
        setViewState,
        setPendingStateApplied,
      });
    };

    window.addEventListener('message', handleMessage);
    postMessage({ type: 'ready' });
    postMessage({ type: 'refreshState' });
    return () => window.removeEventListener('message', handleMessage);
  }, [clearTransientUi, postMessage, resetPerSessionState]);

  useStateAppliedDiagnostics(pendingStateApplied, postMessage);

  useFocusRefresh(postMessage);

  return { viewState, mergedTranscript, draftRestore, activeSessionPathRef, setDraftRestore, addOptimisticMessage };
}

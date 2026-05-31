import type { HostToWebviewMessage, PatchOp, ViewState } from '../../shared/protocol';
import { WEBVIEW_PROTOCOL_VERSION } from '../../shared/protocol';

/**
 * Per-session sync bookkeeping. `revision` advances on each patch envelope for
 * the session; `dirty` is set when a patch could not be posted (view hidden or
 * webview not ready) and triggers a snapshot recovery on the next flush.
 */
export type SessionSyncEntry = { revision: number; dirty: boolean };

/**
 * Sync state held by `SidebarViewProvider`. Per the Phase 1 architecture
 * migration, patch revisions are per-session: envelopes addressed to session A
 * advance only A's counter, leaving B's untouched. `hostInstanceId` and
 * `globalRevision` remain process-wide — `globalRevision` advances on each
 * state envelope (full snapshot) so the webview can still detect host counter
 * resets in conjunction with `hostInstanceId`.
 */
export type SidebarSyncState = {
  hostInstanceId: string;
  globalRevision: number;
  globalDirty: boolean;
  sessions: Record<string, SessionSyncEntry>;
};

export function createSidebarSyncState(hostInstanceId: string): SidebarSyncState {
  return {
    hostInstanceId,
    globalRevision: 0,
    globalDirty: false,
    sessions: {},
  };
}

export function canPostSnapshotToWebview(hasView: boolean, _webviewReady: boolean): boolean {
  return hasView;
}

function anySessionDirty(syncState: SidebarSyncState): boolean {
  for (const entry of Object.values(syncState.sessions)) {
    if (entry.dirty) return true;
  }
  return false;
}

/**
 * Build a global state-snapshot envelope. On a successful post the snapshot is
 * authoritative: all per-session revisions reset to 0 and all dirty flags
 * clear (the webview rebuilds its mirrors from the snapshot).
 */
export function buildStateEnvelope(
  syncState: SidebarSyncState,
  viewState: ViewState,
  canPost: boolean,
): { nextSyncState: SidebarSyncState; message?: HostToWebviewMessage } {
  if (!canPost) {
    return {
      nextSyncState: { ...syncState, globalDirty: true },
    };
  }

  const revision = syncState.globalRevision + 1;
  return {
    nextSyncState: {
      ...syncState,
      globalRevision: revision,
      globalDirty: false,
      sessions: {},
    },
    message: {
      type: 'state',
      protocolVersion: WEBVIEW_PROTOCOL_VERSION,
      hostInstanceId: syncState.hostInstanceId,
      revision,
      state: viewState,
    },
  };
}

/**
 * Build a session-addressed patch envelope. Advances only `sessionPath`'s
 * revision counter; other sessions are unaffected. When the webview cannot
 * receive (hidden or not ready) the session is marked dirty and the patch is
 * dropped — recovery is via a subsequent snapshot.
 */
export function buildPatchEnvelope(
  syncState: SidebarSyncState,
  sessionPath: string,
  op: PatchOp,
  canPost: boolean,
): { nextSyncState: SidebarSyncState; message?: HostToWebviewMessage } {
  const existing = syncState.sessions[sessionPath] ?? { revision: 0, dirty: false };

  if (!canPost) {
    return {
      nextSyncState: {
        ...syncState,
        sessions: {
          ...syncState.sessions,
          [sessionPath]: { ...existing, dirty: true },
        },
      },
    };
  }

  const revision = existing.revision + 1;
  return {
    nextSyncState: {
      ...syncState,
      sessions: {
        ...syncState.sessions,
        [sessionPath]: { revision, dirty: false },
      },
    },
    message: {
      type: 'patch',
      protocolVersion: WEBVIEW_PROTOCOL_VERSION,
      sessionPath,
      hostInstanceId: syncState.hostInstanceId,
      revision,
      op,
    },
  };
}

/**
 * Emit a recovery snapshot when any session — or the global state — is dirty.
 * Today recovery is always a full global snapshot; a future sub-step may emit
 * per-session snapshots when only one session is dirty.
 */
export function flushDirtySnapshot(
  syncState: SidebarSyncState,
  viewState: ViewState,
  canPost: boolean,
): { nextSyncState: SidebarSyncState; message?: HostToWebviewMessage } {
  if (!syncState.globalDirty && !anySessionDirty(syncState)) {
    return { nextSyncState: syncState };
  }

  return buildStateEnvelope(syncState, viewState, canPost);
}

/**
 * Remove tracking for a session that was closed or invalidated. Keeps the sync
 * state free of stale entries that would otherwise accumulate over a long
 * session.
 */
export function clearSessionSync(
  syncState: SidebarSyncState,
  sessionPath: string,
): SidebarSyncState {
  if (!(sessionPath in syncState.sessions)) return syncState;
  const { [sessionPath]: _removed, ...rest } = syncState.sessions;
  return { ...syncState, sessions: rest };
}

/**
 * A host->webview post can fail even after we've decided the view is ready
 * enough to attempt delivery. Treat that as dropped state and force snapshot
 * recovery on the next explicit resync or visibility transition.
 */
export function reconcilePostedMessageDelivery(
  syncState: SidebarSyncState,
  message: HostToWebviewMessage,
  delivered: boolean,
): SidebarSyncState {
  if (delivered) {
    return syncState;
  }

  if (message.type === 'state') {
    return { ...syncState, globalDirty: true };
  }

  if (message.type === 'patch') {
    const existing = syncState.sessions[message.sessionPath] ?? { revision: 0, dirty: false };
    return {
      ...syncState,
      sessions: {
        ...syncState.sessions,
        [message.sessionPath]: { ...existing, dirty: true },
      },
    };
  }

  return syncState;
}

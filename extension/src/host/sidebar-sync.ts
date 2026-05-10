import type { HostToWebviewMessage, PatchOp, ViewState } from '../shared/protocol';

export type SidebarSyncState = {
  revision: number;
  hostInstanceId: string;
  dirty: boolean;
};

export function createSidebarSyncState(hostInstanceId: string): SidebarSyncState {
  return {
    revision: 0,
    hostInstanceId,
    dirty: false,
  };
}

export function canPostToWebview(hasView: boolean, isVisible: boolean): boolean {
  return hasView && isVisible;
}

export function buildStateEnvelope(
  syncState: SidebarSyncState,
  viewState: ViewState,
  canPost: boolean,
): { nextSyncState: SidebarSyncState; message?: HostToWebviewMessage } {
  if (!canPost) {
    return {
      nextSyncState: { ...syncState, dirty: true },
    };
  }

  const revision = syncState.revision + 1;
  return {
    nextSyncState: { ...syncState, revision, dirty: false },
    message: {
      type: 'state',
      hostInstanceId: syncState.hostInstanceId,
      revision,
      state: viewState,
    },
  };
}

export function buildPatchEnvelope(
  syncState: SidebarSyncState,
  op: PatchOp,
  canPost: boolean,
): { nextSyncState: SidebarSyncState; message?: HostToWebviewMessage } {
  if (!canPost) {
    return {
      nextSyncState: { ...syncState, dirty: true },
    };
  }

  const revision = syncState.revision + 1;
  return {
    nextSyncState: { ...syncState, revision },
    message: {
      type: 'patch',
      hostInstanceId: syncState.hostInstanceId,
      revision,
      op,
    },
  };
}

export function flushDirtySnapshot(
  syncState: SidebarSyncState,
  viewState: ViewState,
  canPost: boolean,
): { nextSyncState: SidebarSyncState; message?: HostToWebviewMessage } {
  if (!syncState.dirty) {
    return { nextSyncState: syncState };
  }

  return buildStateEnvelope(syncState, viewState, canPost);
}
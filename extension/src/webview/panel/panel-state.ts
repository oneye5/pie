import type { ViewState } from '../../shared/protocol';

export type PanelSurface = 'loading' | 'empty' | 'session';

type PanelSurfaceState = Pick<ViewState, 'backendReady' | 'notice' | 'openTabPaths'>;
type PanelBootState = Pick<ViewState, 'backendReady' | 'notice'>;

export function isPanelBooting(state: PanelBootState): boolean {
  const hasNotice = typeof state.notice === 'string' && state.notice.trim().length > 0;
  return !state.backendReady && !hasNotice;
}

export function resolvePanelSurface(state: PanelSurfaceState): PanelSurface {
  // If there are open tabs, always show the session surface — even during boot.
  // This lets users type immediately; their messages will be queued until the
  // backend is ready.
  if (state.openTabPaths.length > 0) {
    return 'session';
  }

  if (isPanelBooting(state)) {
    return 'loading';
  }

  return 'empty';
}

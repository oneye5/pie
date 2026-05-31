import { store, uiActions } from '../store';

export interface PublishBackendReadyOptions {
  scheduleRender: () => void;
  openSession: (sessionPath: string) => void;
  preloadSessions: (sessionPaths: readonly string[]) => void;
  restoredStartupPath: string | null;
  preloadPaths: readonly string[];
}

export function publishBackendReady(options: PublishBackendReadyOptions): Error | null {
  store.dispatch(uiActions.setBackendReady(true));
  options.scheduleRender();

  if (!options.restoredStartupPath) {
    return null;
  }

  try {
    options.openSession(options.restoredStartupPath);
    options.preloadSessions(options.preloadPaths);
    return null;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    store.dispatch(uiActions.setNotice(`Failed to restore session: ${failure.message}`));
    options.scheduleRender();
    return failure;
  }
}
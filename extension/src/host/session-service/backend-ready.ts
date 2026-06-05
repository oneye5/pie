import type { ArchState } from '../core/arch-state';

export interface PublishBackendReadyOptions {
  mutateArchState: (recipe: (draft: ArchState) => void) => void;
  scheduleRender: () => void;
  openSession: (sessionPath: string) => void;
  preloadSessions: (sessionPaths: readonly string[]) => void;
  restoredStartupPath: string | null;
  preloadPaths: readonly string[];
}

export function publishBackendReady(options: PublishBackendReadyOptions): Error | null {
  options.mutateArchState((draft) => {
    draft.settings.backendReady = true;
  });
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
    options.mutateArchState((draft) => {
      draft.settings.notice = `Failed to restore session: ${failure.message}`;
    });
    options.scheduleRender();
    return failure;
  }
}
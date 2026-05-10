import type { SessionSummary } from './protocol';

export const PENDING_SESSION_PREFIX = '__pending__:';

export function isPendingTabPath(sessionPath: string): boolean {
  return sessionPath.startsWith(PENDING_SESSION_PREFIX);
}

export function normalizeStoredOpenTabPaths(openTabPaths: readonly unknown[]): string[] {
  const seenPaths = new Set<string>();
  const normalizedPaths: string[] = [];

  for (const value of openTabPaths) {
    // Accept both old string format and new {path, name?} object format.
    const path =
      typeof value === 'string'
        ? value
        : value !== null && typeof value === 'object'
          ? (typeof (value as Record<string, unknown>)['path'] === 'string'
              ? ((value as Record<string, unknown>)['path'] as string)
              : null)
          : null;

    if (!path || isPendingTabPath(path) || seenPaths.has(path)) {
      continue;
    }

    normalizedPaths.push(path);
    seenPaths.add(path);
  }

  return normalizedPaths;
}

type VisibleTabOptions = {
  openTabPaths: string[];
  sessions: SessionSummary[];
  workspaceCwd: string | null;
  activeSession: SessionSummary | null;
};

export function getVisibleTabPaths({
  openTabPaths,
}: VisibleTabOptions): string[] {
  const seenPaths = new Set<string>();
  const visiblePaths: string[] = [];

  for (const sessionPath of openTabPaths) {
    if (seenPaths.has(sessionPath)) {
      continue;
    }

    visiblePaths.push(sessionPath);
    seenPaths.add(sessionPath);
  }

  return visiblePaths;
}

type NextTabOnCloseOptions = VisibleTabOptions & {
  closingPath: string;
};

export function getNextVisibleTabPathOnClose({ closingPath, ...options }: NextTabOnCloseOptions): string | null {
  const visiblePaths = getVisibleTabPaths(options);
  const closingIndex = visiblePaths.indexOf(closingPath);
  if (closingIndex === -1) {
    return null;
  }

  const remainingPaths = visiblePaths.filter((sessionPath) => sessionPath !== closingPath);
  if (remainingPaths.length === 0) {
    return null;
  }

  const nextIndex = Math.min(closingIndex, remainingPaths.length - 1);
  return remainingPaths[nextIndex] ?? null;
}
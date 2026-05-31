import type { SessionSummary } from './protocol';

export const PENDING_SESSION_PREFIX = '__pending__:';

export type HorizontalDropRect = {
  left: number;
  right: number;
};

export function isPendingTabPath(sessionPath: string): boolean {
  return sessionPath.startsWith(PENDING_SESSION_PREFIX);
}

export function readStoredOpenTabPath(value: unknown): string | null {
  return typeof value === 'string'
    ? value
    : value !== null && typeof value === 'object'
      ? (typeof (value as Record<string, unknown>)['path'] === 'string'
          ? ((value as Record<string, unknown>)['path'] as string)
          : null)
      : null;
}

export function normalizeStoredOpenTabPaths(openTabPaths: readonly unknown[]): string[] {
  const seenPaths = new Set<string>();
  const normalizedPaths: string[] = [];

  for (const value of openTabPaths) {
    // Accept both old string format and new {path, name?} object format.
    const path = readStoredOpenTabPath(value);

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
  activeSessionPath: string | null;
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

export function getHorizontalDropIndex(rects: readonly HorizontalDropRect[], clientX: number): number {
  if (rects.length === 0) {
    return 0;
  }

  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    const midpoint = rect.left + ((rect.right - rect.left) / 2);
    if (clientX <= midpoint) {
      return index;
    }
  }

  return rects.length;
}

export function moveOpenTabPath(
  openTabPaths: readonly string[],
  options: { sessionPath?: string; fromIndex: number; toIndex: number },
): string[] {
  if (openTabPaths.length <= 1) {
    return [...openTabPaths];
  }

  const nextPaths = [...openTabPaths];
  const resolvedFromIndex =
    options.sessionPath !== undefined
      ? nextPaths.indexOf(options.sessionPath)
      : -1;
  const fromIndex = resolvedFromIndex === -1 ? options.fromIndex : resolvedFromIndex;

  if (fromIndex < 0 || fromIndex >= nextPaths.length) {
    return nextPaths;
  }

  const toIndex = Math.max(0, Math.min(options.toIndex, nextPaths.length - 1));
  if (fromIndex === toIndex) {
    return nextPaths;
  }

  const [movedPath] = nextPaths.splice(fromIndex, 1);
  nextPaths.splice(toIndex, 0, movedPath);
  return nextPaths;
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
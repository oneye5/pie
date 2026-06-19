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

/**
 * Normalize a stored tab-path list (read back from globalState) into a clean
 * `string[]`. Accepts both the legacy bare-string format and the newer
 * `{ path, name? }` object format, drops pending paths, and de-duplicates while
 * preserving order. Generic over open vs pinned tabs — both are persisted as
 * path lists and need the same normalization on restore.
 */
export function normalizeStoredTabPaths(storedPaths: readonly unknown[]): string[] {
  const seenPaths = new Set<string>();
  const normalizedPaths: string[] = [];

  for (const value of storedPaths) {
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

/** Result of a pin/unpin mutation: the new `openTabPaths` (still the canonical
 *  strip order) and the new `pinnedTabPaths`. */
export interface PinTabResult {
  openTabPaths: string[];
  pinnedTabPaths: string[];
}

/**
 * Pin a tab (browser semantics). Maintains the invariant that pinned tabs form
 * the leading prefix of `openTabPaths`: the tab is moved to the end of the
 * pinned prefix and appended to `pinnedTabPaths`. Idempotent — pinning a tab
 * that is already pinned is a no-op. Pending paths cannot be pinned (the
 * caller guards this; the helper still tolerates them defensively).
 */
export function pinTab(
  openTabPaths: readonly string[],
  pinnedTabPaths: readonly string[],
  sessionPath: string,
): PinTabResult {
  if (pinnedTabPaths.includes(sessionPath)) {
    return { openTabPaths: [...openTabPaths], pinnedTabPaths: [...pinnedTabPaths] };
  }
  const nextPinned = [...pinnedTabPaths, sessionPath];
  // Remove from the current position, then reinsert as the LAST pinned tab
  // (the tail of the pinned prefix). After removal the pinned prefix holds
  // `nextPinned.length - 1` tabs, so the new tail index is that count.
  const withoutPath = openTabPaths.filter((p) => p !== sessionPath);
  const insertAt = Math.min(nextPinned.length - 1, withoutPath.length);
  const nextOpen = [...withoutPath];
  nextOpen.splice(insertAt, 0, sessionPath);
  return { openTabPaths: nextOpen, pinnedTabPaths: nextPinned };
}

/**
 * Unpin a tab (browser semantics). Removes the tab from `pinnedTabPaths` and
 * moves it to the START of the unpinned region (right after the remaining
 * pinned tabs), preserving the pinned-prefix invariant. Idempotent — unpinning
 * a tab that is not pinned is a no-op.
 */
export function unpinTab(
  openTabPaths: readonly string[],
  pinnedTabPaths: readonly string[],
  sessionPath: string,
): PinTabResult {
  if (!pinnedTabPaths.includes(sessionPath)) {
    return { openTabPaths: [...openTabPaths], pinnedTabPaths: [...pinnedTabPaths] };
  }
  const nextPinned = pinnedTabPaths.filter((p) => p !== sessionPath);
  const withoutPath = openTabPaths.filter((p) => p !== sessionPath);
  // Reinsert at the start of the unpinned region (index = remaining pinned count).
  const insertAt = Math.min(nextPinned.length, withoutPath.length);
  const nextOpen = [...withoutPath];
  nextOpen.splice(insertAt, 0, sessionPath);
  return { openTabPaths: nextOpen, pinnedTabPaths: nextPinned };
}

/**
 * Insert a not-yet-open tab into `openTabPaths` while preserving the
 * pinned-prefix invariant. A pinned path lands inside the pinned prefix (at its
 * `pinnedTabPaths` position, clamped to the count of currently-open pinned
 * tabs); an unpinned path appends at the end. Used by OpenSession (reopening a
 * pinned tab) — DuplicateSession builds its own insertion so the unpinned copy
 * can land adjacent to its source when the source is unpinned.
 */
export function insertTabRespectingPinnedPrefix(
  openTabPaths: readonly string[],
  pinnedTabPaths: readonly string[],
  sessionPath: string,
): string[] {
  if (openTabPaths.includes(sessionPath)) {
    return [...openTabPaths];
  }
  const pinnedIndex = pinnedTabPaths.indexOf(sessionPath);
  if (pinnedIndex === -1) {
    return [...openTabPaths, sessionPath];
  }
  const openPinnedCount = pinnedTabPaths.filter((p) => openTabPaths.includes(p)).length;
  const insertAt = Math.min(pinnedIndex, openPinnedCount);
  const next = [...openTabPaths];
  next.splice(insertAt, 0, sessionPath);
  return next;
}

/**
 * Reorder `openTabPaths` so the pinned tabs form the leading prefix (in
 * `pinnedTabPaths` order), followed by the unpinned tabs in their existing
 * `openTabPaths` order. Pinned paths absent from `openTabPaths` are dropped
 * (the pinned ⊆ open invariant). Used by startup restore to normalize whatever
 * was persisted into the canonical pinned-first order.
 */
export function reorderOpenTabsPinnedFirst(
  openTabPaths: readonly string[],
  pinnedTabPaths: readonly string[],
): PinTabResult {
  const openSet = new Set(openTabPaths);
  const pinned = pinnedTabPaths.filter((p) => openSet.has(p));
  const pinnedSet = new Set(pinned);
  const unpinned = openTabPaths.filter((p) => !pinnedSet.has(p));
  return { openTabPaths: [...pinned, ...unpinned], pinnedTabPaths: pinned };
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
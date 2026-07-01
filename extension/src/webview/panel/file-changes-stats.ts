import type { FileChangeEntry, FileChangeKind } from '../../shared/protocol';

// Reading order for the collapsed sliver's hover `title` kind breakdown:
// created → modified → deleted (calm → concerning).
export const KIND_ORDER: { kind: FileChangeKind; label: string }[] = [
  { kind: 'created', label: 'Added' },
  { kind: 'modified', label: 'Modified' },
  { kind: 'deleted', label: 'Deleted' },
];

interface DiffTotals {
  additions: number;
  deletions: number;
}

/** Per-kind counts + line churn (drives the collapsed sliver's hover `title`
 * kind breakdown; the per-file list colors each name by kind instead). */
interface KindStats {
  count: number;
  additions: number;
  deletions: number;
}

export function computeDiffTotals(changes: FileChangeEntry[]): DiffTotals {
  let additions = 0;
  let deletions = 0;
  for (const c of changes) {
    additions += c.additions ?? 0;
    deletions += c.deletions ?? 0;
  }
  return { additions, deletions };
}

export function computeKindStats(
  changes: FileChangeEntry[],
): Record<FileChangeKind, KindStats> {
  const stats: Record<FileChangeKind, KindStats> = {
    created: { count: 0, additions: 0, deletions: 0 },
    modified: { count: 0, additions: 0, deletions: 0 },
    deleted: { count: 0, additions: 0, deletions: 0 },
  };
  for (const c of changes) {
    const s = stats[c.kind];
    s.count += 1;
    s.additions += c.additions ?? 0;
    s.deletions += c.deletions ?? 0;
  }
  return stats;
}

/** Long-form kind name for the row path aria-label, the context-menu title,
 * and the collapsed-sliver hover titles. */
export const KIND_LABEL: Record<FileChangeKind, string> = {
  created: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

/** Last path segment — the file's name without its directory. */
export function basename(path: string): string {
  // Find the last path separator ("/" or "\") without a regex literal so the
  // source has no backslash escapes to mangle across tool/JSON round-trips.
  let i = path.length;
  while (i-- > 0) {
    const c = path.charCodeAt(i);
    if (c === 47 || c === 92) break; // 47 = forward slash, 92 = backslash
  }
  return i < 0 ? path : path.slice(i + 1);
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { FileChangesPanel, computeDiffTotals } from '../src/webview/panel/file-changes-panel';
import type { FileChangeEntry } from '../src/shared/protocol';

function entry(path: string, additions: number, deletions: number, kind: FileChangeEntry['kind'] = 'modified'): FileChangeEntry {
  return {
    path,
    kind,
    additions,
    deletions,
    toolCallId: 'tc',
    messageId: 'm',
    description: '',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// computeDiffTotals — pure helper driving the aggregate header + diff bars.
// ---------------------------------------------------------------------------

test('computeDiffTotals sums additions/deletions', () => {
  assert.deepEqual(computeDiffTotals([]), { additions: 0, deletions: 0 });
  assert.deepEqual(computeDiffTotals([entry('a', 20, 5), entry('b', 10, 7)]), {
    additions: 30,
    deletions: 12,
  });
});

test('computeDiffTotals treats missing line stats as zero', () => {
  const noStats: FileChangeEntry = {
    path: 'c',
    kind: 'created',
    toolCallId: 'tc',
    messageId: 'm',
    description: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    // additions/deletions omitted
  };
  assert.deepEqual(computeDiffTotals([noStats, entry('d', 4, 1)]), {
    additions: 4,
    deletions: 1,
  });
});

// ---------------------------------------------------------------------------
// FileChangesPanel — SSR render safety + markup contract.
// (Interactive state — hover-peek timers, click-outside, drag — is
// webview-local and effect-driven, so it is not exercised by SSR; the initial
// render path must stay side-effect-free.)
// ---------------------------------------------------------------------------

const noop = () => undefined;

test('FileChangesPanel collapsed: renders sliver + aggregate header (SSR-safe)', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [entry('src/a.ts', 20, 5), entry('src/b.ts', 10, 7)],
      expanded: false,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
    }),
  );
  // Collapsed sliver carries the count.
  assert.match(html, /class="file-changes-sliver"/);
  assert.match(html, /<span class="file-changes-sliver-count">2<\/span>/);
  // Aggregate header: count + totals. ASCII hyphen matches the per-row
  // LineStats (no U+2212 inconsistency).
  assert.match(html, /2 files/);
  assert.match(html, /\+30/);
  assert.match(html, /-12/);
  assert.doesNotMatch(html, /−/);
  // Collapsed sliver carries the count, total +/- magnitude (how much changed
  // at a glance), and the color-encoded kind legend (dot + count per present
  // kind). Both entries are modified, so only the modified chip renders.
  assert.match(html, /file-changes-sliver-magnitude/);
  assert.match(html, /sliver-add">\+30/);
  assert.match(html, /sliver-del">-12/);
  assert.match(html, /sliver-kind kind-modified/);
  assert.match(html, /sliver-kind-dot/);
  assert.doesNotMatch(html, /sliver-kind-glyph/);
  assert.match(html, /sliver-kind-count">2</);
  // The collapsed sliver also lists the affected files, two rows each: row 1
  // is the kind dot + truncated basename; row 2 is the per-file +/- churn,
  // so the tall sliver surfaces per-file magnitude at a glance. Each entry's
  // outer span carries the full path + kind label as a hover title.
  assert.match(html, /file-changes-sliver-files/);
  assert.match(html, /sliver-file kind-modified/);
  assert.match(html, /sliver-file-dot/);
  assert.doesNotMatch(html, /sliver-file-glyph/);
  assert.match(html, /sliver-file-name">a.ts/);
  assert.match(html, /sliver-file-name">b.ts/);
  assert.match(html, /sliver-file-stats/);
  assert.match(html, /sliver-file-add">\+20/);
  assert.match(html, /sliver-file-del">-5/);
  assert.match(html, /sliver-file-add">\+10/);
  assert.match(html, /sliver-file-del">-7/);
  // Zero-count kinds are omitted from the legend (only modified is present).
  assert.doesNotMatch(html, /sliver-kind kind-created/);
  assert.doesNotMatch(html, /sliver-kind kind-deleted/);
  // The per-row red/green diff bar is gone (space reclaimed for the path).
  assert.doesNotMatch(html, /file-change-diff-bar/);
  // Sliver title carries the full summary: count + kind breakdown + line totals.
  assert.match(html, /title="2 changed files · 2 modified · \+30 \/ -12"/);
  // Drawer rows have no A/M/D status labels and no sliding action buttons.
  assert.doesNotMatch(html, /file-change-status/);
  assert.doesNotMatch(html, /file-change-actions/);
  assert.doesNotMatch(html, /file-change-diff/);
  assert.doesNotMatch(html, /file-change-open/);
  // The file name opens the file in the editor and carries its kind label.
  assert.match(html, /<button class="file-change-name"[^>]*aria-label="Modified: open src\/a\.ts in the editor"/);
  assert.match(html, /<button class="file-change-name"[^>]*aria-label="Modified: open src\/b\.ts in the editor"/);
  // A native title hint rides on both buttons (name → open file; stats → diff).
  assert.match(html, /<button class="file-change-name"[^>]*title="Open src\/a\.ts in the editor"/);
  assert.match(html, /<button class="file-change-name"[^>]*title="Open src\/b\.ts in the editor"/);
  // ...and the +/- stats open the diff.
  assert.match(html, /<button class="file-change-stats"[^>]*aria-label="View diff of src\/a\.ts"/);
  assert.match(html, /<button class="file-change-stats"[^>]*aria-label="View diff of src\/b\.ts"/);
  assert.match(html, /<button class="file-change-stats"[^>]*title="Open diff: src\/a\.ts"/);
  assert.match(html, /<button class="file-change-stats"[^>]*title="Open diff: src\/b\.ts"/);
  // Copy path + Revert remain in the right-click context menu only.
  assert.doesNotMatch(html, /file-change-copy/);
  assert.doesNotMatch(html, /file-change-revert/);
});

test('FileChangesPanel collapsed: legend renders one row per present kind', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [
        entry('a.ts', 5, 0, 'created'),
        entry('b.ts', 2, 0, 'created'),
        entry('c.ts', 3, 1, 'modified'),
        entry('d.ts', 0, 4, 'deleted'),
      ],
      expanded: false,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
    }),
  );
  // 2 added · 1 modified · 1 deleted — only present kinds render, in created →
  // modified → deleted order; kind is encoded by dot color (no A/M/D letters).
  assert.match(html, /sliver-kind kind-created/);
  assert.match(html, /sliver-kind kind-modified/);
  assert.match(html, /sliver-kind kind-deleted/);
  assert.match(html, /sliver-kind-count">2</);
  assert.match(html, /sliver-kind-count">1</);
  assert.match(html, /sliver-kind-dot/);
  assert.doesNotMatch(html, /sliver-kind-glyph/);
  // Count at the top is the file total (4), not a per-kind value.
  assert.match(html, /<span class="file-changes-sliver-count">4<\/span>/);
  // Collapsed file list renders one entry per file (4 here), each with a
  // second row of per-file +/- churn (a.ts created → +5; d.ts deleted → -4).
  assert.match(html, /file-changes-sliver-files/);
  assert.match(html, /sliver-file-name">a.ts/);
  assert.match(html, /sliver-file-add">\+5/);
  assert.match(html, /sliver-file-del">-4/);
});

test('FileChangesPanel pinned: renders left resize handle + close, no sliver', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [entry('src/a.ts', 1, 0)],
      expanded: true,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
    }),
  );
  // Pinned: the sliver is not rendered (the drawer header carries unpin).
  assert.doesNotMatch(html, /file-changes-sliver/);
  // Left-edge resize handle present (drag-left = wider).
  assert.match(html, /class="resize-handle resize-handle-left"/);
  // Close (unpin) affordance present.
  assert.match(html, /file-changes-close/);
  // Tooltips were removed from the expanded drawer (they obscured the list):
  // neither the path nor the aggregate header is wrapped in a tooltip trigger.
  // (Native HTML title attributes remain on the row buttons for hover hints.)
  assert.doesNotMatch(html, /pie-tooltip-trigger/);
  // Native title hints on the single pinned file's row buttons.
  assert.match(html, /<button class="file-change-name"[^>]*title="Open src\/a\.ts in the editor"/);
  assert.match(html, /<button class="file-change-stats"[^>]*title="Open diff: src\/a\.ts"/);
});

test('FileChangesPanel pinned: deleted row is disabled with a Deleted title', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [entry('gone.ts', 0, 4, 'deleted')],
      expanded: true,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
    }),
  );
  // Deleted files can't be opened: the name button is disabled and titled
  // "Deleted — <path>" (not the open-file hint), while the stats still open
  // the diff. Covers the disabled branch of the native-title affordance.
  assert.match(html, /<button class="file-change-name"[^>]*disabled/);
  assert.match(html, /<button class="file-change-name"[^>]*title="Deleted — gone\.ts"/);
  assert.match(html, /<button class="file-change-stats"[^>]*title="Open diff: gone\.ts"/);
  assert.doesNotMatch(html, /title="Open gone\.ts in the editor"/);
});

test('FileChangesPanel renders nothing when there are no file changes', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [],
      expanded: false,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
    }),
  );
  assert.equal(html, '');
});

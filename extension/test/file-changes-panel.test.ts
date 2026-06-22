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

test('computeDiffTotals sums additions/deletions and tracks the largest row', () => {
  assert.deepEqual(computeDiffTotals([]), { additions: 0, deletions: 0, maxRowTotal: 0 });
  assert.deepEqual(computeDiffTotals([entry('a', 20, 5), entry('b', 10, 7)]), {
    additions: 30,
    deletions: 12,
    maxRowTotal: 25, // max(20+5, 10+7)
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
    maxRowTotal: 5,
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
  // Shared diff-bar language present in both the sliver (vertical) and rows.
  assert.match(html, /file-change-diff-bar is-vertical/);
  assert.match(html, /file-change-diff-bar is-horizontal/);
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

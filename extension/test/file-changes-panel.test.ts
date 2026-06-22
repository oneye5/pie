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
  // at a glance), and the A/M/D kind legend. Both entries are modified, so
  // only the M row renders.
  assert.match(html, /file-changes-sliver-magnitude/);
  assert.match(html, /sliver-add">\+30/);
  assert.match(html, /sliver-del">-12/);
  assert.match(html, /sliver-kind kind-modified/);
  assert.match(html, /sliver-kind-glyph/);
  assert.match(html, /sliver-kind-count">2</);
  // Zero-count kinds are omitted from the legend (only modified is present).
  assert.doesNotMatch(html, /sliver-kind kind-created/);
  assert.doesNotMatch(html, /sliver-kind kind-deleted/);
  // The per-row red/green diff bar is gone (space reclaimed for the path).
  assert.doesNotMatch(html, /file-change-diff-bar/);
  // Sliver title carries the full summary: count + kind breakdown + line totals.
  assert.match(html, /title="2 changed files · M2 · \+30 \/ -12"/);
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
  // A2 M1 D1 — only present kinds render, in created → modified → deleted order.
  assert.match(html, /sliver-kind kind-created/);
  assert.match(html, /sliver-kind kind-modified/);
  assert.match(html, /sliver-kind kind-deleted/);
  assert.match(html, /sliver-kind-count">2</);
  assert.match(html, /sliver-kind-count">1</);
  // Count at the top is the file total (4), not a per-kind value.
  assert.match(html, /<span class="file-changes-sliver-count">4<\/span>/);
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

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getHorizontalDropIndex,
  getNextVisibleTabPathOnClose,
  getVisibleTabPaths,
  moveOpenTabPath,
  normalizeStoredOpenTabPaths,
} from '../src/shared/tab-behavior';

const sessions = [
  {
    path: '/workspace/a',
    name: 'A',
    cwd: '/workspace',
    modifiedAt: '2026-05-07T00:00:00.000Z',
    messageCount: 1,
  },
  {
    path: '/workspace/b',
    name: 'B',
    cwd: '/workspace',
    modifiedAt: '2026-05-07T00:00:00.000Z',
    messageCount: 2,
  },
  {
    path: '/workspace/c',
    name: 'C',
    cwd: '/workspace',
    modifiedAt: '2026-05-07T00:00:00.000Z',
    messageCount: 3,
  },
  {
    path: '/other/x',
    name: 'X',
    cwd: '/other',
    modifiedAt: '2026-05-07T00:00:00.000Z',
    messageCount: 4,
  },
];

test('getVisibleTabPaths follows open tab order without PI session-list filtering', () => {
  const visiblePaths = getVisibleTabPaths({
    openTabPaths: ['/workspace/a', '/other/x', '__pending__:1', '/workspace/c', '/workspace/missing'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[1].path,
  });

  assert.deepEqual(visiblePaths, ['/workspace/a', '/other/x', '__pending__:1', '/workspace/c', '/workspace/missing']);
});

test('getVisibleTabPaths keeps the active workspace tab visible before the session list catches up', () => {
  const visiblePaths = getVisibleTabPaths({
    openTabPaths: ['/workspace/a', '/workspace/b'],
    sessions: [sessions[0]],
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[1].path,
  });

  assert.deepEqual(visiblePaths, ['/workspace/a', '/workspace/b']);
});

test('closing an active tab prefers the tab on the right', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a', '/workspace/b', '/workspace/c'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[1].path,
    closingPath: '/workspace/b',
  });

  assert.equal(nextPath, '/workspace/c');
});

test('closing the last visible tab falls back to the tab on the left', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a', '/workspace/b', '/workspace/c'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[2].path,
    closingPath: '/workspace/c',
  });

  assert.equal(nextPath, '/workspace/b');
});

test('closing a visible cross-workspace tab follows open tab order', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a', '/other/x', '/workspace/b'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[3].path,
    closingPath: '/other/x',
  });

  assert.equal(nextPath, '/workspace/b');
});

test('closing a visible tab can select an adjacent pending tab', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a', '__pending__:1', '/workspace/c'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[0].path,
    closingPath: '/workspace/a',
  });

  assert.equal(nextPath, '__pending__:1');
});

test('closing the only visible tab returns null', () => {
  const nextPath = getNextVisibleTabPathOnClose({
    openTabPaths: ['/workspace/a'],
    sessions,
    workspaceCwd: '/workspace',
    activeSessionPath: sessions[0].path,
    closingPath: '/workspace/a',
  });

  assert.equal(nextPath, null);
});

test('normalizeStoredOpenTabPaths removes transient and duplicate tabs', () => {
  const paths = normalizeStoredOpenTabPaths([
    '/workspace/a',
    '__pending__:1',
    '/workspace/a',
    '',
    null,
    '/workspace/b',
  ]);

  assert.deepEqual(paths, ['/workspace/a', '/workspace/b']);
});

test('normalizeStoredOpenTabPaths accepts {path, name} objects alongside strings', () => {
  const paths = normalizeStoredOpenTabPaths([
    '/workspace/a',
    { path: '/workspace/b', name: 'My Session' },
    '__pending__:1',
    '/workspace/a', // duplicate
    { path: '/workspace/c' }, // no name — still a valid path entry
  ]);

  assert.deepEqual(paths, ['/workspace/a', '/workspace/b', '/workspace/c']);
});

test('moveOpenTabPath reorders a tab to the front', () => {
  const nextPaths = moveOpenTabPath(['/workspace/a', '/workspace/b', '/workspace/c'], {
    sessionPath: '/workspace/c',
    fromIndex: 2,
    toIndex: 0,
  });

  assert.deepEqual(nextPaths, ['/workspace/c', '/workspace/a', '/workspace/b']);
});

test('moveOpenTabPath falls back to the drag source index when the tab path changed mid-drag', () => {
  const nextPaths = moveOpenTabPath(['/workspace/a', '/workspace/resolved', '/workspace/c'], {
    sessionPath: '__pending__:1',
    fromIndex: 1,
    toIndex: 0,
  });

  assert.deepEqual(nextPaths, ['/workspace/resolved', '/workspace/a', '/workspace/c']);
});

test('getHorizontalDropIndex returns the boundary between tab midpoints', () => {
  const rects = [
    { left: 0, right: 100 },
    { left: 110, right: 210 },
    { left: 220, right: 320 },
  ];

  assert.equal(getHorizontalDropIndex(rects, -10), 0);
  assert.equal(getHorizontalDropIndex(rects, 40), 0);
  assert.equal(getHorizontalDropIndex(rects, 160), 1);
  assert.equal(getHorizontalDropIndex(rects, 260), 2);
  assert.equal(getHorizontalDropIndex(rects, 400), 3);
});

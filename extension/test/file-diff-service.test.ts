import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Module } from 'node:module';

import { createInitialArchState } from '../src/host/core/arch-state';
import type { ArchState } from '../src/host/core/arch-state';
import type { FileChangeEntry } from '../src/shared/protocol';

// file-diff-service.ts does `import * as vscode from 'vscode'`, which tsx
// transpiles to `require('vscode')`. There is no `vscode` runtime module under
// node_modules in this repo (only @types/vscode), so we intercept the bare
// 'vscode' specifier at the CJS loader and return an inline mock. The mock's
// `workspace.workspaceFolders` is mutable so per-test cases can exercise both
// the "fallback present" and "fallback absent" branches of resolveFileChangePath.
const vscodeMock = {
  workspace: {
    workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  commands: { executeCommand: async () => undefined },
  window: { showWarningMessage: async () => undefined },
};
// `Module._load` is an internal/undocumented hook (absent from @types/node),
// so cast to a small typed shape. The patch is installed in `test.before` only
// long enough to resolve `vscode` during the lazy import, then restored in a
// `finally` (mirroring backend-client.test.ts's finally-scoped restore). The
// immediate restore matters: node:test's top-level after hooks are GLOBAL under
// --test-isolation=none, so a hook-only restore would leave the shim live for
// the whole run and leak it into other files sharing the process. file-diff-
// service captures its `vscode` binding at load time, so the shim is unneeded
// once the import returns. A defensive `test.after` is kept as a backstop.
const NodeModule = Module as unknown as {
  _load: (request: string, ...rest: unknown[]) => unknown;
};
let origLoad: ((request: string, ...rest: unknown[]) => unknown) | undefined;

// Imported lazily (after the vscode shim is in place) because the module
// resolves `vscode` at load time. arch-state is pure (no vscode) so it is
// imported statically above.
let FileDiffService: typeof import('../src/host/core/file-diff-service').FileDiffService;

test.before(async () => {
  origLoad = NodeModule._load.bind(NodeModule);
  NodeModule._load = (request: string, ...rest: unknown[]) => {
    if (request === 'vscode') return vscodeMock;
    return origLoad!(request, ...rest);
  };
  try {
    ({ FileDiffService } = await import('../src/host/core/file-diff-service'));
  } finally {
    NodeModule._load = origLoad;
    origLoad = undefined;
  }
});

test.after(() => {
  // Defensive backstop: restore if `before` threw before its finally ran.
  if (origLoad) {
    NodeModule._load = origLoad;
    origLoad = undefined;
  }
});

function archStateWith(over: {
  sessions?: Array<{ path: string; cwd: string }>;
  workspaceCwd?: string | null;
  fileChanges?: Record<string, FileChangeEntry[]>;
}): ArchState {
  const s = createInitialArchState();
  return {
    ...s,
    sessions: {
      ...s.sessions,
      sessions: (over.sessions ?? s.sessions.sessions) as ArchState['sessions']['sessions'],
      workspaceCwd: over.workspaceCwd ?? s.sessions.workspaceCwd,
    },
    fileChanges: {
      ...s.fileChanges,
      bySession: over.fileChanges ?? s.fileChanges.bySession,
    },
  };
}

function entry(pathStr: string, kind: FileChangeEntry['kind']): FileChangeEntry {
  return { path: pathStr, kind, toolCallId: 't', messageId: 'm', description: '', timestamp: '' };
}

// ─── resolveFileChangePath ───────────────────────────────────────────────────

test('resolveFileChangePath passes an absolute path through unchanged', () => {
  const svc = new FileDiffService(() => archStateWith({}));
  assert.equal(svc.resolveFileChangePath('s', '/abs/file.txt'), '/abs/file.txt');
});

test('resolveFileChangePath resolves a relative path against the matching session cwd', () => {
  const svc = new FileDiffService(() =>
    archStateWith({ sessions: [{ path: 's', cwd: '/proj' }] }),
  );
  assert.equal(
    svc.resolveFileChangePath('s', 'a/b.txt'),
    path.resolve('/proj', 'a/b.txt'),
  );
});

test('resolveFileChangePath falls back to workspaceCwd when the session is unknown', () => {
  const svc = new FileDiffService(() => archStateWith({ workspaceCwd: '/ws' }));
  assert.equal(svc.resolveFileChangePath('missing', 'a.txt'), path.resolve('/ws', 'a.txt'));
});

test('resolveFileChangePath prefers the session cwd over workspaceCwd', () => {
  const svc = new FileDiffService(() =>
    archStateWith({ sessions: [{ path: 's', cwd: '/proj' }], workspaceCwd: '/ws' }),
  );
  assert.equal(svc.resolveFileChangePath('s', 'a.txt'), path.resolve('/proj', 'a.txt'));
});

test('resolveFileChangePath falls back to the first vscode workspace folder when nothing else is set', () => {
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/ws/root' } }];
  try {
    const svc = new FileDiffService(() => archStateWith({ workspaceCwd: null }));
    assert.equal(svc.resolveFileChangePath('s', 'rel/file.txt'), path.resolve('/ws/root', 'rel/file.txt'));
  } finally {
    vscodeMock.workspace.workspaceFolders = undefined;
  }
});

test('resolveFileChangePath returns the relative path unchanged when no base path is available anywhere', () => {
  vscodeMock.workspace.workspaceFolders = undefined;
  const svc = new FileDiffService(() => archStateWith({ workspaceCwd: null }));
  assert.equal(svc.resolveFileChangePath('s', 'rel/file.txt'), 'rel/file.txt');
});

// ─── getFileChangeKind ───────────────────────────────────────────────────────

test('getFileChangeKind defaults to "modified" when the session has no entries', () => {
  const svc = new FileDiffService(() => archStateWith({}));
  assert.equal(svc.getFileChangeKind('s', 'x.txt', '/abs/x.txt'), 'modified');
});

test('getFileChangeKind returns the entry kind when entry.path matches filePath', () => {
  const svc = new FileDiffService(() =>
    archStateWith({ fileChanges: { s: [entry('x.txt', 'created')] } }),
  );
  assert.equal(svc.getFileChangeKind('s', 'x.txt', '/abs/x.txt'), 'created');
});

test('getFileChangeKind matches by resolved path even when entry.path differs from filePath', () => {
  // entry.path is relative ('a/b.txt'); filePath is a different label ('x.txt')
  // but resolvedPath equals the entry's resolved path → match.
  const svc = new FileDiffService(() =>
    archStateWith({
      sessions: [{ path: 's', cwd: '/proj' }],
      fileChanges: { s: [entry('a/b.txt', 'deleted')] },
    }),
  );
  const resolved = path.resolve('/proj', 'a/b.txt');
  assert.equal(svc.getFileChangeKind('s', 'x.txt', resolved), 'deleted');
});

test('getFileChangeKind returns "modified" when entries exist but none match', () => {
  const svc = new FileDiffService(() =>
    archStateWith({ fileChanges: { s: [entry('other.txt', 'created')] } }),
  );
  assert.equal(svc.getFileChangeKind('s', 'x.txt', '/abs/x.txt'), 'modified');
});

test('getFileChangeKind picks the matching entry out of several', () => {
  const svc = new FileDiffService(() =>
    archStateWith({
      fileChanges: { s: [entry('first.txt', 'created'), entry('second.txt', 'deleted')] },
    }),
  );
  assert.equal(svc.getFileChangeKind('s', 'second.txt', '/abs/second.txt'), 'deleted');
});

test('getFileChangeKind treats an empty entry list for the session as "modified"', () => {
  const svc = new FileDiffService(() => archStateWith({ fileChanges: { s: [] } }));
  assert.equal(svc.getFileChangeKind('s', 'x.txt', '/abs/x.txt'), 'modified');
});

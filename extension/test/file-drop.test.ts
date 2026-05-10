import assert from 'node:assert/strict';
import test from 'node:test';

import { canAcceptPathDrop, extractDroppedPaths } from '../src/webview/panel/file-drop';

function makeTransfer(options: {
  types?: string[];
  textPlain?: string;
  uriList?: string;
  files?: Array<{ path?: string }>;
}) {
  return {
    types: options.types ?? [],
    files: options.files ?? [],
    getData(format: string): string {
      if (format === 'text/plain') return options.textPlain ?? '';
      if (format === 'text/uri-list') return options.uriList ?? '';
      return '';
    },
  };
}

test('extractDroppedPaths prefers file URIs from text/uri-list', () => {
  const dataTransfer = makeTransfer({
    types: ['text/uri-list', 'Files'],
    uriList: [
      '# comment',
      'file:///C:/workspaces/pi-config/README.md',
      'file:///C:/workspaces/pi-config/README.md',
      'file:///C:/workspaces/pi-config/src/index.ts',
    ].join('\r\n'),
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), [
    'C:\\workspaces\\pi-config\\README.md',
    'C:\\workspaces\\pi-config\\src\\index.ts',
  ]);
});

test('extractDroppedPaths converts UNC file URIs to Windows paths', () => {
  const dataTransfer = makeTransfer({
    types: ['text/uri-list'],
    uriList: 'file://server/share/folder/file.txt',
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), ['\\\\server\\share\\folder\\file.txt']);
});

test('extractDroppedPaths parses VS Code CodeFiles payloads', () => {
  const dataTransfer = makeTransfer({
    types: ['CodeFiles'],
    textPlain: 'not a path',
  });
  dataTransfer.getData = (format: string): string => {
    if (format === 'CodeFiles') {
      return JSON.stringify(['C:/repo/from-explorer.ts', 'C:/repo/from-explorer.ts']);
    }
    if (format === 'text/plain') {
      return 'not a path';
    }
    return '';
  };

  assert.deepEqual(extractDroppedPaths(dataTransfer), ['C:\\repo\\from-explorer.ts']);
});

test('extractDroppedPaths parses VS Code ResourceURLs payloads', () => {
  const dataTransfer = makeTransfer({
    types: ['ResourceURLs'],
  });
  dataTransfer.getData = (format: string): string => {
    if (format === 'ResourceURLs') {
      return JSON.stringify(['file:///C:/repo/from-resource.ts']);
    }
    return '';
  };

  assert.deepEqual(extractDroppedPaths(dataTransfer), ['C:\\repo\\from-resource.ts']);
});

test('canAcceptPathDrop accepts explicit file drag types without reading payloads', () => {
  for (const type of ['Files', 'CodeFiles', 'CodeEditors', 'ResourceURLs', 'application/vnd.code.uri-list']) {
    const dataTransfer = makeTransfer({ types: [type] });
    dataTransfer.getData = (): string => {
      throw new Error('payload unavailable during hover');
    };

    assert.equal(canAcceptPathDrop(dataTransfer), true, `expected ${type} to be accepted during hover`);
  }
});

test('canAcceptPathDrop accepts file drags when the browser exposes files without useful types', () => {
  const dataTransfer = makeTransfer({
    files: [{}],
  });
  dataTransfer.getData = (): string => {
    throw new Error('payload unavailable during hover');
  };

  assert.equal(canAcceptPathDrop(dataTransfer), true);
});

test('supported VS Code file drags still parse on drop after hover payload access fails', () => {
  const hoverTransfer = makeTransfer({
    types: ['CodeFiles'],
  });
  hoverTransfer.getData = (): string => {
    throw new Error('payload unavailable during hover');
  };

  const dropTransfer = makeTransfer({
    types: ['CodeFiles'],
  });
  dropTransfer.getData = (format: string): string => {
    if (format === 'CodeFiles') {
      return JSON.stringify(['C:/repo/from-explorer.ts']);
    }
    return '';
  };

  assert.equal(canAcceptPathDrop(hoverTransfer), true);
  assert.deepEqual(extractDroppedPaths(dropTransfer), ['C:\\repo\\from-explorer.ts']);
});

test('canAcceptPathDrop does not treat generic URL drags as file drops', () => {
  const dataTransfer = makeTransfer({
    types: ['text/uri-list', 'text/plain'],
    uriList: 'https://example.com/readme',
    textPlain: 'https://example.com/readme',
  });

  assert.equal(canAcceptPathDrop(dataTransfer), true);
  assert.deepEqual(extractDroppedPaths(dataTransfer), []);
});

test('extractDroppedPaths accepts plain text absolute paths only', () => {
  const dataTransfer = makeTransfer({
    types: ['text/plain'],
    textPlain: 'C:/repo/a.ts\n\\\\server\\share\\b.ts',
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), [
    'C:\\repo\\a.ts',
    '\\\\server\\share\\b.ts',
  ]);
});

test('extractDroppedPaths rejects arbitrary dragged text', () => {
  const dataTransfer = makeTransfer({
    types: ['text/plain'],
    textPlain: 'dragged text from the editor',
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), []);
  assert.equal(canAcceptPathDrop(dataTransfer), true);
});

test('extractDroppedPaths falls back to file.path when present', () => {
  const dataTransfer = makeTransfer({
    types: ['Files'],
    files: [{ path: 'C:\\repo\\alpha.ts' }, { path: 'C:\\repo\\beta.ts' }],
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), [
    'C:\\repo\\alpha.ts',
    'C:\\repo\\beta.ts',
  ]);
});

test('canAcceptPathDrop detects file-like drag payloads without parsing plain text drags', () => {
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['Files'] })), true);
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['CodeFiles'] })), true);
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['ResourceURLs'] })), true);
  assert.equal(
    canAcceptPathDrop(makeTransfer({ types: ['text/uri-list'], uriList: 'file:///tmp/app.ts' })),
    true,
  );
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['text/plain'], textPlain: '/tmp/app.ts' })), true);
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['text/plain'], textPlain: 'hello world' })), true);
});

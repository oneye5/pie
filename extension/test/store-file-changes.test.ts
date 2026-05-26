import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  deriveFileChangeFromToolCall,
  deriveFileChangesFromTranscript,
  fileChangesActions,
  fileChangesReducer,
} from '../src/host/store/file-changes-slice';
import type { FileChangeEntry } from '../src/shared/protocol';

describe('fileChanges slice', () => {
  it('removeFileChange drops an exact match', () => {
    const change: FileChangeEntry = {
      path: 'src/foo.ts',
      kind: 'created',
      toolCallId: 't1',
      messageId: 'm1',
      description: 'created',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const state = fileChangesReducer(
      { bySession: { '/session/a': [change] } },
      fileChangesActions.removeFileChange({ sessionPath: '/session/a', path: 'src/foo.ts' }),
    );
    assert.deepStrictEqual(state.bySession['/session/a'], []);
  });

  it('removeFileChange normalises separators on Windows-style paths', () => {
    const change: FileChangeEntry = {
      path: 'src/foo.ts',
      kind: 'created',
      toolCallId: 't1',
      messageId: 'm1',
      description: 'created',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const state = fileChangesReducer(
      { bySession: { '/session/a': [change] } },
      fileChangesActions.removeFileChange({ sessionPath: '/session/a', path: 'src\\foo.ts' }),
    );
    assert.deepStrictEqual(state.bySession['/session/a'], []);
  });

  it('removeFileChange ignores mismatched paths', () => {
    const change: FileChangeEntry = {
      path: 'src/foo.ts',
      kind: 'created',
      toolCallId: 't1',
      messageId: 'm1',
      description: 'created',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const state = fileChangesReducer(
      { bySession: { '/session/a': [change] } },
      fileChangesActions.removeFileChange({ sessionPath: '/session/a', path: 'src/bar.ts' }),
    );
    assert.deepStrictEqual(state.bySession['/session/a'], [change]);
  });

  it('removeFileChange is a no-op for unknown sessions', () => {
    const state = fileChangesReducer(
      { bySession: {} },
      fileChangesActions.removeFileChange({ sessionPath: '/session/a', path: 'src/foo.ts' }),
    );
    assert.deepStrictEqual(state.bySession, {});
  });

  it('setFileChanges, addFileChange, and clearFileChanges manage per-session state', () => {
    const created: FileChangeEntry = {
      path: 'src/created.ts',
      kind: 'created',
      toolCallId: 't1',
      messageId: 'm1',
      description: 'created',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const updated: FileChangeEntry = {
      ...created,
      description: 'edited',
      kind: 'modified',
    };

    const afterSet = fileChangesReducer(
      { bySession: {} },
      fileChangesActions.setFileChanges({ sessionPath: '/session/a', changes: [created] }),
    );
    const afterReplace = fileChangesReducer(
      afterSet,
      fileChangesActions.addFileChange({ sessionPath: '/session/a', change: updated }),
    );
    const afterAppend = fileChangesReducer(
      afterReplace,
      fileChangesActions.addFileChange({
        sessionPath: '/session/a',
        change: {
          path: 'src/second.ts',
          kind: 'modified',
          toolCallId: 't2',
          messageId: 'm2',
          description: 'bash',
          timestamp: '2024-01-01T00:00:01Z',
        },
      }),
    );
    const afterClear = fileChangesReducer(afterAppend, fileChangesActions.clearFileChanges('/session/a'));

    assert.deepStrictEqual(afterSet.bySession['/session/a'], [created]);
    assert.deepStrictEqual(afterReplace.bySession['/session/a'], [updated]);
    assert.equal(afterAppend.bySession['/session/a']?.length, 2);
    assert.equal(afterClear.bySession['/session/a'], undefined);
  });

  it('addFileChange accumulates additions/deletions for the same file', () => {
    const first: FileChangeEntry = {
      path: 'src/foo.ts',
      kind: 'modified',
      toolCallId: 't1',
      messageId: 'm1',
      description: 'edited',
      timestamp: '2024-01-01T00:00:00Z',
      additions: 5,
      deletions: 3,
    };
    const second: FileChangeEntry = {
      path: 'src/foo.ts',
      kind: 'modified',
      toolCallId: 't2',
      messageId: 'm2',
      description: 'edited',
      timestamp: '2024-01-01T00:00:01Z',
      additions: 10,
      deletions: 2,
    };

    const afterFirst = fileChangesReducer(
      { bySession: {} },
      fileChangesActions.addFileChange({ sessionPath: '/session/a', change: first }),
    );
    const afterSecond = fileChangesReducer(
      afterFirst,
      fileChangesActions.addFileChange({ sessionPath: '/session/a', change: second }),
    );

    assert.deepStrictEqual(afterSecond.bySession['/session/a'], [{
      path: 'src/foo.ts',
      kind: 'modified',
      toolCallId: 't2',
      messageId: 'm2',
      description: 'edited',
      timestamp: '2024-01-01T00:00:01Z',
      additions: 15,
      deletions: 5,
    }]);
  });

  it('deriveFileChangeFromToolCall classifies write/edit/delete and skips non-file tools', () => {
    assert.deepStrictEqual(
      deriveFileChangeFromToolCall({ id: '1', name: 'write', input: { path: 'src/new.ts' } }, 'm1', '2024-01-01T00:00:00Z'),
      {
        path: 'src/new.ts',
        kind: 'created',
        toolCallId: '1',
        messageId: 'm1',
        description: 'created',
        timestamp: '2024-01-01T00:00:00Z',
      },
    );
    assert.deepStrictEqual(
      deriveFileChangeFromToolCall({ id: '2', name: 'edit_file', input: { path: 'src/edit.ts', edits: [{ oldText: 'a', newText: 'b' }] } }, 'm2', '2024-01-01T00:00:00Z'),
      {
        path: 'src/edit.ts',
        kind: 'modified',
        toolCallId: '2',
        messageId: 'm2',
        description: '1 edits',
        timestamp: '2024-01-01T00:00:00Z',
        additions: 1,
        deletions: 1,
      },
    );
    assert.deepStrictEqual(
      deriveFileChangeFromToolCall({ id: '3', name: 'delete_file', input: { filePath: 'src/old.ts' } }, 'm3', '2024-01-01T00:00:00Z'),
      {
        path: 'src/old.ts',
        kind: 'deleted',
        toolCallId: '3',
        messageId: 'm3',
        description: 'deleted',
        timestamp: '2024-01-01T00:00:00Z',
      },
    );
    assert.deepStrictEqual(
      deriveFileChangeFromToolCall({ id: '4', name: 'bash', input: { targetPath: 'src/bash.ts' } }, 'm4', '2024-01-01T00:00:00Z'),
      {
        path: 'src/bash.ts',
        kind: 'modified',
        toolCallId: '4',
        messageId: 'm4',
        description: 'bash',
        timestamp: '2024-01-01T00:00:00Z',
      },
    );
    assert.equal(deriveFileChangeFromToolCall({ id: '5', name: 'search', input: { path: 'src/ignored.ts' } }, 'm5', '2024-01-01T00:00:00Z'), null);
    assert.equal(deriveFileChangeFromToolCall({ id: '6', name: 'edit', input: {} }, 'm6', '2024-01-01T00:00:00Z'), null);
  });

  it('deriveFileChangesFromTranscript accumulates stats for repeated edits to the same file', () => {
    const transcript = [
      {
        id: 'assistant-1',
        role: 'assistant',
        createdAt: '2024-01-01T00:00:00Z',
        markdown: '',
        status: 'completed',
        toolCalls: [
          { id: 't1', name: 'write', input: { path: 'src/a.ts' }, status: 'completed' },
          { id: 't2', name: 'edit', input: { path: 'src/a.ts', oldText: 'a', newText: 'b' }, status: 'completed' },
          { id: 't3', name: 'delete_file', input: { filePath: 'src/b.ts' }, status: 'failed' },
        ],
      },
      {
        id: 'user-1',
        role: 'user',
        createdAt: '2024-01-01T00:00:01Z',
        markdown: 'ignored',
        status: 'completed',
      },
    ] as any;

    assert.deepStrictEqual(deriveFileChangesFromTranscript(transcript), [{
      path: 'src/a.ts',
      kind: 'modified',
      toolCallId: 't2',
      messageId: 'assistant-1',
      description: 'edited',
      timestamp: '2024-01-01T00:00:00Z',
      additions: 1,
      deletions: 1,
    }]);
  });
});

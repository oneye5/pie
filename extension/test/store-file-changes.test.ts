import { describe, it } from 'node:test';
import assert from 'node:assert';

import { fileChangesActions, fileChangesReducer } from '../src/host/store/file-changes-slice';
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
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateMessageSend,
  validateSessionCreate,
  validateSessionOpen,
} from '../src/backend/rpc';

test('validateMessageSend requires an explicit sessionPath', () => {
  assert.throws(
    () => validateMessageSend({ text: 'hello' }),
    /sessionPath/,
  );
});

test('validateSessionCreate accepts an optional selection token', () => {
  assert.deepEqual(
    validateSessionCreate({ cwd: '/workspace', selectionToken: 'selection:1' }),
    { cwd: '/workspace', selectionToken: 'selection:1' },
  );
});

test('validateSessionOpen accepts an optional selection token', () => {
  assert.deepEqual(
    validateSessionOpen({ sessionPath: '/workspace/session.jsonl', selectionToken: 'selection:2' }),
    { sessionPath: '/workspace/session.jsonl', selectionToken: 'selection:2' },
  );
});
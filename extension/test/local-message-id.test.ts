import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalMessageId } from '../src/shared/local-message-id';

test('createLocalMessageId creates send ids by default', (t) => {
  t.mock.method(Date, 'now', () => 1234);
  t.mock.method(Math, 'random', () => 0.5);

  assert.equal(createLocalMessageId(), `local:1234:${(0.5).toString(36).slice(2)}`);
});

test('createLocalMessageId creates edit ids with the edit prefix', (t) => {
  t.mock.method(Date, 'now', () => 5678);
  t.mock.method(Math, 'random', () => 0.25);

  assert.equal(createLocalMessageId('edit'), `local:edit:5678:${(0.25).toString(36).slice(2)}`);
});

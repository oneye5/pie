import test from 'node:test';
import assert from 'node:assert/strict';

import { toErrorMessage } from '../src/host/util/error-message';

test('toErrorMessage normalizes any thrown value into a human-readable string', () => {
  // Error with a message
  assert.equal(toErrorMessage(new Error('boom')), 'boom');

  // Error with an empty message falls back to the constructor name
  assert.equal(toErrorMessage(new Error('')), 'Error');

  // Bare string throw
  assert.equal(toErrorMessage('something broke'), 'something broke');

  // RPC-style objects exposing message / error / code
  assert.equal(toErrorMessage({ message: 'rpc failed' }), 'rpc failed');
  assert.equal(toErrorMessage({ error: 'denied' }), 'denied');
  assert.equal(toErrorMessage({ code: 'ENOENT' }), 'ENOENT');

  // null / undefined
  assert.equal(toErrorMessage(null), 'Unknown error');
  assert.equal(toErrorMessage(undefined), 'Unknown error');

  // number / plain object fall back to String(err)
  assert.equal(toErrorMessage(42), '42');
  assert.equal(toErrorMessage({ foo: 'bar' }), '[object Object]');
});
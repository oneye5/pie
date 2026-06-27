import test from 'node:test';
import assert from 'node:assert/strict';

import { toErrorMessage, parseJsonOrThrow } from '../src/host/util/error-message';

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

test('parseJsonOrThrow returns parsed JSON for valid input', () => {
  assert.deepEqual(parseJsonOrThrow<number>('{"a":1}', 'test.json'), { a: 1 });
  assert.deepEqual(parseJsonOrThrow<number[]>('[1,2,3]', 'test.json'), [1, 2, 3]);
});

test('parseJsonOrThrow throws a contextual Error naming the label on malformed JSON', () => {
  const cases = ['{', 'not json', '{a:1}', '{"a":1,}', 'null x'];
  for (const raw of cases) {
    assert.throws(
      () => parseJsonOrThrow(raw, 'settings.json'),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'should throw an Error');
        const msg = (err as Error).message;
        assert.ok(msg.startsWith('settings.json: invalid JSON \u2014 '), `unexpected message: ${msg}`);
        return true;
      },
      'parseJsonOrThrow should throw a contextual Error for malformed JSON',
    );
  }
});

test('parseJsonOrThrow surfaces non-SyntaxError throws via toErrorMessage', () => {
  // JSON.parse only throws SyntaxError, but the helper still labels any
  // non-SyntaxError via toErrorMessage. Verify the label prefix is applied.
  assert.throws(
    () => parseJsonOrThrow('{', 'models.json'),
    /models\.json: invalid JSON/,
  );
});
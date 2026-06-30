import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CHAT_PREFS,
  EMPTY_SUBAGENT_BUCKETS,
  normalizeSubagentBuckets,
  resolveChatPrefs,
} from '../src/shared/protocol';

test('DEFAULT_CHAT_PREFS seeds empty subagent buckets', () => {
  assert.deepEqual(DEFAULT_CHAT_PREFS.subagentBuckets, { small: [], medium: [], frontier: [] });
  // and a distinct copy, not the shared EMPTY_SUBAGENT_BUCKETS reference
  assert.notEqual(DEFAULT_CHAT_PREFS.subagentBuckets, EMPTY_SUBAGENT_BUCKETS);
});

test('normalizeSubagentBuckets returns empty buckets for non-object input', () => {
  assert.deepEqual(normalizeSubagentBuckets(undefined), { small: [], medium: [], frontier: [] });
  assert.deepEqual(normalizeSubagentBuckets(null), { small: [], medium: [], frontier: [] });
  assert.deepEqual(normalizeSubagentBuckets(['a']), { small: [], medium: [], frontier: [] });
  assert.deepEqual(normalizeSubagentBuckets('nope'), { small: [], medium: [], frontier: [] });
});

test('normalizeSubagentBuckets coerces a well-formed value', () => {
  assert.deepEqual(
    normalizeSubagentBuckets({ small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] }),
    { small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] },
  );
});

test('normalizeSubagentBuckets drops non-array / non-string entries', () => {
  assert.deepEqual(
    normalizeSubagentBuckets({ small: 'haiku', medium: [1, 'sonnet', null, ''], frontier: ['opus'] }),
    { small: [], medium: ['sonnet'], frontier: ['opus'] },
  );
});

test('normalizeSubagentBuckets defaults missing bucket keys to empty', () => {
  assert.deepEqual(
    normalizeSubagentBuckets({ medium: ['sonnet'] }),
    { small: [], medium: ['sonnet'], frontier: [] },
  );
});

test('resolveChatPrefs fills subagentBuckets from defaults when absent', () => {
  const resolved = resolveChatPrefs(null);
  assert.deepEqual(resolved.subagentBuckets, { small: [], medium: [], frontier: [] });
});

test('resolveChatPrefs normalizes a malformed stored subagentBuckets', () => {
  const resolved = resolveChatPrefs({
    // @ts-expect-error intentionally malformed stored value
    subagentBuckets: { small: 'haiku', medium: [1, 'sonnet'], frontier: null },
  });
  assert.deepEqual(resolved.subagentBuckets, { small: [], medium: ['sonnet'], frontier: [] });
});

test('resolveChatPrefs preserves a valid stored subagentBuckets', () => {
  const resolved = resolveChatPrefs({
    subagentBuckets: { small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] },
  });
  assert.deepEqual(resolved.subagentBuckets, { small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] });
});

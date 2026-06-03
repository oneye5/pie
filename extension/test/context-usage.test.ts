import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveFallbackContextUsageFromBranch } from '../src/backend/context-usage';
import type { SessionEntryLike } from '../src/backend/transcript';

test('deriveFallbackContextUsageFromBranch returns undefined without a valid context window', () => {
  const entries: SessionEntryLike[] = [
    {
      id: '1',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', usage: { input: 10, output: 5 } },
    },
  ];

  assert.equal(deriveFallbackContextUsageFromBranch(entries, undefined), undefined);
  assert.equal(deriveFallbackContextUsageFromBranch(entries, 0), undefined);
  assert.equal(deriveFallbackContextUsageFromBranch(entries, Number.NaN), undefined);
});

test('deriveFallbackContextUsageFromBranch uses latest assistant prompt footprint', () => {
  const entries: SessionEntryLike[] = [
    {
      id: 'old',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', usage: { input: 30, output: 20, cacheRead: 5 } },
    },
    {
      id: 'latest',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        usage: { prompt_tokens: 40, completion_tokens: 11, prompt_tokens_details: { cached_tokens: 7 } },
      },
    },
  ];

  assert.deepEqual(deriveFallbackContextUsageFromBranch(entries, 100), {
    tokens: 40,
    contextWindow: 100,
    percent: 40,
  });
});

test('deriveFallbackContextUsageFromBranch falls back to total tokens and clamps percent', () => {
  const entries: SessionEntryLike[] = [
    {
      id: '1',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', usage: { total_tokens: 400 } },
    },
  ];

  assert.deepEqual(deriveFallbackContextUsageFromBranch(entries, 100), {
    tokens: 400,
    contextWindow: 100,
    percent: 100,
  });
});

test('deriveFallbackContextUsageFromBranch returns undefined when no assistant usage exists', () => {
  const entries: SessionEntryLike[] = [
    {
      id: '1',
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    },
  ];

  assert.equal(deriveFallbackContextUsageFromBranch(entries, 100), undefined);
});

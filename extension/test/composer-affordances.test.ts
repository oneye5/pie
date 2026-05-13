import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeImagePasteAffordance,
  describeRunAnalyticsStatus,
  shouldHandleGlobalComposerPaste,
} from '../src/webview/panel/composer-affordances';

function closestTarget(matchesBlockingSelector: boolean): EventTarget {
  return {
    closest: (selector: string) => (selector.includes('textarea') ? (matchesBlockingSelector ? {} : null) : null),
  } as unknown as EventTarget;
}

test('shouldHandleGlobalComposerPaste allows ordinary panel paste targets', () => {
  assert.equal(shouldHandleGlobalComposerPaste(closestTarget(false)), true);
});

test('shouldHandleGlobalComposerPaste suppresses editable descendants', () => {
  assert.equal(shouldHandleGlobalComposerPaste(closestTarget(true)), false);
});

test('shouldHandleGlobalComposerPaste follows parentElement for text-node-like targets', () => {
  const parent = {
    closest: () => ({}),
  };
  const textNodeLike = {
    parentElement: parent,
  };

  assert.equal(shouldHandleGlobalComposerPaste(textNodeLike as unknown as EventTarget), false);
});

test('shouldHandleGlobalComposerPaste defaults to handling when target cannot use closest', () => {
  assert.equal(shouldHandleGlobalComposerPaste({} as EventTarget), true);
});

test('describeRunAnalyticsStatus reflects local run-tracking state', () => {
  assert.equal(describeRunAnalyticsStatus(null), 'Local analytics ready');
  assert.equal(describeRunAnalyticsStatus({ runId: 'run-open', status: 'open', scored: false }), 'Local analytics tracking');
  assert.equal(
    describeRunAnalyticsStatus({ runId: 'run-rate', status: 'closed_unscored', scored: false }),
    'Local analytics awaiting rating',
  );
  assert.equal(describeRunAnalyticsStatus({ runId: 'run-scored', status: 'scored', scored: true }), 'Local analytics scored');
});

test('describeImagePasteAffordance explains when screenshot paste is available', () => {
  assert.equal(describeImagePasteAffordance(true), 'Paste screenshots anywhere in chat');
  assert.equal(
    describeImagePasteAffordance(false),
    'Switch to an image-capable model to paste screenshots',
  );
});

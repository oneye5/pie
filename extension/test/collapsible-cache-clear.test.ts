import test from 'node:test';
import assert from 'node:assert/strict';

import { clearCollapsibleCache } from '../src/webview/panel/transcript/use-collapsible-open';

test('clearCollapsibleCache is callable and does not throw on empty cache', () => {
  // The module-level Maps start empty (or may have entries from other tests).
  // Calling clear should always succeed without error.
  assert.doesNotThrow(() => clearCollapsibleCache());
});

test('clearCollapsibleCache is idempotent — calling twice does not throw', () => {
  clearCollapsibleCache();
  assert.doesNotThrow(() => clearCollapsibleCache());
});

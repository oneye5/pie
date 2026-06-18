import test from 'node:test';
import assert from 'node:assert/strict';

import { clearDisclosureCache } from '../src/webview/panel/transcript/use-disclosure-open';

test('clearDisclosureCache is callable and does not throw on empty cache', () => {
  // The module-level Maps start empty (or may have entries from other tests).
  // Calling clear should always succeed without error.
  assert.doesNotThrow(() => clearDisclosureCache());
});

test('clearDisclosureCache is idempotent — calling twice does not throw', () => {
  clearDisclosureCache();
  assert.doesNotThrow(() => clearDisclosureCache());
});

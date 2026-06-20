import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { UiFlyout } from '../src/webview/panel/composer/settings-menu-subcomponents';
import { DEFAULT_CHAT_PREFS } from '../src/shared/protocol';
import type { ChatPrefs } from '../src/shared/protocol';

function prefsWith(overrides: Partial<ChatPrefs>): ChatPrefs {
  return { ...DEFAULT_CHAT_PREFS, ...overrides };
}

test('UiFlyout renders the message-width slider bound to the pref value', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({ uiMessageWidth: 70 }),
    onSetPrefs: () => undefined,
  }));

  // The slider carries the configured range and the current value, and the
  // head label mirrors it as "70%".
  assert.match(html, /<input[^>]*type="range"[^>]*>/);
  assert.match(html, /<input[^>]*min="60"[^>]*max="100"[^>]*step="2"[^>]*value="70"[^>]*aria-label="Message width"/);
  assert.match(html, />70%</);
});

test('UiFlyout reduce-motion switch reflects the off state', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({ uiReduceMotion: false }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Reduce motion"/);
  // Off state must not carry the "on" class.
  const switchBtn = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? '';
  assert.doesNotMatch(switchBtn, /class="toolbar-settings-ui-toggle on"/);
});

test('UiFlyout reduce-motion switch reflects the on state', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({ uiReduceMotion: true }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /<button[^>]*role="switch"[^>]*aria-checked="true"[^>]*aria-label="Reduce motion"/);
  assert.match(html, /class="toolbar-settings-ui-toggle on"/);
});

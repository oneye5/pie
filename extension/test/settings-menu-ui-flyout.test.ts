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

test('UiFlyout selects the Night theme by default and lists all themes', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({}),
    onSetPrefs: () => undefined,
  }));

  // Lookahead pattern: match the <option> tag whose attribute list contains
  // both selected and value="night", regardless of attribute order.
  assert.match(html, /<option\b(?=[^>]*selected)(?=[^>]*value="night")[^>]*>Night</);
  assert.match(html, />Slate</);
  assert.match(html, />Warm</);
  assert.match(html, />Midnight</);
  assert.match(html, />Carbon</);
});

test('UiFlyout shows Custom when colors do not match a preset', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({ uiAccentColor: '#abcdef' }),
    onSetPrefs: () => undefined,
  }));

  // Preact renders an empty-string option value as the bare attribute `value`.
  assert.match(html, /<option[^>]*>Custom</);
  assert.match(html, /<option selected value>Custom</);
});

test('UiFlyout renders all color rows with default swatches and reset buttons', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({}),
    onSetPrefs: () => undefined,
  }));

  // Four color inputs and their labels.
  assert.match(html, /Background/);
  assert.match(html, /Text/);
  assert.match(html, /Border/);
  assert.match(html, /Accent/);

  // Default swatches.
  assert.match(html, /<input[^>]*type="color"[^>]*value="#050506"[^>]*aria-label="Background color"/);
  assert.match(html, /<input[^>]*type="color"[^>]*value="#f2eee4"[^>]*aria-label="Text color"/);
  assert.match(html, /<input[^>]*type="color"[^>]*value="#f2eee4"[^>]*aria-label="Border color"/);
  assert.match(html, /<input[^>]*type="color"[^>]*value="#d7a942"[^>]*aria-label="Accent color"/);

  // Reset buttons are disabled because none of the colors are overridden.
  const resetButtons = html.match(/<button[^>]*class="toolbar-settings-color-reset"/g) ?? [];
  assert.equal(resetButtons.length, 4, 'expected one reset button per color row');
  assert.doesNotMatch(html, /class="toolbar-settings-color-reset"[^>]*disabled=""/);
});

test('UiFlyout color rows enable Reset only when their pref is overridden', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({ uiBackground: '#0d1117', uiAccentColor: '#abcdef' }),
    onSetPrefs: () => undefined,
  }));

  // Enabled buttons have no disabled attribute; disabled ones do.
  const totalResets = (html.match(/class="toolbar-settings-color-reset"/g) ?? []).length;
  const disabledResets = (html.match(/class="toolbar-settings-color-reset"[^>]*disabled[^>]*>/g) ?? []).length;
  assert.equal(totalResets, 4, 'expected one reset button per color row');
  assert.equal(totalResets - disabledResets, 2, 'expected exactly the two overridden rows to be resettable');
});

test('UiFlyout renders the corner-radius slider with the current value and range', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({ uiCornerRadius: 12 }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Corner radius/);
  assert.match(html, />12px</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="0"[^>]*max="16"[^>]*step="1"[^>]*value="12"[^>]*aria-label="Corner radius"/);
});

test('UiFlyout renders the density select with comfortable selected by default', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({}),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Density/);
  assert.match(html, /<option\b(?=[^>]*selected)(?=[^>]*value="comfortable")[^>]*>Comfortable</);
  assert.match(html, />Compact</);
  assert.match(html, />Spacious</);
});

test('UiFlyout renders the message-width slider with the current value', () => {
  const html = renderToString(h(UiFlyout, {
    prefs: prefsWith({ uiMessageWidth: 70 }),
    onSetPrefs: () => undefined,
  }));

  assert.match(html, /Message width/);
  assert.match(html, />70%</);
  assert.match(html, /<input[^>]*type="range"[^>]*min="60"[^>]*max="100"[^>]*step="2"[^>]*value="70"[^>]*aria-label="Message width"/);
});

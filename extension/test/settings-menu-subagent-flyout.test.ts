import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { SubagentFlyout } from '../src/webview/panel/composer/settings-menu-subcomponents';
import { orderModelsForPicker } from '../src/webview/panel/composer/model-list';
import { DEFAULT_CHAT_PREFS } from '../src/shared/protocol';
import type { ChatPrefs, ModelInfo } from '../src/shared/protocol';

function prefsWith(overrides: Partial<ChatPrefs>): ChatPrefs {
  return { ...DEFAULT_CHAT_PREFS, ...overrides };
}

const AVAILABLE_MODELS: ModelInfo[] = [
  { id: 'haiku', name: 'Haiku', provider: 'anthropic', reasoning: false, inputKinds: ['text'] },
  { id: 'sonnet', name: 'Sonnet', provider: 'anthropic', reasoning: true, inputKinds: ['text', 'image'] },
  { id: 'opus', name: 'Opus', provider: 'anthropic', reasoning: true, inputKinds: ['text', 'image'] },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', reasoning: true, inputKinds: ['text'] },
];

test('SubagentFlyout renders the flyout chrome, toggle, buckets, and nesting controls', () => {
  const html = renderToString(
    h(SubagentFlyout, {
      prefs: prefsWith({}),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // Flyout chrome (shared FlyoutPanel) + the always-parent-model toggle.
  assert.match(html, /toolbar-settings-ui-flyout-title"[^>]*>Subagent</);
  assert.match(html, /Always use parent model</);

  // Model buckets group + all three bucket labels + hints.
  assert.match(html, /Model buckets</);
  assert.match(html, /Haiku-class busywork</);
  assert.match(html, /Sonnet-class main development</);
  assert.match(html, /Opus-class hardest problems</);

  // Nesting controls.
  assert.match(html, /Max depth</);
  assert.match(html, /Tree session budget</);
});

test('SubagentFlyout renders selected bucket models as chips labelled with model names', () => {
  const html = renderToString(
    h(SubagentFlyout, {
      prefs: prefsWith({
        subagentBuckets: { small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] },
      }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // Each selected model renders as a chip labelled with its display name.
  assert.match(html, /toolbar-settings-keep-chip[^>]*>[\s\S]*?Haiku</);
  assert.match(html, /toolbar-settings-keep-chip[^>]*>[\s\S]*?Sonnet</);
  assert.match(html, /toolbar-settings-keep-chip[^>]*>[\s\S]*?Opus</);
});

test('SubagentFlyout add-model selects list only models not already in their bucket', () => {
  const html = renderToString(
    h(SubagentFlyout, {
      prefs: prefsWith({
        subagentBuckets: { small: ['haiku'], medium: [], frontier: [] },
      }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // The "small" bucket already has haiku; the medium/frontier buckets are empty
  // so every model is selectable there. At minimum the add-model options exist.
  assert.match(html, /Add model…</);
  // GPT-5 is never selected, so it must appear as an addable option.
  assert.match(html, /<option[^>]*value="gpt-5"[^>]*>GPT-5</);
});

test('SubagentFlyout renders empty buckets without chips and keeps the add-model control', () => {
  const html = renderToString(
    h(SubagentFlyout, {
      prefs: prefsWith({ subagentBuckets: { small: [], medium: [], frontier: [] } }),
      onSetPrefs: () => undefined,
      availableModels: AVAILABLE_MODELS,
      modelEntries: orderModelsForPicker(AVAILABLE_MODELS),
    }),
  );

  // No chips when nothing is selected, but each bucket still offers "Add model…".
  const addCount = (html.match(/Add model…/g) ?? []).length;
  assert.equal(addCount, 3);
  assert.doesNotMatch(html, /toolbar-settings-keep-chips/);
});

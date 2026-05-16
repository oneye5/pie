import test from 'node:test';
import assert from 'node:assert/strict';

import { orderModelsForPicker } from '../src/webview/panel/composer/model-list';
import type { ModelInfo } from '../src/shared/protocol';

function model(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: overrides.name ?? id,
    provider: overrides.provider ?? 'test',
    reasoning: overrides.reasoning ?? false,
    inputKinds: overrides.inputKinds ?? ['text'],
    ...overrides,
  };
}

test('orderModelsForPicker sorts by aggregate descending and pushes ineligible models to the bottom', () => {
  const models: ModelInfo[] = [
    model('low-eligible', { subagent: { eligible: true, aggregate: 8 } }),
    model('ineligible-top', { subagent: { eligible: false, aggregate: 20, disabledReason: 'incompatible' } }),
    model('high-eligible', { subagent: { eligible: true, aggregate: 18 } }),
    model('ineligible-mid', { subagent: { eligible: false, aggregate: 12 } }),
    model('unrated', {}),
  ];

  const ordered = orderModelsForPicker(models).map((e) => e.model.id);
  assert.deepEqual(ordered, ['high-eligible', 'low-eligible', 'unrated', 'ineligible-top', 'ineligible-mid']);
});

test('orderModelsForPicker decorates ineligible options with a warning prefix and reason in the tooltip', () => {
  const ordered = orderModelsForPicker([
    model('bad', { name: 'Bad Model', subagent: { eligible: false, aggregate: 4, disabledReason: 'broken' } }),
    model('good', { name: 'Good Model', subagent: { eligible: true, aggregate: 16 } }),
  ]);
  const bad = ordered.find((e) => e.model.id === 'bad');
  const good = ordered.find((e) => e.model.id === 'good');
  assert.ok(bad && good);
  assert.equal(bad!.ineligible, true);
  assert.match(bad!.label, /^⚠ /);
  assert.equal(bad!.selectedLabel, '⚠ Bad Model');
  assert.match(bad!.title, /rating 4\/20/);
  assert.match(bad!.title, /Disabled for subagent use: broken/);
  assert.equal(good!.ineligible, false);
  assert.equal(good!.label, 'Good Model');
  assert.equal(good!.selectedLabel, 'Good Model');
  assert.match(good!.title, /rating 16\/20/);
});

test('orderModelsForPicker strips provider text only from the compact selected label', () => {
  const [entry] = orderModelsForPicker([
    model('deepseek', { name: 'Ollama Cloud: Deepseek V4 pro', subagent: { eligible: true, aggregate: 12 } }),
  ]);
  assert.equal(entry.label, 'Ollama Cloud: Deepseek V4 pro');
  assert.equal(entry.selectedLabel, 'Deepseek V4 pro');
});

test('orderModelsForPicker keeps deterministic name-based tiebreak when aggregates match', () => {
  const ordered = orderModelsForPicker([
    model('b', { name: 'Beta', subagent: { eligible: true, aggregate: 10 } }),
    model('a', { name: 'Alpha', subagent: { eligible: true, aggregate: 10 } }),
  ]).map((e) => e.model.id);
  assert.deepEqual(ordered, ['a', 'b']);
});

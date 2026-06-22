import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { loadModelFamilyMap, resolveModelFamily } from '../scripts/model-family.ts';
import { withTempDir } from './helpers.ts';

/**
 * The same underlying model is often offered by multiple providers under different ids
 * (e.g. `umans-glm-5.2` via Umans and `glm-5.2:cloud` via Ollama Cloud). `models.json`'s
 * optional `family` field declares these as siblings so analytics can collapse them into one
 * canonical family while the backend keeps storing each provider-specific id distinctly.
 */
test('loadModelFamilyMap: collapses provider-specific ids that share a declared family', async () => {
  await withTempDir(async (dir) => {
    const modelsJsonPath = path.join(dir, 'models.json');
    await fs.writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          ollama: {
            models: [
              { id: 'glm-5.2:cloud', name: 'Ollama Cloud: GLM 5.2', family: 'glm-5.2' },
              { id: 'glm-5.1:cloud', name: 'Ollama Cloud: GLM 5.1', family: 'glm-5.1' },
              // No `family` → defaults to its own id (kept distinct).
              { id: 'deepseek-v4-pro:cloud', name: 'Ollama Cloud: DeepSeek V4 Pro' },
            ],
          },
          umans: {
            models: [
              { id: 'umans-glm-5.2', name: 'Umans: GLM 5.2', family: 'glm-5.2' },
              { id: 'umans-glm-5.1', name: 'Umans: GLM 5.1', family: 'glm-5.1' },
            ],
          },
          'github-copilot': {
            modelOverrides: {
              // Override whose id already equals the canonical family — no `family` needed.
              'glm-5.2': { name: 'Copilot: GLM 5.2' },
              'gpt-5.2': { name: 'Copilot: GPT-5.2' },
            },
          },
        },
      }),
    );

    const map = loadModelFamilyMap(modelsJsonPath);

    // Provider-specific ids sharing a family collapse to the same canonical family.
    assert.equal(map.get('glm-5.2:cloud')?.family, 'glm-5.2');
    assert.equal(map.get('umans-glm-5.2')?.family, 'glm-5.2');
    assert.equal(map.get('glm-5.2')?.family, 'glm-5.2'); // copilot override, id == family
    assert.equal(map.get('glm-5.1:cloud')?.family, 'glm-5.1');
    assert.equal(map.get('umans-glm-5.1')?.family, 'glm-5.1');

    // Provider is carried so analytics can break a family down by provider.
    assert.equal(map.get('glm-5.2:cloud')?.provider, 'ollama');
    assert.equal(map.get('umans-glm-5.2')?.provider, 'umans');
    assert.equal(map.get('glm-5.2')?.provider, 'github-copilot');

    // A model with no declared family defaults to its own id — stays distinct, no spurious collapse.
    assert.equal(map.get('deepseek-v4-pro:cloud')?.family, 'deepseek-v4-pro:cloud');
    assert.equal(map.get('gpt-5.2')?.family, 'gpt-5.2');
  });
});

test('loadModelFamilyMap: returns an empty map (never throws) for a missing or malformed file', async () => {
  await withTempDir(async (dir) => {
    const missing = path.join(dir, 'does-not-exist.json');
    assert.equal(loadModelFamilyMap(missing).size, 0);

    const malformed = path.join(dir, 'malformed.json');
    await fs.writeFile(malformed, '{ not valid json');
    assert.equal(loadModelFamilyMap(malformed).size, 0);

    const notAnObject = path.join(dir, 'array.json');
    await fs.writeFile(notAnObject, '[]');
    assert.equal(loadModelFamilyMap(notAnObject).size, 0);
  });
});

test('resolveModelFamily: returns the declared family, or the model id when unregistered, or null when blank', async () => {
  await withTempDir(async (dir) => {
    const modelsJsonPath = path.join(dir, 'models.json');
    await fs.writeFile(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          umans: { models: [{ id: 'umans-glm-5.2', family: 'glm-5.2' }] },
        },
      }),
    );
    const map = loadModelFamilyMap(modelsJsonPath);

    assert.equal(resolveModelFamily('umans-glm-5.2', map), 'glm-5.2');
    // Unregistered model → falls back to its own id (kept distinct, no spurious grouping).
    assert.equal(resolveModelFamily('some-other-model', map), 'some-other-model');
    // Blank / null → null (caller mirrors its null-model handling).
    assert.equal(resolveModelFamily(null, map), null);
    assert.equal(resolveModelFamily('   ', map), null);
  });
});

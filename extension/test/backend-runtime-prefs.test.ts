import test from 'node:test';
import assert from 'node:assert/strict';

import { handleBackendRequest } from '../src/backend/request-handler';
import { EXTENSION_TOGGLES_ENV, PROVIDER_TOGGLES_ENV } from '../src/shared/protocol';

const SUBAGENT_ALWAYS_PARENT_MODEL_ENV = 'PIE_SUBAGENT_ALWAYS_PARENT_MODEL';

test('runtimePrefs.set mirrors provider and extension toggles into backend environment', async (t) => {
  const previousProvider = process.env[PROVIDER_TOGGLES_ENV];
  const previousExtension = process.env[EXTENSION_TOGGLES_ENV];
  const previousAlwaysParent = process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
  t.after(() => {
    if (previousProvider === undefined) {
      delete process.env[PROVIDER_TOGGLES_ENV];
    } else {
      process.env[PROVIDER_TOGGLES_ENV] = previousProvider;
    }
    if (previousExtension === undefined) {
      delete process.env[EXTENSION_TOGGLES_ENV];
    } else {
      process.env[EXTENSION_TOGGLES_ENV] = previousExtension;
    }
    if (previousAlwaysParent === undefined) {
      delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
    } else {
      process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = previousAlwaysParent;
    }
  });

  const providerToggles = { ollama: false, 'github-copilot': true };
  const extensionToggles = { 'skill-pruner': false };
  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs',
    method: 'runtimePrefs.set',
    params: { providerToggles, extensionToggles },
  });

  assert.deepEqual(result, { providerToggles, extensionToggles, subagentAlwaysParentModel: undefined });
  assert.equal(process.env[PROVIDER_TOGGLES_ENV], JSON.stringify(providerToggles));
  assert.equal(process.env[EXTENSION_TOGGLES_ENV], JSON.stringify(extensionToggles));
  // When the field is omitted, the env var must not be touched.
  assert.equal(process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV], previousAlwaysParent);
});

test('runtimePrefs.set writes the subagent always-parent-model env var when provided', async (t) => {
  const previousAlwaysParent = process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
  t.after(() => {
    if (previousAlwaysParent === undefined) {
      delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
    } else {
      process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = previousAlwaysParent;
    }
  });

  delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-parent',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentAlwaysParentModel: true },
  });

  assert.deepEqual(result, { providerToggles: {}, extensionToggles: {}, subagentAlwaysParentModel: true });
  assert.equal(process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV], '1');
});

test('runtimePrefs.set writes 0 when subagentAlwaysParentModel is false', async (t) => {
  const previousAlwaysParent = process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
  t.after(() => {
    if (previousAlwaysParent === undefined) {
      delete process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
    } else {
      process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV] = previousAlwaysParent;
    }
  });

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-parent-false',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentAlwaysParentModel: false },
  }) as { subagentAlwaysParentModel?: boolean };

  assert.equal(result.subagentAlwaysParentModel, false);
  assert.equal(process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV], '0');
});

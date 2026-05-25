import test from 'node:test';
import assert from 'node:assert/strict';

import { handleBackendRequest } from '../src/backend/request-handler';
import { EXTENSION_TOGGLES_ENV, PROVIDER_TOGGLES_ENV } from '../src/shared/protocol';

test('runtimePrefs.set mirrors provider and extension toggles into backend environment', async (t) => {
  const previousProvider = process.env[PROVIDER_TOGGLES_ENV];
  const previousExtension = process.env[EXTENSION_TOGGLES_ENV];
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
  });

  const providerToggles = { ollama: false, 'github-copilot': true };
  const extensionToggles = { 'skill-pruner': false };
  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs',
    method: 'runtimePrefs.set',
    params: { providerToggles, extensionToggles },
  });

  assert.deepEqual(result, { providerToggles, extensionToggles });
  assert.equal(process.env[PROVIDER_TOGGLES_ENV], JSON.stringify(providerToggles));
  assert.equal(process.env[EXTENSION_TOGGLES_ENV], JSON.stringify(extensionToggles));
});

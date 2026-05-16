import test from 'node:test';
import assert from 'node:assert/strict';

import { handleBackendRequest } from '../src/backend/request-handler';
import { PROVIDER_TOGGLES_ENV } from '../src/shared/protocol';

test('runtimePrefs.set mirrors provider toggles into backend environment', async (t) => {
  const previous = process.env[PROVIDER_TOGGLES_ENV];
  t.after(() => {
    if (previous === undefined) {
      delete process.env[PROVIDER_TOGGLES_ENV];
    } else {
      process.env[PROVIDER_TOGGLES_ENV] = previous;
    }
  });

  const providerToggles = { ollama: false, 'github-copilot': true };
  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs',
    method: 'runtimePrefs.set',
    params: { providerToggles },
  });

  assert.deepEqual(result, { providerToggles });
  assert.equal(process.env[PROVIDER_TOGGLES_ENV], JSON.stringify(providerToggles));
});

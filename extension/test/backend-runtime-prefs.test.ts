import test from 'node:test';
import assert from 'node:assert/strict';

import { handleBackendRequest } from '../src/backend/request-handler';
import { EXTENSION_TOGGLES_ENV, PROVIDER_TOGGLES_ENV } from '../src/shared/protocol';
import { validateRuntimePrefsSet } from '../src/backend/rpc';

const SUBAGENT_ALWAYS_PARENT_MODEL_ENV = 'PIE_SUBAGENT_ALWAYS_PARENT_MODEL';
const SUBAGENT_MAX_DEPTH_ENV = 'PIE_SUBAGENT_MAX_DEPTH';
const SUBAGENT_MAX_TREE_SESSIONS_ENV = 'PIE_SUBAGENT_MAX_TREE_SESSIONS';

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

  assert.deepEqual(result, { providerToggles, extensionToggles, subagentAlwaysParentModel: undefined, subagentMaxDepth: undefined, subagentMaxTreeSessions: undefined });
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

  assert.deepEqual(result, { providerToggles: {}, extensionToggles: {}, subagentAlwaysParentModel: true, subagentMaxDepth: undefined, subagentMaxTreeSessions: undefined });
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

test('runtimePrefs.set writes the subagent nesting env vars when provided', async (t) => {
  const prevDepth = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const prevTree = process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
  t.after(() => {
    if (prevDepth === undefined) delete process.env[SUBAGENT_MAX_DEPTH_ENV];
    else process.env[SUBAGENT_MAX_DEPTH_ENV] = prevDepth;
    if (prevTree === undefined) delete process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
    else process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV] = prevTree;
  });

  const result = await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-nesting',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {}, subagentMaxDepth: 6, subagentMaxTreeSessions: 80 },
  }) as { subagentMaxDepth?: number; subagentMaxTreeSessions?: number };

  assert.equal(result.subagentMaxDepth, 6);
  assert.equal(result.subagentMaxTreeSessions, 80);
  assert.equal(process.env[SUBAGENT_MAX_DEPTH_ENV], '6');
  assert.equal(process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV], '80');
});

test('runtimePrefs.set leaves nesting env vars untouched when omitted', async (t) => {
  const prevDepth = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const prevTree = process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
  t.after(() => {
    if (prevDepth === undefined) delete process.env[SUBAGENT_MAX_DEPTH_ENV];
    else process.env[SUBAGENT_MAX_DEPTH_ENV] = prevDepth;
    if (prevTree === undefined) delete process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
    else process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV] = prevTree;
  });

  delete process.env[SUBAGENT_MAX_DEPTH_ENV];
  delete process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV];
  await handleBackendRequest({} as any, {
    id: 'test-runtime-prefs-nesting-omitted',
    method: 'runtimePrefs.set',
    params: { providerToggles: {}, extensionToggles: {} },
  });

  assert.equal(process.env[SUBAGENT_MAX_DEPTH_ENV], undefined);
  assert.equal(process.env[SUBAGENT_MAX_TREE_SESSIONS_ENV], undefined);
});

test('runtimePrefs.set rejects out-of-range nesting values', () => {
  assert.throws(() =>
    validateRuntimePrefsSet({ providerToggles: {}, extensionToggles: {}, subagentMaxDepth: 99 }),
  );
  assert.throws(() =>
    validateRuntimePrefsSet({ providerToggles: {}, extensionToggles: {}, subagentMaxTreeSessions: 1 }),
  );
  assert.throws(() =>
    validateRuntimePrefsSet({ providerToggles: {}, extensionToggles: {}, subagentMaxDepth: 4.5 }),
  );
});

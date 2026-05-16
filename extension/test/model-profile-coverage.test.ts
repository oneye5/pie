import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// tsx compiles .ts files to CJS where __dirname is available (import.meta.url is not).
declare const __dirname: string;

interface RawModelConfig {
  providers?: Record<string, { models?: Array<{ id?: unknown }> }>;
}

interface RawProfileConfig {
  profiles?: Array<{ id?: unknown }>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

test('every configured model has a matching model profile entry', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const models = readJson<RawModelConfig>(path.join(repoRoot, 'models.json'));
  const profiles = readJson<RawProfileConfig>(path.join(repoRoot, 'model-profiles.json'));

  const modelIds = Object.values(models.providers ?? {}).flatMap((provider) =>
    Array.isArray(provider.models)
      ? provider.models
          .map((model) => (typeof model.id === 'string' ? model.id : null))
          .filter((id): id is string => id !== null)
      : [],
  );
  const profileIds = new Set(
    Array.isArray(profiles.profiles)
      ? profiles.profiles
          .map((profile) => (typeof profile.id === 'string' ? profile.id : null))
          .filter((id): id is string => id !== null)
      : [],
  );

  const missing = modelIds.filter((id) => !profileIds.has(id));
  assert.deepEqual(missing, [], `Missing model profiles for: ${missing.join(', ')}`);
});

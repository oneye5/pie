import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionModuleUrl = pathToFileURL(path.resolve(__dirname, '../index.ts')).href;

type ResourceDiscoverHandler = (event: { cwd: string; reason: 'startup' | 'reload' }, ctx: unknown) => Promise<unknown> | unknown;

function createApiRecorder() {
  const handlers = new Map<string, ResourceDiscoverHandler[]>();

  return {
    api: {
      on(eventName: string, handler: ResourceDiscoverHandler) {
        const existing = handlers.get(eventName) ?? [];
        existing.push(handler);
        handlers.set(eventName, existing);
      },
    },
    getSingleHandler(eventName: string): ResourceDiscoverHandler {
      const existing = handlers.get(eventName) ?? [];
      assert.equal(existing.length, 1, `Expected exactly one handler for ${eventName}`);
      return existing[0];
    },
  };
}

async function loadFactory() {
  const module = (await import(extensionModuleUrl)) as { default: (api: unknown) => void };
  return module.default;
}

test('resources_discover adds working-directory skills when present', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cwd-skills-'));
  await fs.mkdir(path.join(cwd, 'skills'), { recursive: true });
  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const { api, getSingleHandler } = createApiRecorder();
  const factory = await loadFactory();
  factory(api);

  const handler = getSingleHandler('resources_discover');
  const result = await handler({ cwd, reason: 'startup' }, {});

  assert.deepEqual(result, {
    skillPaths: [path.join(cwd, 'skills')],
  });
});

test('resources_discover does nothing when working-directory skills are absent', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cwd-skills-'));
  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const { api, getSingleHandler } = createApiRecorder();
  const factory = await loadFactory();
  factory(api);

  const handler = getSingleHandler('resources_discover');
  const result = await handler({ cwd, reason: 'reload' }, {});

  assert.deepEqual(result, {});
});

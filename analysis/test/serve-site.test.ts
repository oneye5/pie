import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import { resolveSiteRequestPath } from '../scripts/serve-site-paths.ts';

const SITE_ROOT = path.resolve('analysis/site');

test('resolveSiteRequestPath serves canonical allowed data files only', () => {
  assert.equal(
    resolveSiteRequestPath(SITE_ROOT, '/data/manifest.json'),
    path.resolve(SITE_ROOT, 'data', 'manifest.json'),
  );
  assert.equal(
    resolveSiteRequestPath(SITE_ROOT, '/data/Manifest.json'),
    path.resolve(SITE_ROOT, 'data', 'manifest.json'),
  );
  assert.equal(
    resolveSiteRequestPath(SITE_ROOT, '/dist/../data/manifest.json'),
    path.resolve(SITE_ROOT, 'data', 'manifest.json'),
  );
});

test('resolveSiteRequestPath rejects unapproved or escaped data paths', () => {
  assert.throws(
    () => resolveSiteRequestPath(SITE_ROOT, '/data/run-analytics.json'),
    /Not found/,
  );
  assert.throws(
    () => resolveSiteRequestPath(SITE_ROOT, '/DATA/run-analytics.json'),
    /Not found/,
  );
  assert.throws(
    () => resolveSiteRequestPath(SITE_ROOT, '/../outside.txt'),
    /Invalid path/,
  );
});

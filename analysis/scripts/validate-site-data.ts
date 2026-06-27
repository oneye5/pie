#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SiteDataBundle } from './contracts.ts';
import { toErrorMessage } from '../../shared/error-message.js';
import { parseCliOptions, formatUsage } from './cli.ts';
import { DEFAULT_SITE_DATA_DIR, loadSourceAnalytics } from './source.ts';
import { prepareSourceAnalytics } from './prepare.ts';
import { buildSiteDataBundle, readSiteDataBundle, validateSiteDataBundle, writeSiteData } from './site-data.ts';

function normalizedForComparison(
  bundle: SiteDataBundle,
  options: { ignoreSourceExportedAt?: boolean } = {},
): SiteDataBundle {
  return {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      generatedAt: '__normalized__',
      sourceExportedAt: options.ignoreSourceExportedAt ? '__normalized__' : bundle.manifest.sourceExportedAt,
    },
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(formatUsage('npm run validate-site-data --', 'Validate generated site data and site-data invariants.'));
    return;
  }

  const hasExplicitSource = Boolean(options.exportPath || options.storageDir);
  const outputDir = options.outputDir ?? DEFAULT_SITE_DATA_DIR;
  const outputDirExists = fs.existsSync(outputDir);

  if (outputDirExists) {
    const existingBundle = await readSiteDataBundle(outputDir);
    validateSiteDataBundle(existingBundle);

    if (!hasExplicitSource) {
      console.log('Validated existing generated site data.');
      console.log(`Directory: ${outputDir}`);
      return;
    }
  }

  const loaded = await loadSourceAnalytics({ exportPath: options.exportPath, storageDir: options.storageDir });
  const prepared = prepareSourceAnalytics(loaded.source);
  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pie-analysis-site-data-'));

  try {
    await writeSiteData(tempDir, bundle);
    const roundTrip = await readSiteDataBundle(tempDir);
    validateSiteDataBundle(roundTrip);

    if (outputDirExists) {
      const existingBundle = await readSiteDataBundle(outputDir);
      validateSiteDataBundle(existingBundle);
      assert.deepEqual(
        normalizedForComparison(existingBundle, { ignoreSourceExportedAt: loaded.sourceKind === 'storage-dir' }),
        normalizedForComparison(bundle, { ignoreSourceExportedAt: loaded.sourceKind === 'storage-dir' }),
        `Existing site data at ${outputDir} does not match the selected source. Regenerate it with npm run export-site-data.`,
      );
    }

    console.log(`Validated site data for workspace ${loaded.source.workspaceKey}.`);
    console.log(`Source: ${loaded.sourceKind} (${loaded.sourcePath})`);
    console.log(`Directory: ${outputDirExists ? outputDir : '(temporary output from source build)'}`);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('validate-site-data failed:', toErrorMessage(error));
  process.exitCode = 1;
});

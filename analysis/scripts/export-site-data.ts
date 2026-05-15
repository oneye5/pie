#!/usr/bin/env node
import { parseCliOptions, formatUsage } from './cli.ts';
import { buildDuckDbDatabase } from './duckdb.ts';
import { DEFAULT_DUCKDB_PATH, DEFAULT_SITE_DATA_DIR, DEFAULT_STAGING_EXPORTS_DIR, loadSourceAnalytics } from './source.ts';
import { prepareSourceAnalytics } from './prepare.ts';
import { buildSiteDataBundle, validateSiteDataBundle, writeSiteData } from './site-data.ts';

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(formatUsage('npm run export-site-data --', 'Generate dashboard-ready dashboard JSON from a analytics source.'));
    return;
  }

  const loaded = await loadSourceAnalytics({ exportPath: options.exportPath, storageDir: options.storageDir });
  if (loaded.sourceKind === 'fixture') {
    console.warn('Warning: using fixture analytics data. Pass --export or --storage-dir to generate dashboard data from real runs.');
  }
  const prepared = prepareSourceAnalytics(loaded.source);
  const dbPath = options.dbPath ?? DEFAULT_DUCKDB_PATH;
  const exportsDir = options.exportsDir ?? DEFAULT_STAGING_EXPORTS_DIR;
  const outputDir = options.outputDir ?? DEFAULT_SITE_DATA_DIR;

  await buildDuckDbDatabase({ dbPath, exportsDir, prepared });

  const bundle = buildSiteDataBundle(prepared);
  validateSiteDataBundle(bundle);
  await writeSiteData(outputDir, bundle);

  console.log(`Source: ${loaded.sourceKind} (${loaded.sourcePath})`);
  console.log(`Exported at: ${loaded.source.exportedAt}`);
  console.log(`Workspace key: ${loaded.source.workspaceKey}`);
  console.log(`DuckDB: ${dbPath}`);
  console.log(`Site data: ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

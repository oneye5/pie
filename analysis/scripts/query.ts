#!/usr/bin/env node
import * as fs from 'node:fs';

import { parseCliOptions, formatUsage } from './cli.ts';
import { toErrorMessage } from '../../shared/error-message.js';
import { buildDuckDbDatabase, runNamedDuckDbQuery, type NamedQuery, QUERY_FILE_BY_NAME } from './duckdb.ts';
import { prepareSourceAnalytics } from './prepare.ts';
import { DEFAULT_DUCKDB_PATH, DEFAULT_STAGING_EXPORTS_DIR, loadSourceAnalytics } from './source.ts';

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help || !options.name) {
    console.log(formatUsage(
      'npm run query --',
      'Run a named DuckDB analytics query.',
      ['Named queries: ' + Object.keys(QUERY_FILE_BY_NAME).join(', ')],
    ));
    return;
  }

  const queryName = options.name as NamedQuery;
  if (!(queryName in QUERY_FILE_BY_NAME)) {
    throw new Error(`Unknown query name: ${options.name}`);
  }

  const dbPath = options.dbPath ?? DEFAULT_DUCKDB_PATH;
  if (!fs.existsSync(dbPath) || options.exportPath || options.storageDir) {
    const loaded = await loadSourceAnalytics({ exportPath: options.exportPath, storageDir: options.storageDir });
    const prepared = prepareSourceAnalytics(loaded.source);
    await buildDuckDbDatabase({
      dbPath,
      exportsDir: options.exportsDir ?? DEFAULT_STAGING_EXPORTS_DIR,
      prepared,
    });
  }

  const rows = await runNamedDuckDbQuery(dbPath, queryName);
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((error) => {
  console.error('query failed:', toErrorMessage(error));
  process.exitCode = 1;
});

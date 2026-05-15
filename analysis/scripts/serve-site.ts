#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliOptions, formatUsage } from './cli.ts';
import { prepareSourceAnalytics } from './prepare.ts';
import { resolveSiteRequestPath } from './serve-site-paths.ts';
import {
  buildSiteDataBundle,
  readSiteDataBundle,
  validateSiteDataBundle,
  writeSiteData,
} from './site-data.ts';
import {
  DEFAULT_SITE_DATA_DIR,
  loadSourceAnalytics,
} from './source.ts';
import {
  detectPreferredStorageDir,
  listStorageDirCandidates,
} from './source-auto.ts';

const SITE_ROOT = fileURLToPath(new URL('../site', import.meta.url));
const ANALYSIS_ROOT = path.resolve(SITE_ROOT, '..');
const WORKSPACE_ROOT = path.resolve(ANALYSIS_ROOT, '..');
const DEFAULT_OUTCOMES_ROOT = path.join(WORKSPACE_ROOT, 'data', 'outcomes');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function canServeExistingSiteData(outputDir: string): Promise<boolean> {
  try {
    const bundle = await readSiteDataBundle(outputDir);
    validateSiteDataBundle(bundle);
    return true;
  } catch {
    return false;
  }
}

async function isUsableStorageDir(storageDir: string): Promise<boolean> {
  const parentDir = path.dirname(storageDir);
  const normalizedTarget = path.resolve(storageDir);
  const candidates = await listStorageDirCandidates(parentDir);
  return candidates.some((candidate) => path.resolve(candidate.storageDir) === normalizedTarget);
}

interface ResolvedSourceSelection {
  selection: { exportPath: string } | { storageDir: string };
  message?: string;
}

async function resolveServeSourceSelection(options: ReturnType<typeof parseCliOptions>): Promise<ResolvedSourceSelection | null> {
  if (options.exportPath) {
    return { selection: { exportPath: options.exportPath } };
  }

  if (options.storageDir) {
    if (!(await isUsableStorageDir(options.storageDir))) {
      throw new Error(`No run-analytics artifacts found in --storage-dir ${options.storageDir}.`);
    }
    return { selection: { storageDir: options.storageDir } };
  }

  const preferredStorageDir = await detectPreferredStorageDir(DEFAULT_OUTCOMES_ROOT, WORKSPACE_ROOT);
  if (preferredStorageDir) {
    return {
      selection: { storageDir: preferredStorageDir },
      message: `[pie-analysis] Auto-selected workspace-matching run store: ${preferredStorageDir}`,
    };
  }

  const candidates = await listStorageDirCandidates(DEFAULT_OUTCOMES_ROOT);
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return {
      selection: { storageDir: candidates[0]!.storageDir },
      message: `[pie-analysis] No workspace-hash match found; using only available run store: ${candidates[0]!.storageDir}`,
    };
  }

  throw new Error(
    `Multiple run stores found under ${DEFAULT_OUTCOMES_ROOT} but none matches this workspace hash. Pass --storage-dir explicitly. Candidates: ${candidates.map((candidate) => candidate.storageDir).join(', ')}`,
  );
}

async function refreshSiteDataForServe(options: ReturnType<typeof parseCliOptions>): Promise<void> {
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_SITE_DATA_DIR);
  const canonicalOutputDir = path.resolve(DEFAULT_SITE_DATA_DIR);
  if (outputDir !== canonicalOutputDir) {
    throw new Error(`Serve expects site data at ${canonicalOutputDir}; received --output-dir ${outputDir}.`);
  }

  const resolvedSelection = await resolveServeSourceSelection(options);
  if (!resolvedSelection) {
    if (await canServeExistingSiteData(outputDir)) {
      console.warn(`[pie-analysis] No local analytics source detected under ${DEFAULT_OUTCOMES_ROOT}; serving existing generated site data.`);
      return;
    }

    throw new Error(
      `No local analytics source detected under ${DEFAULT_OUTCOMES_ROOT}. Run pie first, or pass --storage-dir / --export.`,
    );
  }

  if (resolvedSelection.message) {
    console.log(resolvedSelection.message);
  }

  const loaded = await loadSourceAnalytics(resolvedSelection.selection);
  const prepared = prepareSourceAnalytics(loaded.source);
  const bundle = buildSiteDataBundle(prepared);

  validateSiteDataBundle(bundle);
  await writeSiteData(outputDir, bundle);

  console.log(`Site data refreshed from ${loaded.sourceKind} source: ${loaded.sourcePath}`);
  console.log(`Workspace key: ${loaded.source.workspaceKey} · exported: ${loaded.source.exportedAt}`);
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(formatUsage('npm run serve --', 'Serve the built analytics dashboard over localhost.'));
    return;
  }

  await refreshSiteDataForServe(options);

  const port = options.port ?? 4173;
  const server = http.createServer(async (request, response) => {
    try {
      const filePath = resolveSiteRequestPath(SITE_ROOT, request.url ?? '/');
      const data = await fs.readFile(filePath);
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });
      response.end(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Not found';
      const statusCode = message === 'Invalid path.' ? 400 : 404;
      response.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });
      response.end(statusCode === 400 ? 'Bad request' : 'Not found');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`pie analytics dashboard available at http://127.0.0.1:${port}`);
    console.log('Press Ctrl+C to stop the local server.');
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

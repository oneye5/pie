/**
 * Architectural boundary guards.
 *
 * These tests enforce that concerns live in their designated layer:
 * - Alias resolution and turn-tracking belong in the arch reducer (core/reducer.ts)
 * - The transcript-slice is a "dumb store" — it receives pre-resolved IDs and
 *   never performs request-correlation or alias bookkeeping.
 *
 * If any of these tests fail, it means a layering violation has been introduced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// tsx compiles .ts files to CJS where __dirname is available (import.meta.url is not).
declare const __dirname: string;

const ROOT = resolve(__dirname, '..', 'src', 'host', 'store');
const SLICE_PATH = resolve(ROOT, 'transcript-slice.ts');
const HELPERS_PATH = resolve(ROOT, 'transcript-helpers.ts');

// ─── Guard: TranscriptState has no alias/turn fields ─────────────────────────

test('TranscriptState must not contain messageIdAlias or currentTurnBySession fields', () => {
  const helpers = readFileSync(HELPERS_PATH, 'utf8');

  // Extract the TranscriptState interface body
  const ifaceMatch = helpers.match(/export interface TranscriptState\s*\{([^}]+)\}/);
  assert.ok(ifaceMatch, 'TranscriptState interface not found in transcript-helpers.ts');

  const body = ifaceMatch[1];
  assert.ok(!body.includes('messageIdAlias'), 'TranscriptState must not contain messageIdAlias — alias state belongs in ArchState');
  assert.ok(!body.includes('currentTurnBySession'), 'TranscriptState must not contain currentTurnBySession — turn tracking belongs in ArchState');
});

// ─── Guard: transcript-slice.ts does not import alias helpers ────────────────

test('transcript-slice must not import clearSessionAliases', () => {
  const slice = readFileSync(SLICE_PATH, 'utf8');
  assert.ok(!slice.includes('clearSessionAliases'), 'transcript-slice must not use clearSessionAliases — alias lifecycle belongs in the arch reducer');
});

test('transcript-slice must not call resolveAlias internally', () => {
  const slice = readFileSync(SLICE_PATH, 'utf8');
  // resolveAlias is allowed to exist in helpers (as a standalone utility), but
  // the slice itself should never call it — the arch reducer does resolution
  // before dispatching to the slice.
  assert.ok(!slice.includes('resolveAlias('), 'transcript-slice must not call resolveAlias — IDs must arrive pre-resolved from the arch reducer');
});

// ─── Guard: arch reducer is pure (no external imports beyond types) ──────────
// NOTE: The arch reducer now imports mutation helpers from store/transcript-helpers
// and window helpers from session-service/transcript-window, which is intentional
// for the Phase 5+ migration where the reducer owns transcript state directly.
// These imports are pure functions (no Redux coupling), so they are allowed.

test('arch reducer must not import from extension-host', () => {
  const reducerPath = resolve(__dirname, '..', 'src', 'host', 'core', 'reducer.ts');
  const reducer = readFileSync(reducerPath, 'utf8');

  const imports = [...reducer.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);

  for (const imp of imports) {
    assert.ok(!imp.includes('extension-host'), `Arch reducer must not import from extension-host (found: "${imp}")`);
  }
});
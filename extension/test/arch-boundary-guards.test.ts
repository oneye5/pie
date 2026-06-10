/**
 * Architectural boundary guards.
 *
 * These tests enforce that concerns live in their designated layer:
 * - Alias resolution and turn-tracking belong in the arch reducer (core/reducer.ts)
 *
 * If any of these tests fail, it means a layering violation has been introduced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// tsx compiles .ts files to CJS where __dirname is available (import.meta.url is not).
declare const __dirname: string;

const CORE_ROOT = resolve(__dirname, '..', 'src', 'host', 'core');
const ARCH_STATE_PATH = resolve(CORE_ROOT, 'arch-state.ts');

// ─── Guard: TranscriptState has no alias/turn fields ─────────────────────────

test('TranscriptState must not contain messageIdAlias or currentTurnBySession fields', () => {
  const archState = readFileSync(ARCH_STATE_PATH, 'utf8');

  // Extract the TranscriptState interface body from arch-state.ts (canonical location)
  const ifaceMatch = archState.match(/export interface TranscriptState\s*\{([\s\S]+?)\}/);
  assert.ok(ifaceMatch, 'TranscriptState interface not found in arch-state.ts');

  const body = ifaceMatch[1];
  assert.ok(!body.includes('messageIdAlias'), 'TranscriptState must not contain messageIdAlias — alias state belongs in ArchState');
  assert.ok(!body.includes('currentTurnBySession'), 'TranscriptState must not contain currentTurnBySession — turn tracking belongs in ArchState');
});

// ─── Guard: arch reducer is pure (no external imports beyond types) ──────────
// NOTE: The arch reducer now imports mutation helpers from core/transcript-helpers
// and window helpers from core/transcript-window, which is intentional
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

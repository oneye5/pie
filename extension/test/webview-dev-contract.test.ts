import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  EMPTY_TRANSCRIPT_WINDOW,
} from '../src/shared/protocol';
import { devFixtures } from '../src/webview/panel/dev-fixtures';
import { EMPTY_VIEW_STATE } from '../src/webview/panel/hooks/use-host-sync';

test('browser webview empty state uses shared protocol defaults', () => {
  assert.deepEqual(EMPTY_VIEW_STATE.prefs, DEFAULT_CHAT_PREFS);
  assert.deepEqual(EMPTY_VIEW_STATE.pruningSettings, DEFAULT_PRUNING_SETTINGS);
  assert.deepEqual(EMPTY_VIEW_STATE.transcriptWindow, EMPTY_TRANSCRIPT_WINDOW);
});

test('browser dev fixtures are complete ViewState snapshots', () => {
  assert.ok(devFixtures.length > 0);

  for (const fixture of devFixtures) {
    const { state } = fixture;
    assert.ok(Array.isArray(state.sessions), `${fixture.id}: sessions`);
    assert.ok(Array.isArray(state.openTabPaths), `${fixture.id}: openTabPaths`);
    assert.ok(Array.isArray(state.runningSessionPaths), `${fixture.id}: runningSessionPaths`);
    assert.ok(Array.isArray(state.unreadFinishedSessionPaths), `${fixture.id}: unreadFinishedSessionPaths`);
    assert.ok(Array.isArray(state.transcript), `${fixture.id}: transcript`);
    assert.ok(Array.isArray(state.pendingComposerInputs), `${fixture.id}: pendingComposerInputs`);
    assert.ok(Array.isArray(state.availableModels), `${fixture.id}: availableModels`);
    assert.ok(Array.isArray(state.availableExtensions), `${fixture.id}: availableExtensions`);
    assert.ok(Array.isArray(state.fileChanges), `${fixture.id}: fileChanges`);
    assert.equal(typeof state.backendReady, 'boolean', `${fixture.id}: backendReady`);
    assert.equal(typeof state.busy, 'boolean', `${fixture.id}: busy`);
    assert.equal(typeof state.transcriptLoaded, 'boolean', `${fixture.id}: transcriptLoaded`);
    assert.equal(state.pruningSettings.prepassTimeoutSec, DEFAULT_PRUNING_SETTINGS.prepassTimeoutSec, `${fixture.id}: pruning timeout default`);
    assert.equal(state.transcriptWindow.totalCount, state.transcript.length, `${fixture.id}: transcript count`);
  }
});

test('live browser dev host carries parity handlers for common panel controls', async () => {
  const source = await readFile(new URL('../scripts/webview-dev.mjs', import.meta.url), 'utf8');
  const buildScript = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');

  assert.match(source, /prepassTimeoutSec: null/);
  assert.match(source, /headlessHostPath/);
  assert.match(source, /HeadlessWebviewDevHost/);
  assert.match(source, /host\.handleBackendEvent\(event\)/);
  assert.match(source, /hostState\(\)/);
  assert.match(source, /const PENDING_SESSION_PREFIX = '__pending__:'/);
  assert.match(source, /function createPendingSessionPath\(\)/);
  assert.match(source, /function applyCreatedSessionOpened\(payload, selectionToken\)/);
  assert.match(source, /function cancelPendingCreateForPath\(sessionPath\)/);
  assert.match(source, /function clearTransientSessionUi\(\)/);
  assert.match(source, /function setSessionRunning\(sessionPath, running\)/);
  assert.match(source, /const pendingInterruptRequests = new Set\(\)/);
  assert.match(source, /function resolveInterruptSessionPath\(sessionPath\)/);
  assert.match(source, /function drainPendingInterrupt\(pendingPath, resolvedPath\)/);
  assert.match(source, /case 'openFilePicker':/);
  assert.match(source, /case 'openFile':/);
  assert.match(source, /case 'openFileDiff':/);
  assert.match(source, /case 'revertFile':/);
  assert.match(source, /case 'startNewTask':/);
  assert.match(source, /case 'continueTask':/);
  assert.match(source, /case 'stateApplied':/);
  assert.match(buildScript, /webview-dev-host\.js/);
});

test('service-backed browser dev host queues pending interrupts until session path resolution', async () => {
  const source = await readFile(new URL('../src/webview-dev/headless-host.ts', import.meta.url), 'utf8');

  assert.match(source, /pendingInterruptRequests = new Set<string>\(\)/);
  assert.match(source, /onSessionPathResolved:[\s\S]*this\.drainPendingSendQueue\(pendingPath, resolvedPath\);[\s\S]*this\.drainPendingInterrupt\(pendingPath, resolvedPath\);/);
  assert.match(source, /if \(isPendingTabPath\(sessionPath\)\) \{[\s\S]*this\.pendingInterruptRequests\.add\(sessionPath\);[\s\S]*return;[\s\S]*\}/);
  assert.match(source, /private drainPendingInterrupt\(pendingPath: string, resolvedPath: string\): void \{/);
});
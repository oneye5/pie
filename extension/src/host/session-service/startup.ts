import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { buildRestoredSessionPlan, filterRestorableStoredTabs } from '../core/restored-session-plan';
import { normalizeStoredTabPaths } from '../../shared/tab-behavior';
import { createCommandExecutor } from '../../shared/exec-command';

import { resolveNodePath, resolveSdkPath } from '../../shared/runtime-resolution';
import { resolveAgentDir } from '../../shared/agent-dir-resolution';
import type { ChatPrefs, SessionSummary } from '../../shared/protocol';
import { SessionService } from './service';
import { SessionServiceEvents } from './events';
import { SessionServiceState } from './state';
import { buildRestoredSessionSummaries } from '../core/restored-session-summaries';
import { bootLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';
import { publishBackendReady } from './backend-ready';
import type { ArchState } from '../core/arch-state';
import type { Event } from '../core/events';

const PREFS_STORAGE_KEY = 'chatPrefs';
const SDK_PATH_CACHE_KEY = 'resolvedSdkPath';

interface StartSessionBackendOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: () => void;
  events: SessionServiceEvents;
  state: SessionServiceState;
  service: SessionService;
  openSession: (sessionPath: string) => void;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
}

function resolveWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function applyStoredPrefs(options: StartSessionBackendOptions): void {
  const storedPrefs = options.context.globalState.get<Partial<ChatPrefs>>(PREFS_STORAGE_KEY);
  if (storedPrefs) {
    // The SetPrefs Command reduces to a SetPrefsRpc effect; service.setPrefs
    // (the effect handler) resolves and persists the merged prefs. No separate
    // globalState write is needed here.
    options.dispatchArch({ kind: 'Command', cmd: { kind: 'SetPrefs', corrId: `prefs:${Date.now()}`, prefs: storedPrefs } });
  }
}

async function loadPruningSettingsFromService(options: StartSessionBackendOptions): Promise<void> {
  await options.service.loadPruningSettings();
}

function computeRestorePlan(options: StartSessionBackendOptions) {
  const storedRawTabs = options.context.globalState.get<unknown[]>('openTabPaths') ?? [];
  // Skip fs.existsSync checks during restore — session files may be temporarily
  // inaccessible during rapid extension host restarts (Windows file locks, race
  // conditions). Missing sessions are handled gracefully when the backend tries
  // to open them. Dropping tabs here permanently destroys saved tab state.
  const { rawTabs, openTabPaths: restoredTabs, droppedPaths } = filterRestorableStoredTabs(
    storedRawTabs,
    () => true,
  );
  const preferredStartupPath = options.context.globalState.get<string>('activeSessionPath') ?? null;
  // Pinned tabs are stored as a path list (no name enrichment). Normalize
  // defensively (accept legacy string/{path} forms, drop pending/dupes), then
  // drop any pinned path that didn't survive the open-tab restore so the
  // pinned ⊆ openTabPaths invariant holds.
  const storedRawPinned = options.context.globalState.get<unknown[]>('pinnedTabPaths') ?? [];
  const storedPinned = normalizeStoredTabPaths(storedRawPinned);
  const restoredPinnedTabs = storedPinned.filter((p) => restoredTabs.includes(p));
  const restoredSessionPlan = buildRestoredSessionPlan(restoredTabs, preferredStartupPath);
  const { startupPath: restoredStartupPath, preloadPaths } = restoredSessionPlan;
  return {
    storedRawTabs,
    rawTabs,
    restoredTabs,
    droppedPaths,
    preferredStartupPath,
    restoredStartupPath,
    preloadPaths,
    storedPinned,
    restoredPinnedTabs,
  };
}

function applyRestoredTabPaths(options: StartSessionBackendOptions, restoredTabs: string[], restoredPinnedTabs: string[]): void {
  options.dispatchArch({ kind: 'OpenTabsChanged', openTabPaths: restoredTabs, pinnedTabPaths: restoredPinnedTabs });
}

function persistIfTabStateChanged(
  options: StartSessionBackendOptions,
  storedRawTabs: unknown[],
  rawTabs: unknown[],
  preferredStartupPath: string | null,
  restoredStartupPath: string | null,
  storedPinned: string[],
  restoredPinnedTabs: string[],
): void {
  const tabsChanged =
    rawTabs.length !== storedRawTabs.length
    || preferredStartupPath !== (restoredStartupPath ?? undefined);
  const pinnedChanged =
    restoredPinnedTabs.length !== storedPinned.length
    || restoredPinnedTabs.some((p, i) => p !== storedPinned[i]);
  if (tabsChanged) {
    void Promise.resolve(options.context.globalState.update('openTabPaths', rawTabs)).catch((error) => {
      // Non-fatal: tab-path persistence failure must not block startup restore.
      console.warn('[pie] globalState.update failed for openTabPaths:', toErrorMessage(error));
    });
    void Promise.resolve(options.context.globalState.update('activeSessionPath', restoredStartupPath ?? undefined)).catch((error) => {
      // Non-fatal: startup-path persistence failure must not block startup restore.
      console.warn('[pie] globalState.update failed for activeSessionPath:', toErrorMessage(error));
    });
  }
  if (pinnedChanged) {
    void Promise.resolve(options.context.globalState.update('pinnedTabPaths', restoredPinnedTabs)).catch((error) => {
      // Non-fatal: pinned-tab persistence failure must not block startup restore.
      console.warn('[pie] globalState.update failed for pinnedTabPaths:', toErrorMessage(error));
    });
  }
}

function bootLogRestorePrepared(
  restoredStartupPath: string | null,
  cachedSessionCount: number,
  droppedTabCount: number,
  openTabCount: number,
  preloadCount: number,
): void {
  bootLog('session-startup', 'restore.prepared', {
    activeSessionPath: restoredStartupPath,
    cachedSessionCount,
    droppedTabCount,
    openTabCount,
    preloadCount,
  });
}

async function resolveAndCacheRuntimePaths(options: StartSessionBackendOptions): Promise<{ nodePath: string; sdkPath: string } | null> {
  try {
    const config = vscode.workspace.getConfiguration('pie');
    const rootConfig = vscode.workspace.getConfiguration();
    const configuredNodePath =
      config.get<string>('nodePath')?.trim()
      || rootConfig.get<string>('piAssistant.nodePath')?.trim()
      || undefined;
    const configuredSdkPath =
      config.get<string>('sdkPath')?.trim()
      || rootConfig.get<string>('piAssistant.sdkPath')?.trim()
      || undefined;
    const envSdkPath = process.env.PI_SDK_PATH?.trim() || undefined;
    const shouldUseSdkCache = !configuredSdkPath && !envSdkPath;
    const cachedSdkPath = shouldUseSdkCache
      ? options.context.globalState.get<string>(SDK_PATH_CACHE_KEY)
      : undefined;

    const nodePath = resolveNodePath({
      configuredPath: configuredNodePath,
      env: process.env as NodeJS.ProcessEnv,
    });
    const sdkPath = await resolveSdkPath({
      configuredPath: configuredSdkPath,
      cachedPath: cachedSdkPath,
      env: process.env as NodeJS.ProcessEnv,
      exec: createCommandExecutor(),
    });
    if (shouldUseSdkCache) {
      void Promise.resolve(options.context.globalState.update(SDK_PATH_CACHE_KEY, sdkPath)).catch((error) => {
        // Non-fatal: sdk-path cache failure must not block runtime resolution.
        console.warn('[pie] globalState.update failed for resolvedSdkPath:', toErrorMessage(error));
      });
    }
    return { nodePath, sdkPath };
  } catch (err) {
    options.dispatchArch({ kind: 'NoticeShown', notice:
      `pie setup error: ${toErrorMessage(err)}. ` +
        'Set pie.nodePath and pie.sdkPath in settings.',
    });
    return null;
  }
}

function setupInTreeAuthEnv(): void {
  const allowInTreeAuth = vscode.workspace.getConfiguration('pie').get<boolean>('allowInTreeAuth', false);
  if (allowInTreeAuth) {
    process.env.PIE_ALLOW_IN_TREE_AUTH = '1';
  } else {
    delete process.env.PIE_ALLOW_IN_TREE_AUTH;
  }
}

/**
 * Ensure PI_CODING_AGENT_DIR is set in process.env before the backend is
 * spawned. The backend inherits process.env and the pi SDK uses
 * PI_CODING_AGENT_DIR to resolve `getAgentDir()` — which controls where
 * settings.json, models.json, and auth.json are read from.
 *
 * Candidates (pie.agentDir setting, PI_CODING_AGENT_DIR env var, and the
 * dir above the extension package) are VALIDATED: a dir is only trusted if
 * it actually contains settings.json. This is what makes the recurring
 * "umans provider missing" failure self-healing: a STALE pie.agentDir
 * pointing at a path from another machine (or after a repo relocation) used
 * to silently overwrite a correct PI_CODING_AGENT_DIR env var, leaving the
 * backend to read models.json from a non-existent dir — so custom providers
 * (umans is defined ONLY in models.json, never built-in) vanished with no
 * error. Now stale candidates are rejected (logged) and resolution falls
 * through to a valid dir instead of clobbering a good env var.
 *
 * `extensionPath` is the loaded extension's install dir; its parent is the
 * repo root in the standard checkout layout, used as a last-resort fallback
 * so pie works even when both the setting and the env var are missing/stale.
 */
function setupAgentDirEnv(options: StartSessionBackendOptions): void {
  const configuredAgentDir = vscode.workspace.getConfiguration('pie').get<string>('agentDir', '').trim();
  const result = resolveAgentDir({
    configuredAgentDir,
    envAgentDir: process.env.PI_CODING_AGENT_DIR,
    extensionPath: options.context.extensionPath,
  });

  if (result.agentDir) {
    process.env.PI_CODING_AGENT_DIR = result.agentDir;
  } else {
    // No candidate validated. Clear any stale value so the backend doesn't
    // read a non-existent dir; the pi SDK will fall back to ~/.pi/agent.
    delete process.env.PI_CODING_AGENT_DIR;
    const tried = result.rejections
      .map((r) => `${r.source}="${r.candidate}" (${r.reason})`)
      .join('; ');
    console.warn(
      `[pie] No valid agent dir found (settings.json absent from every candidate). Tried: ${tried || 'none'}. ` +
        'Custom providers like "umans" will be unavailable. Set pie.agentDir to the directory containing settings.json and models.json.',
    );
    return;
  }

  // Surface stale-setting recovery so the user understands WHY providers were
  // missing and can fix the persisted setting (rather than relying on the
  // env-var fallback indefinitely). The notice is only shown when the setting
  // was set but a DIFFERENT source actually resolved — i.e. the setting is stale.
  const settingRejected = result.rejections.some((r) => r.source === 'setting');
  if (settingRejected && result.source !== 'setting') {
    const sourceLabel =
      result.source === 'env' ? 'the PI_CODING_AGENT_DIR env var'
      : result.source === 'extension-relative' ? 'the extension\'s parent dir'
      : 'a fallback';
    options.dispatchArch({
      kind: 'NoticeShown',
      notice:
        `pie.agentDir points to a path that no longer exists${configuredAgentDir ? ` (${configuredAgentDir})` : ''}. ` +
        `Recovering using ${sourceLabel} (${result.agentDir}). Set pie.agentDir to this path, or re-run the installer, to clear this warning.`,
    });
  }
}

async function startBackendWithLogging(
  options: StartSessionBackendOptions,
  nodePath: string,
  sdkPath: string,
  backendPath: string,
  workspaceCwd: string,
  restoredStartupPath: string | null,
): Promise<boolean> {
  try {
    bootLog('session-startup', 'backend.starting', {
      backendPath,
      cwd: workspaceCwd,
      restoredStartupPath,
    });
    await options.backend.start({ nodePath, sdkPath, backendPath, cwd: workspaceCwd });
    bootLog('session-startup', 'backend.started', {
      restoredStartupPath,
    });
    return true;
  } catch (err) {
    options.dispatchArch({ kind: 'NoticeShown', notice: `Failed to start PI backend: ${toErrorMessage(err)}` });
    bootLog('session-startup', 'backend.startFailed', {
      message: toErrorMessage(err),
    });
    return false;
  }
}

async function sendRuntimePrefsWithLogging(
  options: StartSessionBackendOptions,
  restoredStartupPath: string | null,
): Promise<void> {
  try {
    const archState = options.getArchState();
    bootLog('session-startup', 'runtimePrefs.set.requested', {
      backendReady: archState.settings.backendReady,
      restoredStartupPath,
    });
    await options.backend.request('runtimePrefs.set', {
      providerToggles: archState.settings.prefs.providerToggles,
      extensionToggles: archState.settings.prefs.extensionToggles,
      subagentAlwaysParentModel: archState.settings.prefs.subagentAlwaysParentModel,
      subagentMaxDepth: archState.settings.prefs.subagentMaxDepth,
      subagentMaxTreeSessions: archState.settings.prefs.subagentMaxTreeSessions,
      subagentBuckets: archState.settings.prefs.subagentBuckets,
      subagentNestedAllowedBuckets: archState.settings.prefs.subagentNestedAllowedBuckets,
    });
    bootLog('session-startup', 'runtimePrefs.set.completed', {
      backendReady: options.getArchState().settings.backendReady,
      restoredStartupPath,
    });
  } catch {
    bootLog('session-startup', 'runtimePrefs.set.failed', {
      backendReady: options.getArchState().settings.backendReady,
      restoredStartupPath,
    });
  }
}

function bootLogBackendReadyDispatched(options: StartSessionBackendOptions): void {
  bootLog('session-startup', 'backend.readyDispatched', {
    activeSessionPath: options.getArchState().sessions.activeSessionPath,
    backendReady: options.getArchState().settings.backendReady,
    notice: options.getArchState().settings.notice,
    openTabCount: options.getArchState().sessions.openTabPaths.length,
  });
}

async function listAndOpenFirstSession(options: StartSessionBackendOptions): Promise<void> {
  try {
    const sessions = await options.backend.request<SessionSummary[]>('session.list');
    options.dispatchArch({ kind: 'SessionSummariesReplaced', summaries: sessions });
    options.scheduleRender();

    const toOpen = sessions[0]?.path;
    if (toOpen) {
      options.openSession(toOpen);
    }
  } catch (err) {
    bootLog('session-startup', 'listAndOpenFirstSession.failed', { error: toErrorMessage(err) });
  }
}

export async function startSessionBackend(options: StartSessionBackendOptions): Promise<void> {
  options.state.resetRuntimeState();

  const workspaceCwd = resolveWorkspaceCwd();
  const { dispatchArch } = options;

  dispatchArch({ kind: 'WorkspaceCwdChanged', workspaceCwd });

  applyStoredPrefs(options);
  await loadPruningSettingsFromService(options);

  const {
    storedRawTabs,
    rawTabs,
    restoredTabs,
    droppedPaths,
    preferredStartupPath,
    restoredStartupPath,
    preloadPaths,
    storedPinned,
    restoredPinnedTabs,
  } = computeRestorePlan(options);

  applyRestoredTabPaths(options, restoredTabs, restoredPinnedTabs);
  persistIfTabStateChanged(options, storedRawTabs, rawTabs, preferredStartupPath, restoredStartupPath, storedPinned, restoredPinnedTabs);

  const cachedSessions = buildRestoredSessionSummaries(rawTabs, restoredTabs, workspaceCwd, new Date().toISOString());
  if (cachedSessions.length > 0) {
    dispatchArch({ kind: 'SessionSummariesReplaced', summaries: cachedSessions });
  }

  if (restoredStartupPath) {
    dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: restoredStartupPath } });
  }

  bootLogRestorePrepared(restoredStartupPath, cachedSessions.length, droppedPaths.length, restoredTabs.length, preloadPaths.length);

  const paths = await resolveAndCacheRuntimePaths(options);
  if (!paths) {
    options.scheduleRender();
    return;
  }
  const { nodePath, sdkPath } = paths;

  const backendPath = path.join(options.context.extensionPath, 'out', 'backend.js');
  setupAgentDirEnv(options);
  setupInTreeAuthEnv();

  options.events.attach(options.backend);

  const started = await startBackendWithLogging(options, nodePath, sdkPath, backendPath, workspaceCwd, restoredStartupPath);
  if (!started) {
    options.events.detach();
    options.scheduleRender();
    return;
  }

  await sendRuntimePrefsWithLogging(options, restoredStartupPath);

  const restoreError = publishBackendReady({
    dispatchArch,
    scheduleRender: options.scheduleRender,
    openSession: options.openSession,
    preloadSessions: (sessionPaths) => options.state.preloadSessions(sessionPaths),
    restoredStartupPath,
    preloadPaths,
  });

  bootLogBackendReadyDispatched(options);

  if (restoreError) {
    bootLog('session-startup', 'restore.failed', {
      activeSessionPath: restoredStartupPath,
      message: restoreError.message,
    });
    return;
  }

  if (restoredStartupPath) {
    bootLog('session-startup', 'restore.openRequested', {
      activeSessionPath: restoredStartupPath,
      preloadCount: preloadPaths.length,
    });
    return;
  }

  await listAndOpenFirstSession(options);
}

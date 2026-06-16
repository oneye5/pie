import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { buildRestoredSessionPlan, filterRestorableStoredTabs } from '../core/restored-session-plan';
import { createCommandExecutor } from '../../shared/exec-command';

import { resolveNodePath, resolveSdkPath } from '../../shared/runtime-resolution';
import type { ChatPrefs, SessionSummary } from '../../shared/protocol';
import { SessionService } from './service';
import { SessionServiceEvents } from './events';
import { SessionServiceState } from './state';
import { buildRestoredSessionSummaries } from '../core/restored-session-summaries';
import { bootLog } from '../util/audit';
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
  };
}

function applyRestoredTabPaths(options: StartSessionBackendOptions, restoredTabs: string[]): void {
  options.dispatchArch({ kind: 'OpenTabsChanged', openTabPaths: restoredTabs });
}

function persistIfTabStateChanged(
  options: StartSessionBackendOptions,
  storedRawTabs: unknown[],
  rawTabs: unknown[],
  preferredStartupPath: string | null,
  restoredStartupPath: string | null,
): void {
  if (
    rawTabs.length !== storedRawTabs.length
    || preferredStartupPath !== (restoredStartupPath ?? undefined)
  ) {
    void options.context.globalState.update('openTabPaths', rawTabs);
    void options.context.globalState.update('activeSessionPath', restoredStartupPath ?? undefined);
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
      void options.context.globalState.update(SDK_PATH_CACHE_KEY, sdkPath);
    }
    return { nodePath, sdkPath };
  } catch (err) {
    options.dispatchArch({ kind: 'NoticeShown', notice:
      `pie setup error: ${(err as Error).message}. ` +
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
    options.dispatchArch({ kind: 'NoticeShown', notice: `Failed to start PI backend: ${(err as Error).message}` });
    bootLog('session-startup', 'backend.startFailed', {
      message: (err as Error).message,
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
  } catch {
    // Non-fatal; session list may be empty on a fresh install.
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
  } = computeRestorePlan(options);

  applyRestoredTabPaths(options, restoredTabs);
  persistIfTabStateChanged(options, storedRawTabs, rawTabs, preferredStartupPath, restoredStartupPath);

  const cachedSessions = buildRestoredSessionSummaries(rawTabs, restoredTabs, workspaceCwd);
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

import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { buildRestoredSessionPlan, filterRestorableStoredTabs } from './restored-session-plan';
import { sessionsActions, settingsActions, store, uiActions } from '../store';
import { createCommandExecutor } from '../../shared/exec-command';
import { resolveChatPrefs } from '../../shared/protocol';
import { readPruningSettings } from './pruning-settings';
import { resolveNodePath, resolveSdkPath } from '../../shared/runtime-resolution';
import type { ChatPrefs, SessionSummary } from '../../shared/protocol';
import { SessionServiceEvents } from './events';
import { SessionServiceState } from './state';
import { buildRestoredSessionSummaries } from './restored-session-summaries';
import { bootLog } from '../util/audit';
import { publishBackendReady } from './backend-ready';

const PREFS_STORAGE_KEY = 'chatPrefs';
const SDK_PATH_CACHE_KEY = 'resolvedSdkPath';

interface StartSessionBackendOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: () => void;
  events: SessionServiceEvents;
  state: SessionServiceState;
  openSession: (sessionPath: string) => void;
}

function resolveWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

export async function startSessionBackend(options: StartSessionBackendOptions): Promise<void> {
  options.state.resetRuntimeState();

  const workspaceCwd = resolveWorkspaceCwd();
  store.dispatch(sessionsActions.setWorkspaceCwd(workspaceCwd));

  const storedPrefs = options.context.globalState.get<Partial<ChatPrefs>>(PREFS_STORAGE_KEY);
  if (storedPrefs) {
    store.dispatch(uiActions.setPrefs(resolveChatPrefs(storedPrefs)));
  }

  // Load pruning settings from settings.json (non-blocking).
  readPruningSettings().then(
    (ps) => store.dispatch(settingsActions.setPruningSettings(ps)),
    () => { /* defaults remain in store */ },
  );

  const storedRawTabs = options.context.globalState.get<unknown[]>(
    'openTabPaths',
  ) ?? [];
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
  store.dispatch(sessionsActions.setOpenTabPaths(restoredTabs));

  if (
    rawTabs.length !== storedRawTabs.length
    || preferredStartupPath !== (restoredStartupPath ?? undefined)
  ) {
    void options.context.globalState.update('openTabPaths', rawTabs);
    void options.context.globalState.update('activeSessionPath', restoredStartupPath ?? undefined);
  }

  const cachedSessions = buildRestoredSessionSummaries(rawTabs, restoredTabs, workspaceCwd);
  if (cachedSessions.length > 0) {
    store.dispatch(sessionsActions.replaceSessionSummaries(cachedSessions));
  }
  if (restoredStartupPath) {
    store.dispatch(sessionsActions.setActiveSessionPath(restoredStartupPath));
  }

  bootLog('session-startup', 'restore.prepared', {
    activeSessionPath: restoredStartupPath,
    cachedSessionCount: cachedSessions.length,
    droppedTabCount: droppedPaths.length,
    openTabCount: restoredTabs.length,
    preloadCount: preloadPaths.length,
  });

  let nodePath: string;
  let sdkPath: string;

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

    nodePath = resolveNodePath({
      configuredPath: configuredNodePath,
      env: process.env as NodeJS.ProcessEnv,
    });
    sdkPath = await resolveSdkPath({
      configuredPath: configuredSdkPath,
      cachedPath: cachedSdkPath,
      env: process.env as NodeJS.ProcessEnv,
      exec: createCommandExecutor(),
    });
    if (shouldUseSdkCache) {
      void options.context.globalState.update(SDK_PATH_CACHE_KEY, sdkPath);
    }
  } catch (err) {
    store.dispatch(
      uiActions.setNotice(
        `pie setup error: ${(err as Error).message}. ` +
          'Set pie.nodePath and pie.sdkPath in settings.',
      ),
    );
    options.scheduleRender();
    return;
  }

  const backendPath = path.join(options.context.extensionPath, 'out', 'backend.js');

  // Pass the in-tree auth opt-in setting to the backend via env.
  const allowInTreeAuth = vscode.workspace.getConfiguration('pie').get<boolean>('allowInTreeAuth', false);
  if (allowInTreeAuth) {
    process.env.PIE_ALLOW_IN_TREE_AUTH = '1';
  } else {
    delete process.env.PIE_ALLOW_IN_TREE_AUTH;
  }

  options.events.attach(options.backend);

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
  } catch (err) {
    store.dispatch(
      uiActions.setNotice(`Failed to start PI backend: ${(err as Error).message}`),
    );
    bootLog('session-startup', 'backend.startFailed', {
      message: (err as Error).message,
    });
    options.events.detach();
    options.scheduleRender();
    return;
  }

  try {
    bootLog('session-startup', 'runtimePrefs.set.requested', {
      backendReady: store.getState().ui.backendReady,
      restoredStartupPath,
    });
    await options.backend.request('runtimePrefs.set', {
      providerToggles: store.getState().ui.prefs.providerToggles,
      extensionToggles: store.getState().ui.prefs.extensionToggles,
    });
    bootLog('session-startup', 'runtimePrefs.set.completed', {
      backendReady: store.getState().ui.backendReady,
      restoredStartupPath,
    });
  } catch {
    // Non-fatal: older/failed backends simply won't expose provider toggles to pi extensions.
    bootLog('session-startup', 'runtimePrefs.set.failed', {
      backendReady: store.getState().ui.backendReady,
      restoredStartupPath,
    });
  }

  const restoreError = publishBackendReady({
    scheduleRender: options.scheduleRender,
    openSession: options.openSession,
    preloadSessions: (sessionPaths) => options.state.preloadSessions(sessionPaths),
    restoredStartupPath,
    preloadPaths,
  });

  bootLog('session-startup', 'backend.readyDispatched', {
    activeSessionPath: store.getState().sessions.activeSessionPath,
    backendReady: store.getState().ui.backendReady,
    notice: store.getState().ui.notice,
    openTabCount: store.getState().sessions.openTabPaths.length,
  });

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

  try {
    const sessions = await options.backend.request<SessionSummary[]>('session.list');
    store.dispatch(sessionsActions.replaceSessionSummaries(sessions));
    options.scheduleRender();

    const toOpen = sessions[0]?.path;
    if (toOpen) {
      options.openSession(toOpen);
    }
  } catch {
    // Non-fatal; session list may be empty on a fresh install.
  }
}

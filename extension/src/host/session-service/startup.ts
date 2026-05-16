import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from '../backend-client';
import { buildRestoredSessionPlan } from '../restored-session-plan';
import { sessionsActions, store, uiActions } from '../store';
import { normalizeStoredOpenTabPaths, isPendingTabPath } from '../../shared/tab-behavior';
import { createCommandExecutor } from '../../shared/exec-command';
import { resolveChatPrefs } from '../../shared/protocol';
import { resolveNodePath, resolveSdkPath } from '../../shared/runtime-resolution';
import type { ChatPrefs, SessionSummary } from '../../shared/protocol';
import { SessionServiceEvents } from './events';
import { SessionServiceState } from './state';

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

  const rawTabs = options.context.globalState.get<unknown[]>(
    'openTabPaths',
  ) ?? [];
  const restoredTabs = normalizeStoredOpenTabPaths(rawTabs);
  const preferredStartupPath = options.context.globalState.get<string>('activeSessionPath') ?? null;
  const restoredSessionPlan = buildRestoredSessionPlan(restoredTabs, preferredStartupPath);
  store.dispatch(sessionsActions.setOpenTabPaths(restoredTabs));

  const cachedSessions: SessionSummary[] = rawTabs.flatMap((value) => {
    if (value === null || typeof value !== 'object') {
      return [];
    }
    const obj = value as Record<string, unknown>;
    const sessionPath = typeof obj['path'] === 'string' ? (obj['path'] as string) : null;
    if (!sessionPath || isPendingTabPath(sessionPath)) {
      return [];
    }
    const name = typeof obj['name'] === 'string' ? (obj['name'] as string) : 'New Session';
    return [{
      path: sessionPath,
      name,
      isPlaceholder: name === 'New Session',
      cwd: workspaceCwd,
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
    }];
  });
  if (cachedSessions.length > 0) {
    store.dispatch(sessionsActions.replaceSessionSummaries(cachedSessions));
  }

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
    await options.backend.start({ nodePath, sdkPath, backendPath, cwd: workspaceCwd });
  } catch (err) {
    store.dispatch(
      uiActions.setNotice(`Failed to start PI backend: ${(err as Error).message}`),
    );
    options.events.detach();
    options.scheduleRender();
    return;
  }

  try {
    await options.backend.request('runtimePrefs.set', {
      providerToggles: store.getState().ui.prefs.providerToggles,
    });
  } catch {
    // Non-fatal: older/failed backends simply won't expose provider toggles to pi extensions.
  }

  const { startupPath: restoredStartupPath, preloadPaths } = restoredSessionPlan;

  if (restoredStartupPath) {
    options.openSession(restoredStartupPath);
    options.state.preloadSessions(preloadPaths);
  }

  store.dispatch(uiActions.setBackendReady(true));
  options.scheduleRender();

  if (restoredStartupPath) {
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

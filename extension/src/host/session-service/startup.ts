import * as path from 'node:path';

import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { buildRestoredSessionPlan, filterRestorableStoredTabs } from '../core/restored-session-plan';
import { createCommandExecutor } from '../../shared/exec-command';
import { resolveChatPrefs } from '../../shared/protocol';
import { readPruningSettings } from './pruning-settings';
import { resolveNodePath, resolveSdkPath } from '../../shared/runtime-resolution';
import type { ChatPrefs, SessionSummary } from '../../shared/protocol';
import { SessionServiceEvents } from './events';
import { SessionServiceState } from './state';
import { buildRestoredSessionSummaries } from '../core/restored-session-summaries';
import { bootLog } from '../util/audit';
import { publishBackendReady } from './backend-ready';
import type { ArchState } from '../core/arch-state';

const PREFS_STORAGE_KEY = 'chatPrefs';
const SDK_PATH_CACHE_KEY = 'resolvedSdkPath';

interface StartSessionBackendOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: () => void;
  events: SessionServiceEvents;
  state: SessionServiceState;
  openSession: (sessionPath: string) => void;
  getArchState: () => ArchState;
  mutateArchState: (recipe: (draft: ArchState) => void) => void;
}

function resolveWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

/**
 * Merge an existing summary with an incoming one. We preserve a real local name
 * over a backend-emitted placeholder so that "New Session" doesn't clobber a
 * user-meaningful tab label after a list refresh.
 */
function mergeSessionSummary(
  existing: SessionSummary | undefined,
  incoming: SessionSummary,
): SessionSummary {
  if (!existing) return incoming;
  const keepExistingName =
    !existing.isPlaceholder &&
    incoming.isPlaceholder === true;
  return {
    ...incoming,
    name: keepExistingName ? existing.name : incoming.name,
    isPlaceholder: keepExistingName ? false : incoming.isPlaceholder,
    modelId: incoming.modelId ?? existing.modelId,
    thinkingLevel: incoming.thinkingLevel ?? existing.thinkingLevel,
  };
}

function applyStoredPrefs(options: StartSessionBackendOptions): void {
  const storedPrefs = options.context.globalState.get<Partial<ChatPrefs>>(PREFS_STORAGE_KEY);
  if (storedPrefs) {
    options.mutateArchState((draft) => {
      draft.settings.prefs = resolveChatPrefs({ ...draft.settings.prefs, ...storedPrefs });
    });
  }
}

function loadPruningSettingsAsync(options: StartSessionBackendOptions): void {
  readPruningSettings().then(
    (ps) => options.mutateArchState((draft) => { draft.settings.pruningSettings = ps; }),
    () => { /* defaults remain */ },
  );
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
  options.mutateArchState((draft) => {
    draft.sessions.openTabPaths = restoredTabs;
    draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
      .filter((p) => restoredTabs.includes(p));
  });
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

function replaceSessionSummaries(draft: ArchState, incoming: SessionSummary[]): void {
  const mergedByPath = new Map<string, SessionSummary>();
  for (const item of incoming) {
    const existing = mergedByPath.get(item.path) ?? draft.sessions.sessions.find((s) => s.path === item.path);
    mergedByPath.set(item.path, mergeSessionSummary(existing, item));
  }
  for (const s of draft.sessions.sessions) {
    if (!mergedByPath.has(s.path) && draft.sessions.openTabPaths.includes(s.path)) {
      mergedByPath.set(s.path, s);
    }
  }
  const activeSession = draft.sessions.activeSessionPath
    ? draft.sessions.sessions.find((session) => session.path === draft.sessions.activeSessionPath)
    : undefined;
  draft.sessions.sessions = [...mergedByPath.values()];
  if (activeSession && !mergedByPath.has(activeSession.path) && draft.sessions.openTabPaths.includes(activeSession.path)) {
    draft.sessions.sessions.push(activeSession);
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
    options.mutateArchState((draft) => {
      draft.settings.notice =
        `pie setup error: ${(err as Error).message}. ` +
          'Set pie.nodePath and pie.sdkPath in settings.';
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
    options.mutateArchState((draft) => {
      draft.settings.notice = `Failed to start PI backend: ${(err as Error).message}`;
    });
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
    options.mutateArchState((draft) => {
      replaceSessionSummaries(draft, sessions);
    });
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
  const { mutateArchState } = options;

  mutateArchState((draft) => {
    draft.sessions.workspaceCwd = workspaceCwd;
  });

  applyStoredPrefs(options);
  loadPruningSettingsAsync(options);

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
    mutateArchState((draft) => {
      replaceSessionSummaries(draft, cachedSessions);
    });
  }

  if (restoredStartupPath) {
    mutateArchState((draft) => {
      draft.sessions.activeSessionPath = restoredStartupPath;
      draft.sessions.unreadFinishedSessionPaths = draft.sessions.unreadFinishedSessionPaths
        .filter((p) => p !== restoredStartupPath);
    });
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
    mutateArchState,
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

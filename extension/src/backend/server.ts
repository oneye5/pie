import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { attachJsonlLineReader } from '../shared/jsonl';
import {
  PROTOCOL_VERSION,
  type BusyChangedPayload,
  type ContextUsageChangedPayload,
  type ContextWindowUsage,
  type ModelSettings,
  type RequestEnvelope,
  type SessionListChangedPayload,
  type SessionOpenedPayload,
  type SystemPromptEntry,
  type ThinkingLevel,
  type TranscriptPageDirection,
  type TranscriptPagePayload,
} from '../shared/protocol';
import { prepareContextFiles } from './context-files';
import { handleBackendRequest } from './request-handler';
import { buildSessionAnalyticsFactors } from './session-analytics';
import { handleSdkSessionEvent } from './session-event-handler';
import {
  buildCurrentSummary,
  listAvailableModels,
  listSessions as listSessionSummaries,
} from './session-metadata';
import {
  loadSdk,
  loadSdkInternalModule,
  type SdkModule,
  type SdkSession,
  type SdkSessionEvent,
  type SdkSessionManager,
  type SdkSystemPromptModule,
} from './sdk';
import { extractRequestError, responseError, responseOk, writeStdout } from './server-io';
import {
  type SessionContext,
  type SessionContextCreationReason,
  type SessionPromptState,
} from './server-types';
import {
  buildSessionSystemPrompts,
  normalizePromptText,
} from './system-prompts';
import {
  buildDisplayTranscriptCache,
  buildPagedTranscriptWindow,
  buildTailTranscriptWindow,
  isDisplayTranscriptCacheStale,
} from './transcript-window';
import type { SessionEntryLike } from './transcript';

/**
 * Walk up from a file path looking for a `.git` directory. Returns true if the
 * file resides inside a Git working tree.
 */
async function isInsideGitWorkTree(filePath: string): Promise<boolean> {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.parse(dir).root;
  while (true) {
    try {
      const stat = await fs.stat(path.join(dir, '.git'));
      if (stat.isDirectory() || stat.isFile()) {
        return true;
      }
    } catch {
      // .git not found at this level — continue walking up.
    }
    if (dir === root) {
      break;
    }
    dir = path.dirname(dir);
  }
  return false;
}

/**
 * Returns the platform-standard directory for pie credentials.
 * - Windows: %LOCALAPPDATA%\pie
 * - macOS/Linux: ~/.config/pie
 */
function getDefaultAuthDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return path.join(localAppData, 'pie');
    }
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return path.join(home, '.config', 'pie');
}

/**
 * Ensures a directory exists, creating it (and parents) if needed.
 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * If `source` exists and `dest` does not, copy source to dest and remove the
 * original. Returns true if a migration occurred.
 */
async function migrateAuthFile(source: string, dest: string): Promise<boolean> {
  try {
    await fs.access(source);
  } catch {
    return false; // source doesn't exist — nothing to migrate
  }
  try {
    await fs.access(dest);
    return false; // dest already exists — don't overwrite
  } catch {
    // dest doesn't exist — proceed with migration
  }
  await ensureDir(path.dirname(dest));
  await fs.copyFile(source, dest);
  // Verify copy matches before removing original
  const [srcBuf, dstBuf] = await Promise.all([fs.readFile(source), fs.readFile(dest)]);
  if (srcBuf.equals(dstBuf)) {
    await fs.unlink(source);
    return true;
  }
  return false;
}

export class BackendServer {
  private sdk!: SdkModule;
  private readonly sdkPath: string;
  private readonly startupCwd: string;
  private agentDir = '';
  private authStorage: unknown;
  private viewedSessionPath?: string;
  private readonly sessionContexts = new Map<string, SessionContext>();
  private systemPromptModulePromise?: Promise<SdkSystemPromptModule>;

  constructor(options: { sdkPath: string; cwd: string }) {
    this.sdkPath = options.sdkPath;
    this.startupCwd = options.cwd;
  }

  async start(): Promise<void> {
    this.sdk = await loadSdk(this.sdkPath);
    this.agentDir = this.sdk.getAgentDir();

    const authDir = process.env.PI_CODING_AGENT_AUTH_DIR?.trim();
    let authPath: string;

    if (authDir) {
      // Explicit override — use as-is.
      authPath = path.resolve(authDir, 'auth.json');
    } else {
      // Default: check if agentDir is inside a git tree.
      const agentDirAuthPath = path.resolve(this.agentDir, 'auth.json');
      if (await isInsideGitWorkTree(agentDirAuthPath)) {
        const allowInTree = process.env.PIE_ALLOW_IN_TREE_SECRETS === '1';
        if (allowInTree) {
          authPath = agentDirAuthPath;
        } else {
          // Auto-resolve to platform-standard safe location.
          const safeDir = getDefaultAuthDir();
          authPath = path.resolve(safeDir, 'auth.json');
          // Migrate existing in-tree auth.json to the safe location.
          await migrateAuthFile(agentDirAuthPath, authPath);
        }
      } else {
        authPath = agentDirAuthPath;
      }
    }

    // Ensure the auth directory exists so the SDK can write to it.
    await ensureDir(path.dirname(authPath));

    this.authStorage = this.sdk.AuthStorage.create(authPath);

    this.emit('backend.ready', {
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      sdkVersion: this.sdk.VERSION,
      protocolVersion: PROTOCOL_VERSION,
      authPath,
    });

    const detachReader = attachJsonlLineReader(process.stdin, (line) => {
      void this.handleLine(line);
    });

    process.stdin.on('end', () => {
      detachReader();
      void this.dispose();
    });
  }

  private createRuntimeFactory() {
    return async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
      const services = (await this.sdk.createAgentSessionServices({
        cwd,
        agentDir,
        authStorage: this.authStorage,
        resourceLoaderOptions: {
          agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
            agentsFiles: prepareContextFiles(base.agentsFiles).map((contextFile) => ({
              path: contextFile.path,
              content: contextFile.content,
            })),
          }),
        },
      })) as Record<string, unknown>;

      const created = (await this.sdk.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })) as Record<string, unknown>;

      return {
        ...created,
        services,
      };
    };
  }

  private resolveSessionPath(session: SdkSession): string | undefined {
    return session.sessionFile ?? session.sessionManager.getSessionFile();
  }

  private getSessionContext(sessionPath?: string): SessionContext | undefined {
    return sessionPath ? this.sessionContexts.get(sessionPath) : undefined;
  }

  private async createSessionContext(
    sessionManager: SdkSessionManager,
    reason: SessionContextCreationReason,
  ): Promise<SessionContext> {
    const previousSessionFile = this.viewedSessionPath;
    const runtime = await this.sdk.createAgentSessionRuntime(this.createRuntimeFactory(), {
      cwd: sessionManager.getCwd(),
      agentDir: this.agentDir,
      sessionManager,
      sessionStartEvent: previousSessionFile
        ? {
            type: 'session_start',
            reason,
            previousSessionFile,
          }
        : undefined,
    });

    const session = runtime.session;
    const sessionPath = this.resolveSessionPath(session);
    if (!sessionPath) {
      await runtime.dispose();
      throw new Error('The PI session did not expose a session path.');
    }

    const existing = this.sessionContexts.get(sessionPath);
    const initialBusySeq = existing?.busySeq ?? 0;
    if (existing) {
      existing.unsubscribe();
      await existing.runtime.dispose();
    }

    const context: SessionContext = {
      runtime,
      session,
      sessionPath,
      unsubscribe: () => undefined,
      busySeq: initialBusySeq,
      lastContextUsage: undefined,
    };

    context.unsubscribe = session.subscribe((event: SdkSessionEvent) => {
      this.handleSessionEvent(context, event);
    });

    this.sessionContexts.set(sessionPath, context);
    return context;
  }

  private async ensureSessionContext(sessionPath: string): Promise<SessionContext> {
    const existing = this.sessionContexts.get(sessionPath);
    if (existing) {
      return existing;
    }

    return await this.createSessionContext(this.sdk.SessionManager.open(sessionPath), 'resume');
  }

  private ensureDisplayTranscriptCache(context: SessionContext) {
    const entries = (context.session.sessionManager.getBranch() ?? []) as SessionEntryLike[];
    if (isDisplayTranscriptCacheStale(context.displayTranscriptCache, entries)) {
      context.displayTranscriptCache = buildDisplayTranscriptCache(entries);
    }
    return context.displayTranscriptCache!;
  }

  private getPinnedStreamingMessageId(context: SessionContext): string | undefined {
    return context.activeRequest?.currentMessageId ?? context.activeRequest?.lastAssistantMessageId;
  }

  private async loadTranscriptPage(
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
  ): Promise<TranscriptPagePayload> {
    const context = await this.ensureSessionContext(sessionPath);
    const cache = this.ensureDisplayTranscriptCache(context);
    const page = buildPagedTranscriptWindow(cache, {
      direction,
      loadedStart,
      loadedEnd,
      pinnedMessageId: this.getPinnedStreamingMessageId(context),
    });

    return {
      sessionPath: context.sessionPath,
      transcript: page.transcript,
      transcriptWindow: page.transcriptWindow,
      busy: context.session.isStreaming,
    };
  }

  private getContextUsage(context: SessionContext): ContextWindowUsage | undefined {
    return context.session.getContextUsage?.();
  }

  private emitContextUsageChanged(context: SessionContext): void {
    const nextUsage = this.getContextUsage(context) ?? null;
    const previousUsage = context.lastContextUsage;
    const changed = previousUsage === undefined
      || (previousUsage === null
        ? nextUsage !== null
        : nextUsage === null
          || previousUsage.tokens !== nextUsage.tokens
          || previousUsage.contextWindow !== nextUsage.contextWindow
          || previousUsage.percent !== nextUsage.percent);

    if (!changed) {
      return;
    }

    context.lastContextUsage = nextUsage;
    this.emit('contextUsage.changed', {
      sessionPath: context.sessionPath,
      contextUsage: nextUsage,
    } satisfies ContextUsageChangedPayload);
  }

  private async getSystemPromptModule(): Promise<SdkSystemPromptModule> {
    this.systemPromptModulePromise ??= loadSdkInternalModule<SdkSystemPromptModule>(
      this.sdkPath,
      path.join('core', 'system-prompt.js'),
    );
    return await this.systemPromptModulePromise;
  }

  private getSessionPromptState(context: SessionContext): SessionPromptState {
    return context.session as SdkSession & SessionPromptState;
  }

  private async readHarnessSystemPrompt(context: SessionContext): Promise<string | undefined> {
    const promptState = this.getSessionPromptState(context);
    const options = promptState._baseSystemPromptOptions;
    if (!options) {
      return normalizePromptText(promptState._baseSystemPrompt);
    }

    try {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      return normalizePromptText(buildSystemPrompt({
        cwd: options.cwd,
        selectedTools: options.selectedTools,
        toolSnippets: options.toolSnippets,
        promptGuidelines: options.promptGuidelines,
      }));
    } catch {
      return normalizePromptText(promptState._baseSystemPrompt);
    }
  }

  private async buildSystemPrompts(
    context: SessionContext,
    harnessPromptOverride?: string,
  ): Promise<SystemPromptEntry[]> {
    const promptState = this.getSessionPromptState(context);
    const harnessPrompt = harnessPromptOverride ?? await this.readHarnessSystemPrompt(context);
    const tools = typeof context.session.getAllTools === 'function'
      ? context.session.getAllTools()
      : [];

    return buildSessionSystemPrompts({
      harnessPrompt,
      promptOptions: promptState._baseSystemPromptOptions,
      formatSkillsForPrompt: this.sdk.formatSkillsForPrompt,
      tools,
    });
  }

  private async readModelSettings(): Promise<ModelSettings> {
    const defaults: ModelSettings = { defaultModel: '', defaultThinkingLevel: 'medium' };
    try {
      const raw = await fs.readFile(path.join(this.agentDir, 'settings.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ModelSettings>;
      return {
        defaultModel: parsed.defaultModel ?? defaults.defaultModel,
        defaultThinkingLevel: (parsed.defaultThinkingLevel as ThinkingLevel) ?? defaults.defaultThinkingLevel,
      };
    } catch {
      return defaults;
    }
  }

  private async writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings> {
    const settingsPath = path.join(this.agentDir, 'settings.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      // may not exist yet
    }
    const merged = { ...existing, ...updates };
    await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    return await this.readModelSettings();
  }

  private async emitSessionOpened(sessionPath: string, selectionToken?: string): Promise<void> {
    if (!this.sessionContexts.has(sessionPath)) {
      return;
    }

    const payload = await this.buildSessionOpenedPayload(sessionPath, selectionToken);
    this.emit('session.opened', payload);
  }

  private async buildSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
  ): Promise<SessionOpenedPayload> {
    const context = this.getSessionContext(sessionPath);
    if (!context) {
      throw new Error(`Unknown session: ${sessionPath}`);
    }

    const harnessPrompt = await this.readHarnessSystemPrompt(context);
    const [systemPrompts, modelSettings, analyticsFactors] = await Promise.all([
      this.buildSystemPrompts(context, harnessPrompt),
      this.readModelSettings(),
      buildSessionAnalyticsFactors({
        harnessPrompt,
        promptOptions: this.getSessionPromptState(context)._baseSystemPromptOptions,
      }),
    ]);

    const contextUsage = this.getContextUsage(context) ?? null;
    context.lastContextUsage = contextUsage;

    const cache = this.ensureDisplayTranscriptCache(context);
    const transcriptSlice = buildTailTranscriptWindow(cache, {
      pinnedMessageId: this.getPinnedStreamingMessageId(context),
    });

    return {
      session: buildCurrentSummary(context, this.startupCwd),
      transcript: transcriptSlice.transcript,
      transcriptWindow: transcriptSlice.transcriptWindow,
      busy: context.session.isStreaming,
      selectionToken,
      systemPrompts,
      analyticsFactors,
      modelSettings,
      availableModels: listAvailableModels(context),
      contextUsage: contextUsage ?? undefined,
    };
  }

  private async emitSessionListChanged(): Promise<void> {
    const payload: SessionListChangedPayload = {
      sessions: await listSessionSummaries(this.sdk),
      activeSessionPath: this.viewedSessionPath,
    };
    this.emit('session.list.changed', payload);
  }

  private emitBusyChanged(context: SessionContext, busy: boolean): void {
    context.busySeq += 1;
    const payload: BusyChangedPayload = {
      sessionPath: context.sessionPath,
      busy,
      seq: context.busySeq,
    };
    this.emit('busy.changed', payload);
  }

  private emit(event: string, payload?: unknown): void {
    writeStdout({ event, payload });
  }

  private async handleLine(line: string): Promise<void> {
    let request: RequestEnvelope;
    try {
      request = JSON.parse(line) as RequestEnvelope;
    } catch (error) {
      writeStdout(responseError('parse-error', 'PARSE_ERROR', String(error)));
      return;
    }

    try {
      const result = await this.handleRequest(request);
      writeStdout(responseOk(request.id, result));
    } catch (error) {
      const details = extractRequestError(error);
      writeStdout(responseError(request.id, details.code, details.message));
      this.emit('error', details);
    }
  }

  private async handleRequest(request: RequestEnvelope): Promise<unknown> {
    return await handleBackendRequest({
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
      sdk: this.sdk,
      getSessionContext: (sessionPath) => this.getSessionContext(sessionPath),
      createSessionContext: (sessionManager, reason) => this.createSessionContext(sessionManager, reason),
      ensureSessionContext: (sessionPath) => this.ensureSessionContext(sessionPath),
      setViewedSessionPath: (sessionPath) => {
        this.viewedSessionPath = sessionPath;
      },
      buildSessionOpenedPayload: (sessionPath, selectionToken) => (
        this.buildSessionOpenedPayload(sessionPath, selectionToken)
      ),
      loadTranscriptPage: (sessionPath, direction, loadedStart, loadedEnd) => (
        this.loadTranscriptPage(sessionPath, direction, loadedStart, loadedEnd)
      ),
      emit: (event, payload) => this.emit(event, payload),
      emitBusyChanged: (context, busy) => this.emitBusyChanged(context, busy),
      emitSessionListChanged: () => this.emitSessionListChanged(),
      listSessions: () => listSessionSummaries(this.sdk),
      listAvailableModels: (context) => listAvailableModels(context),
      readModelSettings: () => this.readModelSettings(),
      writeModelSettings: (updates) => this.writeModelSettings(updates),
    }, request);
  }

  private handleSessionEvent(context: SessionContext, event: SdkSessionEvent): void {
    handleSdkSessionEvent({
      emit: (name, payload) => this.emit(name, payload),
      emitBusyChanged: (sessionContext, busy) => this.emitBusyChanged(sessionContext, busy),
      emitContextUsageChanged: (sessionContext) => this.emitContextUsageChanged(sessionContext),
      emitSessionOpened: (sessionPath, selectionToken) => this.emitSessionOpened(sessionPath, selectionToken),
      emitSessionListChanged: () => this.emitSessionListChanged(),
    }, context, event);
  }

  async dispose(): Promise<void> {
    const contexts = [...this.sessionContexts.values()];
    this.sessionContexts.clear();

    for (const context of contexts) {
      context.unsubscribe();
      await context.runtime.dispose();
    }
  }
}

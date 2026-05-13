import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { attachJsonlLineReader, serializeJsonLine } from '../shared/jsonl';
import { deriveSessionNameFromText, NEW_SESSION_NAME } from '../shared/session-name';
import {
  PROTOCOL_VERSION,
  type BusyChangedPayload,
  type ChatMessage,
  type ComposerInput,
  type ContextUsageChangedPayload,
  type ContextWindowUsage,
  type ErrorPayload,
  type EventEnvelope,
  type MessageAbortedPayload,
  type MessageDeltaPayload,
  type MessageFinishedPayload,
  type MessageStartedPayload,
  type MessageThinkingPayload,
  type ModelInfo,
  type ModelInputKind,
  type ModelSettings,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SessionListChangedPayload,
  type SessionOpenedPayload,
  type SystemPromptEntry,
  type SessionSummary,
  type ThinkingLevel,
  type ToolFinishedPayload,
  type ToolProgressPayload,
  type ToolStartedPayload,
} from '../shared/protocol';
import {
  parseArgs,
  validateMessageSend,
  validateSessionCreate,
  validateSessionOpen,
  validateSessionPath,
  validateSettingsSet,
  validateTruncateAfter,
} from './rpc';
import {
  loadSdk,
  loadSdkInternalModule,
  type SdkBuildSystemPromptOptions,
  type SdkImageContent,
  type SdkModule,
  type SdkRuntime,
  type SdkSession,
  type SdkSessionEvent,
  type SdkSessionManager,
  type SdkSkill,
  type SdkSystemPromptModule,
} from './sdk';
import { buildSessionAnalyticsFactors } from './session-analytics';
import { mapAssistantMessage, mapTranscript, summarizeSession, type SessionEntryLike } from './transcript';

interface ActiveRequest {
  id: string;
  messageIndex: number;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  currentMessageId?: string;
  lastAssistantMessageId?: string;
  currentMessageStartedAt?: number;
  aborted: boolean;
}

interface SessionContext {
  runtime: SdkRuntime;
  session: SdkSession;
  sessionPath: string;
  unsubscribe: () => void;
  activeRequest?: ActiveRequest;
  /** Per-session monotonic counter for `busy.changed` events. */
  busySeq: number;
  lastContextUsage?: ContextWindowUsage | null;
}

function writeStdout(value: EventEnvelope | ResponseEnvelope): void {
  process.stdout.write(serializeJsonLine(value));
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function extractRequestError(error: unknown): ErrorPayload {
  if (error instanceof Error) {
    return { code: 'BACKEND_ERROR', message: error.message };
  }
  return { code: 'BACKEND_ERROR', message: String(error) };
}

function responseOk(id: string, result?: unknown): ResponseEnvelope {
  return { id, ok: true, result };
}

function responseError(id: string, code: string, message: string, data?: unknown): ResponseEnvelope {
  return { id, ok: false, error: { code, message, data } };
}

function summarizePrompt(text: string): string {
  const stripped = text
    .replace(/\*\*?(.*?)\*\*?/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 80 ? stripped.slice(0, 80) + '...' : stripped;
}

function normalizePromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  switch (value) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}

function toDisplayPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function normalizeModelInputKinds(value: unknown): ModelInputKind[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const kinds = [...new Set(
    value.filter((kind): kind is ModelInputKind => kind === 'text' || kind === 'image'),
  )];

  if (kinds.length === 0) {
    return ['text'];
  }

  return kinds.includes('text') ? kinds : ['text', ...kinds];
}

function resolveModelInputKinds(model: Record<string, unknown>): ModelInputKind[] {
  return normalizeModelInputKinds(model['input']) ?? ['text'];
}

function lowerFilesystemPathRefs(inputs: ComposerInput[]): string[] {
  return inputs
    .filter((input): input is Extract<ComposerInput, { kind: 'filesystemPathRef' }> =>
      input.kind === 'filesystemPathRef')
    .map((input) => `@${input.path}`);
}

function lowerImageInputs(inputs: ComposerInput[]): SdkImageContent[] {
  return inputs
    .filter((input): input is Extract<ComposerInput, { kind: 'imageBlob' }> => input.kind === 'imageBlob')
    .map((input) => ({
      type: 'image',
      data: input.dataBase64,
      mimeType: input.mimeType,
    }));
}

function buildPromptText(text: string, inputs: ComposerInput[]): string {
  const sections: string[] = [];
  const pathPrelude = lowerFilesystemPathRefs(inputs);
  if (pathPrelude.length > 0) {
    sections.push(pathPrelude.join('\n'));
  }
  if (text.trim()) {
    sections.push(text);
  }
  return sections.join('\n\n');
}

const PROVIDER_SYSTEM_PROMPT: SystemPromptEntry = {
  source: 'provider',
  title: 'Provider system prompt',
  summary: 'Unknown',
  text: 'Unknown.\n\nThe upstream GitHub Copilot provider prompt is not exposed to this extension.',
  availability: 'unknown',
};

interface SessionPromptState {
  _baseSystemPrompt?: string;
  _baseSystemPromptOptions?: SdkBuildSystemPromptOptions;
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
    this.authStorage = this.sdk.AuthStorage.create();

    this.emit('backend.ready', {
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      sdkVersion: this.sdk.VERSION,
      protocolVersion: PROTOCOL_VERSION,
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
        resourceLoaderOptions: {},
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
    reason: 'new' | 'resume',
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
      // Preserve the per-session counter across context recreation so the host
      // can continue deduplicating busy.changed events after edit reruns.
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

  private getPreferredSessionContext(sessionPath?: string): SessionContext | undefined {
    const preferred = this.getSessionContext(sessionPath) ?? this.getSessionContext(this.viewedSessionPath);
    if (preferred) {
      return preferred;
    }

    return this.sessionContexts.values().next().value;
  }

  private textFromSessionMessageContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return (content as Array<{ type?: string; text?: string }>)
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
    }

    return '';
  }

  private async deriveNameFromFile(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as SessionEntryLike;
          if (entry.type === 'message' && entry.message?.role === 'user') {
            const derived = deriveSessionNameFromText(
              this.textFromSessionMessageContent(entry.message.content),
            );
            if (!derived.isPlaceholder) {
              return derived.name;
            }
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // file not readable
    }
    return NEW_SESSION_NAME;
  }

  private async listSessions(): Promise<SessionSummary[]> {
    const sessions = await this.sdk.SessionManager.listAll();
    const summaries = await Promise.all(
      sessions.map(async (session) => {
        const summary = summarizeSession(session);
        if (summary.name === NEW_SESSION_NAME && session.path) {
          const derived = await this.deriveNameFromFile(session.path);
          if (derived !== NEW_SESSION_NAME) {
            summary.name = derived;
            summary.isPlaceholder = false;
          } else {
            summary.isPlaceholder = true;
          }
        }
        return summary;
      }),
    );
    return summaries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  private deriveSessionName(context: SessionContext): { name: string; isPlaceholder: boolean } {
    const sdkName = context.session.sessionName || context.session.sessionManager.getSessionName();
    if (sdkName) return { name: sdkName, isPlaceholder: false };

    const entries = context.session.sessionManager.getBranch() ?? [];
    for (const entry of entries) {
      if (entry.type === 'message' && entry.message?.role === 'user') {
        const derived = deriveSessionNameFromText(
          this.textFromSessionMessageContent(entry.message.content),
        );
        if (!derived.isPlaceholder) {
          return derived;
        }
      }
    }

    return { name: NEW_SESSION_NAME, isPlaceholder: true };
  }

  private buildCurrentSummary(context: SessionContext): SessionSummary {
    const messageCount = context.session.messages.length ?? 0;
    const { name, isPlaceholder } = this.deriveSessionName(context);
    return {
      path: context.sessionPath,
      cwd: context.session.sessionManager.getCwd() ?? this.startupCwd,
      name,
      isPlaceholder,
      modifiedAt: new Date().toISOString(),
      messageCount,
      modelId: context.session.model?.id,
      thinkingLevel: normalizeThinkingLevel(context.session.thinkingLevel),
    };
  }

  private buildTranscript(context: SessionContext): ChatMessage[] {
    const entries = context.session.sessionManager.getBranch() ?? [];
    return mapTranscript(entries);
  }

  private listAvailableModels(context?: SessionContext): ModelInfo[] {
    if (!context) return [];
    try {
      const models = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
      return models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        reasoning: model.reasoning,
        inputKinds: resolveModelInputKinds(model as unknown as Record<string, unknown>),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
    } catch {
      return [];
    }
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

  private buildUserPromptSections(options?: SdkBuildSystemPromptOptions): string | undefined {
    if (!options) {
      return undefined;
    }

    const sections: string[] = [];
    const customPrompt = normalizePromptText(options.customPrompt);
    if (customPrompt) {
      sections.push(`## System prompt override\n\n${customPrompt}`);
    }

    const appendSystemPrompt = normalizePromptText(options.appendSystemPrompt);
    if (appendSystemPrompt) {
      sections.push(`## Appended system prompt\n\n${appendSystemPrompt}`);
    }

    for (const contextFile of options.contextFiles ?? []) {
      const content = normalizePromptText(contextFile.content);
      if (!content) {
        continue;
      }
      sections.push(`## ${toDisplayPath(contextFile.path)}\n\n${content}`);
    }

    if (typeof this.sdk.formatSkillsForPrompt === 'function' && (options.skills?.length ?? 0) > 0) {
      const formattedSkills = normalizePromptText(this.sdk.formatSkillsForPrompt(options.skills as SdkSkill[]));
      if (formattedSkills) {
        sections.push(`## Skills\n\n${formattedSkills}`);
      }
    }

    return sections.length > 0 ? sections.join('\n\n---\n\n') : undefined;
  }

  private async buildSystemPrompts(
    context: SessionContext,
    harnessPromptOverride?: string,
  ): Promise<SystemPromptEntry[]> {
    const promptState = this.getSessionPromptState(context);
    const userPrompt = this.buildUserPromptSections(promptState._baseSystemPromptOptions);
    const harnessPrompt = harnessPromptOverride ?? await this.readHarnessSystemPrompt(context);

    const entries: SystemPromptEntry[] = [PROVIDER_SYSTEM_PROMPT];

    entries.push(
      harnessPrompt
        ? {
            source: 'harness',
            title: 'Harness system prompt',
            summary: summarizePrompt(harnessPrompt),
            text: harnessPrompt,
            availability: 'available',
          }
        : {
            source: 'harness',
            title: 'Harness system prompt',
            summary: 'Unavailable',
            text: 'The PI harness prompt could not be reconstructed for this session.',
            availability: 'missing',
          },
    );

    entries.push(
      userPrompt
        ? {
            source: 'user',
            title: 'User system prompt',
            summary: summarizePrompt(userPrompt),
            text: userPrompt,
            availability: 'available',
          }
        : {
            source: 'user',
            title: 'User system prompt',
            summary: 'None configured',
            text: 'No user-controlled system prompt content is configured for this session.',
            availability: 'missing',
          },
    );

    return entries;
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

    return {
      session: this.buildCurrentSummary(context),
      transcript: this.buildTranscript(context),
      busy: context.session.isStreaming,
      selectionToken,
      systemPrompts,
      analyticsFactors,
      modelSettings,
      availableModels: this.listAvailableModels(context),
      contextUsage: contextUsage ?? undefined,
    };
  }

  private async emitSessionListChanged(): Promise<void> {
    const payload: SessionListChangedPayload = {
      sessions: await this.listSessions(),
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
    switch (request.method) {
      case 'app.ping':
        return {
          sdkPath: this.sdkPath,
          agentDir: this.agentDir,
          sdkVersion: this.sdk.VERSION,
          protocolVersion: PROTOCOL_VERSION,
        };

      case 'session.list':
        return this.listSessions();

      case 'session.create': {
        const params = validateSessionCreate(request.params);
        const cwd = params.cwd || this.startupCwd;
        const context = await this.createSessionContext(this.sdk.SessionManager.create(cwd), 'new');
        this.viewedSessionPath = context.sessionPath;
        const createPayload = await this.buildSessionOpenedPayload(
          context.sessionPath,
          params.selectionToken,
        );
        this.emit('session.opened', createPayload);
        this.emitBusyChanged(context, context.session.isStreaming);
        void this.emitSessionListChanged();
        return createPayload;
      }

      case 'session.open': {
        const params = validateSessionOpen(request.params);
        const context = await this.ensureSessionContext(params.sessionPath);
        this.viewedSessionPath = context.sessionPath;
        const openPayload = await this.buildSessionOpenedPayload(
          context.sessionPath,
          params.selectionToken,
        );
        this.emit('session.opened', openPayload);
        this.emitBusyChanged(context, context.session.isStreaming);
        void this.emitSessionListChanged();
        return openPayload;
      }

      case 'session.preload': {
        const params = validateSessionPath('session.preload', request.params);
        const context = await this.ensureSessionContext(params.sessionPath);
        return await this.buildSessionOpenedPayload(context.sessionPath);
      }

      case 'session.truncateAfter': {
        const params = validateTruncateAfter(request.params);

        const existingCtx = this.getSessionContext(params.sessionPath);
        if (existingCtx?.activeRequest || existingCtx?.session.isStreaming) {
          throw new Error('Cannot truncate a session that is currently streaming.');
        }

        // Rewrite the JSONL file, dropping the target entry and everything after it.
        const raw = await fs.readFile(params.sessionPath, 'utf8');
        const keepLines: string[] = [];
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as { id?: string };
            if (entry.id === params.entryId) break;
            keepLines.push(line);
          } catch {
            // skip malformed lines
          }
        }
        const newContent = keepLines.length > 0 ? keepLines.join('\n') + '\n' : '';
        await fs.writeFile(params.sessionPath, newContent, 'utf8');

        // Reload session from the truncated file.
        const context = await this.createSessionContext(
          this.sdk.SessionManager.open(params.sessionPath),
          'resume',
        );
        this.viewedSessionPath = context.sessionPath;
        const truncatePayload = await this.buildSessionOpenedPayload(context.sessionPath);
        this.emit('session.opened', truncatePayload);
        this.emitBusyChanged(context, false);
        void this.emitSessionListChanged();
        return truncatePayload;
      }

      case 'message.send': {
        const params = validateMessageSend(request.params);
        const context = await this.ensureSessionContext(params.sessionPath);
        if (context.activeRequest || context.session.isStreaming) {
          throw new Error('A request is already in progress for this session.');
        }

        const requestId = crypto.randomUUID();
        const promptText = buildPromptText(params.text, params.inputs);
        const images = lowerImageInputs(params.inputs);
        const imagePayload = images.length > 0 ? images : undefined;
        context.activeRequest = {
          id: requestId,
          messageIndex: 0,
          modelId: context.session.model?.id,
          thinkingLevel: normalizeThinkingLevel(context.session.thinkingLevel),
          aborted: false,
        };

        let preflightSettled = false;
        const accepted = new Promise<void>((resolve, reject) => {
          void context.session
            .prompt(promptText, {
              source: 'rpc',
              images: imagePayload,
              preflightResult: (success) => {
                if (preflightSettled) {
                  return;
                }

                preflightSettled = true;
                if (!success) {
                  reject(new Error('Prompt rejected before PI accepted the request.'));
                  return;
                }

                this.emitBusyChanged(context, true);
                resolve();
              },
            })
            .catch((error: Error) => {
              if (!preflightSettled) {
                preflightSettled = true;
                reject(error);
                return;
              }

              this.emit('error', {
                code: 'MESSAGE_SEND_FAILED',
                message: error.message,
                requestId,
              } satisfies ErrorPayload);
              if (context.activeRequest?.id === requestId) {
                context.activeRequest = undefined;
                this.emitBusyChanged(context, false);
              }
            });
        });

        try {
          await accepted;
        } catch (error) {
          if (context.activeRequest?.id === requestId) {
            context.activeRequest = undefined;
          }
          throw error;
        }

        return { requestId };
      }

      case 'message.interrupt': {
        const params = validateSessionPath('message.interrupt', request.params);
        const context = this.getSessionContext(params.sessionPath);
        if (!context) {
          throw new Error(`Cannot interrupt an unopened session: ${params.sessionPath}`);
        }
        if (!context.activeRequest && !context.session.isStreaming) {
          throw new Error(`Cannot interrupt a session that is not running: ${params.sessionPath}`);
        }
        if (context.activeRequest) {
          context.activeRequest.aborted = true;
        }
        // Fire abort without awaiting — session.abort() can block while a subagent
        // subprocess is running and must not hold the RPC response hostage.
        void context.session.abort().catch((error: unknown) => {
          this.emit('error', {
            code: 'MESSAGE_INTERRUPT_FAILED',
            message: error instanceof Error ? error.message : String(error),
            requestId: context.activeRequest?.id,
          } satisfies ErrorPayload);
        });
        return { interrupted: true };
      }

      case 'models.list': {
        const params = validateSessionPath('models.list', request.params);
        return this.listAvailableModels(await this.ensureSessionContext(params.sessionPath));
      }

      case 'settings.get':
        return await this.readModelSettings();

      case 'settings.set': {
        const params = validateSettingsSet(request.params);
        const { sessionPath, ...settingsUpdates } = params;
        const previousSettings = await this.readModelSettings();
        const targetContext = sessionPath ? await this.ensureSessionContext(sessionPath) : undefined;
        const result = await this.writeModelSettings(settingsUpdates);

        try {
          // Apply immediately to the targeted session so the change takes effect
          // without needing to create a new session.
          if (params.defaultModel && targetContext) {
            const available = targetContext.runtime.services?.modelRegistry?.getAvailable() ?? [];
            const info = available.find((model) => model.id === params.defaultModel);
            if (!info) {
              throw new Error(`Model not available in this session: ${params.defaultModel}`);
            }

            const resolvedModel = targetContext.runtime.services.modelRegistry.find(info.provider, info.id);
            if (!resolvedModel) {
              throw new Error(`Could not resolve model in registry: ${params.defaultModel}`);
            }

            if (typeof targetContext.session.setModel !== 'function') {
              throw new Error('This PI session does not support live model switching.');
            }

            await targetContext.session.setModel(resolvedModel);
            if (targetContext.session.model?.id !== params.defaultModel) {
              throw new Error(`Live model switch did not take effect: ${params.defaultModel}`);
            }

            if (params.defaultThinkingLevel) {
              targetContext.session.setThinkingLevel?.(params.defaultThinkingLevel);
            }

            targetContext.lastContextUsage = null;
            this.emit('contextUsage.changed', {
              sessionPath: targetContext.sessionPath,
              contextUsage: null,
            } satisfies ContextUsageChangedPayload);
          }

          return result;
        } catch (error) {
          await this.writeModelSettings({
            defaultModel: previousSettings.defaultModel,
            defaultThinkingLevel: previousSettings.defaultThinkingLevel,
          });
          throw error;
        }
      }

      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }

  private handleSessionEvent(context: SessionContext, event: SdkSessionEvent): void {
    switch (event.type) {
      case 'agent_start': {
        this.emitBusyChanged(context, true);
        this.emitContextUsageChanged(context);
        return;
      }

      case 'message_start': {
        if (event.message?.role !== 'assistant' || !context.activeRequest) {
          return;
        }
        context.activeRequest.messageIndex += 1;
        context.activeRequest.currentMessageId = `${context.activeRequest.id}:${context.activeRequest.messageIndex}`;
        context.activeRequest.lastAssistantMessageId = context.activeRequest.currentMessageId;
        context.activeRequest.currentMessageStartedAt = Date.now();

        this.emit('message.started', {
          requestId: context.activeRequest.id,
          messageId: context.activeRequest.currentMessageId,
          sessionPath: context.sessionPath,
          modelId: context.activeRequest.modelId,
          thinkingLevel: context.activeRequest.thinkingLevel,
        } satisfies MessageStartedPayload);
        this.emitContextUsageChanged(context);
        return;
      }

      case 'message_update': {
        if (event.message?.role !== 'assistant' || !context.activeRequest?.currentMessageId) {
          return;
        }

        if (event.assistantMessageEvent?.type === 'text_delta') {
          this.emit('message.delta', {
            requestId: context.activeRequest.id,
            sessionPath: context.sessionPath,
            messageId: context.activeRequest.currentMessageId,
            delta: event.assistantMessageEvent.delta ?? '',
          } satisfies MessageDeltaPayload);
        }

        if (event.assistantMessageEvent?.type === 'thinking_delta') {
          const thinkingContent: string =
            event.assistantMessageEvent.thinking ?? event.assistantMessageEvent.delta ?? '';
          if (thinkingContent) {
            this.emit('message.thinking', {
              requestId: context.activeRequest.id,
              sessionPath: context.sessionPath,
              messageId: context.activeRequest.currentMessageId,
              thinking: thinkingContent,
            } satisfies MessageThinkingPayload);
          }
        }

        this.emitContextUsageChanged(context);
        return;
      }

      case 'tool_execution_start': {
        if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
          return;
        }

        this.emit('tool.started', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          messageId: context.activeRequest.lastAssistantMessageId,
          toolCallId: event.toolCallId ?? '',
          name: event.toolName ?? '',
          input: event.args,
        } satisfies ToolStartedPayload);
        this.emitContextUsageChanged(context);
        return;
      }

      case 'tool_execution_update': {
        if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
          return;
        }

        this.emit('tool.progress', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          messageId: context.activeRequest.lastAssistantMessageId,
          toolCallId: event.toolCallId ?? '',
          partialResult: event.partialResult,
        } satisfies ToolProgressPayload);
        this.emitContextUsageChanged(context);
        return;
      }

      case 'tool_execution_end': {
        if (!context.activeRequest || !context.activeRequest.lastAssistantMessageId) {
          return;
        }

        this.emit('tool.finished', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          messageId: context.activeRequest.lastAssistantMessageId,
          toolCallId: event.toolCallId ?? '',
          result: event.result,
          status: event.isError ? 'failed' : 'completed',
        } satisfies ToolFinishedPayload);
        this.emitContextUsageChanged(context);
        return;
      }

      case 'message_end': {
        if (event.message?.role !== 'assistant' || !context.activeRequest) {
          return;
        }

        const messageId =
          context.activeRequest.currentMessageId ??
          context.activeRequest.lastAssistantMessageId ??
          `${context.activeRequest.id}:${context.activeRequest.messageIndex + 1}`;

        context.activeRequest.lastAssistantMessageId = messageId;
        context.activeRequest.currentMessageId = undefined;

        const durationMs = context.activeRequest.currentMessageStartedAt !== undefined
          ? Date.now() - context.activeRequest.currentMessageStartedAt
          : undefined;
        context.activeRequest.currentMessageStartedAt = undefined;
        const message = mapAssistantMessage(messageId, event.message as any, durationMs, {
          modelId: context.activeRequest.modelId,
          thinkingLevel: context.activeRequest.thinkingLevel,
        });
        this.emit('message.finished', {
          requestId: context.activeRequest.id,
          sessionPath: context.sessionPath,
          message,
        } satisfies MessageFinishedPayload);

        if (message.status === 'interrupted') {
          this.emit('message.aborted', {
            requestId: context.activeRequest.id,
            sessionPath: context.sessionPath,
            messageId,
          } satisfies MessageAbortedPayload);
        }

        this.emitContextUsageChanged(context);
        return;
      }

      case 'agent_end': {
        const requestId = context.activeRequest?.id;
        const messageId = context.activeRequest?.lastAssistantMessageId;
        const abortedWithoutMessage = context.activeRequest?.aborted && !messageId;

        this.emitBusyChanged(context, false);
        this.emitContextUsageChanged(context);

        void this.emitSessionOpened(context.sessionPath);
        void this.emitSessionListChanged();

        if (requestId && abortedWithoutMessage) {
          this.emit('message.aborted', {
            requestId,
            sessionPath: context.sessionPath,
          } satisfies MessageAbortedPayload);
        }

        context.activeRequest = undefined;
        return;
      }

      default:
        return;
    }
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

async function main(): Promise<void> {
  const server = new BackendServer(parseArgs(process.argv.slice(2)));
  await server.start();
}

if (require.main === module) {
  void main().catch((error) => {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';

import { EXTENSION_TOGGLES_ENV, PROVIDER_TOGGLES_ENV, PROTOCOL_VERSION, type ContextUsageChangedPayload, type ErrorPayload, type ExtensionUIResponsePayload, type ModelInfo, type ModelSettings, type RequestEnvelope, type SessionOpenedPayload, type SessionSummary, type TranscriptPageDirection, type TranscriptPagePayload } from '../shared/protocol';
import {
  validateLoadTranscriptPage,
  validateMessageSend,
  validateRuntimePrefsSet,
  validateSessionCreate,
  validateSessionOpen,
  validateSessionPath,
  validateSettingsSet,
  validateTruncateAfter,
} from './rpc';
import type { SdkModule, SdkSessionManager } from './sdk';
import { buildPromptText, lowerImageInputs, normalizeThinkingLevel } from './message-inputs';
import type { SessionContext, SessionContextCreationReason } from './server-types';

export interface BackendRequestHandlerDeps {
  sdkPath: string;
  agentDir: string;
  startupCwd: string;
  sdk: SdkModule;
  getSessionContext(sessionPath?: string): SessionContext | undefined;
  createSessionContext(
    sessionManager: SdkSessionManager,
    reason: SessionContextCreationReason,
  ): Promise<SessionContext>;
  ensureSessionContext(sessionPath: string): Promise<SessionContext>;
  setViewedSessionPath(sessionPath: string | undefined): void;
  buildSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
  ): Promise<SessionOpenedPayload>;
  loadTranscriptPage(
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
  ): Promise<TranscriptPagePayload>;
  emit(event: string, payload?: unknown): void;
  emitBusyChanged(context: SessionContext, busy: boolean): void;
  emitSessionListChanged(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  listAvailableModels(context?: SessionContext): ModelInfo[];
  readModelSettings(): Promise<ModelSettings>;
  writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings>;
}

export async function handleBackendRequest(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  switch (request.method) {
    case 'app.ping':
      return {
        sdkPath: deps.sdkPath,
        agentDir: deps.agentDir,
        sdkVersion: deps.sdk.VERSION,
        protocolVersion: PROTOCOL_VERSION,
      };

    case 'runtimePrefs.set': {
      const params = validateRuntimePrefsSet(request.params);
      process.env[PROVIDER_TOGGLES_ENV] = JSON.stringify(params.providerToggles);
      process.env[EXTENSION_TOGGLES_ENV] = JSON.stringify(params.extensionToggles);
      return params;
    }

    case 'session.list':
      return await deps.listSessions();

    case 'session.create': {
      const params = validateSessionCreate(request.params);
      const cwd = params.cwd || deps.startupCwd;
      const context = await deps.createSessionContext(deps.sdk.SessionManager.create(cwd), 'new');
      deps.setViewedSessionPath(context.sessionPath);
      const createPayload = await deps.buildSessionOpenedPayload(
        context.sessionPath,
        params.selectionToken,
      );
      deps.emit('session.opened', createPayload);
      deps.emitBusyChanged(context, context.session.isStreaming || !!context.activeRequest);
      void deps.emitSessionListChanged();
      return createPayload;
    }

    case 'session.open': {
      const params = validateSessionOpen(request.params);
      const context = await deps.ensureSessionContext(params.sessionPath);
      deps.setViewedSessionPath(context.sessionPath);
      const openPayload = await deps.buildSessionOpenedPayload(
        context.sessionPath,
        params.selectionToken,
      );
      deps.emit('session.opened', openPayload);
      deps.emitBusyChanged(context, context.session.isStreaming || !!context.activeRequest);
      void deps.emitSessionListChanged();
      return openPayload;
    }

    case 'session.preload': {
      const params = validateSessionPath('session.preload', request.params);
      const context = await deps.ensureSessionContext(params.sessionPath);
      return await deps.buildSessionOpenedPayload(context.sessionPath);
    }

    case 'session.loadTranscriptPage': {
      const params = validateLoadTranscriptPage(request.params);
      return await deps.loadTranscriptPage(
        params.sessionPath,
        params.direction,
        params.loadedStart,
        params.loadedEnd,
      );
    }

    case 'session.truncateAfter': {
      const params = validateTruncateAfter(request.params);

      const existingCtx = deps.getSessionContext(params.sessionPath);
      if (existingCtx?.activeRequest || existingCtx?.session.isStreaming) {
        throw new Error('Cannot truncate a session that is currently streaming.');
      }

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

      const context = await deps.createSessionContext(
        deps.sdk.SessionManager.open(params.sessionPath),
        'resume',
      );
      deps.setViewedSessionPath(context.sessionPath);
      const truncatePayload = await deps.buildSessionOpenedPayload(context.sessionPath);
      deps.emit('session.opened', truncatePayload);
      deps.emitBusyChanged(context, false);
      void deps.emitSessionListChanged();
      return truncatePayload;
    }

    case 'message.send': {
      const params = validateMessageSend(request.params);
      const context = await deps.ensureSessionContext(params.sessionPath);
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

              deps.emitBusyChanged(context, true);
              resolve();
            },
          })
          .catch((error: Error) => {
            if (!preflightSettled) {
              preflightSettled = true;
              reject(error);
              return;
            }

            deps.emit('error', {
              code: 'MESSAGE_SEND_FAILED',
              message: error.message,
              requestId,
            } satisfies ErrorPayload);
            if (context.activeRequest?.id === requestId) {
              context.activeRequest = undefined;
              deps.emitBusyChanged(context, false);
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
      const context = deps.getSessionContext(params.sessionPath);
      if (!context) {
        throw new Error(`Cannot interrupt an unopened session: ${params.sessionPath}`);
      }
      if (!context.activeRequest && !context.session.isStreaming) {
        throw new Error(`Cannot interrupt a session that is not running: ${params.sessionPath}`);
      }
      if (context.activeRequest) {
        context.activeRequest.aborted = true;
      }
      context.uiBridge?.cancelAll();
      void context.session.abort().catch((error: unknown) => {
        deps.emit('error', {
          code: 'MESSAGE_INTERRUPT_FAILED',
          message: error instanceof Error ? error.message : String(error),
          requestId: context.activeRequest?.id,
        } satisfies ErrorPayload);
      });
      return { interrupted: true };
    }

    case 'extension_ui.response': {
      const params = request.params as { sessionPath: string; response: ExtensionUIResponsePayload } | undefined;
      if (!params?.sessionPath || !params.response?.id) {
        throw new Error('extension_ui.response requires sessionPath and response.id');
      }
      const context = deps.getSessionContext(params.sessionPath);
      if (!context?.uiBridge) {
        throw new Error(`No UI bridge for session: ${params.sessionPath}`);
      }
      context.uiBridge.resolveRequest(params.response);
      return { ok: true };
    }

    case 'models.list': {
      const params = validateSessionPath('models.list', request.params);
      return deps.listAvailableModels(await deps.ensureSessionContext(params.sessionPath));
    }

    case 'settings.get':
      return await deps.readModelSettings();

    case 'settings.set': {
      const params = validateSettingsSet(request.params);
      const { sessionPath, ...settingsUpdates } = params;
      const previousSettings = await deps.readModelSettings();
      const targetContext = sessionPath ? await deps.ensureSessionContext(sessionPath) : undefined;
      const result = await deps.writeModelSettings(settingsUpdates);

      try {
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
          deps.emit('contextUsage.changed', {
            sessionPath: targetContext.sessionPath,
            contextUsage: null,
          } satisfies ContextUsageChangedPayload);
        }

        return result;
      } catch (error) {
        await deps.writeModelSettings({
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

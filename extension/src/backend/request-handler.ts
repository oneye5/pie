import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';

import { EXTENSION_TOGGLES_ENV, PROVIDER_TOGGLES_ENV, PROTOCOL_VERSION, type ErrorPayload, type ModelInfo, type ModelSettings, type PreflightFailedPayload, type RequestEnvelope, type SessionOpenedPayload, type SessionSummary, type TranscriptPageDirection, type TranscriptPagePayload } from '../shared/protocol';
import { toErrorMessage } from '../shared/error-message';
import {
  validateLoadTranscriptPage,
  validateMessageSend,
  validateRuntimePrefsSet,
  validateSessionCreate,
  validateSessionDuplicate,
  validateSessionOpen,
  validateSessionPath,
  validateSettingsSet,
  validateTruncateAfter,
  validateExtensionUiResponse,
} from './rpc';
import type { SdkModule, SdkSessionManager, SdkImageContent } from './sdk';
import { buildPromptText, lowerImageInputs, normalizeThinkingLevel } from './message-inputs';
import type { SessionContext, SessionContextCreationReason } from './server-types';
import { BackendError } from './server-io';

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
  emitContextUsageChanged(context: SessionContext): void;
  emitSessionListChanged(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  listAvailableModels(context?: SessionContext): ModelInfo[];
  readModelSettings(): Promise<ModelSettings>;
  writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings>;
}

type RequestHandler = (deps: BackendRequestHandlerDeps, request: RequestEnvelope) => Promise<unknown>;

function unknownMethodResponse(method: string): never {
  throw new BackendError('UNKNOWN_METHOD', `Unknown method: ${method}`);
}

async function handleAppPing(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  return {
    sdkPath: deps.sdkPath,
    agentDir: deps.agentDir,
    sdkVersion: deps.sdk.VERSION,
    protocolVersion: PROTOCOL_VERSION,
  };
}

async function handleRuntimePrefsSet(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateRuntimePrefsSet(request.params);
  process.env[PROVIDER_TOGGLES_ENV] = JSON.stringify(params.providerToggles);
  process.env[EXTENSION_TOGGLES_ENV] = JSON.stringify(params.extensionToggles);
  if (params.subagentAlwaysParentModel !== undefined) {
    process.env['PIE_SUBAGENT_ALWAYS_PARENT_MODEL'] = params.subagentAlwaysParentModel ? '1' : '0';
  }
  if (params.subagentMaxDepth !== undefined) {
    process.env['PIE_SUBAGENT_MAX_DEPTH'] = String(params.subagentMaxDepth);
  }
  if (params.subagentMaxTreeSessions !== undefined) {
    process.env['PIE_SUBAGENT_MAX_TREE_SESSIONS'] = String(params.subagentMaxTreeSessions);
  }
  return params;
}

async function handleSessionList(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  return await deps.listSessions();
}

async function handleSessionCreate(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
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

async function handleSessionOpen(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
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

async function handleSessionDuplicate(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionDuplicate(request.params);
  const sourceContext = deps.getSessionContext(params.sessionPath);
  const sourceCwd = sourceContext?.session.sessionManager.getCwd() ?? deps.startupCwd;
  const forkedManager = deps.sdk.SessionManager.forkFrom(params.sessionPath, sourceCwd);
  const context = await deps.createSessionContext(forkedManager, 'new');
  deps.setViewedSessionPath(context.sessionPath);
  const duplicatePayload = await deps.buildSessionOpenedPayload(
    context.sessionPath,
    params.selectionToken,
  );
  deps.emit('session.opened', duplicatePayload);
  deps.emitBusyChanged(context, context.session.isStreaming || !!context.activeRequest);
  void deps.emitSessionListChanged();
  return duplicatePayload;
}

async function handleSessionPreload(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('session.preload', request.params);
  const context = await deps.ensureSessionContext(params.sessionPath);
  return await deps.buildSessionOpenedPayload(context.sessionPath);
}

async function handleSessionLoadTranscriptPage(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateLoadTranscriptPage(request.params);
  return await deps.loadTranscriptPage(
    params.sessionPath,
    params.direction,
    params.loadedStart,
    params.loadedEnd,
  );
}

async function handleSessionTruncateAfter(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateTruncateAfter(request.params);

  const existingCtx = deps.getSessionContext(params.sessionPath);
  if (existingCtx?.activeRequest || existingCtx?.session.isStreaming) {
    throw new BackendError('STREAMING_BUSY', 'Cannot truncate a session that is currently streaming.');
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

function clearActiveRequest(
  context: SessionContext,
  requestId: string,
): void {
  if (context.activeRequest?.id === requestId) {
    context.activeRequest = undefined;
  }
}

function reportPromptFailure(
  deps: BackendRequestHandlerDeps,
  context: SessionContext,
  requestId: string,
  error: Error,
): void {
  deps.emit('error', {
    code: 'MESSAGE_SEND_FAILED',
    message: error.message,
    requestId,
  } satisfies ErrorPayload);
  clearActiveRequest(context, requestId);
  deps.emitBusyChanged(context, false);
}

/**
 * Post-ack, pre-commit prepass failure: `message.send` has already early-acked
 * (the prompt was queued) but the pruning prepass then failed. Surface it via
 * the dedicated `preflight.failed` backend event so the host dispatches
 * `PreflightFailed` and reverts via `pending.promoted[corrId]` (resolved by
 * `requestId`). Clearing `activeRequest` matches the pre-early-ack failure
 * path: the turn is not proceeding to streaming, so a subsequent send must not
 * be blocked by `REQUEST_IN_PROGRESS`. The host clears its optimistic running
 * state in the `PreflightFailed` reducer handler. See `docs/STATE_CONTRACT.md`
 * § Optimistic Reconciliation "Two failure windows for send".
 */
function emitPreflightFailed(
  deps: BackendRequestHandlerDeps,
  context: SessionContext,
  requestId: string,
  message: string,
): void {
  deps.emit('preflight.failed', {
    requestId,
    sessionPath: context.sessionPath,
    error: message,
  } satisfies PreflightFailedPayload);
  clearActiveRequest(context, requestId);
}

async function handleMessageSend(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMessageSend(request.params);
  const context = await deps.ensureSessionContext(params.sessionPath);
  if (context.activeRequest || context.session.isStreaming) {
    throw new BackendError('REQUEST_IN_PROGRESS', 'A request is already in progress for this session.');
  }

  const requestId = crypto.randomUUID();
  context.activeRequest = {
    id: requestId,
    messageIndex: 0,
    modelId: context.session.model?.id,
    thinkingLevel: normalizeThinkingLevel(context.session.thinkingLevel),
    // The first turn has no preceding tool call, so its latency window opens at
    // prompt-send. Subsequent turns overwrite this on `tool_execution_end`.
    turnBoundaryAt: Date.now(),
    aborted: false,
  };

  const images = lowerImageInputs(params.inputs);
  const imagePayload = images.length > 0 ? images : undefined;
  const promptText = buildPromptText(params.text, params.inputs);

  // Early ack: resolve {requestId} as soon as the prompt is QUEUED (before the
  // pruning prepass), so a slow prepass can no longer time out `message.send`.
  // The prepass runs concurrently inside `session.prompt()`; its outcome is
  // surfaced post-ack via the `preflightResult` callback:
  //  - success → the turn proceeds to streaming (commit point = first
  //    `MessageStarted` for the requestId, handled host-side).
  //  - failure → emit `preflight.failed` so the host dispatches `PreflightFailed`
  //    and reverts via `pending.promoted` (STATE_CONTRACT § Optimistic
  //    Reconciliation "Two failure windows for send").
  // `preflightFailed` makes the failure emission one-shot so `preflightResult`
  // and a concurrent `session.prompt()` rejection cannot both emit.
  let preflightFailed = false;

  try {
    context.session
      .prompt(promptText, {
        source: 'rpc',
        images: imagePayload,
        preflightResult: (success) => {
          if (preflightFailed) return;
          if (success) {
            // Prepass succeeded: the turn is proceeding to streaming.
            // `emitBusyChanged(true)` is idempotent (the host set running
            // optimistically at Send time; `agent_start` will also fire it) —
            // kept for parity with the pre-early-ack path.
            deps.emitBusyChanged(context, true);
          } else {
            preflightFailed = true;
            emitPreflightFailed(deps, context, requestId, 'Prompt rejected before PI accepted the request.');
          }
        },
      })
      .catch((error: Error) => {
        // `session.prompt()` rejected. With early ack the RPC has already
        // resolved, so this is a post-ack failure. If streaming already started
        // (commit point reached) it is an in-turn error → legacy `error` emit
        // (no rollback, matching the post-commit contract). Otherwise it is a
        // pre-commit failure → emit `preflight.failed` so the host reverts via
        // `pending.promoted`. `preflightFailed` guards a double emit when
        // `preflightResult(false)` already settled.
        if (preflightFailed) return;
        if (context.activeRequest?.currentMessageId) {
          reportPromptFailure(deps, context, requestId, error);
          return;
        }
        preflightFailed = true;
        emitPreflightFailed(deps, context, requestId, error.message || 'Prompt failed before streaming started.');
      });
  } catch (syncError) {
    // `session.prompt` threw synchronously before returning a promise — treat
    // as a pre-ack failure: clear activeRequest and let the RPC reject so the
    // host dispatches `SendResult{ok:false}` and reverts via `pending.ops`.
    clearActiveRequest(context, requestId);
    throw syncError;
  }

  return { requestId };
}

async function handleMessageInterrupt(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('message.interrupt', request.params);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context) {
    throw new BackendError('SESSION_NOT_FOUND', `Cannot interrupt an unopened session: ${params.sessionPath}`);
  }
  if (!context.activeRequest && !context.session.isStreaming) {
    throw new BackendError('SESSION_NOT_RUNNING', `Cannot interrupt a session that is not running: ${params.sessionPath}`);
  }
  if (context.activeRequest) {
    context.activeRequest.aborted = true;
  }
  context.uiBridge?.cancelAll();
  void context.session.abort().catch((error: unknown) => {
    deps.emit('error', {
      code: 'MESSAGE_INTERRUPT_FAILED',
      message: toErrorMessage(error),
      requestId: context.activeRequest?.id,
    } satisfies ErrorPayload);
  });
  return { interrupted: true };
}

async function handleExtensionUiResponse(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateExtensionUiResponse(request.params);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context?.uiBridge) {
    throw new BackendError('NO_UI_BRIDGE', `No UI bridge for session: ${params.sessionPath}`);
  }
  context.uiBridge.resolveRequest(params.response);
  return { ok: true };
}

async function handleModelsList(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('models.list', request.params);
  return deps.listAvailableModels(await deps.ensureSessionContext(params.sessionPath));
}

async function handleSettingsGet(
  deps: BackendRequestHandlerDeps,
  _request: RequestEnvelope,
): Promise<unknown> {
  return await deps.readModelSettings();
}

async function handleSettingsSet(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
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
        throw new BackendError('MODEL_UNAVAILABLE', `Model not available in this session: ${params.defaultModel}`);
      }

      const resolvedModel = targetContext.runtime.services.modelRegistry.find(info.provider, info.id);
      if (!resolvedModel) {
        throw new BackendError('MODEL_UNAVAILABLE', `Could not resolve model in registry: ${params.defaultModel}`);
      }

      if (typeof targetContext.session.setModel !== 'function') {
        throw new BackendError('MODEL_SWITCH_UNSUPPORTED', 'This PI session does not support live model switching.');
      }

      await targetContext.session.setModel(resolvedModel);
      if (targetContext.session.model?.id !== params.defaultModel) {
        throw new BackendError('MODEL_SWITCH_FAILED', `Live model switch did not take effect: ${params.defaultModel}`);
      }

      if (params.defaultThinkingLevel) {
        targetContext.session.setThinkingLevel?.(params.defaultThinkingLevel);
      }

      // Re-emit a fresh context-usage reading immediately so the indicator
      // reflects the new model's context window with the same conversation,
      // instead of blanking to null (which previously made the indicator flip
      // to a tokenizer-based transcript estimate until the next turn).
      // emitContextUsageChanged resolves the new model's window and the last
      // assistant prompt footprint, and no-ops via change-detection when
      // nothing differs.
      deps.emitContextUsageChanged(targetContext);
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

const handlers: Record<string, RequestHandler> = {
  'app.ping': handleAppPing,
  'runtimePrefs.set': handleRuntimePrefsSet,
  'session.list': handleSessionList,
  'session.create': handleSessionCreate,
  'session.open': handleSessionOpen,
  'session.duplicate': handleSessionDuplicate,
  'session.preload': handleSessionPreload,
  'session.loadTranscriptPage': handleSessionLoadTranscriptPage,
  'session.truncateAfter': handleSessionTruncateAfter,
  'message.send': handleMessageSend,
  'message.interrupt': handleMessageInterrupt,
  'extension_ui.response': handleExtensionUiResponse,
  'models.list': handleModelsList,
  'settings.get': handleSettingsGet,
  'settings.set': handleSettingsSet,
};

export async function handleBackendRequest(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  return handlers[request.method]?.(deps, request) ?? unknownMethodResponse(request.method);
}

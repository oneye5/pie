/**
 * Phase 2 type spine — `EffectRunner` skeleton.
 *
 * The runner is the **only** place that performs side effects in the new
 * architecture. It owns no state. It consumes `Effect`s and produces
 * `Event`s (specifically `*Result` variants) via a `dispatch` callback.
 *
 * Routing rules (binding for all later phases — see plan §Phase 2):
 *  - `*Rpc` effects use the **double-wrap**
 *    `enqueueLifecycle(() => enqueueSessionOperation(sessionPath, do_rpc))` so
 *    they serialize correctly with legacy `send`/`edit` paths during the
 *    multi-phase migration.
 *  - Lifecycle effects (`OpenSession`, `CreateSession`) use `enqueueLifecycle`
 *    only (the session may not exist yet, so the inner per-session queue
 *    cannot be addressed).
 *  - `PersistTabs` and `Log` execute directly without queueing.
 *  - `PostImperative` sends an imperative message to the webview via the
 *    `postImperative` callback.
 *
 * The runner never inspects state. All routing decisions are derived from the
 * effect's discriminator. Result dispatch is async via `Promise` → microtask,
 * which precludes re-entrant blocking even if a reducer chains effects.
 */

import type { Effect, SendRpcEffect, EditRpcEffect, InterruptRpcEffect, TruncateRpcEffect, ExtensionUiResponseRpcEffect } from './effects';
import { isLifecycleEffect, isRpcEffect } from './effects';
import { toErrorMessage } from '../util/error-message';
import type { EffectResultEvent } from './events';
import type { FileDiffService } from './file-diff-service';
import type { ChatPrefs, ComposerInput, PruningSettings, RunOutcome, ThinkingLevel } from '../../shared/protocol';

/** Minimal backend surface the runner needs. Matches `BackendClient.request`. */
export interface BackendLike {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/**
 * The two queues that exist today on `SessionServiceState`. We inject them as
 * functions rather than the full state object so tests can pass spies and
 * future refactors can move queue ownership without touching the runner.
 */
export interface QueueRouter {
  enqueueLifecycle<T>(task: () => Promise<T>): Promise<T>;
  enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T>;
}

/**
 * Persistence sink for `PersistTabs`. Matches the relevant slice of the
 * existing `globalState`-backed tab persistence helper.
 */
export interface TabPersistenceSink {
  persistTabs(openTabPaths: string[], activeSessionPath: string | null): Promise<void>;
}

/** Logger sink for `Log`. Matches the audit-log surface used elsewhere. */
export interface LogSink {
  log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

/** Callback for posting imperative messages to the webview. */
export interface PostImperativeSink {
  postImperative(message: { type: string; sessionPath?: string; text?: string; localId?: string }): void;
}

export interface SessionServiceLike {
  setModel(sessionPath: string | undefined, defaultModel: string, defaultThinkingLevel: ThinkingLevel): Promise<void>;
  hydrateModelState(sessionPath: string): Promise<void>;
  setPrefs(prefs: Partial<ChatPrefs>): void;
  bumpSessionDataEpoch(sessionPath: string): void;
  suppressNextCompletionNotificationFor(sessionPath: string): void;
  addFilesystemPaths(sessionPath: string | undefined, paths: string[], source: 'picker' | 'drop'): Promise<void>;
  loadOlderTranscript(sessionPath: string): Promise<void>;
  loadNewerTranscript(sessionPath: string): Promise<void>;
  jumpToLatestTranscript(sessionPath: string): Promise<void>;
  closeSession(sessionPath: string): Promise<void>;
  setPruningSettings(updates: Partial<PruningSettings>): Promise<void>;
  duplicateSession(sessionPath: string): void;
  createNewSession(): string;
  openSession(sessionPath: string): void;
}

export interface StatsServiceLike {
  prepareForSend(sessionPath: string, inputs: ComposerInput[]): void;
  onTruncatedAfter(sessionPath: string, messageId: string): void;
  onMessageEdited(sessionPath: string, messageId: string): void;
  recordOutcome(sessionPath: string, outcome: RunOutcome): void;
  startNewTask(sessionPath: string): void;
  continueTask(sessionPath: string): void;
}

export interface EffectRunnerDeps {
  backend: BackendLike;
  queues: QueueRouter;
  tabs: TabPersistenceSink;
  log: LogSink;
  postImperative: PostImperativeSink;
  fileDiffService: FileDiffService;
  service: SessionServiceLike;
  statsService: StatsServiceLike;
  /** Called with each `*Result` event the runner produces. */
  dispatch: (event: EffectResultEvent) => void;
}

export class EffectRunner {
  constructor(private readonly deps: EffectRunnerDeps) {}

  /**
   * Execute a single effect. Returns a promise that resolves when the effect
   * has been queued (not when it has completed) — the actual result is
   * delivered asynchronously via `deps.dispatch`. Callers do not await
   * completion; this preserves the no-re-entrant-blocking invariant.
   */
  run(effect: Effect): void {
    if (effect.kind === 'SetModelRpc') {
      void (async () => {
        try {
          await this.deps.service.setModel(effect.sessionPath, effect.modelSettings.defaultModel, effect.modelSettings.defaultThinkingLevel);
          this.deps.dispatch({ kind: 'SetModelResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'SetModelResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'SetPrefsRpc') {
      void (async () => {
        try {
          await this.deps.service.setPrefs(effect.prefs);
          this.deps.dispatch({ kind: 'SetPrefsResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'SetPrefsResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (isRpcEffect(effect)) {
      this.runRpc(effect);
      return;
    }
    if (isLifecycleEffect(effect)) {
      this.runLifecycle(effect);
      return;
    }
    if (effect.kind === 'PersistTabs') {
      this.runPersistTabs(effect);
      return;
    }
    if (effect.kind === 'Log') {
      this.deps.log.log(effect.level, effect.message, effect.data);
      return;
    }
    if (effect.kind === 'PostImperative') {
      this.deps.postImperative.postImperative(effect.imperativeMessage);
      return;
    }
    if (effect.kind === 'FileDiff') {
      void (async () => {
        try {
          await this.deps.fileDiffService.openFileDiff(effect.sessionPath, effect.filePath);
          this.deps.dispatch({ kind: 'FileDiffResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'FileDiffResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'FileRevert') {
      void (async () => {
        try {
          await this.deps.fileDiffService.revertFile(effect.sessionPath, effect.filePath);
          this.deps.dispatch({ kind: 'FileRevertResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'FileRevertResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'AddFilesystemPaths') {
      void (async () => {
        try {
          await this.deps.service.addFilesystemPaths(effect.sessionPath, effect.paths, effect.source);
          this.deps.dispatch({ kind: 'AddFilesystemPathsResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'AddFilesystemPathsResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'LoadOlderTranscript') {
      void (async () => {
        try {
          await this.deps.service.loadOlderTranscript(effect.sessionPath);
          this.deps.dispatch({ kind: 'LoadOlderTranscriptResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'LoadOlderTranscriptResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'LoadNewerTranscript') {
      void (async () => {
        try {
          await this.deps.service.loadNewerTranscript(effect.sessionPath);
          this.deps.dispatch({ kind: 'LoadNewerTranscriptResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'LoadNewerTranscriptResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'JumpToLatestTranscript') {
      void (async () => {
        try {
          await this.deps.service.jumpToLatestTranscript(effect.sessionPath);
          this.deps.dispatch({ kind: 'JumpToLatestTranscriptResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'JumpToLatestTranscriptResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'RecordOutcome') {
      void (async () => {
        try {
          this.deps.statsService.recordOutcome(effect.sessionPath, effect.outcome);
          this.deps.dispatch({ kind: 'RecordOutcomeResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'RecordOutcomeResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'StartNewTask') {
      void (async () => {
        try {
          this.deps.statsService.startNewTask(effect.sessionPath);
          this.deps.dispatch({ kind: 'StartNewTaskResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'StartNewTaskResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'ContinueTask') {
      void (async () => {
        try {
          this.deps.statsService.continueTask(effect.sessionPath);
          this.deps.dispatch({ kind: 'ContinueTaskResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'ContinueTaskResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'OpenFileInEditor') {
      void (async () => {
        try {
          await this.deps.fileDiffService.openFileInEditor(effect.sessionPath, effect.filePath);
          this.deps.dispatch({ kind: 'OpenFileInEditorResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'OpenFileInEditorResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'OpenFile') {
      void (async () => {
        try {
          const vscode = await import('vscode');
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(effect.path));
          this.deps.dispatch({ kind: 'OpenFileResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'OpenFileResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'SetPruningSettings') {
      void (async () => {
        try {
          await this.deps.service.setPruningSettings(effect.settings);
          this.deps.dispatch({ kind: 'SetPruningSettingsResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'SetPruningSettingsResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'CloseSession') {
      void (async () => {
        try {
          await this.deps.service.closeSession(effect.sessionPath);
          this.deps.dispatch({ kind: 'CloseSessionResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'CloseSessionResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'DuplicateSession') {
      void (async () => {
        try {
          this.deps.service.duplicateSession(effect.sessionPath);
          this.deps.dispatch({ kind: 'DuplicateSessionResult', corrId: effect.corrId, ok: true });
        } catch (err) {
          this.deps.dispatch({ kind: 'DuplicateSessionResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
        }
      })();
      return;
    }
    if (effect.kind === 'HydrateModel') {
      // Fire-and-forget, like PostImperative: the service's dispatched
      // SetModel/AvailableModelsChanged events apply the results, so no
      // *Result event is produced here.
      void (async () => {
        try {
          await this.deps.service.hydrateModelState(effect.sessionPath);
        } catch (err) {
          this.deps.log.log('error', `hydrateModelState failed: ${toErrorMessage(err)}`);
        }
      })();
      return;
    }
    // Exhaustiveness check: TS rejects unhandled Effect kinds at compile time.
    // Reachable only if the type system is bypassed (e.g. an `as` cast); fail
    // loud via the log sink rather than silently dropping the effect.
    const _exhaustive: never = effect;
    void _exhaustive;
    this.deps.log.log('error', `EffectRunner: unhandled effect kind (type system bypassed?): ${(effect as { kind?: string }).kind}`);
  }

  /**
   * Route `*Rpc` effects through the double-wrap. The outer `enqueueLifecycle`
   * exists to preserve serialization with legacy `send`/`edit` callers that
   * still use the same lifecycle queue directly.
   */
  private runRpc(effect: RpcEffect): void {
    if (effect.kind === 'EditRpc') {
      this.runEditRpc(effect);
      return;
    }
    if (effect.kind === 'SendRpc') {
      this.runSendRpc(effect);
      return;
    }
    // InterruptRpc: set the host-local completion-suppression flag for this
    // session synchronously (same tick as the click), so the busy-completed
    // handler suppresses the "run finished" notification the interrupt causes.
    // The runner is the side-effect executor — this host-local flag stays out
    // of the reducer (no read-vs-clear ordering hazard).
    if (effect.kind === 'InterruptRpc') {
      this.deps.service.suppressNextCompletionNotificationFor(effect.sessionPath);
    }
    const { queues, backend, dispatch } = this.deps;
    void queues.enqueueLifecycle(async () => {
      await queues.enqueueSessionOperation(effect.sessionPath, async () => {
        try {
          await backend.request(rpcMethodFor(effect), rpcParamsFor(effect));
          dispatch(rpcResultFor(effect, { ok: true }));
        } catch (err) {
          dispatch(rpcResultFor(effect, { ok: false, error: toErrorMessage(err) }));
        }
      });
    });
  }

  /**
   * SendRpc needs to capture the `requestId` from the backend response
   * so the host can bind events to sessions.
   */
  private runSendRpc(effect: Extract<Effect, { kind: 'SendRpc' }>): void {
    const { queues, backend, dispatch, service, statsService } = this.deps;
    void queues.enqueueLifecycle(async () => {
      await queues.enqueueSessionOperation(effect.sessionPath, async () => {
        try {
          service.bumpSessionDataEpoch(effect.sessionPath);
          statsService.prepareForSend(effect.sessionPath, effect.inputs);
          const response = await backend.request<{ requestId?: string }>('message.send', {
            sessionPath: effect.sessionPath,
            text: effect.text,
            inputs: effect.inputs,
            localId: effect.localId,
          });
          dispatch({
            kind: 'SendResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: true,
            requestId: response.requestId,
          });
        } catch (err) {
          dispatch({
            kind: 'SendResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: false,
            error: toErrorMessage(err),
          });
        }
      });
    });
  }

  /**
   * EditRpc is a composite operation: truncate-then-send in a single session
   * operation. If truncate fails, the send is skipped and the whole operation
   * fails atomically (matching the legacy behavior).
   */
  private runEditRpc(effect: Extract<Effect, { kind: 'EditRpc' }>): void {
    const { queues, backend, dispatch, service, statsService } = this.deps;
    void queues.enqueueLifecycle(async () => {
      await queues.enqueueSessionOperation(effect.sessionPath, async () => {
        try {
          service.bumpSessionDataEpoch(effect.sessionPath);
          statsService.onTruncatedAfter(effect.sessionPath, effect.messageId);
          statsService.onMessageEdited(effect.sessionPath, effect.messageId);
          statsService.prepareForSend(effect.sessionPath, []);
          await backend.request('session.truncateAfter', {
            sessionPath: effect.sessionPath,
            entryId: effect.messageId,
          });
          await backend.request('message.send', {
            sessionPath: effect.sessionPath,
            text: effect.text,
            localId: effect.localId,
          });
          dispatch({ kind: 'EditResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
        } catch (err) {
          dispatch({ kind: 'EditResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
        }
      });
    });
  }

  /**
   * Create/open session lifecycle. Delegates to the session service, which
   * performs the full tab lifecycle setup: registering a selection-request
   * token (so the backend's `session.opened` event activates and opens the
   * tab), inserting a placeholder summary, dispatching `TabOpened`/
   * `SelectSession`, persisting tabs, and enqueueing the backend RPC with the
   * registered token. Calling the backend directly here would skip that setup
   * and the new/opened session would never activate.
   *
   * The service methods dispatch arch events synchronously, so we defer them to
   * a microtask (matching `CloseSession`/`DuplicateSession`) to avoid
   * re-entrant dispatch while the outer effects loop is still running.
   */
  private runLifecycle(effect: Extract<Effect, { kind: 'OpenSession' | 'CreateSession' }>): void {
    const { service, dispatch } = this.deps;
    void (async () => {
      try {
        if (effect.kind === 'OpenSession') {
          service.openSession(effect.sessionPath);
          dispatch({
            kind: 'OpenSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: true,
          });
        } else {
          const sessionPath = service.createNewSession();
          dispatch({
            kind: 'CreateSessionResult',
            corrId: effect.corrId,
            sessionPath,
            ok: true,
          });
        }
      } catch (err) {
        if (effect.kind === 'OpenSession') {
          dispatch({
            kind: 'OpenSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: false,
            error: toErrorMessage(err),
          });
        } else {
          dispatch({
            kind: 'CreateSessionResult',
            corrId: effect.corrId,
            ok: false,
            error: toErrorMessage(err),
          });
        }
      }
    })();
  }

  private runPersistTabs(effect: Extract<Effect, { kind: 'PersistTabs' }>): void {
    void (async () => {
      try {
        await this.deps.tabs.persistTabs(effect.openTabPaths, effect.activeSessionPath);
        this.deps.dispatch({ kind: 'PersistTabsResult', corrId: effect.corrId, ok: true });
      } catch (err) {
        this.deps.dispatch({
          kind: 'PersistTabsResult',
          corrId: effect.corrId,
          ok: false,
          error: toErrorMessage(err),
        });
      }
    })();
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type RpcEffect = SendRpcEffect | EditRpcEffect | InterruptRpcEffect | TruncateRpcEffect | ExtensionUiResponseRpcEffect;

function rpcMethodFor(effect: RpcEffect): string {
  switch (effect.kind) {
    case 'SendRpc':
      return 'message.send';
    case 'EditRpc':
      // Edit is implemented as truncate-then-send on the backend; the runner
      // here issues only the single `message.send` after callers have already
      // emitted a `TruncateRpc`. Future refactors may collapse these.
      return 'message.send';
    case 'InterruptRpc':
      return 'message.interrupt';
    case 'TruncateRpc':
      return 'session.truncateAfter';
    case 'ExtensionUiResponseRpc':
      return 'extension_ui.response';
  }
}

function rpcParamsFor(effect: RpcEffect): unknown {
  switch (effect.kind) {
    case 'SendRpc':
      return { sessionPath: effect.sessionPath, text: effect.text, inputs: effect.inputs };
    case 'EditRpc':
      return { sessionPath: effect.sessionPath, text: effect.text };
    case 'InterruptRpc':
      return { sessionPath: effect.sessionPath };
    case 'TruncateRpc':
      return { sessionPath: effect.sessionPath, entryId: effect.messageId };
    case 'ExtensionUiResponseRpc':
      return { sessionPath: effect.sessionPath, response: effect.response };
  }
}

function rpcResultFor(
  effect: RpcEffect,
  outcome: { ok: true } | { ok: false; error: string },
): EffectResultEvent {
  const base = {
    corrId: effect.corrId,
    sessionPath: effect.sessionPath,
    ...outcome,
  };
  switch (effect.kind) {
    case 'SendRpc':
      return { kind: 'SendResult', ...base };
    case 'EditRpc':
      return { kind: 'EditResult', ...base };
    case 'InterruptRpc':
      return { kind: 'InterruptResult', ...base };
    case 'TruncateRpc':
      return { kind: 'TruncateResult', ...base };
    case 'ExtensionUiResponseRpc':
      return { kind: 'ExtensionUiResponseResult', ...base };
  }
}

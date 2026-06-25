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
 *
 * Dispatch is a `Record<Effect['kind'], EffectHandler>` table — the key type
 * gives compile-time exhaustiveness for free (every kind MUST have an entry or
 * the object literal won't type-check). The 12 pure 1:1 `*Result` kinds are
 * built by {@link EffectRunner.templateRow}; the 19 kinds with non-template
 * control flow are named handler methods (or delegate to `runRpc` /
 * `runLifecycle`).
 */

import type {
  Effect,
  SendRpcEffect,
  EditRpcEffect,
  InterruptRpcEffect,
  TruncateRpcEffect,
  ExtensionUiResponseRpcEffect,
  ShowModelSwitchConfirmEffect,
  SetModelRpcEffect,
  SetPrefsRpcEffect,
  HydrateModelEffect,
  LogEffect,
  PostImperativeEffect,
  OpenFileEffect,
  DrainPendingSendQueueEffect,
  DrainBackendReadyQueueEffect,
  StartBackendReadyWatchdogEffect,
  CancelBackendReadyWatchdogEffect,
  PostImperativeMessage,
} from './effects';
import { toErrorMessage } from '../util/error-message';
import type { EffectResultEvent, CommandEvent } from './events';
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
  persistTabs(openTabPaths: string[], activeSessionPath: string | null, pinnedTabPaths: string[]): Promise<void>;
}

/** Logger sink for `Log`. Matches the audit-log surface used elsewhere. */
export interface LogSink {
  log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

/** Callback for posting imperative messages to the webview. */
export interface PostImperativeSink {
  postImperative(message: PostImperativeMessage): void;
}

/** Sink for modal user-confirmation dialogs (VS Code `showWarningMessage`).
 *  `showWarningModal` resolves to the chosen button label, or `undefined` if
 *  the user dismisses the dialog. Returns `PromiseLike` (VS Code's
 *  `showWarningMessage` yields a `Thenable`, which is a `PromiseLike`); `await`
 *  accepts it and both real Promises and Thenables satisfy the type. */
export interface ModalSink {
  showWarningModal(message: string, confirmChoice: string): PromiseLike<string | undefined>;
}

export interface SessionServiceLike {
  hydrateModelState(sessionPath: string): Promise<void>;
  setPrefs(prefs: Partial<ChatPrefs>): void;
  bumpSessionDataEpoch(sessionPath: string): void;
  /** Notify the run-analytics observer that a session's model config changed
   *  (disk-persisting side effect, not ArchState). Effect-side concern. */
  onModelConfigChanged(sessionPath: string, modelId: string, thinkingLevel: ThinkingLevel): void;
  suppressNextCompletionNotificationFor(sessionPath: string): void;
  loadOlderTranscript(sessionPath: string): Promise<void>;
  loadNewerTranscript(sessionPath: string): Promise<void>;
  jumpToLatestTranscript(sessionPath: string): Promise<void>;
  closeSession(sessionPath: string, nextPath: string | null): Promise<void>;
  setPruningSettings(updates: Partial<PruningSettings>): Promise<void>;
  /** Recover from a failed/timed-out selection: finish the request and
   *  dispatch the reducer transitions that undo the optimistic tab setup
   *  (CloseTab / SelectSession-fallback / SessionScopeCleared / NoticeShown). */
  handleSelectionFailure(selectionToken: string, notice: string): void;
}

export interface StatsServiceLike {
  prepareForSend(sessionPath: string, inputs: ComposerInput[]): void;
  onTruncatedAfter(sessionPath: string, messageId: string): void;
  onMessageEdited(sessionPath: string, messageId: string): void;
  recordOutcome(sessionPath: string, outcome: RunOutcome): void;
  startNewTask(sessionPath: string): void;
  continueTask(sessionPath: string): void;
}

/** Opaque handle returned by {@link TimerSink.schedule}. Stored & passed back to cancel. */
export type TimerHandle = unknown;

/**
 * Injectable timer sink. Defaults to real `setTimeout`/`clearTimeout`; tests
 * pass a fake to drive timers deterministically (no wall-clock waits, no flakes
 * from real-timer races under load).
 */
export interface TimerSink {
  schedule(fn: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
}

const defaultTimerSink: TimerSink = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface EffectRunnerDeps {
  backend: BackendLike;
  queues: QueueRouter;
  tabs: TabPersistenceSink;
  log: LogSink;
  postImperative: PostImperativeSink;
  modal: ModalSink;
  fileDiffService: FileDiffService;
  service: SessionServiceLike;
  statsService: StatsServiceLike;
  /** Called with each `*Result` event the runner produces. */
  dispatch: (event: EffectResultEvent) => void;
  /**
   * Re-dispatch a Command into the reducer. Used by `DrainPendingSendQueue` to
   * re-dispatch queued `Send` Commands with a resolved session path. The runner
   * cannot emit Effects that loop back synchronously, but it CAN feed Commands
   * back via this callback (dispatched asynchronously inside a void async IIFE
   * so they land after the current synchronous dispatch cycle).
   */
  dispatchCommand: (event: CommandEvent) => void;
  /**
   * Dispatch a non-result, non-command Event (e.g. `BackendReadyWatchdogFired`)
   * back into the reducer. The runner uses this for watchdog timeout events.
   */
  dispatchEvent: (event: import('./events').Event) => void;
  /**
   * Override the optimistic-op TTL (default 60s). Used by tests to avoid
   * waiting the full timeout. When the timer fires, the runner dispatches a
   * `*Result{ok:false}` event so the reducer reverts the optimistic change.
   */
  optimisticOpTimeoutMs?: number;
  /**
   * Timer sink used for the backend-ready watchdog + optimistic-op TTL.
   * Defaults to real `setTimeout`/`clearTimeout`. Tests inject a fake to
   * advance timers synchronously without wall-clock waits.
   */
  timer?: TimerSink;
}

/** A per-kind effect handler. `effect` is `any` so a handler accepting a
 *  narrower `Effect` variant is assignable without contravariance friction;
 *  the {@link EffectRunner.handlers} `Record<Effect['kind'], EffectHandler>`
 *  key type — not the value type — provides compile-time exhaustiveness. */
type EffectHandler = (effect: any) => void;

export class EffectRunner {
  /** The backend-ready watchdog timer. Started by `StartBackendReadyWatchdog`,
   * cleared by `CancelBackendReadyWatchdog` / `DrainBackendReadyQueue` / fire. */
  private backendReadyWatchdog: TimerHandle | null = null;

  /** Per-corrId timers for optimistic-op TTL. Started in runSendRpc/runEditRpc,
   * cancelled when the RPC completes. On fire, dispatches *Result{ok:false}
   * so the reducer reverts the optimistic change (same as a backend error). */
  private optimisticOpTimers: Map<string, TimerHandle> = new Map();

  /** Injectable timer sink (real timers in production, fake in tests). */
  private readonly timer: TimerSink;

  /** The timeout for optimistic ops. Generous — message.send usually returns
   * in <1s, but a hung backend should not leave the session stuck forever. */
  private static readonly OPTIMISTIC_OP_TIMEOUT_MS = 60_000;

  private readonly optimisticOpTimeoutMs: number;

  /** Dispatch table: one handler per `Effect['kind']`. The `Record` key type
   *  forces every kind to have an entry (compile-time exhaustiveness). Built
   *  once in the constructor. */
  private readonly handlers: Record<Effect['kind'], EffectHandler>;

  constructor(private readonly deps: EffectRunnerDeps) {
    this.optimisticOpTimeoutMs = deps.optimisticOpTimeoutMs ?? EffectRunner.OPTIMISTIC_OP_TIMEOUT_MS;
    this.timer = deps.timer ?? defaultTimerSink;
    this.handlers = {
      // ── RPC kinds: route through the double-wrap. `runRpc` short-circuits
      //    Send→runSendRpc / Edit→runEditRpc; Interrupt sets the host-local
      //    completion-suppression flag synchronously before enqueue; Truncate /
      //    ExtensionUiResponse take the generic rpcMethodFor/rpcParamsFor/
      //    rpcResultFor path. ──
      SendRpc: (e) => this.runRpc(e),
      EditRpc: (e) => this.runRpc(e),
      InterruptRpc: (e) => this.runRpc(e),
      TruncateRpc: (e) => this.runRpc(e),
      ExtensionUiResponseRpc: (e) => this.runRpc(e),
      // ── Lifecycle kinds: `enqueueLifecycle`-only. ──
      OpenSession: (e) => this.runLifecycle(e),
      CreateSession: (e) => this.runLifecycle(e),
      DuplicateSession: (e) => this.runLifecycle(e),
      // ── Special kinds (non-template control flow → named handlers). ──
      ShowModelSwitchConfirm: (e) => this.handleShowModelSwitchConfirm(e),
      SetModelRpc: (e) => this.handleSetModelRpc(e),
      SetPrefsRpc: (e) => this.handleSetPrefsRpc(e),
      Log: (e) => this.handleLog(e),
      PostImperative: (e) => this.handlePostImperative(e),
      OpenFile: (e) => this.handleOpenFile(e),
      DrainPendingSendQueue: (e) => this.handleDrainPendingSendQueue(e),
      DrainBackendReadyQueue: (e) => this.handleDrainBackendReadyQueue(e),
      StartBackendReadyWatchdog: (e) => this.handleStartBackendReadyWatchdog(e),
      CancelBackendReadyWatchdog: (e) => this.handleCancelBackendReadyWatchdog(e),
      HydrateModel: (e) => this.handleHydrateModel(e),
      // ── Template rows (pure 1:1 effect → *Result). ──
      FileDiff: this.templateRow({ resultKind: 'FileDiffResult', withSessionPath: true, call: (e, d) => d.fileDiffService.openFileDiff(e.sessionPath, e.filePath) }),
      FileRevert: this.templateRow({ resultKind: 'FileRevertResult', withSessionPath: true, call: (e, d) => d.fileDiffService.revertFile(e.sessionPath, e.filePath) }),
      LoadOlderTranscript: this.templateRow({ resultKind: 'LoadOlderTranscriptResult', withSessionPath: true, call: (e, d) => d.service.loadOlderTranscript(e.sessionPath) }),
      LoadNewerTranscript: this.templateRow({ resultKind: 'LoadNewerTranscriptResult', withSessionPath: true, call: (e, d) => d.service.loadNewerTranscript(e.sessionPath) }),
      JumpToLatestTranscript: this.templateRow({ resultKind: 'JumpToLatestTranscriptResult', withSessionPath: true, call: (e, d) => d.service.jumpToLatestTranscript(e.sessionPath) }),
      RecordOutcome: this.templateRow({ resultKind: 'RecordOutcomeResult', withSessionPath: false, call: (e, d) => { d.statsService.recordOutcome(e.sessionPath, e.outcome); } }),
      StartNewTask: this.templateRow({ resultKind: 'StartNewTaskResult', withSessionPath: false, call: (e, d) => { d.statsService.startNewTask(e.sessionPath); } }),
      ContinueTask: this.templateRow({ resultKind: 'ContinueTaskResult', withSessionPath: false, call: (e, d) => { d.statsService.continueTask(e.sessionPath); } }),
      OpenFileInEditor: this.templateRow({ resultKind: 'OpenFileInEditorResult', withSessionPath: false, call: (e, d) => d.fileDiffService.openFileInEditor(e.sessionPath, e.filePath) }),
      SetPruningSettings: this.templateRow({ resultKind: 'SetPruningSettingsResult', withSessionPath: false, call: (e, d) => d.service.setPruningSettings(e.settings) }),
      CloseSession: this.templateRow({ resultKind: 'CloseSessionResult', withSessionPath: true, call: (e, d) => d.service.closeSession(e.sessionPath, e.nextPath) }),
      PersistTabs: this.templateRow({ resultKind: 'PersistTabsResult', withSessionPath: false, call: (e, d) => d.tabs.persistTabs(e.openTabPaths, e.activeSessionPath, e.pinnedTabPaths) }),
    };
  }

  /**
   * Execute a single effect. Returns a promise that resolves when the effect
   * has been queued (not when it has completed) — the actual result is
   * delivered asynchronously via `deps.dispatch`. Callers do not await
   * completion; this preserves the no-re-entrant-blocking invariant.
   */
  run(effect: Effect): void {
    this.handlers[effect.kind](effect);
  }

  // ─── Template rows ────────────────────────────────────────────────────────

  /** Build the standard async-IIFE + try/catch + `dispatch({kind, corrId,
   *  [sessionPath?], ok, error?})` handler for a pure 1:1 effect→result row.
   *
   *  `call` returns a `Promise` for await-rows and `void` for sync rows
   *  (RecordOutcome / StartNewTask / ContinueTask call sync stats methods).
   *  The helper awaits only when a `Promise` is returned, preserving the
   *  original await-vs-sync distinction exactly — sync rows must NOT gain an
   *  extra microtask (the dispatch would slip one tick later). */
  private templateRow(opts: {
    resultKind: EffectResultEvent['kind'];
    withSessionPath: boolean;
    call: (effect: any, deps: EffectRunnerDeps) => Promise<unknown> | void;
  }): EffectHandler {
    return (effect) => {
      void (async () => {
        try {
          const r = opts.call(effect, this.deps);
          if (r) await r;
          this.deps.dispatch(
            (opts.withSessionPath
              ? { kind: opts.resultKind, corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true }
              : { kind: opts.resultKind, corrId: effect.corrId, ok: true }) as EffectResultEvent,
          );
        } catch (err) {
          this.deps.dispatch(
            (opts.withSessionPath
              ? { kind: opts.resultKind, corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) }
              : { kind: opts.resultKind, corrId: effect.corrId, ok: false, error: toErrorMessage(err) }) as EffectResultEvent,
          );
        }
      })();
    };
  }

  // ─── Special-kind handlers (non-template control flow) ────────────────────

  /** `ShowModelSwitchConfirm` — modal confirmation. NOT queued on the
   *  lifecycle queue (a modal must not block session create/open). Dispatches
   *  `ModelSwitchConfirmResult{corrId, confirmed}` (no `ok`/`error`/
   *  `sessionPath`); on modal throw, logs + dispatches `{confirmed:false}`
   *  (no error field). */
  private handleShowModelSwitchConfirm(effect: ShowModelSwitchConfirmEffect): void {
    // Intentionally NOT queued on the lifecycle queue: a modal is a user
    // interaction, and holding the lifecycle queue (shared with create/open)
    // behind an open modal would block session creation while the user stares
    // at a dialog. The old service path awaited the modal *inside*
    // enqueueLifecycle, which did exactly that. VS Code serializes modal
    // dialogs itself, corrIds are independent, and the backend write
    // (SetModelRpc) still goes through the lifecycle queue — so ordering is
    // preserved where it matters. This is an improvement, not a regression.
    void (async () => {
      try {
        const choice = await this.deps.modal.showWarningModal(effect.message, effect.confirmChoice);
        this.deps.dispatch({ kind: 'ModelSwitchConfirmResult', corrId: effect.corrId, confirmed: choice === effect.confirmChoice });
      } catch (err) {
        // If the modal itself throws, treat as not confirmed and log; the
        // reducer drops the stashed intent on a non-confirm.
        this.deps.log.log('error', `ShowModelSwitchConfirm failed: ${toErrorMessage(err)}`);
        this.deps.dispatch({ kind: 'ModelSwitchConfirmResult', corrId: effect.corrId, confirmed: false });
      }
    })();
  }

  /** `SetModelRpc` — 3 sequential dep calls (settings.set → bumpSessionDataEpoch
   *  → onModelConfigChanged). `enqueueLifecycle`-only (NOT via `runRpc`).
   *  Result `SetModelResult` with `sessionPath`+`ok`+`error?`. */
  private handleSetModelRpc(effect: SetModelRpcEffect): void {
    // The reducer owns every ArchState transition (global default, per-session
    // model badge, context-usage clear, pending-image clear, rollback). The
    // runner only performs the backend write + the two Effect-side concerns
    // that are not ArchState: the host-local data epoch (transcript paging
    // staleness) and the disk-persisting run-analytics observer. Serialized
    // through the lifecycle queue to match the pre-migration service path.
    const { backend, queues, dispatch, service } = this.deps;
    void queues.enqueueLifecycle(async () => {
      try {
        await backend.request('settings.set', {
          sessionPath: effect.sessionPath,
          defaultModel: effect.modelSettings.defaultModel,
          defaultThinkingLevel: effect.modelSettings.defaultThinkingLevel,
        });
        service.bumpSessionDataEpoch(effect.sessionPath);
        service.onModelConfigChanged(effect.sessionPath, effect.modelSettings.defaultModel, effect.modelSettings.defaultThinkingLevel);
        dispatch({ kind: 'SetModelResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
      } catch (err) {
        dispatch({ kind: 'SetModelResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
      }
    });
  }

  /** `SetPrefsRpc` — IIFE (not queued), `service.setPrefs(prefs)`. Result
   *  `SetPrefsResult` (NO `sessionPath`). */
  private handleSetPrefsRpc(effect: SetPrefsRpcEffect): void {
    void (async () => {
      try {
        await this.deps.service.setPrefs(effect.prefs);
        this.deps.dispatch({ kind: 'SetPrefsResult', corrId: effect.corrId, ok: true });
      } catch (err) {
        this.deps.dispatch({ kind: 'SetPrefsResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
      }
    })();
  }

  /** `Log` — synchronous `log.log(level, message, data)`. No try/catch, no
   *  result: exceptions propagate to the `run()` caller. */
  private handleLog(effect: LogEffect): void {
    this.deps.log.log(effect.level, effect.message, effect.data);
  }

  /** `PostImperative` — synchronous `postImperative.postImperative(...)`. No
   *  try/catch, no result. */
  private handlePostImperative(effect: PostImperativeEffect): void {
    this.deps.postImperative.postImperative(effect.imperativeMessage);
  }

  /** `OpenFile` — dynamic `import('vscode')` → `vscode.open` command. NOT a
   *  `deps.*` method (kept inline to avoid adding a sink that would break the
   *  7 untyped test mocks). IIFE. Result `OpenFileResult` (NO `sessionPath`). */
  private handleOpenFile(effect: OpenFileEffect): void {
    void (async () => {
      try {
        const vscode = await import('vscode');
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(effect.path));
        this.deps.dispatch({ kind: 'OpenFileResult', corrId: effect.corrId, ok: true });
      } catch (err) {
        this.deps.dispatch({ kind: 'OpenFileResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
      }
    })();
  }

  /** `DrainPendingSendQueue` — IIFE; loop dispatches `Command(Send)` per entry
   *  via `dispatchCommand`. No `*Result`; catch: `log.log('error',…)` swallow
   *  (no dispatch). The IIFE deferral is load-bearing (clear-then-reinsert
   *  ordering). */
  private handleDrainPendingSendQueue(effect: DrainPendingSendQueueEffect): void {
    // Re-dispatch each queued entry as a `Send` Command with the resolved
    // session path. The entries were read from ArchState by the reducer's
    // `handlePendingPathReplaced` and carried in this effect; the runner
    // never reads ArchState. The void async IIFE ensures the Commands land
    // AFTER the synchronous SessionScopeCleared + SessionOpened + SelectSession
    // events that follow PendingPathReplaced — preserving the clear-then-
    // reinsert ordering of the old drainPendingSendQueue callback.
    const { resolvedSessionPath, entries } = effect;
    void (async () => {
      try {
        for (const entry of entries) {
          this.deps.dispatchCommand({
            kind: 'Command',
            cmd: {
              kind: 'Send',
              corrId: entry.corrId,
              sessionPath: resolvedSessionPath,
              text: entry.text,
              inputs: entry.inputs,
              composedText: entry.composedText,
              localId: entry.localId,
              userParts: entry.userParts,
              previousSummary: entry.previousSummary,
              timestamp: entry.timestamp,
            },
          });
        }
      } catch (err) {
        this.deps.log.log('error', `DrainPendingSendQueue failed: ${toErrorMessage(err)}`);
      }
    })();
  }

  /** `DrainBackendReadyQueue` — synchronous `clearBackendReadyWatchdog()`
   *  BEFORE the IIFE (the drain implies backend-ready, so the watchdog is
   *  no longer needed), then loop `dispatchCommand(Send, entry.sessionPath)`.
   *  No result; catch: log swallow. */
  private handleDrainBackendReadyQueue(effect: DrainBackendReadyQueueEffect): void {
    // Clear the watchdog timer — the backend is ready, so the timeout is
    // no longer needed.
    this.clearBackendReadyWatchdog();
    // Re-dispatch each queued entry as a Send Command. The void async IIFE
    // ensures the Commands land after the current synchronous dispatch cycle
    // (the BackendReadyChanged event may be followed by other synchronous
    // events). Each entry carries its own sessionPath.
    const { entries } = effect;
    void (async () => {
      try {
        for (const entry of entries) {
          this.deps.dispatchCommand({
            kind: 'Command',
            cmd: {
              kind: 'Send',
              corrId: entry.corrId,
              sessionPath: entry.sessionPath,
              text: entry.text,
              inputs: entry.inputs,
              composedText: entry.composedText,
              localId: entry.localId,
              userParts: entry.userParts,
              previousSummary: entry.previousSummary,
              timestamp: entry.timestamp,
            },
          });
        }
      } catch (err) {
        this.deps.log.log('error', `DrainBackendReadyQueue failed: ${toErrorMessage(err)}`);
      }
    })();
  }

  /** `StartBackendReadyWatchdog` — `timer.schedule(cb, timeoutMs)`; cb nulls
   *  `this.backendReadyWatchdog` then dispatches `BackendReadyWatchdogFired`.
   *  No try/catch; synchronous scheduling. Mutates instance state. */
  private handleStartBackendReadyWatchdog(effect: StartBackendReadyWatchdogEffect): void {
    // Start the watchdog timer if not already running. On fire, dispatch
    // BackendReadyWatchdogFired → the reducer drops the queued messages +
    // removes optimistic entries + sets a notice.
    if (!this.backendReadyWatchdog) {
      this.backendReadyWatchdog = this.timer.schedule(() => {
        this.backendReadyWatchdog = null;
        this.deps.dispatchEvent({ kind: 'BackendReadyWatchdogFired' });
      }, effect.timeoutMs);
    }
  }

  /** `CancelBackendReadyWatchdog` — `clearBackendReadyWatchdog()`. No try/catch,
   *  no result, synchronous. */
  private handleCancelBackendReadyWatchdog(_effect: CancelBackendReadyWatchdogEffect): void {
    this.clearBackendReadyWatchdog();
  }

  /** `HydrateModel` — IIFE; `service.hydrateModelState(sessionPath)`. No
   *  result; catch: `log.log('error',…)` swallow. */
  private handleHydrateModel(effect: HydrateModelEffect): void {
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
  }

  /** Clear the backend-ready watchdog timer (no-op if not running). */
  private clearBackendReadyWatchdog(): void {
    if (this.backendReadyWatchdog) {
      this.timer.cancel(this.backendReadyWatchdog);
      this.backendReadyWatchdog = null;
    }
  }

  /** Start the optimistic-op TTL timer for a corrId. On fire, dispatches
   *  a *Result{ok:false} event so the reducer reverts the optimistic change.
   *  No-op if a timer is already running for this corrId. */
  private startOptimisticOpTimer(corrId: string, sessionPath: string, kind: 'send' | 'edit'): void {
    if (this.optimisticOpTimers.has(corrId)) return; // already running
    const timer = this.timer.schedule(() => {
      this.optimisticOpTimers.delete(corrId);
      const error = `Timed out waiting for backend response (${this.optimisticOpTimeoutMs / 1000}s)`;
      if (kind === 'send') {
        this.deps.dispatch({ kind: 'SendResult', corrId, sessionPath, ok: false, error });
      } else {
        this.deps.dispatch({ kind: 'EditResult', corrId, sessionPath, ok: false, error });
      }
    }, this.optimisticOpTimeoutMs);
    this.optimisticOpTimers.set(corrId, timer);
  }

  /** Cancel the optimistic-op TTL timer for a corrId (the RPC completed). */
  private clearOptimisticOpTimer(corrId: string): void {
    const timer = this.optimisticOpTimers.get(corrId);
    if (timer) {
      this.timer.cancel(timer);
      this.optimisticOpTimers.delete(corrId);
    }
  }

  /** Dispose of the runner's resources (called on shutdown). */
  dispose(): void {
    this.clearBackendReadyWatchdog();
    for (const timer of this.optimisticOpTimers.values()) {
      this.timer.cancel(timer);
    }
    this.optimisticOpTimers.clear();
  }

  /**
   * Route `*Rpc` effects through the double-wrap. The outer `enqueueLifecycle`
   * exists to preserve serialization with legacy `send`/`edit` callers that
   * still use the same lifecycle queue directly.
   */
  private runRpc(effect: SendRpcEffect | EditRpcEffect | InterruptRpcEffect | TruncateRpcEffect | ExtensionUiResponseRpcEffect): void {
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
        this.startOptimisticOpTimer(effect.corrId, effect.sessionPath, 'send');
        try {
          service.bumpSessionDataEpoch(effect.sessionPath);
          statsService.prepareForSend(effect.sessionPath, effect.inputs);
          const response = await backend.request<{ requestId?: string }>('message.send', {
            sessionPath: effect.sessionPath,
            text: effect.text,
            inputs: effect.inputs,
            localId: effect.localId,
          });
          this.clearOptimisticOpTimer(effect.corrId);
          dispatch({
            kind: 'SendResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: true,
            requestId: response.requestId,
          });
        } catch (err) {
          this.clearOptimisticOpTimer(effect.corrId);
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
        this.startOptimisticOpTimer(effect.corrId, effect.sessionPath, 'edit');
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
          this.clearOptimisticOpTimer(effect.corrId);
          dispatch({ kind: 'EditResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
        } catch (err) {
          this.clearOptimisticOpTimer(effect.corrId);
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
  private runLifecycle(effect: Extract<Effect, { kind: 'OpenSession' | 'CreateSession' | 'DuplicateSession' }>): void {
    const { service, backend, queues, dispatch } = this.deps;
    if (effect.kind === 'OpenSession') {
      // OpenSession: the reducer already did the optimistic tab setup; the
      // runner owns the backend session.open RPC, serialized on the lifecycle
      // queue (shared with create/close). The selection token was minted in
      // service.openSession() BEFORE the reducer activated the opened tab, so
      // handleSelectionFailure can restore the previous active path on
      // failure. On failure handleSelectionFailure dispatches the reducer
      // transitions that undo the optimistic setup (CloseTab / SelectSession-
      // fallback / SessionScopeCleared / NoticeShown) — so the reducer's
      // OpenSessionResult handler stays a no-op, matching CreateSession.
      void queues.enqueueLifecycle(async () => {
        try {
          await backend.request('session.open', { sessionPath: effect.sessionPath, selectionToken: effect.selectionToken });
          dispatch({
            kind: 'OpenSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: true,
          });
        } catch (err) {
          service.handleSelectionFailure(effect.selectionToken, `Failed to open session: ${toErrorMessage(err)}`);
          dispatch({
            kind: 'OpenSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: false,
            error: toErrorMessage(err),
          });
        }
      });
      return;
    }
    if (effect.kind === 'DuplicateSession') {
      // DuplicateSession: the reducer already did the optimistic tab setup
      // (placeholder copy tab inserted adjacent to the source); the runner
      // owns the backend session.duplicate RPC, serialized on the lifecycle
      // queue (shared with create/open). The selection token was minted in
      // service.duplicateSession() BEFORE the reducer activated the copy tab,
      // so handleSelectionFailure can restore the previous active path on
      // failure. On failure handleSelectionFailure dispatches the reducer
      // transitions that undo the optimistic setup (CloseTab /
      // SelectSession-fallback / SessionScopeCleared / NoticeShown) — so the
      // reducer's DuplicateSessionResult handler stays a no-op, mirroring
      // CreateSession.
      void queues.enqueueLifecycle(async () => {
        try {
          await backend.request('session.duplicate', { sessionPath: effect.sourceSessionPath, selectionToken: effect.selectionToken });
          dispatch({ kind: 'DuplicateSessionResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
        } catch (err) {
          service.handleSelectionFailure(effect.selectionToken, `Failed to duplicate session: ${toErrorMessage(err)}`);
          dispatch({ kind: 'DuplicateSessionResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
        }
      });
      return;
    }
    // CreateSession: the reducer already did the optimistic tab setup; the
    // runner owns the backend session.create RPC, serialized on the lifecycle
    // queue (shared with open/close). The selection token was minted in
    // service.createNewSession() BEFORE the reducer activated the pending tab,
    // so handleSelectionFailure can restore the previous active path on
    // failure. On failure handleSelectionFailure dispatches the reducer
    // transitions that undo the optimistic setup (CloseTab / SelectSession-
    // fallback / SessionScopeCleared / NoticeShown) — so the reducer's
    // CreateSessionResult handler stays a no-op, matching the pre-migration
    // recovery path.
    void queues.enqueueLifecycle(async () => {
      try {
        await backend.request('session.create', { cwd: effect.cwd, selectionToken: effect.selectionToken });
        dispatch({
          kind: 'CreateSessionResult',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          ok: true,
        });
      } catch (err) {
        service.handleSelectionFailure(effect.selectionToken, `Failed to create session: ${toErrorMessage(err)}`);
        dispatch({
          kind: 'CreateSessionResult',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          ok: false,
          error: toErrorMessage(err),
        });
      }
    });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** RPC kinds that reach the generic double-wrap path in {@link runRpc} after
 *  Send/Edit have been short-circuited to their dedicated handlers. Kept
 *  exhaustive over this 3-kind set so the helper switches below stay
 *  exhaustive with no `never`-unreachable arms. */
type RpcEffect = InterruptRpcEffect | TruncateRpcEffect | ExtensionUiResponseRpcEffect;

function rpcMethodFor(effect: RpcEffect): string {
  switch (effect.kind) {
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
    case 'InterruptRpc':
      return { kind: 'InterruptResult', ...base };
    case 'TruncateRpc':
      return { kind: 'TruncateResult', ...base };
    case 'ExtensionUiResponseRpc':
      return { kind: 'ExtensionUiResponseResult', ...base };
  }
}
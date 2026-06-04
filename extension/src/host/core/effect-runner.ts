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

import type { Effect } from './effects';
import { isLifecycleEffect, isRpcEffect } from './effects';
import type { EffectResultEvent } from './events';

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

export interface EffectRunnerDeps {
  backend: BackendLike;
  queues: QueueRouter;
  tabs: TabPersistenceSink;
  log: LogSink;
  postImperative: PostImperativeSink;
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
    // CQRS effect types — not yet implemented; no-op until runner is extended.
    if (
      effect.kind === 'FileDiff' ||
      effect.kind === 'FileRevert' ||
      effect.kind === 'FlashWindow' ||
      effect.kind === 'PlayCompletionSound' ||
      effect.kind === 'ExportRunAnalytics' ||
      effect.kind === 'EvictTranscript' ||
      effect.kind === 'DeriveFileChanges' ||
      effect.kind === 'DeriveAvailableExtensions'
    ) {
      return;
    }
    // Exhaustiveness check — TS should reject unhandled kinds at compile time.
    const _exhaustive: never = effect;
    void _exhaustive;
  }

  /**
   * Route `*Rpc` effects through the double-wrap. The outer `enqueueLifecycle`
   * exists to preserve serialization with legacy `send`/`edit` callers that
   * still use the same lifecycle queue directly.
   */
  private runRpc(effect: Extract<Effect, { kind: `${string}Rpc` }>): void {
    if (effect.kind === 'EditRpc') {
      this.runEditRpc(effect);
      return;
    }
    if (effect.kind === 'SendRpc') {
      this.runSendRpc(effect);
      return;
    }
    const { queues, backend, dispatch } = this.deps;
    void queues.enqueueLifecycle(async () => {
      await queues.enqueueSessionOperation(effect.sessionPath, async () => {
        try {
          await backend.request(rpcMethodFor(effect), rpcParamsFor(effect));
          dispatch(rpcResultFor(effect, { ok: true }));
        } catch (err) {
          dispatch(rpcResultFor(effect, { ok: false, error: (err as Error).message }));
        }
      });
    });
  }

  /**
   * SendRpc needs to capture the `requestId` from the backend response
   * so the host can bind events to sessions.
   */
  private runSendRpc(effect: Extract<Effect, { kind: 'SendRpc' }>): void {
    const { queues, backend, dispatch } = this.deps;
    void queues.enqueueLifecycle(async () => {
      await queues.enqueueSessionOperation(effect.sessionPath, async () => {
        try {
          const response = await backend.request<{ requestId?: string }>('message.send', {
            sessionPath: effect.sessionPath,
            text: effect.text,
            inputs: effect.inputs,
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
            error: (err as Error).message,
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
    const { queues, backend, dispatch } = this.deps;
    void queues.enqueueLifecycle(async () => {
      await queues.enqueueSessionOperation(effect.sessionPath, async () => {
        try {
          await backend.request('session.truncateAfter', {
            sessionPath: effect.sessionPath,
            entryId: effect.messageId,
          });
          await backend.request('message.send', {
            sessionPath: effect.sessionPath,
            text: effect.text,
          });
          dispatch({ kind: 'EditResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
        } catch (err) {
          dispatch({ kind: 'EditResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: (err as Error).message });
        }
      });
    });
  }

  private runLifecycle(effect: Extract<Effect, { kind: 'OpenSession' | 'CreateSession' }>): void {
    const { queues, backend, dispatch } = this.deps;
    void queues.enqueueLifecycle(async () => {
      try {
        if (effect.kind === 'OpenSession') {
          await backend.request('session.open', {
            sessionPath: effect.sessionPath,
            selectionToken: effect.selectionToken,
          });
          dispatch({
            kind: 'OpenSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: true,
          });
        } else {
          const result = await backend.request<{ sessionPath: string }>('session.create', {
            selectionToken: effect.selectionToken,
          });
          dispatch({
            kind: 'CreateSessionResult',
            corrId: effect.corrId,
            sessionPath: result.sessionPath,
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
            error: (err as Error).message,
          });
        } else {
          dispatch({
            kind: 'CreateSessionResult',
            corrId: effect.corrId,
            ok: false,
            error: (err as Error).message,
          });
        }
      }
    });
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
          error: (err as Error).message,
        });
      }
    })();
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type RpcEffect = Extract<Effect, { kind: `${string}Rpc` }>;

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
  }
}
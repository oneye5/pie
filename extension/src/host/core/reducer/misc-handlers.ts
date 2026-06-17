import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';

export function handleTruncateResult(state: ArchState, _event: Extract<Event, { kind: 'TruncateResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleCreateSessionResult(state: ArchState, _event: Extract<Event, { kind: 'CreateSessionResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleDuplicateSessionResult(state: ArchState, _event: Extract<Event, { kind: 'DuplicateSessionResult' }>): ReducerResult {
  // No-op: recovery is host-driven via `handleSelectionFailure` (which
  // dispatches SessionScopeCleared + SelectSession-fallback + NoticeShown to
  // undo the optimistic setup), mirroring CreateSession/OpenSession. The result
  // event exists only to complete the Command→reducer→Effect→runner→Result
  // spine; the reducer has no pending snapshot to reconcile.
  return { state, effects: [] };
}

export function handleOpenSessionResult(state: ArchState, _event: Extract<Event, { kind: 'OpenSessionResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handlePersistTabsResult(state: ArchState, _event: Extract<Event, { kind: 'PersistTabsResult' }>): ReducerResult {
  return { state, effects: [] };
}
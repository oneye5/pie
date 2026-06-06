import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';

export function handleTruncateResult(state: ArchState, _event: Extract<Event, { kind: 'TruncateResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleCreateSessionResult(state: ArchState, _event: Extract<Event, { kind: 'CreateSessionResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handleOpenSessionResult(state: ArchState, _event: Extract<Event, { kind: 'OpenSessionResult' }>): ReducerResult {
  return { state, effects: [] };
}

export function handlePersistTabsResult(state: ArchState, _event: Extract<Event, { kind: 'PersistTabsResult' }>): ReducerResult {
  return { state, effects: [] };
}
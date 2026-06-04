/**
 * Single entry point for dispatching events to the CQRS reducer.
 * 
 * During the transitional phase, this wraps the reducer call. After the
 * cutover (when Redux is removed), this module will also handle:
 * - Auto-projection: compute ViewState after every cycle
 * - State change notification: notify subscribers after every cycle
 * - Effect execution: run the EffectRunner after every cycle
 */

import { reducer } from './reducer';
import type { ArchState } from './arch-state';
import type { Event } from './events';
import type { Effect } from './effects';

type StateChangeListener = (state: ArchState) => void;

const listeners = new Set<StateChangeListener>();

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribeToArchState(callback: StateChangeListener): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

function notifyListeners(state: ArchState): void {
  for (const listener of listeners) {
    listener(state);
  }
}

/**
 * Dispatch an event through the CQRS reducer.
 * 
 * Returns the new state and effects. Callers are responsible for
 * executing the effects (via EffectRunner) and persisting state changes.
 */
export function dispatch(state: ArchState, event: Event): { state: ArchState; effects: Effect[] } {
  const result = reducer(state, event);
  notifyListeners(result.state);
  return result;
}
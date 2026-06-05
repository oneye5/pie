/**
 * Single entry point for dispatching events to the CQRS reducer.
 * 
 * Handles the complete dispatch cycle:
 * 1. Reduce: (ArchState, Event) → { state, effects }
 * 2. Notify: subscribers hear about state changes (auto-projection)
 * 3. Run effects: the caller must pass the effects to the EffectRunner
 * 
 * Auto-projection: any listener subscribed via `subscribeToArchState()`
 * receives the new state after every dispatch, enabling automatic render
 * scheduling without explicit `scheduleRender()` calls.
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
 * Returns the new state and effects. The caller must:
 * - Store the new state (e.g., `this.archState = result.state`)
 * - Execute the effects (via `EffectRunner.run()`)
 * 
 * State change listeners are notified automatically, enabling auto-projection.
 */
export function dispatch(state: ArchState, event: Event): { state: ArchState; effects: Effect[] } {
  const result = reducer(state, event);
  notifyListeners(result.state);
  return result;
}
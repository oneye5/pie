import type { PruningMode, ThinkingLevel } from '../../../shared/protocol';

/** Extension IDs that have nested settings panels */
export const EXTENSIONS_WITH_SETTINGS = new Set(['skill-pruner']);

export const PRUNING_MODE_OPTIONS: { value: PruningMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'off', label: 'Off' },
];

export const THINKING_LEVEL_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/**
 * Tools contributed by non-extension providers are only visible to the backend
 * when they are active. After pruning, analytics can therefore contain only the
 * kept subset, which makes the always-keep picker unable to recover omitted
 * provider tools. Seed the picker with the stable built-in/provider tools so
 * users can pin them even when the previous turn pruned them away.
 */
export const DEFAULT_TOOL_KEEP_CATALOG = [
  'ask_user',
  'bash',
  'code_search',
  'edit',
  'fetch_content',
  'find',
  'get_search_content',
  'grep',
  'ls',
  'read',
  'request_tool',
  'web_search',
  'write',
];

/** Compute a sorted, deduplicated catalog for the always-keep picker. */
export function computeKeepCatalog(
  discoveredNames: string[],
  fromPruningResult: { included?: string[]; excluded?: string[] } | null,
  currentlySelected: string[],
): string[] {
  const set = new Set<string>();
  for (const name of discoveredNames) set.add(name);
  for (const name of fromPruningResult?.included ?? []) set.add(name);
  for (const name of fromPruningResult?.excluded ?? []) set.add(name);
  // Always-keep items are filtered OUT of the prepass input, so they will not
  // appear in included/excluded after the next pruning turn. Union them in so
  // they remain visible/removable in the picker.
  for (const name of currentlySelected) set.add(name);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Filter catalog by hiding already-selected names. */
export function filterKeepCatalog(catalog: string[], selected: string[]): string[] {
  const selectedSet = new Set(selected);
  return catalog.filter((name) => !selectedSet.has(name));
}

/** Compute the tool catalog, including provider tools that may be hidden by pruning. */
export function computeToolKeepCatalog(
  discoveredNames: string[],
  fromPruningResult: { included?: string[]; excluded?: string[] } | null,
  currentlySelected: string[],
): string[] {
  return computeKeepCatalog(
    [...DEFAULT_TOOL_KEEP_CATALOG, ...discoveredNames],
    fromPruningResult,
    currentlySelected,
  );
}

/**
 * Reference-stabilization helpers for host-delivered config objects.
 *
 * The host posts a fully-serialized `ViewState` on every `state` message
 * (≈7/sec while streaming, debounced to 150ms). `postMessage`'s structured
 * clone gives every nested object a fresh reference even when its content is
 * byte-identical, which defeats downstream `memo()` barriers,
 * `useMemo`/`useCallback` deps, and pref-driven `useEffect`s — they all re-run
 * on every snapshot. To make those barriers effective we reuse the previous
 * reference when a config object's content is structurally unchanged.
 *
 * Only the small, flat, infrequently-changing config objects (`prefs`,
 * `pruningSettings`, `pruningCatalog`) are stabilized here. The transcript is
 * left untouched (it changes shape every snapshot while streaming, and a
 * correct content comparison would be O(n) per tick).
 */

/**
 * Compare two collections (plain object or array) whose *values* are
 * primitives, by key/index. Used for `Record<string, boolean>` toggle maps and
 * `string[]` keep-lists without recursing into nested objects.
 */
function primitiveCollectionsEqual(a: object, b: object): boolean {
  // An array and a plain object can share the same keys (e.g. both empty →
  // `Object.keys` `[]`), so guard the shape first to avoid a false positive
  // that would let a malformed value reuse a stale reference.
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const aa = a as Record<string, unknown>;
  const bb = b as Record<string, unknown>;
  for (const k of ka) {
    if (aa[k] !== bb[k]) return false;
  }
  return true;
}

/**
 * Structural equality for the small, flat config objects posted on every host
 * `state` message (`prefs`, `pruningSettings`, `pruningCatalog`). Scalar fields
 * are compared with `===`; object/array fields (toggle records, keep-lists,
 * skill/tool catalogs) are compared via {@link primitiveCollectionsEqual}.
 *
 * Generic over keys so newly-added scalar fields are covered automatically
 * without touching this helper. Fails SAFE: a non-primitive collection whose
 * values are themselves objects is compared by reference (which differs for
 * fresh host-serialized objects), so it reports "not equal" and falls back to
 * the fresh reference rather than reusing a stale one.
 */
export function shallowConfigEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const av = a[k];
    const bv = b[k];
    if (av === bv) continue;
    if (av && bv && typeof av === 'object' && typeof bv === 'object') {
      if (primitiveCollectionsEqual(av, bv)) continue;
    }
    return false;
  }
  return true;
}

/**
 * Reuse `stable` when its content equals `candidate` (keeping a stable
 * reference across host state posts that didn't actually change this config),
 * otherwise adopt `candidate`. Pure and stateless; the caller owns the cached
 * reference (e.g. a module-level `let`).
 */
export function pickStable<T extends Record<string, unknown>>(stable: T | null, candidate: T): T {
  if (stable && shallowConfigEqual(stable, candidate)) {
    return stable;
  }
  return candidate;
}

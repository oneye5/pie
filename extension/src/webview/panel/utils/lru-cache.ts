/**
 * Minimal bounded LRU (least-recently-used) cache backed by a `Map`, which
 * iterates in insertion order. A hit is moved to the tail (most-recently-used);
 * on overflow the head (least-recently-used) is evicted.
 *
 * Extracted from `renderMarkdown` so the eviction / refresh logic can be unit-
 * tested in isolation — the markdown path pulls in `marked` + `DOMPurify`,
 * which need a DOM and cannot be reliably spy'd on under tsx (static and
 * dynamic imports of the same package resolve to different module instances).
 *
 * Note: `get` uses `undefined` as the sentinel for "not present", so this cache
 * is intended for value types that never legitimately store `undefined` (the
 * markdown cache stores non-`undefined` HTML strings).
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  readonly maxSize: number;

  constructor(maxSize: number) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new RangeError(`LruCache maxSize must be a positive finite number (got ${maxSize})`);
    }
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Returns the cached value and refreshes its recency, or `undefined`. */
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Move to tail (most-recently-used).
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Inserts/updates an entry, evicting the LRU entry when at capacity. */
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      // Refresh recency for an existing key (delete so re-insert moves it to tail).
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}

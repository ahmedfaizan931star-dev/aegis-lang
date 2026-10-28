/**
 * A small least-recently-used cache. Map keeps insertion order, so the first key is the oldest.
 * It is bounded two ways: by number of entries and by the total size of the texts it remembers,
 * so a few huge files cannot fill the memory.
 */
export class LruCache<V> {
  private map = new Map<string, { value: V; weight: number }>();
  private total = 0;
  hits = 0;
  misses = 0;

  constructor(
    private maxEntries: number,
    private maxWeight = Infinity,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (e === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.map.delete(key); // re-insert: now the newest
    this.map.set(key, e);
    return e.value;
  }

  /** `weight` is how much room the entry takes (for texts: their length). Entries heavier than the whole budget are not kept. */
  set(key: string, value: V, weight = key.length): void {
    this.drop(key);
    if (weight > this.maxWeight) return;
    this.map.set(key, { value, weight });
    this.total += weight;
    while (this.map.size > this.maxEntries || this.total > this.maxWeight) this.drop(this.map.keys().next().value as string);
  }

  private drop(key: string): void {
    const e = this.map.get(key);
    if (e) {
      this.total -= e.weight;
      this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.map.size;
  }
}

/** Freeze an object and everything inside it. Only for plain data (objects, arrays, strings, numbers). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) deepFreeze(value[i]);
  else for (const k in value) deepFreeze(value[k]);
  return value;
}

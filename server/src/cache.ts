export interface Cached<T> {
  value: T;
  loadedAt: number;
}

export interface CachedLoader<T> {
  /** cached value, loaded again once it is older than the TTL */
  get(): Promise<Cached<T>>;
  /** loads a fresh value; concurrent callers share one load */
  refresh(): Promise<Cached<T>>;
  peek(): Cached<T> | null;
}

/**
 * Time-based cache around a loader. Loaders are expected to never throw: they return an "unavailable" value instead,
 * so a broken data source cannot turn into a stream of failing requests.
 */
export function createCachedLoader<T>(load: () => Promise<T>, ttlMs: number): CachedLoader<T> {
  let current: Cached<T> | null = null;
  let pending: Promise<Cached<T>> | null = null;

  const refresh = (): Promise<Cached<T>> => {
    pending ??= load()
      .then((value) => {
        current = { value, loadedAt: Date.now() };
        return current;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    get: async () => (current && Date.now() - current.loadedAt < ttlMs ? current : refresh()),
    refresh,
    peek: () => current,
  };
}

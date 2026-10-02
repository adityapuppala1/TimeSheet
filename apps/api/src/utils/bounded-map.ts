/**
 * `items.map(fn)` with at most `limit` calls in flight, results in the ORDER OF `items`.
 *
 * For the console's fleet reads, which open one tenant database per workspace: one at a time makes a
 * page wait for the sum of every tenant's latency, and all at once is a connection storm on the box
 * the platform runs on. A small fixed number is the trade between the two. `fn` must not throw for an
 * item it can answer about — a fleet read records a failing tenant and carries on.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

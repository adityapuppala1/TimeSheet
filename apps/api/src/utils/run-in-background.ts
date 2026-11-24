/**
 * "This promise is deliberately not awaited" — for side effects (a notification, a cache refresh)
 * whose outcome nothing in the response depends on. It changes nothing about WHEN the work happens:
 * the promise has already started. It gives a rejection a home (logged, never an unhandled
 * rejection that takes the process down). Tenant context still propagates (AsyncLocalStorage).
 *
 * Same contract as apps/web/src/lib/run-in-background.ts.
 */
export function runInBackground(promise: PromiseLike<unknown>, label = "background"): void {
  Promise.resolve(promise).catch((error: unknown) => {
    console.warn(`[${label}]`, error instanceof Error ? error.message : error);
  });
}

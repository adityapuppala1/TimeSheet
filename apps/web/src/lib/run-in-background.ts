/**
 * WHAT: "this promise is deliberately not awaited" — for a METHOD call such as a cache refresh
 * (`queryClient.invalidateQueries(...)`) or a `.then(...)` chain, started from a handler that has
 * nothing to wait for.
 *
 * WHY NOT `void`: that is the idiom for a plain function call (`void navigate("/x")`), and SonarQube
 * accepts it everywhere. But the local `sonarjs/void-use` rule has no type information in this repo,
 * so it can only exempt `void` on an IDENTIFIER call — on a method call it reports, and the lint
 * ratchet would climb by one per call. This states the same intent without that false positive.
 *
 * It changes nothing about WHEN work happens: the promise already started; nothing waits for it.
 * What it adds is a home for a rejection, which is otherwise an "Uncaught (in promise)" — reported
 * to the console the same way, so a failure is no harder to find. (A TanStack Query refresh never
 * rejects anyway: refetch errors land on the query, unless `throwOnError` is set.)
 */
export function runInBackground(promise: PromiseLike<unknown>): void {
  Promise.resolve(promise).catch((error: unknown) => {
    console.warn("[background]", error);
  });
}

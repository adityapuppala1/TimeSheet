/**
 * Returns `value` only after it has stopped changing for `delayMs`.
 *
 * WHY: search boxes that feed a SERVER-paged endpoint. Typing "Priya" is five renders, and without
 * this that's five round trips, five loading states, and a race where an earlier response can land
 * after a later one and paint stale rows. React Query dedupes identical keys but these keys are all
 * different, so the debounce has to happen before the key is built.
 *
 * Not needed for client-side filtering (DataTable's own search filters an array already in memory),
 * which is why this arrived late and only has server-paged callers.
 */
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    // Clearing on every change is what makes this a debounce rather than a throttle: the timer
    // restarts while the user is still typing and only fires once they pause.
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

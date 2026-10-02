/**
 * WHAT: the one way an analytics surface says "still loading", "could not load" and "nothing here" —
 * a skeleton, a dash with a Retry button, or the caller's own empty state — before it renders data.
 *
 * WHY IT EXISTS: a failed request looked like an all-clear. The API client has no global handling for
 * a 4xx/5xx, so each page decided for itself, and most decided by accident: the home page's tiles
 * read `data?.x ?? 0` and printed a green 0 (the security risk score's 0 was even toned "success"),
 * My Work said "Nothing assigned to you right now" under a green check, Portfolio said "0 projects /
 * 0%", and Insights, Security insights and both report panels rendered an empty card. Each of those
 * is a measurement the page never made. NN/g's rule for empty states is the one applied here: no
 * data is not zero, and the reader must be able to tell the two apart and do something about it.
 *
 * The pattern is IntelligenceCenter.tsx's status ladders ("unavailable" vs "not measured"), promoted
 * so every analytics page uses the same words and the same Retry.
 *
 * A REFETCH THAT FAILS KEEPS THE LAST GOOD DATA ON SCREEN, with a line saying it is stale, rather
 * than blanking a card that was right a minute ago — the polled admin summary would otherwise flash
 * to "—" every time one request in thirty hiccupped.
 */
import { AlertTriangle, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { NO_VALUE } from "../lib/format";
import { cn } from "../lib/utils";

/** The subset of a React Query result this reads — a plain object in tests. */
export interface QueryLike<T> {
  data: T | undefined;
  isLoading?: boolean;
  isPending?: boolean;
  isError: boolean;
  refetch: () => unknown;
}

export type QueryPhase = "loading" | "error" | "empty" | "ready" | "stale";

/**
 * Which state a query is in, in the order a reader must be told:
 *   - error with nothing to show  → "error" (a dash and Retry — never a zero);
 *   - still waiting               → "loading";
 *   - error over earlier data     → "stale" (keep the figures, say they may be out of date);
 *   - data the caller calls empty → "empty";
 *   - otherwise                   → "ready".
 * A disabled query (no data, not loading, no error) reads as "loading" until it is enabled.
 */
export function queryPhase<T>(query: QueryLike<T>, isEmpty?: (data: T) => boolean): QueryPhase {
  if (query.data === undefined) return query.isError ? "error" : "loading";
  if (query.isError) return "stale";
  if (isEmpty?.(query.data)) return "empty";
  return "ready";
}

/** The failed-request block: a dash where the figure would be, what failed, and a way to try again. */
export function QueryError({ what, onRetry, compact = false, className }: { what: string; onRetry: () => unknown; compact?: boolean; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 text-sm",
        compact ? "px-3 py-2" : "px-4 py-4",
        className
      )}
    >
      <span className="text-lg font-black tabular-nums text-muted-foreground" aria-hidden>
        {NO_VALUE}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
        Couldn&apos;t load {what}. Nothing here is a measured zero.
      </span>
      <Button type="button" size="sm" variant="outline" onClick={() => { onRetry(); }}>
        <RotateCw className="h-3.5 w-3.5" aria-hidden />
        Retry
      </Button>
    </div>
  );
}

/** The line under figures that are still shown but could not be refreshed. */
export function StaleNote({ what, onRetry }: { what: string; onRetry: () => unknown }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden />
      Couldn&apos;t refresh {what} — showing the last figures that loaded.
      <button type="button" className="font-semibold text-primary hover:underline" onClick={() => { onRetry(); }}>
        Retry
      </button>
    </p>
  );
}

/**
 * Renders `children(data)` once there is data, and the right block before that.
 *
 * `what` names the thing for the error copy ("the workload summary"). `empty` is the caller's own
 * empty state — this component cannot know what the honest next step is.
 */
export function QueryState<T>({
  query,
  what,
  isEmpty,
  empty,
  loading,
  compact = false,
  children
}: {
  query: QueryLike<T>;
  what: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  loading?: ReactNode;
  compact?: boolean;
  children: (data: T) => ReactNode;
}) {
  const phase = queryPhase(query, isEmpty);
  if (phase === "loading") return <>{loading ?? <Skeleton className={compact ? "h-16 w-full" : "h-40 w-full"} />}</>;
  if (phase === "error") return <QueryError what={what} onRetry={query.refetch} compact={compact} />;
  if (phase === "empty") return <>{empty ?? null}</>;
  return (
    <>
      {children(query.data as T)}
      {phase === "stale" && <StaleNote what={what} onRetry={query.refetch} />}
    </>
  );
}

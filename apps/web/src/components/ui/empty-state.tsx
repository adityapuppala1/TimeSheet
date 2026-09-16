/**
 * WHAT: the one way an empty list, table or panel says so — an icon, a title, an optional line of
 * explanation, and an optional next action.
 *
 * WHY IT EXISTS: 33 in-app surfaces each hand-rolled a `<p className="py-6 text-center text-sm
 * text-muted-foreground">No … yet.</p>`. None had an icon, none offered a next step, and a person
 * meeting one could not tell "there is nothing" from "your filters hid everything" — the two
 * states that need different next actions ("New ticket" vs "Clear filters").
 *
 * WHY IT WAS PROMOTED, NOT WRITTEN: the platform console had already built exactly this in
 * `pages/platform-admin/console-ui.tsx`, with 60+ call sites. Enhance before adding: that file now
 * re-exports this one, so the console keeps its look and its callers do not change.
 *
 * TWO SIZES. `compact` sits inside a card or table body where a 10-row-tall panel would shout;
 * the default is for a whole empty panel. The action slot is a plain node so a page passes its own
 * `<Button>` — the primitive owns no navigation and no permissions.
 */
import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  /** A `<Button>` (or link) for the honest next step. Omit when there is none — a fake CTA is
   *  worse than no CTA. */
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({ title, description, icon: Icon = Inbox, action, compact = false, className }: Readonly<EmptyStateProps>) {
  return (
    <div
      role="status"
      className={cn(
        "grid place-items-center gap-2 rounded-lg border border-dashed border-border text-center",
        compact ? "px-4 py-6" : "px-6 py-10",
        className
      )}
    >
      <span className={cn("grid place-items-center rounded-full bg-muted text-muted-foreground", compact ? "h-8 w-8" : "h-10 w-10")}>
        <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} aria-hidden="true" />
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

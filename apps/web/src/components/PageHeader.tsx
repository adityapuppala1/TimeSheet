/**
 * WHAT: the page title block every page used to hand-roll, plus the breadcrumb the V12 shell asks
 * for — derived, never typed.
 *
 * WHY IT EXISTS: 26 of the 50 pages carried an identical `<h1>` block, half with an icon tile and
 * half without, and none had a breadcrumb. A breadcrumb typed per page is a second copy of the
 * sidebar's labels that drifts the day one is renamed — the exact failure this repo has fixed for
 * connectors, proposal types and pitch exports. So the crumb is READ from `nav`, the sidebar's own
 * table, which is already exported precisely so other surfaces (the product tour) derive from it.
 *
 * WHY THE MATCHING RULE IS COPIED FROM THE SIDEBAR AND NOT INVENTED: the sidebar highlights a route
 * through `<NavLink end={item.end ?? false}>`. `matchPath` with the same `end` reproduces that
 * exactly, so the crumb can never name a different page than the sidebar is highlighting. A route
 * not in `nav` (a detail page, a settings tab) falls back to the nearest ancestor in `nav`, which
 * is what a breadcrumb is for — and if nothing matches at all, no crumb renders rather than a wrong
 * one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not replace the pages' own responsive-wrapping rules.
 * The Tickets header comment records that `min-w-0` + `flex-wrap` on the actions row are
 * load-bearing at 390px (four view buttons once dragged the header off-screen, and `overflow-x:
 * clip` hid the damage). The `actions` slot here inherits that same containment, so a page that
 * migrates cannot lose it.
 */
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link, matchPath, useLocation } from "react-router";
import { nav, type NavItem } from "./Sidebar";
import { cn } from "../lib/utils";

/** The sidebar entry for a path, using the sidebar's own `end` rule; longest match wins so that
 *  `/app/tickets/123` resolves to Tickets, not Home. */
export function navItemFor(pathname: string, items: readonly NavItem[] = nav): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of items) {
    const hit = matchPath({ path: item.to, end: item.end ?? false }, pathname);
    if (hit && (!best || item.to.length > best.to.length)) best = item;
  }
  return best;
}

/** Section › Page, or just Page for the ungrouped lead item. Empty when the path is unknown. */
export function crumbsFor(pathname: string, items: readonly NavItem[] = nav): Array<{ label: string; to?: string }> {
  const item = navItemFor(pathname, items);
  if (!item) return [];
  const crumbs: Array<{ label: string; to?: string }> = [];
  if (item.section) crumbs.push({ label: item.section });
  // The current page is the last crumb and is not a link — a link to where you already are is
  // the one breadcrumb affordance that does nothing.
  crumbs.push({ label: item.label, to: pathname === item.to ? undefined : item.to });
  return crumbs;
}

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** A lucide icon component. Renders the tinted tile half the pages already use; omit for the
   *  plain variant the other half use. Both shapes are preserved on purpose. */
  icon?: React.ComponentType<{ className?: string }>;
  /** Right-hand controls — view switchers, primary buttons. Wrapped and width-contained. */
  actions?: ReactNode;
  /** Off by default on pages that are their own landmark (the dashboard); on everywhere else. */
  breadcrumb?: boolean;
  className?: string;
}

export function PageHeader({ title, description, icon: Icon, actions, breadcrumb = true, className }: Readonly<PageHeaderProps>) {
  const { pathname } = useLocation();
  const crumbs = breadcrumb ? crumbsFor(pathname) : [];

  return (
    <div className={cn("grid gap-2", className)}>
      {crumbs.length > 1 && (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />}
              {c.to ? (
                <Link to={c.to} className="focus-ring truncate rounded-sm hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                <span className={cn("truncate", i === crumbs.length - 1 && "text-foreground")} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
                  {c.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {Icon && (
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-black tracking-tight">{title}</h1>
            {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

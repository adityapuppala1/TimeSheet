/**
 * WHAT: the Views Bar — a tab strip directly under a page's header that switches how the same set
 * of work is shown (List, Board, Timeline, Calendar), with room for the page's saved views after
 * the built-in ones.
 *
 * WHY A BAR UNDER THE HEADER AND NOT BUTTONS IN IT: the pattern this branch replicates puts views
 * "under the toolbar and the location header" as tabs (V12 state file, sourced), and a tab strip
 * reads as "same data, different lens" where a button group in the header read as actions. The
 * header keeps the actions that create things; the bar keeps the ways of looking.
 *
 * ACCESSIBILITY: real `role="tablist"` / `role="tab"` with `aria-selected`, arrow-key movement
 * between tabs, and a 44px hit area on every tab. The strip scrolls sideways inside its own box at
 * phone width instead of widening the page.
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "../lib/utils";

export interface ViewTab<Id extends string = string> {
  id: Id;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

export function ViewsBar<Id extends string>({
  views,
  active,
  onChange,
  trailing,
  className
}: Readonly<{ views: ReadonlyArray<ViewTab<Id>>; active: Id; onChange: (id: Id) => void; trailing?: ReactNode; className?: string }>) {
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = views.findIndex((v) => v.id === active);
    const next = views[(i + (e.key === "ArrowRight" ? 1 : views.length - 1)) % views.length];
    if (next) {
      onChange(next.id);
      e.preventDefault();
    }
  };
  return (
    <div className={cn("flex min-w-0 max-w-full items-center gap-2 border-b border-border", className)} data-views-bar>
      <div role="tablist" aria-label="Views" onKeyDown={onKey} className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {views.map((v) => {
          const selected = v.id === active;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(v.id)}
              className={cn(
                "focus-ring relative flex h-[44px] shrink-0 items-center gap-1.5 px-3 text-sm font-medium transition-colors",
                selected ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {v.icon && <v.icon className="h-3.5 w-3.5" />}
              {v.label}
              {/* The underline is the selected state; a filled pill would fight the coloured marks. */}
              <span aria-hidden="true" className={cn("absolute inset-x-2 -bottom-px h-0.5 rounded-full", selected ? "bg-primary" : "bg-transparent")} />
            </button>
          );
        })}
      </div>
      {trailing && <div className="ml-auto flex min-w-0 shrink items-center gap-1.5 pl-2">{trailing}</div>}
    </div>
  );
}

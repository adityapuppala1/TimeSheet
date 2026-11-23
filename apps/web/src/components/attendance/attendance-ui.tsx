/**
 * Small shared pieces for the Attendance and Leave screens (V17 UI v2): a titled card whose own
 * failure shows inside it with Retry (so one broken card never blanks a page), a person avatar, a
 * segmented control and a filter chip. Everything is token-styled and keeps 44px touch targets.
 */
import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { initialsFor } from "../AccountMenu";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { fileUrl } from "../../services/api";
import { cn } from "../../lib/utils";

export function CardError({ message, onRetry }: Readonly<{ message: string; onRetry: () => void }>) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <p className="flex min-w-0 items-center gap-2 text-sm text-destructive-ink">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{message}</span>
      </p>
      <Button size="sm" variant="outline" onClick={onRetry} className="min-h-[44px] sm:min-h-8">
        Retry
      </Button>
    </div>
  );
}

/** A card with a heading, an optional action in the corner, and a body. */
export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  headingId
}: Readonly<{ title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string; headingId?: string }>) {
  return (
    <Card className={cn("min-w-0", className)}>
      <section aria-labelledby={headingId} className="grid min-w-0 gap-3 p-4">
        <header className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 id={headingId} className="text-sm font-semibold text-foreground">
              {title}
            </h3>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          {action}
        </header>
        {children}
      </section>
    </Card>
  );
}

export function PersonAvatar({ name, avatarUrl, className }: Readonly<{ name: string; avatarUrl?: string | null; className?: string }>) {
  const src = fileUrl(avatarUrl ?? null);
  return (
    <Avatar className={cn("h-8 w-8 shrink-0", className)}>
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback>{initialsFor(name)}</AvatarFallback>
    </Avatar>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** A roving segmented control (radio-group semantics) with 44px targets. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className
}: Readonly<{ value: T; onChange: (v: T) => void; options: ReadonlyArray<SegmentOption<T>>; label: string; className?: string }>) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex max-w-full min-w-0 overflow-x-auto rounded-lg border border-border bg-card p-0.5", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "focus-ring inline-flex min-h-[44px] shrink-0 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors sm:min-h-8",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="whitespace-nowrap">{o.label}</span>
            {o.count !== undefined && o.count > 0 && (
              <span className={cn("rounded-full px-1.5 text-[10px] font-semibold tabular-nums", active ? "bg-primary-foreground/20" : "bg-muted")}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function FilterChip({ active, onClick, children }: Readonly<{ active: boolean; onClick: () => void; children: ReactNode }>) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition-colors sm:min-h-8",
        active ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/** Today's key on the viewer's clock. */
export function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/**
 * WHAT: the one place a ticket status or priority is turned into a colour.
 *
 * WHY IT LEFT `pages/Tickets.tsx`: the metric tiles above the ticket table need exactly the same
 * status/priority palette the badges inside the table use, and the tiles live in their own
 * component — importing the maps back out of the page that renders that component would be a
 * circular import. `Tickets.tsx` re-exports both maps, so `TicketKanban.tsx`'s existing import
 * path keeps working unchanged.
 *
 * WHY THE TILE CLASSES ARE DERIVED FROM THE BADGE VARIANT RATHER THAN LISTED SEPARATELY: a second
 * hand-maintained colour table is a drift waiting to happen — the day somebody recolours CRITICAL
 * on the badge, a tile that kept its own copy would silently disagree with the row it filters to.
 * Everything here resolves through the same semantic tokens (`success`/`warning`/`destructive`/
 * `info`/`muted`), so light and dark themes are handled by the token, not by this file.
 */
import type { TicketPriority, TicketStatus } from "@timesheet/shared";
import type { BadgeProps } from "../components/ui/badge";

export type Tone = NonNullable<BadgeProps["variant"]>;

export const STATUS_VARIANT: Record<TicketStatus, BadgeProps["variant"]> = {
  OPEN: "info",
  IN_PROGRESS: "warning",
  IN_REVIEW: "warning",
  RESOLVED: "success",
  CLOSED: "muted",
  REOPENED: "destructive"
};

export const PRIORITY_VARIANT: Record<TicketPriority, BadgeProps["variant"]> = {
  LOW: "muted",
  MEDIUM: "info",
  HIGH: "warning",
  CRITICAL: "destructive"
};

/** The accent bar + number colour a metric tile paints, per semantic tone. */
export const TONE_TEXT_CLASS: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
  muted: "text-muted-foreground",
  default: "text-primary",
  secondary: "text-secondary-foreground",
  outline: "text-foreground"
};

export const TONE_ACCENT_CLASS: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
  muted: "bg-muted-foreground/40",
  default: "bg-primary",
  secondary: "bg-secondary",
  outline: "bg-border"
};

/** The ring a tile wears while its filter is the one currently applied. */
export const TONE_ACTIVE_RING_CLASS: Record<Tone, string> = {
  success: "ring-success/50 bg-success/5",
  warning: "ring-warning/50 bg-warning/5",
  destructive: "ring-destructive/50 bg-destructive/5",
  info: "ring-info/50 bg-info/5",
  muted: "ring-muted-foreground/40 bg-muted/50",
  default: "ring-primary/50 bg-primary/5",
  secondary: "ring-secondary bg-secondary/30",
  outline: "ring-border bg-muted/30"
};

/** "IN_PROGRESS" → "In progress". Used on tiles, where SHOUTING CASE reads as an error state. */
export function humanizeEnum(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The literal colour a chart needs. Recharts paints with values, not Tailwind classes, and these
 *  resolve through the same CSS variables the badge tones use — so a recoloured theme (and dark
 *  mode) moves the sparklines with the badges instead of leaving them behind. */
export const TONE_CHART_COLOR: Record<Tone, string> = {
  success: "hsl(var(--success))",
  warning: "hsl(var(--warning))",
  destructive: "hsl(var(--destructive))",
  info: "hsl(var(--info))",
  muted: "hsl(var(--muted-foreground))",
  default: "hsl(var(--primary))",
  secondary: "hsl(var(--muted-foreground))",
  outline: "hsl(var(--muted-foreground))"
};

/**
 * Which direction is good news for each bucket, for the trend chip's colour.
 *
 * `null` means NEUTRAL and the chip renders grey: a rising MEDIUM-priority count or a growing total
 * is neither good nor bad, and painting it green or red asserts a judgement the number does not
 * support. Only the buckets with a real direction — backlog and urgency down, throughput up — get
 * a colour.
 */
export const STATUS_HIGHER_IS_BETTER: Record<TicketStatus, boolean | null> = {
  OPEN: false,
  IN_PROGRESS: true,
  IN_REVIEW: true,
  RESOLVED: true,
  CLOSED: true,
  REOPENED: false
};

export const PRIORITY_HIGHER_IS_BETTER: Record<TicketPriority, boolean | null> = {
  CRITICAL: false,
  HIGH: false,
  MEDIUM: null,
  LOW: null
};

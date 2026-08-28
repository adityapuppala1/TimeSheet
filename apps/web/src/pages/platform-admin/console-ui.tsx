/**
 * The platform console's small design kit — the pieces every console page shares so the eight of
 * them read as one product: page headers, KPI tiles with a counting number, status pills that mean
 * the same thing on every screen, a marker timeline for the retention stages, and an empty state.
 *
 * Built on the app's theme tokens (so the console follows the light/dark toggle like everything
 * else) with AMBER as the console's own accent — `bg-accent` in this theme IS amber, so a console
 * primary button and the tenant app's accent are the same token, and an operator can still tell
 * at a glance which of the two they are in: the console's chrome carries the amber brand band.
 *
 * Motion is deliberate and cheap: numbers count up once on mount (a reactbits CountUp pattern
 * written in-tree, requestAnimationFrame, honours prefers-reduced-motion) and page bodies fade in.
 * Nothing loops.
 *
 * LAYOUT KIT (3.12.x). The first version shipped the *look* but left the *geometry* to each page,
 * and eight pages invented eight geometries: hand-rolled `overflow-x-auto` + `<Table>` wrappers
 * with different padding and no minimum width (so at 1024px columns squashed into three-line wraps
 * instead of the container scrolling), KPI grids that went 1-up on a phone and scrolled forever,
 * and switch rows of differing heights that made the retention policy card look ragged. The
 * primitives below own that geometry now — `KpiGrid`, `ConsoleTable`, `Field`/`FieldGrid`/
 * `SwitchField`, `Toolbar`, `SegmentedControl` — so a page describes WHAT it shows and never HOW
 * wide anything is. Two rules the pages must not re-litigate:
 *   - wide content scrolls inside its own container (`ConsoleTable`), never the page body;
 *   - the primary action is `PRIMARY_BTN` (amber) and every secondary action is
 *     `<Button variant="outline">` — there is deliberately no `ConsoleButton` to fork.
 */
import { motion, useReducedMotion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { TableCell } from "../../components/ui/table";
import { cn } from "../../lib/utils";
import type { DeletionBlocker, OrgStatus } from "../../services/platform-admin-api";

/* ----------------------------------------------------------------------------------------- */
/* Buttons                                                                                     */
/* ----------------------------------------------------------------------------------------- */

/**
 * The console's primary action, as a className rather than a component. A `<ConsoleButton>` would
 * be a second button API to keep in step with `<Button>`'s variants, sizes and `asChild`; a string
 * is one grep away from being audited and composes with everything the base button already does:
 *   <Button size="sm" className={PRIMARY_BTN}>Save policy</Button>
 * Secondary actions are `<Button variant="outline">`. There is no third kind.
 */
export const PRIMARY_BTN = "bg-accent text-accent-foreground hover:bg-accent/90";

/* ----------------------------------------------------------------------------------------- */
/* Page scaffolding                                                                            */
/* ----------------------------------------------------------------------------------------- */

export function ConsolePage({ title, description, eyebrow, actions, children }: { title: string; description?: ReactNode; eyebrow?: string; actions?: ReactNode; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: "easeOut" }} className="grid min-w-0 grid-cols-1 gap-6">
      {/* Two columns that WRAP rather than collide: the title block is `flex-1` over a basis wide
          enough to keep a real sentence readable, so once the actions no longer fit beside it the
          whole cluster drops to its own line instead of squeezing the heading to one word a line.
          Below `sm` it is simply stacked — a phone has no room for a second column. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        {/*
         * `sm:` on BOTH flex properties, and that prefix is the fix for a real bug rather than
         * tidiness. Below `sm` this container is `flex-col`, and in a column `flex-basis` sizes the
         * HEIGHT — so a bare `basis-[20rem]` gave the title block a 320px tall basis on a phone and
         * left roughly 160px of nothing between the description and the buttons under it. Every
         * page in the console inherited that gap, on every section, which is most of why the
         * console read as loose and unstructured on a small screen. The basis only means "a
         * readable column" once the container is actually a row.
         */}
        <div className="min-w-0 sm:flex-1 sm:basis-[20rem]">
          {eyebrow && <p className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">{eyebrow}</p>}
          <h1 className="text-2xl font-black tracking-tight text-foreground">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
      </div>
      {children}
    </motion.div>
  );
}

export function ConsoleSection({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  flush
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Extra classes on the body wrapper — use for a body-specific grid, not to re-add padding. */
  bodyClassName?: string;
  /** No body padding, for content that must touch the card's edges (a full-bleed table or list). */
  flush?: boolean;
}) {
  return (
    /* `overflow-hidden` only when flush: it is what keeps full-bleed content inside the rounded
       corners, but it also clips focus rings at the card edge, so a padded body does without. */
    <section className={cn("min-w-0 rounded-xl border border-border bg-card shadow-sm", flush && "overflow-hidden", className)}>
      <header className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-3">
        {/* `sm:`-gated for the same reason as ConsolePage's title block above: in the phone's
            column direction a basis is a height, not a width. */}
        <div className="min-w-0 sm:flex-1 sm:basis-[16rem]">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
      </header>
      <div className={cn("min-w-0", flush ? "p-0" : "p-4 sm:p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A right-aligned cluster of controls for a section header's `actions`. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-w-0 flex-wrap items-center gap-2 sm:justify-end", className)}>{children}</div>;
}

/* ----------------------------------------------------------------------------------------- */
/* Tables                                                                                      */
/* ----------------------------------------------------------------------------------------- */

/**
 * The ONE table wrapper in the console. Every page used to hand-roll
 * `<div className="overflow-x-auto rounded-lg border"><Table>…` with its own padding and — the
 * actual bug — no minimum width, so below ~1100px the browser resolved the overflow by wrapping
 * every cell to three lines instead of scrolling. A minimum width on the table is what turns a
 * squashed grid back into a scrollable one.
 *
 * It renders a bare `<table>` rather than the app's `<Table>` on purpose: `<Table>` supplies its
 * own `overflow-auto` wrapper, which nested inside this one would produce two scroll containers
 * and clamp the table back to the card width. The children are the ordinary `<TableHeader>` /
 * `<TableBody>` / `<TableRow>` components, so nothing at the call site changes.
 */
export function ConsoleTable({ minWidth = 900, children, className }: { minWidth?: number; children: ReactNode; className?: string }) {
  return (
    /*
     * `relative` is load-bearing, not decoration. A `sr-only` label inside a button in the last
     * column is `position: absolute`, and an absolutely positioned box whose containing block sits
     * OUTSIDE this scroller does not join the scroller's overflow — it joins the document's. So one
     * visually hidden word at x≈966 quietly stretched `documentElement.scrollWidth` to 967 on a
     * 390px phone while the table itself was perfectly contained, which is exactly the shape of
     * bug the responsive spec caught on /platform-admin/backups. Positioning the wrapper makes it
     * the containing block, and the hidden label scrolls with the table like everything else.
     */
    <div className={cn("relative min-w-0 overflow-x-auto rounded-lg border border-border", className)}>
      {/* Inline style, not `min-w-[${minWidth}px]`: Tailwind's JIT only compiles class names it can
          read as literals in the source, so a class built from a prop would generate no CSS. */}
      <table className="w-full caption-bottom text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

/**
 * A numeric body cell: right-aligned, monospaced, tabular figures — so a column of counts lines up
 * on the decimal everywhere in the console. Pair it with `<TableHead className="text-right">`.
 * Body cells only; it renders a `<td>`.
 */
export function Num({ children, className }: { children?: ReactNode; className?: string }) {
  return <TableCell className={cn("text-right font-mono tabular-nums", className)}>{children}</TableCell>;
}

/* ----------------------------------------------------------------------------------------- */
/* Forms                                                                                       */
/* ----------------------------------------------------------------------------------------- */

/**
 * The ONE form row. A fixed `gap-1.5` between label, control and hint is what makes two fields in
 * adjacent grid columns line up — when each page picks its own gap they never do.
 * `error` REPLACES `hint` rather than stacking under it, so a row does not change height when it
 * goes invalid and drag the rest of the grid with it.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className
}: {
  /** Optional only for a control that labels itself; pass one otherwise. */
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid min-w-0 grid-cols-1 gap-1.5", className)}>
      {label !== undefined && label !== null && label !== "" && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {!error && hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** The column layout `Field`s sit in. Always single column on a phone. */
export function FieldGrid({ cols = 2, children, className }: { cols?: 1 | 2 | 3; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-4",
        cols === 1 && "grid-cols-1",
        cols === 2 && "grid-cols-1 sm:grid-cols-2",
        cols === 3 && "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A switch in a bordered box: label and hint on the left, the switch on the right.
 *
 * The `min-h` is the whole point. These sit in a `FieldGrid` beside text inputs, and a box that
 * hugs a one-line hint next to a box hugging a two-line one is what made the retention policy card
 * look ragged. A floor height makes a row of them a row.
 *
 * `tone="danger"` marks a switch whose ON state is the dangerous one (auto-delete): it turns
 * destructive only when actually on, so the card is calm until the kill switch is armed.
 */
export function SwitchField({
  label,
  hint,
  checked,
  onCheckedChange,
  tone = "default",
  icon: Icon,
  disabled,
  className
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  tone?: "default" | "danger";
  icon?: LucideIcon;
  disabled?: boolean;
  className?: string;
}) {
  const armed = tone === "danger" && checked;
  return (
    <label
      className={cn(
        "flex min-h-[5.5rem] min-w-0 cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 transition-colors",
        armed ? "border-destructive/40 bg-destructive/5" : "border-border",
        disabled && "cursor-not-allowed opacity-60",
        className
      )}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          {Icon && <Icon className={cn("h-4 w-4 shrink-0", armed ? "text-destructive" : "text-muted-foreground")} />}
          <span className="min-w-0">{label}</span>
        </span>
        {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="shrink-0" />
    </label>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Segmented control                                                                           */
/* ----------------------------------------------------------------------------------------- */

/** Either the bare value, or the value with a nicer label and an optional count beside it. */
export type SegmentedOption<T extends string> = T | { value: T; label?: ReactNode; count?: number };

/**
 * One bordered group of mutually exclusive filters — All / Trial / Lapsed / Converted / Deleted —
 * instead of five loose outline buttons that read as five unrelated actions. Buttons, not radios:
 * these filter a list that is already on screen, so `aria-pressed` describes them honestly and
 * there is no form to submit.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  ariaLabel
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5", className)}>
      {options.map((option) => {
        const opt: { value: T; label?: ReactNode; count?: number } = typeof option === "string" ? { value: option } : option;
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "focus-ring inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold capitalize transition-colors",
              active ? "bg-accent text-accent-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {opt.label ?? opt.value}
            {opt.count !== undefined && <span className={cn("tabular-nums", active ? "opacity-70" : "opacity-60")}>{opt.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Counting numbers                                                                            */
/* ----------------------------------------------------------------------------------------- */

/** Counts from 0 to `value` once, ~700ms, eased. Re-runs when the target changes. */
export function useCountUp(value: number, duration = 700): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (reduce) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(origin + (value - origin) * eased);
      if (p < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration, reduce]);
  return shown;
}

/**
 * The KPI row. Two-up from the smallest width — a phone showing eight tiles one per row turns the
 * Overview into a page of scrolling, and the numbers are short enough that two fit at 390px. The
 * grid lives here rather than at each call site so the eight pages cannot drift apart again.
 */
export function KpiGrid({ children, className }: { children: ReactNode; className?: string }) {
  // ARITY-AWARE, because a fixed 4-column track leaves a lone orphan tile on the pages that have
  // three (Feedback, Analytics) — two above one, which reads as a layout accident rather than a
  // set. `auto-fit` with a floor sizes the track to what is actually there: four across on a wide
  // console, three when there are three, and always two on a phone.
  return <div className={cn("grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]", className)}>{children}</div>;
}

export function KpiCard({
  label,
  value,
  icon: Icon,
  hint,
  tone = "default",
  format = (n) => Math.round(n).toLocaleString(),
  delay = 0
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  hint?: ReactNode;
  tone?: "default" | "accent" | "success" | "warning" | "destructive";
  format?: (n: number) => string;
  delay?: number;
}) {
  const shown = useCountUp(value);
  const reduce = useReducedMotion();
  const toneClass = {
    default: "bg-muted text-foreground",
    accent: "bg-accent/15 text-accent",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/15 text-destructive"
  }[tone];
  return (
    /* Everything steps down one notch at 2-up-on-a-phone width: a smaller badge, smaller value
       type, and every line truncating — a tile that overflows is worse than a tile that elides. */
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: "easeOut" }}
      className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm sm:gap-4 sm:p-4"
    >
      <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg sm:h-11 sm:w-11", toneClass)}>
        <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:text-[11px]">{label}</p>
        <p className="truncate text-xl font-black tabular-nums tracking-tight text-foreground sm:text-2xl">{format(shown)}</p>
        {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </motion.div>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Pills                                                                                      */
/* ----------------------------------------------------------------------------------------- */

const STATUS_VARIANT: Record<OrgStatus, "success" | "warning" | "destructive" | "muted" | "info"> = {
  PROVISIONING: "info",
  ACTIVE: "success",
  GRACE: "warning",
  SUSPENDED: "destructive",
  ARCHIVED: "muted"
};

export function OrgStatusPill({ status }: { status: OrgStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}

/**
 * The plan-tier badge. Matches on the tier WORD rather than the whole string, because callers
 * legitimately pass a qualified label — the retention queue renders "TEAM trial" to distinguish an
 * entitlement that is on loan from one that is paid for, and exact equality quietly greyed every
 * one of those out.
 */
export function TierPill({ tier }: { tier: string }) {
  const upper = tier.toUpperCase();
  const variant = upper.includes("ENTERPRISE") ? "info" : upper.includes("TEAM") ? "success" : "muted";
  return <Badge variant={variant}>{tier}</Badge>;
}

export const BLOCKER_LABEL: Record<DeletionBlocker, string> = {
  "not-in-programme": "Not a trial workspace",
  converted: "Paying customer — never deleted",
  status: "Not lapsed",
  "not-yet": "Retention window still running",
  hold: "On hold by a platform admin",
  "auto-delete-off": "Auto-delete is switched off",
  "final-notice-pending": "Final notice not sent yet",
  "final-notice-today": "Final notice went out today — deletes on the next tick"
};

/* ----------------------------------------------------------------------------------------- */
/* Retention marker timeline                                                                  */
/* ----------------------------------------------------------------------------------------- */

export const MARKER_LABEL: Record<string, string> = {
  feedback10: "Day 10 check-in",
  ended: "Trial ended",
  "30": "Day 30",
  "60": "Day 60",
  "80": "Day 80",
  "90": "Day 90 · final",
  deleted: "Deleted"
};

/** Six dots, one per stage: filled when sent, hollow when superseded, ringed when due next. */
export function MarkerTimeline({ markers, sent, next, due }: { markers: string[]; sent: Record<string, string>; next?: string | null; due?: string[] }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Retention stages">
      {markers.map((m) => {
        const state = sent[m] === "superseded" ? "superseded" : sent[m] ? "sent" : due?.includes(m) ? "due" : next === m ? "next" : "pending";
        return (
          <li key={m} title={`${MARKER_LABEL[m] ?? m}: ${state}${sent[m] && sent[m] !== "superseded" ? ` · ${new Date(sent[m]).toLocaleDateString()}` : ""}`}>
            <span
              className={cn(
                "block h-2.5 w-2.5 rounded-full border transition-colors",
                state === "sent" && "border-success bg-success",
                state === "superseded" && "border-muted-foreground/50 bg-transparent",
                state === "due" && "border-accent bg-accent animate-pulse",
                state === "next" && "border-accent bg-transparent ring-2 ring-accent/30",
                state === "pending" && "border-border bg-muted"
              )}
            />
          </li>
        );
      })}
    </ol>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Empty state                                                                                */
/* ----------------------------------------------------------------------------------------- */

export function EmptyState({ title, description, icon: Icon = Inbox, action }: { title: string; description?: ReactNode; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <div className="grid place-items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" />
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}

/**
 * Bytes as a person reads them.
 *
 * IN THE KIT because three console pages had grown their own copy — Backups, Monitoring and the
 * schema panel — and two of them disagreed about when to switch from one decimal to none, so the
 * same figure rendered differently depending on which page you were looking at. Signed, because a
 * reclaimed-space delta is legitimately negative.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const sign = bytes < 0 ? "-" : "";
  const magnitude = Math.abs(bytes);
  if (magnitude < 1024) return `${sign}${Math.round(magnitude)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = magnitude / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${sign}${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export const relativeDay = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
};

export const shortDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
export const shortDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

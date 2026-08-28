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
 */
import { motion, useReducedMotion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import type { DeletionBlocker, OrgStatus } from "../../services/platform-admin-api";

/* ----------------------------------------------------------------------------------------- */
/* Page scaffolding                                                                            */
/* ----------------------------------------------------------------------------------------- */

export function ConsolePage({ title, description, eyebrow, actions, children }: { title: string; description?: ReactNode; eyebrow?: string; actions?: ReactNode; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: "easeOut" }} className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && <p className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">{eyebrow}</p>}
          <h1 className="text-2xl font-black tracking-tight text-foreground">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </motion.div>
  );
}

export function ConsoleSection({ title, description, actions, children, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-border bg-card shadow-sm", className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="p-5">{children}</div>
    </section>
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
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: "easeOut" }}
      className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-lg", toneClass)}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-2xl font-black tabular-nums tracking-tight text-foreground">{format(shown)}</p>
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

export function TierPill({ tier }: { tier: string }) {
  return <Badge variant={tier === "ENTERPRISE" ? "info" : tier === "TEAM" ? "success" : "muted"}>{tier}</Badge>;
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

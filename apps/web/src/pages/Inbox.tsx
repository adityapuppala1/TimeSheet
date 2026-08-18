/**
 * The Inbox — a triage queue over this person's notifications, with the day's brief above it.
 *
 * WHY A TWO-PANE LAYOUT ON DESKTOP AND A LIST ON PHONES: triage is "read one, decide, next", and a
 * list that navigates away on every item makes that four gestures instead of one. Below `lg` the
 * detail pane would be a postage stamp, so the row expands in place instead — the same
 * shrink-to-a-list decision the timeline made rather than shipping a squashed chart.
 *
 * WHY THE BRIEF IS AT THE TOP AND NOT ITS OWN PAGE: "what needs me today" is the question that
 * brings somebody here. Its numbers are arithmetic over definitions that already exist elsewhere in
 * the API (see inbox.service.ts) — no model writes them, so they can be reconciled against the
 * pages they link to.
 *
 * WHY HANDLED ≠ READ: opening the bell marks things read, which says something about attention and
 * nothing about work. Handling is the queue-clearing act, and keeping them separate is what stops a
 * glance from emptying the inbox.
 *
 * WHO renders this: `App.tsx` at `/app/inbox`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BellOff,
  CalendarClock,
  Check,
  CheckCheck,
  CircleDot,
  Clock,
  Inbox as InboxIcon,
  Loader2,
  Sparkles,
  Undo2
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { inboxApi, type InboxFilterValue, type Notification } from "../services/api";

const FILTERS: Array<{ value: InboxFilterValue; label: string; countKey: "unhandled" | "snoozed" | "handled" | null }> = [
  { value: "unhandled", label: "To do", countKey: "unhandled" },
  { value: "snoozed", label: "Snoozed", countKey: "snoozed" },
  { value: "handled", label: "Done", countKey: "handled" },
  { value: "all", label: "Everything", countKey: null }
];

/** Snooze offsets, phrased as intentions rather than durations — "tomorrow morning" is a decision,
 *  "+18h" is arithmetic the reader has to do. */
const SNOOZES: Array<{ label: string; at: () => Date }> = [
  {
    label: "Later today",
    at: () => new Date(Date.now() + 4 * 3600_000)
  },
  {
    label: "Tomorrow 9am",
    at: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    }
  },
  {
    label: "Next week",
    at: () => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      d.setHours(9, 0, 0, 0);
      return d;
    }
  }
];

/** How many rows one press reveals. Small enough that the page stays a screenful, large enough
 *  that clearing a backlog is not a hundred clicks. */
const PAGE = 25;

const relative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Category → a readable group name.
 *
 * The map is keyed on the categories producers ACTUALLY write (read off the live table rather than
 * guessed: `face.verification_flagged`, `ticket.escalation`, `reminder.daily`, …), and the prefix
 * fallback covers the rest of a family so a newly added `ticket.something` reads as "Ticket"
 * instead of as a raw key. A completely unknown prefix still falls through to the key itself —
 * pooling it into "Other" would hide that a new producer has appeared.
 */
const CATEGORY_LABELS: Record<string, string> = {
  "release.published": "Release",
  "sla.breach": "SLA",
  escalation: "Escalation"
};

const CATEGORY_PREFIXES: Array<[string, string]> = [
  ["timesheet.", "Timesheet"],
  ["ticket.", "Ticket"],
  ["face.", "Identity"],
  ["reminder.", "Reminder"],
  ["approval.", "Approval"],
  ["digest.", "Digest"],
  ["goal.", "Goal"],
  ["security.", "Security"]
];

const categoryLabel = (category?: string | null) => {
  if (!category) return "Notification";
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  const prefix = CATEGORY_PREFIXES.find(([p]) => category.startsWith(p));
  return prefix ? prefix[1] : category;
};

export function InboxPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<InboxFilterValue>("unhandled");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The API returns up to 200 rows; the page renders a page-worth at a time. Without this the
      first render of a busy workspace was 24,000 pixels tall, which is not a queue — it is a log,
      and it pushed the detail pane off the bottom of its own layout. */
  const [visible, setVisible] = useState(PAGE);

  const brief = useQuery({ queryKey: ["inbox", "brief"], queryFn: inboxApi.brief, staleTime: 60_000 });
  useEffect(() => setVisible(PAGE), [filter]);
  const inbox = useQuery({ queryKey: ["inbox", filter], queryFn: () => inboxApi.list(filter) });

  const items = inbox.data?.items ?? [];
  const counts = inbox.data?.counts;
  const shown = items.slice(0, visible);

  // Keep a selection that still exists. Without this, handling the selected row leaves the detail
  // pane showing something the list no longer contains.
  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !items.some((i) => i.id === selectedId)) setSelectedId(items[0].id);
  }, [items, selectedId]);

  // A row can only be selected if it is on screen; otherwise the detail pane shows something the
  // reader cannot see in the list.
  const selectedVisible = shown.some((i) => i.id === selectedId);

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["inbox"] });
    // The bell shares this data — leaving it stale would show a count the inbox has already cleared.
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
  };

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { handled?: boolean; read?: boolean; snoozeUntil?: string | null } }) =>
      inboxApi.update(id, patch),
    onSuccess: refresh,
    onError: (err: any) => toast.error("Could not update", { description: err?.response?.data?.message ?? "Try again." })
  });

  const handleAll = useMutation({
    mutationFn: inboxApi.handleAll,
    onSuccess: (c) => {
      toast.success("Inbox cleared", { description: `${c.handled} item${c.handled === 1 ? "" : "s"} marked done. Nothing was deleted.` });
      refresh();
    },
    onError: (err: any) => toast.error("Could not clear", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <InboxIcon className="h-6 w-6 text-primary" />
            Inbox
          </h1>
          <p className="text-sm text-muted-foreground">What needs you today, and everything the workspace has told you.</p>
        </div>
        {(counts?.unhandled ?? 0) > 0 && (
          <Button variant="outline" onClick={() => handleAll.mutate()} disabled={handleAll.isPending} className="shrink-0">
            {handleAll.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCheck className="mr-1.5 h-4 w-4" />}
            Mark all done
          </Button>
        )}
      </div>

      <div data-tour="inbox-brief">
        <DailyBriefCard loading={brief.isLoading} data={brief.data} />
      </div>

      {/* Filter tabs. The counts live on the tabs rather than in a sidebar so the shape of the
          queue is visible before anything is clicked. */}
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Inbox filters">
        {FILTERS.map((f) => {
          const count = f.countKey && counts ? counts[f.countKey] : null;
          const active = filter === f.value;
          return (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(f.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors duration-150",
                active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              )}
            >
              {f.label}
              {count !== null && count > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11px] tabular-nums",
                    active ? "bg-primary-foreground/20" : "bg-background/70"
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {inbox.isLoading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      )}

      {!inbox.isLoading && items.length === 0 && <EmptyState filter={filter} />}

      {items.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {/* The list. Rows are buttons, not links: selecting is not navigating. On desktop it is
              its own scroll container so the detail pane stays put beside it — the two-pane triage
              loop only works if the right-hand side does not scroll away. */}
          <div className="space-y-2 lg:max-h-[calc(100vh-13rem)] lg:overflow-y-auto lg:pr-1">
            {shown.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                busy={update.isPending}
                onSelect={() => {
                  setSelectedId(item.id);
                  if (!item.readAt) update.mutate({ id: item.id, patch: { read: true } });
                }}
                onHandle={() => update.mutate({ id: item.id, patch: { handled: !item.handledAt } })}
                onSnooze={(at) => update.mutate({ id: item.id, patch: { snoozeUntil: at.toISOString() } })}
                onUnsnooze={() => update.mutate({ id: item.id, patch: { snoozeUntil: null } })}
              />
            ))}

            {items.length > shown.length && (
              <Button variant="outline" className="w-full" onClick={() => setVisible((v) => v + PAGE)}>
                Show {Math.min(PAGE, items.length - shown.length)} more
                <span className="ml-1.5 text-xs text-muted-foreground">({items.length - shown.length} left)</span>
              </Button>
            )}
          </div>

          {/* The detail pane, desktop only — below lg the row itself carries everything. */}
          <div className="hidden lg:block">
            <div className="sticky top-4">
              {selected && selectedVisible ? <DetailPane item={selected} /> : <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Select an item.</CardContent></Card>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DailyBriefCard({ loading, data }: Readonly<{ loading: boolean; data?: import("../services/api").DailyBrief }>) {
  if (loading) return <Skeleton className="h-32" />;
  if (!data) return null;

  return (
    <Card className="animate-fade-in overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          Today's brief
        </CardTitle>
        <CardDescription>
          {data.allClear
            ? "Nothing is waiting on you. Every figure below is counted, not estimated."
            : "Counted from the same definitions the pages behind them use — nothing here is generated."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {data.sections.map((s) => {
            const body = (
              <div
                data-brief-tile
                className={cn(
                  "flex h-full items-start gap-2.5 rounded-lg border p-3 transition-all duration-200",
                  s.tone === "attention"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-muted/30",
                  s.link && "hover:border-primary/50 hover:shadow-sm"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md",
                    s.tone === "attention" ? "bg-warning/15 text-warning-foreground" : "bg-background text-muted-foreground"
                  )}
                  aria-hidden
                >
                  {s.tone === "attention" ? <AlertTriangle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-xl font-semibold tabular-nums">{s.count}</span>
                    <span className="truncate text-xs font-medium">{s.label}</span>
                  </span>
                  {s.detail && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{s.detail}</span>}
                </span>
                {s.link && <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              </div>
            );
            return s.link ? (
              <Link key={s.key} to={s.link} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
                {body}
              </Link>
            ) : (
              <div key={s.key}>{body}</div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function InboxRow({
  item,
  selected,
  busy,
  onSelect,
  onHandle,
  onSnooze,
  onUnsnooze
}: Readonly<{
  item: Notification;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onHandle: () => void;
  onSnooze: (at: Date) => void;
  onUnsnooze: () => void;
}>) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const unread = !item.readAt;
  const snoozed = item.snoozedUntil && new Date(item.snoozedUntil) > new Date();

  return (
    <div
      data-inbox-row
      className={cn(
        "animate-fade-in rounded-lg border bg-card transition-all duration-200",
        selected ? "border-primary/60 shadow-sm" : "hover:border-primary/30",
        item.handledAt && "opacity-70"
      )}
    >
      <button type="button" onClick={onSelect} className="w-full px-3 py-2.5 text-left">
        <div className="flex items-start gap-2.5">
          <span className="mt-1 shrink-0" aria-hidden>
            {unread ? (
              <CircleDot className="h-3.5 w-3.5 text-primary" />
            ) : (
              <span className="block h-3.5 w-3.5 rounded-full border border-muted-foreground/30" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium")}>{item.title}</span>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {categoryLabel(item.category)}
              </Badge>
              {snoozed && (
                <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
                  <Clock className="h-2.5 w-2.5" />
                  {when(item.snoozedUntil!)}
                </Badge>
              )}
            </span>
            <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">{item.body}</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">{relative(item.createdAt)}</span>
          </span>
        </div>
      </button>

      {/* Actions live in the row, not behind a menu: triage is a two-click loop and a menu makes
          it three. */}
      <div className="flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
        <Button variant="ghost" size="sm" onClick={onHandle} disabled={busy} className="h-7 px-2 text-xs">
          {item.handledAt ? <Undo2 className="mr-1 h-3 w-3" /> : <Check className="mr-1 h-3 w-3" />}
          {item.handledAt ? "Reopen" : "Done"}
        </Button>

        {snoozed ? (
          <Button variant="ghost" size="sm" onClick={onUnsnooze} disabled={busy} className="h-7 px-2 text-xs">
            <BellOff className="mr-1 h-3 w-3" />
            Un-snooze
          </Button>
        ) : (
          <div className="relative">
            <Button variant="ghost" size="sm" onClick={() => setSnoozeOpen((v) => !v)} disabled={busy} className="h-7 px-2 text-xs">
              <CalendarClock className="mr-1 h-3 w-3" />
              Snooze
            </Button>
            {snoozeOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 w-40 animate-fade-in overflow-hidden rounded-md border bg-popover shadow-md">
                {SNOOZES.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="block w-full px-3 py-2 text-left text-xs hover:bg-muted"
                    onClick={() => {
                      onSnooze(s.at());
                      setSnoozeOpen(false);
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {item.link && (
          <Button asChild variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs">
            <Link to={item.link}>
              Open
              <ArrowRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

function DetailPane({ item }: Readonly<{ item: Notification }>) {
  return (
    <Card className="animate-fade-in">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{categoryLabel(item.category)}</Badge>
          <span className="text-xs text-muted-foreground">{when(item.createdAt)}</span>
          {item.handledAt && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="success" className="gap-1">
                  <Check className="h-3 w-3" />
                  Done
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Marked done {relative(item.handledAt)}. The row is kept, never deleted.</TooltipContent>
            </Tooltip>
          )}
        </div>
        <CardTitle className="text-base leading-snug">{item.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* whitespace-pre-line: several producers write multi-line bodies, and collapsing them
            turns a readable summary into a paragraph. */}
        <p className="whitespace-pre-line text-sm text-muted-foreground">{item.body}</p>
        {item.link && (
          <Button asChild size="sm">
            <Link to={item.link}>
              Open it
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({ filter }: Readonly<{ filter: InboxFilterValue }>) {
  const copy: Record<InboxFilterValue, { title: string; body: string }> = {
    unhandled: { title: "Inbox zero", body: "Nothing is waiting on you. Snoozed items will come back on their own." },
    snoozed: { title: "Nothing snoozed", body: "Anything you defer shows up here until its time comes round." },
    handled: { title: "Nothing marked done yet", body: "Items you finish with stay here — they are kept, never deleted." },
    all: { title: "No notifications yet", body: "This fills up as the workspace has something to tell you." }
  };
  const { title, body } = copy[filter];
  return (
    <Card className="animate-fade-in">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary" aria-hidden>
          <InboxIcon className="h-5 w-5" />
        </span>
        <div className="space-y-1">
          <p className="font-medium">{title}</p>
          <p className="max-w-md text-sm text-muted-foreground">{body}</p>
        </div>
      </CardContent>
    </Card>
  );
}

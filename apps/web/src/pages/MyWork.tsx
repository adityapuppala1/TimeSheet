/**
 * "My work" — one person's cross-project queue, bucketed by when it is due.
 *
 * WHY THE BUCKETS ARE COMPUTED SERVER-SIDE: "overdue", "today", "this week" and "blocked" are the
 * same four questions every morning, and their definitions have to match what the dashboard and
 * the reminder emails already use. Three implementations of "overdue" is three chances to drift.
 *
 * WHY A BLOCKED ITEM APPEARS IN EXACTLY ONE BUCKET: putting it under "today" as well would place
 * work at the top of someone's list that they cannot actually start. That is the fastest way to
 * make a to-do list untrustworthy, and an untrusted list is worse than no list.
 *
 * WHY THIS PAGE HAS NO PERMISSION GATE AND NO PLANNING GATE: it is the caller's own work, read
 * from dates that exist whether or not planning is switched on. A personal queue is not a feature
 * to sell separately, and gating it would leave most users with an empty nav entry.
 *
 * WHO renders this: `App.tsx` at `/app/my-work`.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronRight, Diamond, ListTodo, Lock } from "lucide-react";
import { useNavigate } from "react-router";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { planApi, type MyWorkItem } from "../services/api";

const PRIORITY_VARIANT: Record<string, "secondary" | "info" | "warning" | "destructive"> = {
  LOW: "secondary",
  MEDIUM: "info",
  HIGH: "warning",
  CRITICAL: "destructive"
};

function ItemRow({ item, onOpen, tone }: { item: MyWorkItem; onOpen: (id: string) => void; tone?: "overdue" | "blocked" }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item.id)}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50",
        tone === "overdue" && "border-l-2 border-l-destructive",
        tone === "blocked" && "border-l-2 border-l-warning"
      )}
    >
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {item.isMilestone && <Diamond className="h-3 w-3 text-plan-today" />}
          <span className="font-mono text-[11px] text-muted-foreground">{item.key}</span>
          <span className="truncate text-sm font-medium">{item.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {item.project && <span>{item.project.code}</span>}
          <Badge variant={PRIORITY_VARIANT[item.priority] ?? "secondary"}>{item.priority}</Badge>
          {item.statusLabel && <Badge variant="outline">{item.statusLabel}</Badge>}
          {item.deadline && (
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="h-3 w-3" />
              {item.deadline}
              {/* Says WHICH date is being shown. A scheduled end date and an SLA deadline are
                  different promises, and a bare date that silently means either is misleading. */}
              <span className="text-[10px] opacity-70">{item.endDate ? "planned" : "SLA"}</span>
            </span>
          )}
          {item.blockers.length > 0 && (
            <span className="inline-flex items-center gap-1 text-warning">
              <Lock className="h-3 w-3" />
              blocked by {item.blockers.map((b) => b.key).join(", ")}
            </span>
          )}
        </div>
        {item.progressPct !== null && item.progressPct > 0 && (
          <Progress value={item.progressPct} className="h-1" />
        )}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function Bucket({
  title,
  description,
  items,
  onOpen,
  tone,
  icon: Icon
}: {
  title: string;
  description?: string;
  items: MyWorkItem[];
  onOpen: (id: string) => void;
  tone?: "overdue" | "blocked";
  icon: any;
}) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className={cn("h-4 w-4", tone === "overdue" ? "text-destructive" : tone === "blocked" ? "text-warning" : "text-primary")} />
          {title}
          <Badge variant="secondary">{items.length}</Badge>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-2">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} onOpen={onOpen} tone={tone} />
        ))}
      </CardContent>
    </Card>
  );
}

export function MyWorkPage() {
  const navigate = useNavigate();
  const work = useQuery({ queryKey: ["plan", "my-work"], queryFn: planApi.myWork });
  const open = (id: string) => navigate(`/app/tickets?open=${id}`);

  if (work.isLoading) {
    return (
      <div className="mx-auto grid w-full max-w-4xl gap-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const data = work.data;
  const empty = !data || data.counts.total === 0;

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-4 p-4 sm:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ListTodo className="h-5 w-5 text-primary" />
          My work
        </h1>
        <p className="text-sm text-muted-foreground">
          Everything assigned to you across every project, ordered by when it is actually needed.
        </p>
      </div>

      {empty ? (
        <Card>
          <CardContent className="grid gap-2 p-10 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
            <p className="text-sm font-medium">Nothing assigned to you right now</p>
            <p className="text-xs text-muted-foreground">Work assigned to you shows up here automatically.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Bucket
            title="Overdue"
            description="Past its planned end date or its SLA deadline."
            items={data!.overdue}
            onOpen={open}
            tone="overdue"
            icon={AlertTriangle}
          />
          <Bucket title="Due today" items={data!.today} onOpen={open} icon={CalendarClock} />
          <Bucket title="This week" items={data!.thisWeek} onOpen={open} icon={CalendarClock} />
          <Bucket
            title="Blocked"
            description="Waiting on something else to finish. Listed separately so it never sits at the top of your list pretending to be startable."
            items={data!.blocked}
            onOpen={open}
            tone="blocked"
            icon={Lock}
          />
          <Bucket title="Later" items={data!.later} onOpen={open} icon={ListTodo} />
        </>
      )}
    </div>
  );
}

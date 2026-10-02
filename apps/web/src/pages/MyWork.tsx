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
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronRight, Copy, Diamond, ListTodo, Lock, MessageSquare, RefreshCw, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "../components/ui/toaster";
import { useState } from "react";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { aiApi, planApi, type MyWorkItem } from "../services/api";
import { QueryError } from "../components/QueryState";

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
        // V12 10.3: `pressable` adds the give-under-the-pointer; the lift is motion-safe so a
        // person on reduced motion keeps the colour change and loses only the movement.
        "pressable flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50",
        "motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-soft",
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
  const assigned = work.data?.assignedComments ?? [];

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
  // "Nothing assigned" only when the queue was READ and is empty. A failed request used to land here
  // too, under a green check — telling somebody with a full queue that they had nothing to do.
  const failed = work.isError && !data;
  const empty = Boolean(data) && data!.counts.total === 0;

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

      {/* V12 9.1/9.3: ABOVE the empty branch on purpose. A person whose queue is empty is exactly
          who needs a recap of what they did, and a manager writing a report's stand-up may have
          nothing assigned to them at all — the first version hid the card from precisely them. */}
      <StandupCard />

      {failed && <QueryError what="your work queue" onRetry={() => work.refetch()} />}

      {!failed && (empty ? (
        <Card>
          <CardContent className="grid gap-2 p-10 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
            <p className="text-sm font-medium">Nothing assigned to you right now</p>
            <p className="text-xs text-muted-foreground">Work assigned to you shows up here automatically.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* V12 8.3: comments assigned to me — action items, above the dated work. */}
          {assigned.length > 0 && (
            <Card data-assigned-comments>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <MessageSquare className="h-4 w-4 text-primary" />
                  Comments assigned to you
                  <Badge variant="secondary">{assigned.length}</Badge>
                </CardTitle>
                <CardDescription>Somebody asked you to act on these. Resolve them from the ticket's Comments tab.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                {assigned.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => open(c.ticketId)}
                    className="focus-ring pressable flex min-h-[44px] w-full items-start gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-muted"
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.ticketKey}</span>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate text-sm font-medium">{c.ticketTitle}</span>
                      <span className="truncate text-xs text-muted-foreground">{c.author.name}: {c.excerpt}</span>
                    </span>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}
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
      ))}
    </div>
  );
}

/**
 * V12 9.1 — your own stand-up, phrased by the AI from facts the API gathered under your identity.
 * The availability probe is free and answers first, so a workspace with AI status writing switched
 * off simply never draws the card rather than offering a button that 403s.
 */
function StandupCard() {
  const [hours, setHours] = useState<"24" | "72" | "168">("72");
  const [subject, setSubject] = useState("me");
  const [text, setText] = useState("");
  const [emptyWindow, setEmptyWindow] = useState(false);
  const [writtenAt, setWrittenAt] = useState<Date | null>(null);
  const availability = useQuery({ queryKey: ["ai", "standup", "availability"], queryFn: () => aiApi.standupAvailability() });
  // Only fetched once the card is actually drawable — a workspace with AI status writing off has no
  // reason to be asked who its managers manage.
  const people = useQuery({
    queryKey: ["ai", "standup", "people"],
    queryFn: () => aiApi.standupPeople(),
    enabled: availability.data?.available === true
  });
  const others = (people.data ?? []).filter((p) => !p.isSelf);
  const subjectName = others.find((p) => p.id === subject)?.name ?? null;
  const write = useMutation({
    mutationFn: () => aiApi.standup(Number(hours) as 24 | 72 | 168, subject === "me" ? undefined : subject),
    onSuccess: (res) => {
      setText(res.standup);
      setEmptyWindow(res.empty);
      setWrittenAt(new Date());
    },
    onError: () => toast.error("Could not write your stand-up", { description: "Try again in a moment." })
  });

  if (!availability.data?.available) return null;

  return (
    <Card data-standup>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <div className="grid gap-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            {subjectName ? `${subjectName}'s stand-up` : "Your stand-up"}
          </CardTitle>
          <CardDescription>
            {subjectName
              ? `Written about ${subjectName} from the work you can already see — nothing else, and nothing invented.`
              : "Written from your own tickets, comments and logged hours — nothing else, and nothing invented."}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* V12 9.3: only shown to somebody who actually has a choice — the reference's
              "You can select another person", under this app's own rule about whose work you may read. */}
          {others.length > 0 && (
            <Select
              value={subject}
              onValueChange={(v) => {
                setSubject(v);
                setText("");
                setEmptyWindow(false);
                setWrittenAt(null);
              }}
            >
              <SelectTrigger className="h-[44px] w-[170px]" aria-label="Whose stand-up" data-standup-person>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Me</SelectItem>
                {others.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={hours} onValueChange={(v) => setHours(v as typeof hours)}>
            <SelectTrigger className="h-[44px] w-[150px]" aria-label="Stand-up period" data-standup-period>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24">Last 24 hours</SelectItem>
              <SelectItem value="72">Last 3 days</SelectItem>
              <SelectItem value="168">Last 7 days</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ai" size="sm" className="h-[44px]" disabled={write.isPending} onClick={() => write.mutate()} data-standup-write>
            <RefreshCw className={cn("h-3.5 w-3.5", write.isPending && "motion-safe:animate-spin")} />
            {text || emptyWindow ? "Regenerate" : "Write it"}
          </Button>
          {text && (
            <Button
              variant="outline"
              size="sm"
              className="h-[44px]"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  toast.success("Stand-up copied");
                } catch {
                  toast.error("Could not copy", { description: "Select the text and copy it by hand." });
                }
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        {emptyWindow && (
          <p className="text-sm text-muted-foreground">
            {subjectName
              ? `Nothing you can see from ${subjectName} in that window. Try a longer period.`
              : "Nothing recorded in that window — no ticket moved, no comment, no hours. Try a longer period."}
          </p>
        )}
        {text && <p className="whitespace-pre-wrap text-sm" data-standup-text>{text}</p>}
        {!text && !emptyWindow && !write.isPending && (
          <p className="text-sm text-muted-foreground">Pick a period and press Write it.</p>
        )}
        {writtenAt && !write.isPending && (
          <p className="text-xs text-muted-foreground">
            Written {writtenAt.toLocaleTimeString()}.{" "}
            {subjectName
              ? `A draft about ${subjectName}, from records — not their words.`
              : "It is a draft — read it before you send it."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

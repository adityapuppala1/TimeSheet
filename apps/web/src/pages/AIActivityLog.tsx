/**
 * AI Activity Log — every ticket an AI classifier touched (email-sourced, or a manually
 * created ticket where the operator accepted a triage suggestion), with a thumbs up/down
 * feedback control per row.
 * WHY this reads from the ticket list (`aiOnly=true` filter) instead of the AuditLog: an
 * "ai.triage_suggested" audit entry only means a suggestion was *shown*, not that a ticket
 * was actually created from it — the ticket table (aiConfidence not null, or source=EMAIL) is
 * the only reliable record of which tickets AI actually touched. Full reasoning text for a
 * given decision is still one click away, in that ticket's own Activity tab.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, ArrowUpRight, Mail, Sparkles, ThumbsDown, ThumbsUp, User as UserIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Badge, type BadgeProps } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { DataTable } from "../components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "../components/ui/toaster";
import { projectApi, ticketApi, type AiFeedbackValue, type TicketRow } from "../services/api";

const PRIORITY_VARIANT: Record<string, BadgeProps["variant"]> = {
  LOW: "muted",
  MEDIUM: "info",
  HIGH: "warning",
  CRITICAL: "destructive"
};

function serverMessage(err: any, fallback: string) {
  return err?.response?.data?.message ?? fallback;
}

export function AIActivityLog() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState("all");
  const [source, setSource] = useState("all");
  const [reviewOnly, setReviewOnly] = useState(false);

  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const tickets = useQuery({
    queryKey: ["tickets", "ai-activity", projectId, source],
    queryFn: () =>
      ticketApi.list({
        aiOnly: true,
        projectId: projectId !== "all" ? projectId : undefined,
        source: source !== "all" ? (source as "MANUAL" | "EMAIL" | "API") : undefined
      })
  });

  const rows = useMemo(() => {
    const list = tickets.data ?? [];
    return reviewOnly ? list.filter((t) => t.needsReview) : list;
  }, [tickets.data, reviewOnly]);

  const feedback = useMutation({
    mutationFn: ({ id, value }: { id: string; value: AiFeedbackValue }) => ticketApi.setAiFeedback(id, value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tickets", "ai-activity"] }),
    onError: (err: any) => toast.error("Could not save feedback", { description: serverMessage(err, "Try again.") })
  });

  function toggleFeedback(ticket: TicketRow, value: "up" | "down") {
    feedback.mutate({ id: ticket.id, value: ticket.aiFeedback === value ? null : value });
  }

  const columns = useMemo<ColumnDef<TicketRow, any>[]>(
    () => [
      { accessorKey: "key", header: "Key", cell: (info) => <span className="font-mono text-xs text-muted-foreground">{info.getValue()}</span> },
      { accessorKey: "title", header: "Title", cell: (info) => <span className="block max-w-[260px] truncate font-medium">{info.getValue()}</span> },
      {
        id: "source",
        accessorFn: (row) => row.source,
        header: "Source",
        cell: ({ row }) =>
          row.original.source === "EMAIL" ? (
            <span className="inline-flex items-center gap-1.5 text-sm">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              {row.original.externalReporterName || row.original.externalReporterEmail || "Email"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <UserIcon className="h-3.5 w-3.5" />Manual
            </span>
          )
      },
      {
        id: "typePriority",
        accessorFn: (row) => row.priority,
        header: "Type / Priority",
        cell: ({ row }) => (
          <>
            <span className="text-sm">{row.original.type}</span>{" "}
            <Badge variant={PRIORITY_VARIANT[row.original.priority]}>{row.original.priority}</Badge>
          </>
        )
      },
      {
        accessorKey: "aiConfidence",
        header: "Confidence",
        cell: (info) => {
          const value = info.getValue() as number | null;
          return value !== null ? (
            <span className="text-sm font-semibold">{Math.round(value * 100)}%</span>
          ) : (
            <span className="text-xs text-muted-foreground">n/a</span>
          );
        }
      },
      {
        id: "status",
        accessorFn: (row) => row.needsReview,
        header: "Status",
        cell: ({ row }) =>
          row.original.needsReview ? (
            <Badge variant="warning" className="gap-1"><AlertTriangle className="h-3 w-3" />Needs review</Badge>
          ) : (
            <Badge variant="success">Auto-processed</Badge>
          )
      },
      {
        id: "feedback",
        header: "Feedback",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            <Button
              variant={row.original.aiFeedback === "up" ? "default" : "ghost"}
              size="icon"
              className="h-7 w-7"
              disabled={feedback.isPending}
              onClick={() => toggleFeedback(row.original, "up")}
            >
              <ThumbsUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={row.original.aiFeedback === "down" ? "destructive" : "ghost"}
              size="icon"
              className="h-7 w-7"
              disabled={feedback.isPending}
              onClick={() => toggleFeedback(row.original, "down")}
            >
              <ThumbsDown className="h-3.5 w-3.5" />
            </Button>
          </div>
        )
      },
      {
        id: "open",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <Button variant="ghost" size="sm" onClick={() => navigate(`/app/tickets?open=${row.original.id}`)}>
            Open<ArrowUpRight className="h-3.5 w-3.5" />
          </Button>
        )
      }
    ],
    [feedback, navigate]
  );

  return (
    <div className="grid gap-5">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight">AI activity log</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every ticket an AI classifier touched — email-sourced intake or an accepted manual triage suggestion.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-full sm:w-[180px]"><SelectValue placeholder="All projects" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger className="w-full sm:w-[160px]"><SelectValue placeholder="All sources" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="EMAIL">Email intake</SelectItem>
              <SelectItem value="MANUAL">Manual (AI-assisted)</SelectItem>
            </SelectContent>
          </Select>
          <Button variant={reviewOnly ? "default" : "outline"} size="sm" onClick={() => setReviewOnly((v) => !v)}>
            <AlertTriangle className="h-3.5 w-3.5" />Needs review only
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <DataTable
            columns={columns}
            data={rows}
            isLoading={tickets.isLoading}
            searchPlaceholder="Search these results..."
            emptyMessage="No AI-touched tickets match these filters yet."
            pageSize={20}
          />
        </CardContent>
      </Card>
    </div>
  );
}

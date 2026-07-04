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
import { AlertTriangle, ArrowUpRight, Mail, Sparkles, ThumbsDown, ThumbsUp, User as UserIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, type BadgeProps } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
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

  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list });
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
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="All projects" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder="All sources" /></SelectTrigger>
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
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Type / Priority</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Feedback</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.isLoading &&
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={`skel-${i}`}>
                    {Array.from({ length: 8 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))}
              {!tickets.isLoading &&
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.key}</TableCell>
                    <TableCell className="max-w-[260px] truncate font-medium">{row.title}</TableCell>
                    <TableCell>
                      {row.source === "EMAIL" ? (
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                          {row.externalReporterName || row.externalReporterEmail || "Email"}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                          <UserIcon className="h-3.5 w-3.5" />Manual
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{row.type}</span>{" "}
                      <Badge variant={PRIORITY_VARIANT[row.priority]}>{row.priority}</Badge>
                    </TableCell>
                    <TableCell>
                      {row.aiConfidence !== null ? (
                        <span className="text-sm font-semibold">{Math.round(row.aiConfidence * 100)}%</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">n/a</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.needsReview ? (
                        <Badge variant="warning" className="gap-1"><AlertTriangle className="h-3 w-3" />Needs review</Badge>
                      ) : (
                        <Badge variant="success">Auto-processed</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant={row.aiFeedback === "up" ? "default" : "ghost"}
                          size="icon"
                          className="h-7 w-7"
                          disabled={feedback.isPending}
                          onClick={() => toggleFeedback(row, "up")}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant={row.aiFeedback === "down" ? "destructive" : "ghost"}
                          size="icon"
                          className="h-7 w-7"
                          disabled={feedback.isPending}
                          onClick={() => toggleFeedback(row, "down")}
                        >
                          <ThumbsDown className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => navigate(`/app/tickets?open=${row.id}`)}>
                        Open<ArrowUpRight className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              {!tickets.isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                    No AI-touched tickets match these filters yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

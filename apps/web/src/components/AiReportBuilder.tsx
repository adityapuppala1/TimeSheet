import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Sparkles } from "lucide-react";
import { askAiApi } from "../services/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { AiMarkdown } from "./ui/ai-markdown";
import { ToolEvidence } from "./ai/tool-evidence";

export function AiReportBuilder() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("Summarize my work and highlight overdue items and missing time.");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [group, setGroup] = useState("project");
  const queryClient = useQueryClient();
  const report = useMutation({
    mutationFn: (prompt: string) => askAiApi.ask(prompt, { readOnly: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ask-ai", "history"] })
  });
  const invalidRange = Boolean(from && to && from > to);
  const prompt = [
      "Prepare a read-only report using accessible workspace records. Do not create or update any records.",
      `Period: ${from || "start of this month"} through ${to || "today"}. Group by ${group}.`,
      "Include a summary, a data table, a chart when supported, source limitations and actionable observations. State when data is unavailable; do not invent numbers.",
      question.trim()
    ].join("\n");
  const matchesInputs = report.variables === prompt;
  const hasReport = matchesInputs && report.isSuccess && Boolean(report.data?.answer) && !report.data?.error;
  const recordedAt = new Date(report.data?.createdAt ?? "");
  const hasRecordedAt = !Number.isNaN(recordedAt.getTime());
  function generate() {
    if (invalidRange || question.trim().length < 3 || report.isPending) return;
    report.mutate(prompt);
  }
  function download() {
    if (!hasReport || !report.data?.answer) return;
    const blob = new Blob([`# Workspace report\n\n${report.variables}\n\n${report.data.answer}\n\nGenerated: ${report.data.createdAt}\nTools: ${report.data.toolCalls.map((call) => call.tool).join(", ")}\n`], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "timesphere-report.md";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>
    <Button variant="ai" onClick={() => setOpen(true)}><Sparkles className="h-4 w-4" />Build report</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90dvh] w-[95vw] max-w-4xl overflow-y-auto">
        <DialogHeader><DialogTitle>Build a report</DialogTitle><DialogDescription>Choose a period and ask a question about your workspace.</DialogDescription></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2"><Label htmlFor="report-from">From</Label><Input id="report-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="report-to">To</Label><Input id="report-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="report-group">Group by</Label><Select value={group} onValueChange={setGroup}><SelectTrigger id="report-group"><SelectValue /></SelectTrigger><SelectContent>{["project", "status", "priority", "day"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
        </div>
        <Label htmlFor="report-question">Report question</Label>
        <Textarea id="report-question" maxLength={1400} value={question} onChange={(event) => setQuestion(event.target.value)} />
        {invalidRange && <p role="alert" className="text-sm text-destructive">The end date must be on or after the start date.</p>}
        <div className="flex flex-wrap gap-2"><Button variant="ai" onClick={generate} disabled={invalidRange || question.trim().length < 3 || report.isPending}><Sparkles className="h-4 w-4" />{report.isPending ? "Generating report..." : "Generate report"}</Button>{hasReport && <Button variant="outline" onClick={download}><Download className="h-4 w-4" />Export Markdown</Button>}</div>
        {!report.isIdle && !report.isPending && !matchesInputs && <p role="status" className="text-sm text-muted-foreground">Report settings changed. Generate a report for the current settings.</p>}
        {matchesInputs && report.isError && <p role="alert" className="text-sm text-destructive">Could not generate the report. Check AI availability and try again.</p>}
        {matchesInputs && report.data?.error && <p role="alert" className="text-sm text-destructive">{report.data.error}</p>}
        {hasReport && report.data?.answer && <section className="min-w-0 overflow-x-auto border-t border-border pt-4" aria-label="Generated report">
          <dl aria-label="Report context" className="mb-4 grid gap-3 border-b border-border pb-4 text-sm sm:grid-cols-3">
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">Report recorded</dt><dd className="break-words">{hasRecordedAt ? <time dateTime={recordedAt.toISOString()}>{recordedAt.toLocaleString()}</time> : "Unavailable"}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">Requested period</dt><dd className="break-words">{from || "Start of this month"} to {to || "Today"}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">Grouped by</dt><dd className="capitalize">{group}</dd></div>
          </dl>
          <AiMarkdown content={report.data.answer} />
          <div className="mt-4"><ToolEvidence calls={report.data.toolCalls} /></div>
          <p className="mt-1 text-xs text-muted-foreground">Source-data freshness is not verified by the report timestamp.</p>
        </section>}
      </DialogContent>
    </Dialog>
  </>;
}

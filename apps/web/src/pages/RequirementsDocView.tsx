/**
 * One requirements document — the interview while it's still `DRAFTING`, then the generated
 * document once it's `READY`: sections, a rendered architecture diagram, exports, and the three
 * materialize actions (see requirements-doc.service.ts's header for why those are three separate,
 * human-reviewed steps rather than one).
 *
 * WHO renders this: `App.tsx` at `/app/requirements/:id`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import mermaid from "mermaid";
import { ArrowLeft, Archive, Download, FileDown, Loader2, SkipForward, Sparkles, Target, Ticket } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { permissions } from "@timesheet/shared";
import { AiStrands } from "../components/ui/ai-strands";
import { Badge } from "../components/ui/badge";
import { BorderGlow } from "../components/ui/border-glow";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { useAuthStore } from "../store/auth";
import { projectApi, requirementsDocApi, type RequirementsDocSuccessMetricRow, type RequirementsInterviewTurnResult } from "../services/api";

mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });

const STATUS_DESCRIPTION: Record<string, string> = { DRAFTING: "Interview in progress", READY: "Ready", ARCHIVED: "Archived" };

function formatSuccessMetric(m: RequirementsDocSuccessMetricRow): string {
  if (m.targetValue == null) return m.title;
  const unit = m.unit ? ` ${m.unit}` : "";
  return `${m.title} — target ${m.targetValue}${unit}`;
}

/** Renders Mermaid SOURCE TEXT to an inline SVG. Falls back to the raw source in a `<pre>` if the
 *  model produced something Mermaid can't parse — a document should never go blank over one bad
 *  diagram. */
function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/:/g, "-");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!source.trim()) return;
    mermaid
      .render(`mermaid-${id}`, source)
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source, id]);

  if (!source.trim()) return <p className="text-sm text-muted-foreground">No diagram generated.</p>;
  if (failed) return <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{source}</pre>;
  if (!svg) return <Skeleton className="h-40 w-full" />;
  // Mermaid's own rendered SVG output, not user/model HTML — securityLevel: "strict" above is
  // what actually guards this, the same role safeHtml() plays for AiRefine.tsx's sanitized preview.
  return <div className="overflow-x-auto rounded-md border border-border bg-white p-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function RequirementsDocViewPage() {
  const { id } = useParams<{ id: string }>();
  const docId = String(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const canWrite = Boolean(user?.permissions.includes(permissions.PLAN_WRITE));

  const doc = useQuery({ queryKey: ["requirements-docs", docId], queryFn: () => requirementsDocApi.get(docId) });

  const [answer, setAnswer] = useState("");
  const [lastTurn, setLastTurn] = useState<RequirementsInterviewTurnResult | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["requirements-docs", docId] });

  const turn = useMutation({
    mutationFn: (payload: { answer?: string; skip?: boolean }) => requirementsDocApi.interviewTurn(docId, payload),
    onSuccess: (result) => {
      setLastTurn(result);
      setAnswer("");
      invalidate();
    },
    onError: (err: any) => toast.error("The assistant didn't respond", { description: err?.response?.data?.message ?? "Try again." })
  });

  const generate = useMutation({
    mutationFn: () => requirementsDocApi.generate(docId),
    onSuccess: () => {
      toast.success("Document generated");
      invalidate();
    },
    onError: (err: any) => toast.error("Could not generate the document", { description: err?.response?.data?.message ?? "Try again." })
  });

  const archive = useMutation({
    mutationFn: () => requirementsDocApi.archive(docId),
    onSuccess: () => {
      toast.success("Archived");
      navigate("/app/requirements");
    },
    onError: (err: any) => toast.error("Could not archive", { description: err?.response?.data?.message ?? "Try again." })
  });

  // Ask for the opening question the moment a brand-new (empty-transcript) draft loads — no need
  // to make the person press a button just to see the first question.
  useEffect(() => {
    if (doc.data && doc.data.status === "DRAFTING" && doc.data.interviewTranscript.length === 0 && !turn.isPending && !lastTurn) {
      turn.mutate({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per load, not on every turn state change
  }, [doc.data?.id, doc.data?.status]);

  if (doc.isLoading || !doc.data) {
    return (
      <div className="grid gap-3 p-4 sm:p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const data = doc.data;
  const pending = data.interviewTranscript[data.interviewTranscript.length - 1];
  const hasOpenQuestion = pending && pending.answer === null && !pending.skipped;
  const interviewDone = lastTurn?.done === true;

  return (
    <div className="mx-auto grid min-w-0 max-w-4xl gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate("/app/requirements")} aria-label="Back to Requirements Studio">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{data.title}</h1>
            <p className="text-xs text-muted-foreground">
              {data.docType} · {STATUS_DESCRIPTION[data.status]}
            </p>
          </div>
        </div>
        {canWrite && data.status !== "ARCHIVED" && (
          <Button variant="ghost" size="sm" onClick={() => archive.mutate()} disabled={archive.isPending}>
            <Archive className="mr-2 h-3.5 w-3.5" />
            Archive
          </Button>
        )}
      </div>

      {data.status === "DRAFTING" && (
        <InterviewPanel
          data={data}
          answer={answer}
          setAnswer={setAnswer}
          hasOpenQuestion={Boolean(hasOpenQuestion)}
          pendingQuestion={hasOpenQuestion ? pending : null}
          lastTurn={lastTurn}
          turnPending={turn.isPending}
          onAnswer={(a) => turn.mutate({ answer: a })}
          onSkip={() => turn.mutate({ skip: true })}
          onGenerate={() => generate.mutate()}
          generatePending={generate.isPending}
          canWrite={canWrite}
          interviewDone={interviewDone}
        />
      )}

      {data.sections && <DocumentViewer docId={docId} title={data.title} sections={data.sections} canWrite={canWrite} />}
    </div>
  );
}

function InterviewPanel({
  data,
  answer,
  setAnswer,
  hasOpenQuestion,
  pendingQuestion,
  lastTurn,
  turnPending,
  onAnswer,
  onSkip,
  onGenerate,
  generatePending,
  canWrite,
  interviewDone
}: {
  data: ReturnType<typeof requirementsDocApi.get> extends Promise<infer T> ? T : never;
  answer: string;
  setAnswer: (v: string) => void;
  hasOpenQuestion: boolean;
  pendingQuestion: { question: string; sectionTag: string | null } | null;
  lastTurn: RequirementsInterviewTurnResult | null;
  turnPending: boolean;
  onAnswer: (answer: string) => void;
  onSkip: () => void;
  onGenerate: () => void;
  generatePending: boolean;
  canWrite: boolean;
  interviewDone: boolean;
}) {
  const answered = data.interviewTranscript.filter((t) => t.answer !== null || t.skipped);
  const busy = turnPending || generatePending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          Interview
        </CardTitle>
        {lastTurn?.progress && (
          <CardDescription>
            {lastTurn.progress.section} — {lastTurn.progress.answered}/{lastTurn.progress.total} areas covered
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        {/* The BorderGlow frame is the app-wide "this surface talks to the model" marker — same
            treatment PlanBreakdownDialog gives its own goal form. Re-keyed per turn so the sweep
            plays again each time a fresh question lands, not just once on mount. */}
        <BorderGlow key={data.interviewTranscript.length} animated={!busy}>
          <div className="grid gap-4 p-3">
            {answered.length > 0 && (
              <div className="grid gap-3 border-b border-border pb-4">
                {answered.map((t, i) => (
                  <div key={i} className="text-sm">
                    <p className="font-medium">{t.question}</p>
                    <p className="text-muted-foreground">{t.skipped ? "(skipped — the assistant will assume)" : t.answer}</p>
                  </div>
                ))}
              </div>
            )}

            {turnPending && (
              <AiStrands label={hasOpenQuestion ? "Reading your answer and thinking of the next question…" : "Thinking of the opening question…"} />
            )}

            {hasOpenQuestion && pendingQuestion && !turnPending && (
              <div className="grid gap-3">
                <p className="text-sm font-medium">{pendingQuestion.question}</p>
                {lastTurn?.quickReplies && lastTurn.quickReplies.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {lastTurn.quickReplies.map((reply) => (
                      <Button key={reply} type="button" variant="outline" size="sm" disabled={!canWrite} onClick={() => onAnswer(reply)}>
                        {reply}
                      </Button>
                    ))}
                  </div>
                )}
                <Textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Type your answer…"
                  rows={2}
                  maxLength={4000}
                  disabled={!canWrite}
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="ai" size="sm" disabled={!canWrite || answer.trim().length === 0} onClick={() => onAnswer(answer.trim())}>
                    <Sparkles className="mr-2 h-3.5 w-3.5" />
                    Answer
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!canWrite} onClick={onSkip}>
                    <SkipForward className="mr-2 h-3.5 w-3.5" />
                    Skip — make your best assumption
                  </Button>
                </div>
              </div>
            )}

            {generatePending && <AiStrands label="Writing the document from your answers…" />}

            {(interviewDone || answered.length > 0) && canWrite && !generatePending && (
              <div className="border-t border-border pt-4">
                <Button variant="ai" onClick={onGenerate} disabled={busy}>
                  <Sparkles className="mr-2 h-3.5 w-3.5" />
                  Generate document
                </Button>
                {!interviewDone && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    The interview isn't finished — generating now fills any gaps as stated assumptions instead of asking more questions.
                  </p>
                )}
              </div>
            )}
          </div>
        </BorderGlow>
      </CardContent>
    </Card>
  );
}

const SECTION_ORDER: Array<{ key: string; label: string }> = [
  { key: "problem", label: "Problem" },
  { key: "goals", label: "Goals" },
  { key: "targetUsers", label: "Target users" },
  { key: "scope", label: "Scope" },
  { key: "features", label: "Features" },
  { key: "techStack", label: "Tech stack" },
  { key: "dependencies", label: "Dependencies" },
  { key: "uiUx", label: "UI/UX" },
  { key: "architecture", label: "Architecture" },
  { key: "modules", label: "Modules" },
  { key: "nfr", label: "Non-functional requirements" },
  { key: "timeline", label: "Timeline" },
  { key: "procedures", label: "Procedures" },
  { key: "risks", label: "Risks" },
  { key: "successMetrics", label: "Success metrics" },
  { key: "assumptions", label: "Assumptions" }
];

function DocumentViewer({
  docId,
  title,
  sections,
  canWrite
}: {
  docId: string;
  title: string;
  sections: NonNullable<ReturnType<typeof requirementsDocApi.get> extends Promise<infer T> ? T : never>["sections"];
  canWrite: boolean;
}) {
  const s = sections!;
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "md" | null>(null);

  const exportFile = async (kind: "pdf" | "md") => {
    setExporting(kind);
    try {
      const blob = kind === "pdf" ? await requirementsDocApi.downloadPdf(docId) : await requirementsDocApi.downloadMarkdown(docId);
      downloadBlob(blob, `${title.replace(/[^\w -]/g, "") || "requirements"}.${kind}`);
    } catch (err: any) {
      toast.error("Export failed", { description: err?.response?.data?.message ?? "Try again." });
    } finally {
      setExporting(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Document</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={exporting !== null} onClick={() => exportFile("pdf")}>
              {exporting === "pdf" ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <FileDown className="mr-2 h-3.5 w-3.5" />}
              Export PDF
            </Button>
            <Button size="sm" variant="outline" disabled={exporting !== null} onClick={() => exportFile("md")}>
              {exporting === "md" ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-2 h-3.5 w-3.5" />}
              Export Markdown
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6">
          {canWrite && (
            <div className="flex flex-wrap gap-2 rounded-lg border border-primary/30 bg-primary/[0.03] p-3">
              <CreateProjectButton title={title} problem={s.problem} />
              <Button size="sm" variant="outline" onClick={() => setTicketsOpen(true)}>
                <Ticket className="mr-2 h-3.5 w-3.5" />
                Propose tickets
              </Button>
              <Button size="sm" variant="outline" onClick={() => setGoalsOpen(true)}>
                <Target className="mr-2 h-3.5 w-3.5" />
                Create goals
              </Button>
            </div>
          )}

          {/* This whole panel is the model's own output — the same "where AI's answer is shown"
              frame the interview form above wears while it's asking. */}
          <BorderGlow animated>
            <div className="grid gap-6 p-3">
              {SECTION_ORDER.map(({ key, label }) => (
                <div key={key}>
                  <h3 className="mb-2 text-sm font-semibold">{label}</h3>
                  {renderSection(key, s)}
                </div>
              ))}
            </div>
          </BorderGlow>
        </CardContent>
      </Card>

      {ticketsOpen && <MaterializeTicketsDialog docId={docId} onClose={() => setTicketsOpen(false)} />}
      {goalsOpen && <MaterializeGoalsDialog docId={docId} metrics={s.successMetrics} onClose={() => setGoalsOpen(false)} />}
    </>
  );
}

function renderSection(key: string, s: NonNullable<ReturnType<typeof requirementsDocApi.get> extends Promise<infer T> ? T : never>["sections"]) {
  const sec = s!;
  switch (key) {
    case "problem":
      return <p className="text-sm text-muted-foreground">{sec.problem || "—"}</p>;
    case "goals":
      return <p className="text-sm text-muted-foreground">{sec.goals || "—"}</p>;
    case "targetUsers":
      return <p className="text-sm text-muted-foreground">{sec.targetUsers || "—"}</p>;
    case "scope":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">In scope</p>
            <BulletList items={sec.scopeIn} />
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Out of scope</p>
            <BulletList items={sec.scopeOut} />
          </div>
        </div>
      );
    case "features":
      return (
        <div className="grid gap-2">
          {sec.features.map((f, i) => (
            <div key={i} className="rounded-md border border-border p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{f.title}</span>
                <Badge variant="outline" className="text-xs">
                  {f.priority}
                </Badge>
                {f.moduleName && (
                  <Badge variant="secondary" className="text-xs">
                    {f.moduleName}
                  </Badge>
                )}
                {f.estimatedHours != null && <span className="text-xs text-muted-foreground">~{f.estimatedHours}h</span>}
              </div>
              {f.description && <p className="mt-1 text-xs text-muted-foreground">{f.description}</p>}
            </div>
          ))}
        </div>
      );
    case "techStack":
      return <BulletList items={sec.techStack} />;
    case "dependencies":
      return <BulletList items={sec.dependencies} />;
    case "uiUx":
      return <p className="text-sm text-muted-foreground">{sec.uiUx || "—"}</p>;
    case "architecture":
      return (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">{sec.architecture.description || "—"}</p>
          <MermaidDiagram source={sec.architecture.diagramMermaid} />
        </div>
      );
    case "modules":
      return (
        <div className="grid gap-1.5">
          {sec.modules.map((m, i) => (
            <div key={i} className="text-sm">
              <span className="font-medium">{m.name}</span>
              {m.description && <span className="text-muted-foreground"> — {m.description}</span>}
            </div>
          ))}
        </div>
      );
    case "nfr":
      return (
        <BulletList
          items={[
            sec.nfr.performance ? `Performance: ${sec.nfr.performance}` : null,
            sec.nfr.security ? `Security: ${sec.nfr.security}` : null,
            sec.nfr.compliance ? `Compliance: ${sec.nfr.compliance}` : null,
            sec.nfr.scalability ? `Scalability: ${sec.nfr.scalability}` : null
          ].filter((v): v is string => Boolean(v))}
        />
      );
    case "timeline":
      return (
        <div className="grid gap-1.5">
          {sec.timeline.map((t, i) => (
            <div key={i} className="text-sm">
              {t.isMilestone && "🎯 "}
              <span className="font-medium">{t.label}</span>
              <span className="text-muted-foreground"> — {t.description}</span>
            </div>
          ))}
        </div>
      );
    case "procedures":
      return <BulletList items={sec.procedures} />;
    case "risks":
      return <BulletList items={sec.risks} />;
    case "successMetrics":
      return (
        <BulletList items={sec.successMetrics.map(formatSuccessMetric)} />
      );
    case "assumptions":
      return <BulletList items={sec.assumptions} />;
    default:
      return null;
  }
}

function BulletList({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <ul className="grid gap-1 text-sm text-muted-foreground">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden>•</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function CreateProjectButton({ title, problem }: { title: string; problem: string }) {
  const navigate = useNavigate();
  return (
    <Button
      size="sm"
      onClick={() =>
        navigate("/app/projects", { state: { prefillProject: { name: title, description: problem.slice(0, 500) } } })
      }
    >
      Create project from this document
    </Button>
  );
}

function MaterializeTicketsDialog({ docId, onClose }: { docId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ["projects", "picker"], queryFn: () => projectApi.list() });
  const [projectId, setProjectId] = useState("");

  const materialize = useMutation({
    mutationFn: () => requirementsDocApi.materializeTickets(docId, { projectId }),
    onSuccess: (proposal) => {
      toast.success("Tickets proposed", { description: "Review and accept them in Proposals." });
      onClose();
      navigate(`/app/proposals?id=${proposal.id}`);
    },
    onError: (err: any) => toast.error("Could not propose tickets", { description: err?.response?.data?.message ?? "Try again." })
  });

  const items: Array<{ id: string; name: string }> = projects.data?.items ?? projects.data ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Propose tickets</DialogTitle>
          <DialogDescription>
            Every feature becomes a draft ticket you review and accept individually in Proposals — nothing is created until then.
          </DialogDescription>
        </DialogHeader>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger>
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent>
            {items.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!projectId || materialize.isPending} onClick={() => materialize.mutate()}>
            {materialize.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Propose
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MaterializeGoalsDialog({ docId, metrics, onClose }: { docId: string; metrics: RequirementsDocSuccessMetricRow[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects", "picker"], queryFn: () => projectApi.list() });
  const [projectId, setProjectId] = useState("");

  const materialize = useMutation({
    mutationFn: () =>
      requirementsDocApi.materializeGoals(docId, {
        projectId: projectId || undefined,
        items: metrics.map((m) => ({ title: m.title, description: m.description, targetValue: m.targetValue, unit: m.unit }))
      }),
    onSuccess: (result) => {
      toast.success(`${result.created.length} goal${result.created.length === 1 ? "" : "s"} created`);
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      onClose();
    },
    onError: (err: any) => toast.error("Could not create goals", { description: err?.response?.data?.message ?? "Try again." })
  });

  const items: Array<{ id: string; name: string }> = projects.data?.items ?? projects.data ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create goals</DialogTitle>
          <DialogDescription>These success metrics become goals immediately — review the list before confirming.</DialogDescription>
        </DialogHeader>
        {metrics.length === 0 ? (
          <p className="text-sm text-muted-foreground">This document has no success metrics.</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {metrics.map((m, i) => (
              <li key={i}>{formatSuccessMetric(m)}</li>
            ))}
          </ul>
        )}
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger>
            <SelectValue placeholder="Link to a project (optional)" />
          </SelectTrigger>
          <SelectContent>
            {items.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={metrics.length === 0 || materialize.isPending} onClick={() => materialize.mutate()}>
            {materialize.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Create goals
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

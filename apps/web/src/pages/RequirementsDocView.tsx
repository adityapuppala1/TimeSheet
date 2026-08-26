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
import { ArrowLeft, Archive, Download, Eye, FileDown, FileUp, Loader2, PenLine, RefreshCw, SkipForward, Sparkles, Target, Ticket, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { permissions } from "@timesheet/shared";
import { ImportReviewPanel, SectionTagBadge } from "../components/requirements/ImportReviewPanel";
import { AiStrands } from "../components/ui/ai-strands";
import { Badge } from "../components/ui/badge";
import { BorderGlow } from "../components/ui/border-glow";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { FileDropzone } from "../components/ui/file-dropzone";
import { Progress } from "../components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { useAuthStore } from "../store/auth";
import { useIndeterminateProgress } from "./RequirementsStudio";
import {
  projectApi,
  requirementsDocApi,
  type RequirementsDocRow,
  type RequirementsDocSectionsRow,
  type RequirementsDocSuccessMetricRow,
  type RequirementsImportProposedTurnRow,
  type RequirementsInterviewTurnResult
} from "../services/api";

const IMPORT_ACCEPT = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/plain": [".txt"]
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// suppressErrorRendering: without it, a parse failure makes mermaid append its own "bomb" error
// graphic straight to document.body (outside our component tree) *in addition to* rejecting the
// render() promise below — so our try/catch fallback rendered fine, but the bomb graphic stayed
// stuck in the corner of the page regardless. This stops mermaid from touching the DOM on error at all.
//
// flowchart.htmlLabels: false is load-bearing for the PDF export, not a style choice. Mermaid's
// default emits node labels inside <foreignObject>, which a <canvas> refuses to rasterise — the
// diagram would silently come out blank or label-less in the exported PDF. Plain <text> nodes
// rasterise correctly. See svgToPng below.
mermaid.initialize({
  startOnLoad: false,
  theme: "neutral",
  securityLevel: "strict",
  suppressErrorRendering: true,
  flowchart: { htmlLabels: false }
});

/**
 * Rasterises a rendered Mermaid SVG to a base64 PNG so the server can embed it in the PDF —
 * PDFKit has no Mermaid renderer, and the browser has already done the work.
 *
 * Returns null on any failure rather than throwing: a missing diagram picture degrades the export
 * to the Mermaid source block, which is exactly what the PDF service falls back to. Losing the
 * whole export over a diagram would be the wrong trade.
 */
async function svgToPng(svg: string, scale = 2): Promise<string | null> {
  try {
    const sized = /<svg[^>]*\swidth="/.test(svg) ? svg : svg.replace("<svg", '<svg width="900"');
    const blobUrl = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("svg failed to load"));
        img.src = blobUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = (image.naturalWidth || 900) * scale;
      canvas.height = (image.naturalHeight || 400) * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // Mermaid SVGs are transparent; without this the diagram lands as dark-on-dark in the PDF.
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch {
    return null;
  }
}

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

      {/* Every status, not just DRAFTING — "where did this come from, and who uploaded it" stays a
          real question after the document is generated, which is exactly when people ask it. */}
      {data.status !== "ARCHIVED" && <SourceDocumentCard doc={data} canWrite={canWrite} onChanged={invalidate} />}

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

      {data.sections && (
        <DocumentViewer
          docId={docId}
          title={data.title}
          sections={data.sections}
          canWrite={canWrite}
          onRegenerate={() => generate.mutate()}
          regenerating={generate.isPending}
        />
      )}
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
                    <div className="flex flex-wrap items-baseline gap-2">
                      <p className="font-medium">{t.question}</p>
                      <SectionTagBadge tag={t.sectionTag} className="text-[10px] font-normal" />
                    </div>
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
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="text-sm font-medium">{pendingQuestion.question}</p>
                  <SectionTagBadge tag={pendingQuestion.sectionTag} className="text-[10px] font-normal" />
                </div>
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

/** The dialog's review half — shared review panel plus the confirm/cancel framing around it. The
 *  confirm button changes wording when there are answers to lose, since that's the moment worth
 *  being explicit about. */
function ImportReviewStep({
  rows,
  openQuestions,
  summary,
  truncated,
  hasAnswers,
  reopensInterview,
  applying,
  onChangeAnswer,
  onRemoveRow,
  onCancel,
  onConfirm
}: {
  rows: RequirementsImportProposedTurnRow[];
  openQuestions: string[];
  summary: string | null;
  truncated: boolean;
  hasAnswers: boolean;
  /** True on an already-generated document: confirming makes the generated document stale, so the
   *  interview reopens and it has to be generated again. Said before confirming, never after. */
  reopensInterview: boolean;
  applying: boolean;
  onChangeAnswer: (index: number, answer: string) => void;
  onRemoveRow: (index: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  let description = "Edit or remove anything before it's saved — only what you confirm here becomes an answered interview question.";
  if (reopensInterview) {
    description =
      "Confirming REPLACES every existing answer AND reopens the interview — the document you already generated will need generating again.";
  } else if (hasAnswers) {
    description = "Confirming REPLACES every existing answer on this document with these. Edit or remove anything first.";
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Review what we found</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <ImportReviewPanel
        rows={rows}
        openQuestions={openQuestions}
        summary={summary}
        truncated={truncated}
        onChangeAnswer={onChangeAnswer}
        onRemoveRow={onRemoveRow}
      />

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="ai" disabled={rows.length === 0 || applying} onClick={onConfirm}>
          {applying ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
          {hasAnswers ? "Replace my answers" : "Confirm"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The dialog's pick-a-file half, which doubles as the "reading it" state — a regenerate skips
 *  straight to that state, since it has no file to pick. */
function FilePickerStep({
  title,
  mode,
  analyzing,
  progress,
  file,
  onFileChange,
  onCancel,
  onAnalyze,
  analyzePending
}: {
  title: string;
  mode: "upload" | "regenerate";
  analyzing: boolean;
  progress: number;
  file: File | null;
  onFileChange: (file: File | null) => void;
  onCancel: () => void;
  onAnalyze: () => void;
  analyzePending: boolean;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {mode === "upload"
            ? "The AI reads it and proposes answers — you review everything before anything is saved."
            : "Re-reading the document already attached to this project. Nothing is saved until you confirm."}
        </DialogDescription>
      </DialogHeader>

      {analyzing ? (
        <div className="grid gap-2 py-2">
          <AiStrands label="Reading your document and matching it to the interview…" />
          <Progress value={progress} className="h-1.5" />
        </div>
      ) : (
        <>
          <FileDropzone
            files={file ? [file] : []}
            onChange={(files) => onFileChange(files[0] ?? null)}
            maxFiles={1}
            maxSizeMb={15}
            accept={IMPORT_ACCEPT}
            hint="PDF, Word (.docx), or plain text · 15 MB max"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button disabled={!file || analyzePending} onClick={onAnalyze}>
              <Sparkles className="mr-2 h-3.5 w-3.5" />
              Analyze document
            </Button>
          </DialogFooter>
        </>
      )}
    </>
  );
}

/** The card's identity line — the uploaded file's details, or a plain statement that there wasn't
 *  one. Split out so SourceDocumentCard below stays about the ACTIONS. */
function SourceDocumentSummary({ doc }: { doc: RequirementsDocRow }) {
  if (!doc.sourceDocumentName) {
    return (
      <>
        <p className="text-sm font-medium">Created manually</p>
        <p className="text-xs text-muted-foreground">Built from the interview alone — no document was uploaded.</p>
      </>
    );
  }
  const size = doc.sourceDocumentSize != null ? `${formatBytes(doc.sourceDocumentSize)} · ` : "";
  const uploadedOn = doc.sourceDocumentUploadedAt ? ` on ${new Date(doc.sourceDocumentUploadedAt).toLocaleDateString()}` : "";
  return (
    <>
      <p className="truncate text-sm font-medium">{doc.sourceDocumentName}</p>
      <p className="truncate text-xs text-muted-foreground">
        {size}Uploaded by {doc.sourceDocumentUploadedBy?.name ?? "someone since removed"}
        {uploadedOn}
      </p>
    </>
  );
}

/**
 * Where this document's answers came from — an uploaded PRD/BRD, or the interview alone. Rendered
 * at EVERY non-archived status, not just while drafting: "who uploaded this, and when" is a
 * question people ask most often AFTER the document is finished, and hiding it then was a real bug.
 *
 * Re-upload and Regenerate both REPLACE every existing answer (the backend does a full transcript
 * replace, never a merge), so both go through the same review screen a first import does, and the
 * confirm button says so when there is something to lose — including, on a finished document, that
 * confirming reopens the interview.
 */
function SourceDocumentCard({ doc, canWrite, onChanged }: { doc: RequirementsDocRow; canWrite: boolean; onChanged: () => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [mode, setMode] = useState<"upload" | "regenerate">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<"picking" | "analyzing" | "reviewing" | "applying">("picking");
  const [rows, setRows] = useState<RequirementsImportProposedTurnRow[]>([]);
  const [openQuestions, setOpenQuestions] = useState<string[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [documentText, setDocumentText] = useState<string | null>(null);
  const progress = useIndeterminateProgress(stage === "analyzing");

  const hasSource = Boolean(doc.sourceDocumentName);
  const hasAnswers = doc.interviewTranscript.some((t) => t.answer !== null || t.skipped);
  const isReady = doc.status === "READY";

  // Only fetched when the viewer is actually opened — the extracted text of a long PRD is a lot to
  // ship with every page load of a document nobody is inspecting.
  const sourceText = useQuery({
    queryKey: ["requirements-docs", doc.id, "source-text"],
    queryFn: () => requirementsDocApi.sourceText(doc.id),
    enabled: viewerOpen
  });
  let pickerTitle = "Regenerate from the document";
  if (mode === "upload") pickerTitle = hasSource ? "Replace the supporting document" : "Upload a supporting document";

  function closeDialog() {
    setDialogOpen(false);
    setFile(null);
    setStage("picking");
    setRows([]);
    setOpenQuestions([]);
    setSummary(null);
    setTruncated(false);
    setDocumentText(null);
  }

  function receiveAnalysis(result: { proposedTurns: RequirementsImportProposedTurnRow[]; openQuestions: string[]; documentSummary: string; truncated: boolean; documentText?: string }) {
    setRows(result.proposedTurns);
    setOpenQuestions(result.openQuestions);
    setSummary(result.documentSummary);
    setTruncated(result.truncated);
    setDocumentText(result.documentText ?? null);
    setStage("reviewing");
  }

  const analyze = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("No file selected");
      setStage("analyzing");
      return requirementsDocApi.importAnalyze(doc.id, file);
    },
    onSuccess: receiveAnalysis,
    onError: (err: any) => {
      setStage("picking");
      toast.error("Could not read that document", { description: err?.response?.data?.message ?? "Try a different file." });
    }
  });

  const regenerate = useMutation({
    mutationFn: async () => {
      setMode("regenerate");
      setDialogOpen(true);
      setStage("analyzing");
      return requirementsDocApi.importRegenerate(doc.id);
    },
    onSuccess: receiveAnalysis,
    onError: (err: any) => {
      closeDialog();
      toast.error("Could not regenerate", { description: err?.response?.data?.message ?? "Try again." });
    }
  });

  const apply = useMutation({
    mutationFn: async () => {
      setStage("applying");
      await requirementsDocApi.importApply(doc.id, {
        turns: rows.map(({ question, answer, sectionTag }) => ({ question, answer, sectionTag })),
        // Only a real upload re-stamps the provenance — a regenerate ran against the stored text,
        // so who uploaded it and when are unchanged.
        ...(mode === "upload" && file && documentText
          ? { sourceDocument: { fileName: file.name, fileSize: file.size, text: documentText } }
          : {})
      });
      await requirementsDocApi.interviewTurn(doc.id, {});
    },
    onSuccess: () => {
      toast.success(mode === "upload" ? "Document replaced" : "Answers regenerated");
      closeDialog();
      onChanged();
    },
    onError: (err: any) => {
      setStage("reviewing");
      toast.error("Could not save those answers", { description: err?.response?.data?.message ?? "Try again." });
    }
  });

  const clearSource = useMutation({
    mutationFn: () => requirementsDocApi.importClearSource(doc.id),
    onSuccess: () => {
      toast.success("Supporting document removed", { description: "Your answers were kept." });
      onChanged();
    },
    onError: (err: any) => toast.error("Could not remove it", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <>
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              {hasSource ? <FileUp className="h-4 w-4" /> : <PenLine className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <SourceDocumentSummary doc={doc} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Viewing is read-only, so it needs no write permission and no particular status. */}
            {hasSource && (
              <Button variant="outline" size="sm" onClick={() => setViewerOpen(true)}>
                <Eye className="mr-2 h-3.5 w-3.5" />
                View
              </Button>
            )}
            {canWrite && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMode("upload");
                    setDialogOpen(true);
                  }}
                >
                  <FileUp className="mr-2 h-3.5 w-3.5" />
                  {hasSource ? "Re-upload" : "Upload a document"}
                </Button>
                {hasSource && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
                      <RefreshCw className="mr-2 h-3.5 w-3.5" />
                      Regenerate answers
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={clearSource.isPending}
                      onClick={() => {
                        if (window.confirm("Remove the link to this document? Your answers are kept — only the file details are forgotten.")) {
                          clearSource.mutate();
                        }
                      }}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate">{doc.sourceDocumentName}</DialogTitle>
            <DialogDescription>
              The text the AI read from this file. Formatting, images and layout aren&rsquo;t shown — the original file
              itself isn&rsquo;t stored, only the text extracted from it.
            </DialogDescription>
          </DialogHeader>
          {sourceText.isLoading && <Skeleton className="h-64 w-full" />}
          {sourceText.data && (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
              {sourceText.data.text}
            </pre>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setViewerOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className={stage === "reviewing" ? "sm:max-w-xl" : undefined}>
          {stage === "reviewing" ? (
            <ImportReviewStep
              rows={rows}
              openQuestions={openQuestions}
              summary={summary}
              truncated={truncated}
              hasAnswers={hasAnswers}
              reopensInterview={isReady}
              applying={apply.isPending}
              onChangeAnswer={(index, answer) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, answer } : r)))}
              onRemoveRow={(index) => setRows((prev) => prev.filter((_, i) => i !== index))}
              onCancel={closeDialog}
              onConfirm={() => apply.mutate()}
            />
          ) : (
            <FilePickerStep
              title={pickerTitle}
              mode={mode}
              analyzing={stage === "analyzing"}
              progress={progress}
              file={file}
              onFileChange={setFile}
              onCancel={closeDialog}
              onAnalyze={() => analyze.mutate()}
              analyzePending={analyze.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Document order, following the shape an industry PRD/BRD is expected in: summary first for the
 *  reader who stops there, then the business framing, then the implementable detail, then the
 *  caveats. Sections marked `optional` were added after the first release — a document generated
 *  before them simply has no such key, and its heading is skipped rather than rendered empty. */
const SECTION_ORDER: Array<{ key: string; label: string; optional?: boolean }> = [
  { key: "executiveSummary", label: "Executive summary", optional: true },
  { key: "problem", label: "Problem" },
  { key: "goals", label: "Goals" },
  { key: "targetUsers", label: "Target users" },
  { key: "personas", label: "User personas", optional: true },
  { key: "stakeholders", label: "Stakeholders (RACI)", optional: true },
  { key: "scope", label: "Scope" },
  { key: "features", label: "Features" },
  { key: "functionalRequirements", label: "Functional requirements", optional: true },
  { key: "techStack", label: "Tech stack" },
  { key: "dependencies", label: "Dependencies" },
  { key: "constraints", label: "Constraints", optional: true },
  { key: "uiUx", label: "UI/UX" },
  { key: "architecture", label: "Architecture" },
  { key: "modules", label: "Modules" },
  { key: "nfr", label: "Non-functional requirements" },
  { key: "timeline", label: "Timeline" },
  { key: "procedures", label: "Procedures" },
  { key: "costBenefit", label: "Cost & benefit", optional: true },
  { key: "risks", label: "Risks" },
  { key: "successMetrics", label: "Success metrics" },
  { key: "openQuestions", label: "Open questions", optional: true },
  { key: "assumptions", label: "Assumptions" }
];

/** True when an optional section has nothing worth a heading. Legacy documents have `undefined`
 *  for every one of these; a freshly generated one may still legitimately have an empty list. */
function hasOptionalSection(key: string, s: RequirementsDocSectionsRow): boolean {
  switch (key) {
    case "executiveSummary":
      return Boolean(s.executiveSummary?.trim());
    case "personas":
      return (s.personas?.length ?? 0) > 0;
    case "stakeholders":
      return (s.stakeholders?.length ?? 0) > 0;
    case "constraints":
      return (s.constraints?.length ?? 0) > 0;
    case "functionalRequirements":
      return (s.functionalRequirements?.length ?? 0) > 0;
    case "costBenefit":
      return Boolean(s.costBenefit?.costs?.trim() || s.costBenefit?.benefits?.trim());
    case "openQuestions":
      return (s.openQuestions?.length ?? 0) > 0;
    default:
      return true;
  }
}

const RACI_LABEL: Record<string, string> = {
  R: "Responsible",
  A: "Accountable",
  C: "Consulted",
  I: "Informed"
};

function DocumentViewer({
  docId,
  title,
  sections,
  canWrite,
  onRegenerate,
  regenerating
}: {
  docId: string;
  title: string;
  sections: NonNullable<ReturnType<typeof requirementsDocApi.get> extends Promise<infer T> ? T : never>["sections"];
  canWrite: boolean;
  /** Re-runs generation from the CURRENT transcript — distinct from the source card's "regenerate
   *  answers", which re-reads the uploaded file. Both are things people call "regenerate", so both
   *  exist and are labelled for what they actually do. */
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const s = sections!;
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "md" | null>(null);

  const exportFile = async (kind: "pdf" | "md") => {
    setExporting(kind);
    try {
      let blob: Blob;
      if (kind === "pdf") {
        // Render the diagram here rather than reading it out of the on-screen component: this
        // works whether or not that section is mounted/visible, and keeps the picture-for-the-PDF
        // concern in the place that needs it. Any failure just means no picture — the server
        // falls back to the Mermaid source, so the export still succeeds.
        let diagramPng: string | null = null;
        const source = s.architecture?.diagramMermaid;
        if (source?.trim()) {
          try {
            const { svg } = await mermaid.render(`pdf-diagram-${Date.now()}`, source);
            diagramPng = await svgToPng(svg);
          } catch {
            diagramPng = null;
          }
        }
        blob = await requirementsDocApi.downloadPdf(docId, diagramPng);
      } else {
        blob = await requirementsDocApi.downloadMarkdown(docId);
      }
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
            {canWrite && (
              <Button
                size="sm"
                variant="outline"
                disabled={regenerating}
                onClick={() => {
                  if (window.confirm("Rewrite this document from the current interview answers? The existing text is replaced.")) {
                    onRegenerate();
                  }
                }}
              >
                {regenerating ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Regenerate document
              </Button>
            )}
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
              {SECTION_ORDER.filter(({ key, optional }) => !optional || hasOptionalSection(key, s)).map(({ key, label }) => (
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
    case "executiveSummary":
      return <p className="text-sm text-muted-foreground">{sec.executiveSummary || "—"}</p>;
    case "personas":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {(sec.personas ?? []).map((p, i) => (
            <div key={i} className="rounded-md border border-border p-2.5">
              <p className="text-sm font-medium">{p.name}</p>
              <p className="text-xs text-muted-foreground">{p.role}</p>
              <p className="mt-1.5 text-xs">
                <span className="font-medium">Needs: </span>
                <span className="text-muted-foreground">{p.needs}</span>
              </p>
              <p className="text-xs">
                <span className="font-medium">Pain points: </span>
                <span className="text-muted-foreground">{p.painPoints}</span>
              </p>
            </div>
          ))}
        </div>
      );
    case "stakeholders":
      return (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-1.5 pr-3 font-medium">Name</th>
                <th className="pb-1.5 pr-3 font-medium">Role</th>
                <th className="pb-1.5 font-medium">RACI</th>
              </tr>
            </thead>
            <tbody>
              {(sec.stakeholders ?? []).map((st, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pr-3">{st.name}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{st.role}</td>
                  <td className="py-1.5">
                    <Badge variant={st.raci === "A" ? "default" : "outline"} className="text-xs">
                      {st.raci} · {RACI_LABEL[st.raci] ?? st.raci}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "functionalRequirements":
      return (
        <div className="grid gap-2">
          {(sec.functionalRequirements ?? []).map((fr) => (
            <div key={fr.id} className="rounded-md border border-border p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="font-mono text-xs">
                  {fr.id}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {fr.priority}
                </Badge>
              </div>
              <p className="mt-1.5 text-sm">{fr.requirement}</p>
              <p className="mt-1 text-xs">
                <span className="font-medium">Accepted when: </span>
                <span className="text-muted-foreground">{fr.acceptanceCriteria}</span>
              </p>
            </div>
          ))}
        </div>
      );
    case "constraints":
      return <BulletList items={sec.constraints ?? []} />;
    case "costBenefit":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Costs</p>
            <p className="text-sm text-muted-foreground">{sec.costBenefit?.costs || "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Benefits</p>
            <p className="text-sm text-muted-foreground">{sec.costBenefit?.benefits || "—"}</p>
          </div>
          {sec.costBenefit?.notes && <p className="text-xs text-muted-foreground sm:col-span-2">{sec.costBenefit.notes}</p>}
        </div>
      );
    case "openQuestions":
      return <BulletList items={sec.openQuestions ?? []} />;
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

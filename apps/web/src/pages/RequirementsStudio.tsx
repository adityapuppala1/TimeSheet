/**
 * The Requirements Studio list — every PRD/BRD an AI-guided interview has started, and where a
 * new one begins. The interview and generated document live on their own page
 * (`RequirementsDocView.tsx`, at `/app/requirements/:id`); this page is just the index and the
 * "New document" entry point, same split `Blueprints.tsx` draws between its list and its preview.
 *
 * WHO renders this: `App.tsx` at `/app/requirements`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, FileUp, Loader2, Plus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { permissions } from "@timesheet/shared";
import { ImportReviewPanel } from "../components/requirements/ImportReviewPanel";
import { AiStrands } from "../components/ui/ai-strands";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { FileDropzone } from "../components/ui/file-dropzone";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Progress } from "../components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toaster";
import { useAuthStore } from "../store/auth";
import { requirementsDocApi, type RequirementsDocRow, type RequirementsImportProposedTurnRow } from "../services/api";

const IMPORT_ACCEPT = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/plain": [".txt"]
};

type ImportStage = "idle" | "analyzing" | "reviewing" | "applying";

/**
 * Eases toward `ceiling` while `active`, never reaching it — one request/response, so there is no
 * real progress to report, and a bar that sits at 100% while still working reads as broken. The
 * decreasing step is what makes it feel like it's still going without ever promising a finish.
 */
export function useIndeterminateProgress(active: boolean, ceiling = 92) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!active) {
      setValue(0);
      return;
    }
    const timer = window.setInterval(() => {
      setValue((current) => (current >= ceiling ? current : current + Math.max(1, (ceiling - current) * 0.08)));
    }, 220);
    return () => window.clearInterval(timer);
  }, [active, ceiling]);

  return value;
}

/** Same "authenticated blob, not a bare <a href>" pattern the document exports already use — the
 *  access token lives in memory, so a plain link would hit the route unauthenticated. */
export async function downloadBlobAs(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const STATUS_LABEL: Record<RequirementsDocRow["status"], string> = { DRAFTING: "Drafting", READY: "Ready", ARCHIVED: "Archived" };
const STATUS_VARIANT: Record<RequirementsDocRow["status"], "outline" | "default" | "secondary"> = {
  DRAFTING: "outline",
  READY: "default",
  ARCHIVED: "secondary"
};

export function RequirementsStudioPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const canCreate = Boolean(user?.permissions.includes(permissions.PLAN_WRITE));

  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState<"PRD" | "BRD" | "BOTH">("PRD");

  // Optional "import an existing PRD/BRD" sub-flow — see RequirementsStudio's own plan/header
  // reasoning: the review step lives here, before ever navigating to the document, so
  // RequirementsDocView's own "auto-fire the opening question on an empty transcript" effect
  // can never race an unconfirmed import.
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStage, setImportStage] = useState<ImportStage>("idle");
  const [importDocId, setImportDocId] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [importOpenQuestions, setImportOpenQuestions] = useState<string[]>([]);
  const [importTruncated, setImportTruncated] = useState(false);
  const [importRows, setImportRows] = useState<RequirementsImportProposedTurnRow[]>([]);
  /** Kept so a confirmed upload can persist its provenance — see importApply's `sourceDocument`. */
  const [importDocumentText, setImportDocumentText] = useState<string | null>(null);

  const docs = useQuery({ queryKey: ["requirements-docs"], queryFn: requirementsDocApi.list });
  const rows = (docs.data ?? []).filter((d) => d.status !== "ARCHIVED");
  const analyzeProgress = useIndeterminateProgress(importStage === "analyzing");

  function resetDialog() {
    setCreateOpen(false);
    setTitle("");
    setDocType("PRD");
    setImportFile(null);
    setImportStage("idle");
    setImportDocId(null);
    setImportSummary(null);
    setImportOpenQuestions([]);
    setImportTruncated(false);
    setImportRows([]);
    setImportDocumentText(null);
  }

  const downloadTemplate = useMutation({
    mutationFn: async () => downloadBlobAs(await requirementsDocApi.downloadTemplate(), "prd-brd-template.txt"),
    onError: (err: any) => toast.error("Could not download the template", { description: err?.response?.data?.message ?? "Try again." })
  });

  const create = useMutation({
    mutationFn: () => requirementsDocApi.create({ title: title.trim(), docType }),
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: ["requirements-docs"] });
      resetDialog();
      navigate(`/app/requirements/${doc.id}`);
    },
    onError: (err: any) => toast.error("Could not start the interview", { description: err?.response?.data?.message ?? "Try again." })
  });

  const analyzeImport = useMutation({
    mutationFn: async () => {
      if (!importFile) throw new Error("No file selected");
      setImportStage("analyzing");
      const doc = importDocId ? { id: importDocId } : await requirementsDocApi.create({ title: title.trim(), docType });
      if (!importDocId) {
        setImportDocId(doc.id);
        queryClient.invalidateQueries({ queryKey: ["requirements-docs"] });
      }
      return { docId: doc.id, result: await requirementsDocApi.importAnalyze(doc.id, importFile) };
    },
    onSuccess: ({ result }) => {
      setImportSummary(result.documentSummary);
      setImportOpenQuestions(result.openQuestions);
      setImportTruncated(result.truncated);
      setImportRows(result.proposedTurns);
      setImportDocumentText(result.documentText ?? null);
      setImportStage("reviewing");
    },
    onError: (err: any) => {
      setImportStage("idle");
      toast.error("Could not read that document", { description: err?.response?.data?.message ?? "Try a different file, or start the interview blank." });
    }
  });

  const applyImport = useMutation({
    mutationFn: async () => {
      if (!importDocId) throw new Error("No document to apply to");
      setImportStage("applying");
      await requirementsDocApi.importApply(importDocId, {
        turns: importRows.map(({ question, answer, sectionTag }) => ({ question, answer, sectionTag })),
        // Records where these answers came from — filename, size, extracted text, uploader, date.
        ...(importFile && importDocumentText
          ? { sourceDocument: { fileName: importFile.name, fileSize: importFile.size, text: importDocumentText } }
          : {})
      });
      // Fires the opening question exactly like a fresh document would on its own — the
      // interview engine has no idea these answers came from an import.
      await requirementsDocApi.interviewTurn(importDocId, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["requirements-docs"] });
      const docId = importDocId!;
      resetDialog();
      navigate(`/app/requirements/${docId}`);
    },
    onError: (err: any) => {
      setImportStage("reviewing");
      toast.error("Could not save those answers", { description: err?.response?.data?.message ?? "Try again." });
    }
  });

  function skipImportAndContinueBlank() {
    // The document (if one was already created for the import attempt) still has an empty
    // transcript — identical to any freshly-created, not-yet-started document.
    const docId = importDocId;
    resetDialog();
    if (docId) navigate(`/app/requirements/${docId}`);
  }

  function updateImportRowAnswer(index: number, answer: string) {
    setImportRows((prev) => prev.map((row, i) => (i === index ? { ...row, answer } : row)));
  }

  function removeImportRow(index: number) {
    setImportRows((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="h-5 w-5 text-primary" />
            Requirements Studio
          </h1>
          <p className="text-sm text-muted-foreground">
            An AI interview turns a project idea into a structured PRD/BRD — scope, features, tech stack, architecture, timeline — that
            you can export, or turn into real tickets and goals.
          </p>
        </div>
        {canCreate && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            New document
          </Button>
        )}
      </div>

      {docs.isLoading && (
        <div className="grid gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {!docs.isLoading && rows.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No requirements documents yet. Start one and answer a few questions to get a structured PRD/BRD.
          </CardContent>
        </Card>
      )}
      {!docs.isLoading && rows.length > 0 && (
        <div className="grid gap-2">
          {rows.map((doc) => (
            <Card key={doc.id} className="cursor-pointer transition-colors hover:border-primary/40" onClick={() => navigate(`/app/requirements/${doc.id}`)}>
              <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <CardTitle className="truncate text-sm font-medium">{doc.title}</CardTitle>
                    <p className="text-xs text-muted-foreground">{doc.docType}</p>
                  </div>
                </div>
                <Badge variant={STATUS_VARIANT[doc.status]}>{STATUS_LABEL[doc.status]}</Badge>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={(open) => (open ? setCreateOpen(true) : resetDialog())}>
        <DialogContent className={importStage === "reviewing" ? "sm:max-w-xl" : undefined}>
          {importStage !== "reviewing" && (
            <>
              <DialogHeader>
                <DialogTitle>New requirements document</DialogTitle>
                <DialogDescription>Give it a name — the interview asks everything else.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="rd-title">Title</Label>
                  <Input id="rd-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Field Service Scheduling App" maxLength={200} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Document type</Label>
                  <Select value={docType} onValueChange={(v) => setDocType(v as typeof docType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PRD">Product Requirements (PRD)</SelectItem>
                      <SelectItem value="BRD">Business Requirements (BRD)</SelectItem>
                      <SelectItem value="BOTH">Both</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Optional — strictly secondary to "Start interview" below. */}
                <div className="grid gap-1.5 border-t border-border pt-3">
                  <Label className="flex items-center gap-1.5 text-muted-foreground">
                    <FileUp className="h-3.5 w-3.5" />
                    Or import an existing PRD/BRD instead (optional)
                  </Label>
                  <FileDropzone
                    files={importFile ? [importFile] : []}
                    onChange={(files) => setImportFile(files[0] ?? null)}
                    maxFiles={1}
                    maxSizeMb={15}
                    accept={IMPORT_ACCEPT}
                    hint="PDF, Word (.docx), or plain text · 15 MB max"
                  />
                  <p className="text-xs text-muted-foreground">
                    The AI proposes which answers your document already covers — you review and edit everything before it's saved, and it
                    only asks follow-up questions for what's still missing.
                  </p>
                  {/* For people who don't have a PRD/BRD yet — a text link, not a button, so it
                      never competes with the two real actions in the footer. */}
                  <button
                    type="button"
                    onClick={() => downloadTemplate.mutate()}
                    disabled={downloadTemplate.isPending}
                    className="focus-ring flex w-fit items-center gap-1.5 rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline disabled:opacity-60"
                  >
                    {downloadTemplate.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    Don't have one? Download a fill-in template
                  </button>
                </div>
              </div>

              {importStage === "analyzing" ? (
                <div className="grid gap-2 py-2">
                  <AiStrands label="Reading your document and matching it to the interview…" />
                  <Progress value={analyzeProgress} className="h-1.5" />
                </div>
              ) : (
                <DialogFooter>
                  <Button variant="ghost" onClick={resetDialog}>
                    Cancel
                  </Button>
                  {importFile ? (
                    <Button disabled={title.trim().length < 3 || (analyzeImport.isPending as boolean)} onClick={() => analyzeImport.mutate()}>
                      <Sparkles className="mr-2 h-3.5 w-3.5" />
                      Analyze document
                    </Button>
                  ) : (
                    <Button disabled={title.trim().length < 3 || create.isPending} onClick={() => create.mutate()}>
                      {create.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                      Start interview
                    </Button>
                  )}
                </DialogFooter>
              )}
            </>
          )}

          {importStage === "reviewing" && (
            <>
              <DialogHeader>
                <DialogTitle>Review what we found</DialogTitle>
                <DialogDescription>
                  Edit or remove anything before it's saved — only what you confirm here becomes an answered interview question.
                </DialogDescription>
              </DialogHeader>

              <ImportReviewPanel
                rows={importRows}
                openQuestions={importOpenQuestions}
                summary={importSummary}
                truncated={importTruncated}
                onChangeAnswer={updateImportRowAnswer}
                onRemoveRow={removeImportRow}
              />

              <DialogFooter>
                <Button variant="ghost" onClick={skipImportAndContinueBlank}>
                  Skip import, start blank
                </Button>
                <Button
                  variant="ai"
                  disabled={importRows.length === 0 || (applyImport.isPending as boolean)}
                  onClick={() => applyImport.mutate()}
                >
                  {applyImport.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
                  Confirm and start interview
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

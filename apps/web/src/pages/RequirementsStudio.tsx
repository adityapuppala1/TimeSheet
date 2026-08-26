/**
 * The Requirements Studio list — every PRD/BRD an AI-guided interview has started, and where a
 * new one begins. The interview and generated document live on their own page
 * (`RequirementsDocView.tsx`, at `/app/requirements/:id`); this page is just the index and the
 * "New document" entry point, same split `Blueprints.tsx` draws between its list and its preview.
 *
 * WHO renders this: `App.tsx` at `/app/requirements`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FileUp, Loader2, Plus, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { permissions } from "@timesheet/shared";
import { AiStrands } from "../components/ui/ai-strands";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { FileDropzone } from "../components/ui/file-dropzone";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { useAuthStore } from "../store/auth";
import { requirementsDocApi, type RequirementsDocRow, type RequirementsImportProposedTurnRow } from "../services/api";

const IMPORT_ACCEPT = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/plain": [".txt"]
};

const CONFIDENCE_VARIANT: Record<RequirementsImportProposedTurnRow["confidence"], "default" | "secondary" | "outline"> = {
  HIGH: "default",
  MEDIUM: "secondary",
  LOW: "outline"
};

type ImportStage = "idle" | "analyzing" | "reviewing" | "applying";

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

  const docs = useQuery({ queryKey: ["requirements-docs"], queryFn: requirementsDocApi.list });
  const rows = (docs.data ?? []).filter((d) => d.status !== "ARCHIVED");

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
  }

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
        turns: importRows.map(({ question, answer, sectionTag }) => ({ question, answer, sectionTag }))
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
                </div>
              </div>

              {importStage === "analyzing" ? (
                <div className="py-2">
                  <AiStrands label="Reading your document and matching it to the interview…" />
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

              <div className="grid max-h-[60vh] gap-4 overflow-y-auto pr-1">
                {importSummary && <p className="text-sm text-muted-foreground">{importSummary}</p>}
                {importTruncated && (
                  <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
                    We could only read part of this file — the rest will be covered by follow-up questions.
                  </p>
                )}

                {importRows.length === 0 && <p className="text-sm text-muted-foreground">Nothing left to save — remove was used on every row.</p>}
                {importRows.map((row, index) => (
                  <div key={`${row.sectionTag}-${index}`} className="grid gap-1.5 rounded-md border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium">{row.question}</p>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Badge variant={CONFIDENCE_VARIANT[row.confidence]} className="text-[10px]">
                          {row.confidence.toLowerCase()} confidence
                        </Badge>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeImportRow(index)} aria-label="Remove this answer">
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <Textarea value={row.answer} onChange={(e) => updateImportRowAnswer(index, e.target.value)} rows={2} maxLength={4000} />
                  </div>
                ))}

                {importOpenQuestions.length > 0 && (
                  <div className="grid gap-1.5">
                    <p className="text-xs font-medium text-muted-foreground">The interview will ask about these next:</p>
                    <ul className="grid gap-1 text-xs text-muted-foreground">
                      {importOpenQuestions.map((q) => (
                        <li key={q}>• {q}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

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

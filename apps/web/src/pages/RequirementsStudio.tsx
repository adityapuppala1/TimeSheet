/**
 * The Requirements Studio list — every PRD/BRD an AI-guided interview has started, and where a
 * new one begins. The interview and generated document live on their own page
 * (`RequirementsDocView.tsx`, at `/app/requirements/:id`); this page is just the index and the
 * "New document" entry point, same split `Blueprints.tsx` draws between its list and its preview.
 *
 * WHO renders this: `App.tsx` at `/app/requirements`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { permissions } from "@timesheet/shared";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toaster";
import { useAuthStore } from "../store/auth";
import { requirementsDocApi, type RequirementsDocRow } from "../services/api";

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

  const docs = useQuery({ queryKey: ["requirements-docs"], queryFn: requirementsDocApi.list });
  const rows = (docs.data ?? []).filter((d) => d.status !== "ARCHIVED");

  const create = useMutation({
    mutationFn: () => requirementsDocApi.create({ title: title.trim(), docType }),
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: ["requirements-docs"] });
      setCreateOpen(false);
      setTitle("");
      navigate(`/app/requirements/${doc.id}`);
    },
    onError: (err: any) => toast.error("Could not start the interview", { description: err?.response?.data?.message ?? "Try again." })
  });

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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
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
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button disabled={title.trim().length < 3 || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Start interview
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

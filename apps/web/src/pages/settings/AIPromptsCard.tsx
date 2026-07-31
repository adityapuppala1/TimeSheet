/**
 * WHAT: the prompt editor — change what the AI is told without shipping a release.
 *
 * THE UX OBLIGATION HERE is honesty about blast radius. Editing a prompt changes what every user
 * of that capability gets, silently and immediately. So the editor:
 *   - shows the built-in prompt as the starting point and lets you get back to it in one click,
 *   - validates and renders a real preview BEFORE anything can be saved,
 *   - keeps every past version visible, because "what was it told when it wrote that?" is a
 *     question people ask months later.
 *
 * Only free-text capabilities appear — see ai-prompt.service.ts for why that allowlist is a
 * security boundary rather than a config choice.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileText, History, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { aiPromptApi } from "../../services/api";

export function AIPromptsCard({ readOnly }: { readOnly: boolean }) {
  const prompts = useQuery({ queryKey: ["ai", "prompts"], queryFn: aiPromptApi.list });
  const [openFeature, setOpenFeature] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4 text-primary" />
          Prompts
        </CardTitle>
        <CardDescription>
          Change what the AI is told for a capability, without waiting for a release. If a custom prompt ever fails to render, the
          built-in one is used automatically and the fallback is recorded — a bad edit can't take a feature down.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {prompts.isLoading && <Skeleton className="h-24 w-full" />}

        <div className="grid gap-1.5">
          {(prompts.data ?? []).map((p) => (
            <button
              key={p.feature}
              type="button"
              onClick={() => setOpenFeature(p.feature)}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2.5 text-left text-sm transition hover:border-primary/50 hover:bg-muted/40"
            >
              <span className="font-medium">{p.label}</span>
              {p.customized ? (
                <Badge variant="info">customised · v{p.activeVersion}</Badge>
              ) : (
                <Badge variant="muted">built-in</Badge>
              )}
              <span className="w-full text-xs text-muted-foreground">{p.description}</span>
            </button>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          Capabilities that must return structured JSON aren't listed. Their prompts carry the delimiters that stop content from
          email, chat and CI logs being treated as instructions, and a broken one would stop tickets being created from email.
        </p>
      </CardContent>

      <PromptEditorDialog feature={openFeature} readOnly={readOnly} onClose={() => setOpenFeature(null)} />
    </Card>
  );
}

function PromptEditorDialog({ feature, readOnly, onClose }: { feature: string | null; readOnly: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["ai", "prompts", feature],
    queryFn: () => aiPromptApi.get(feature!),
    enabled: Boolean(feature)
  });

  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{ problems: Array<{ message: string }>; preview: string } | null>(null);

  // Seed the editor from whatever is live — the active custom version, or the built-in prompt.
  useEffect(() => {
    if (!detail.data) return;
    const active = detail.data.versions.find((v) => v.id === detail.data.activeVersionId);
    setBody(active?.body ?? detail.data.defaultTemplate);
    setNote("");
    setPreview(null);
  }, [detail.data]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["ai", "prompts"] });
    queryClient.invalidateQueries({ queryKey: ["ai", "prompts", feature] });
  };

  const check = useMutation({
    mutationFn: () => aiPromptApi.preview(feature!, body),
    onSuccess: setPreview,
    onError: (err: any) => toast.error("Could not check", { description: err?.response?.data?.message ?? "Try again." })
  });

  const save = useMutation({
    mutationFn: () => aiPromptApi.saveVersion(feature!, { body, note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success("Saved and made live");
      invalidate();
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const activate = useMutation({
    mutationFn: (versionId: string | null) => aiPromptApi.activate(feature!, versionId),
    onSuccess: (_data, versionId) => {
      toast.success(versionId ? "Version is now live" : "Reverted to the built-in prompt");
      invalidate();
    },
    onError: (err: any) => toast.error("Could not switch version", { description: err?.response?.data?.message ?? "Try again." })
  });

  const dirty = detail.data ? body !== (detail.data.versions.find((v) => v.id === detail.data.activeVersionId)?.body ?? detail.data.defaultTemplate) : false;

  return (
    <Dialog open={Boolean(feature)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,900px)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{detail.data?.label ?? "Prompt"}</DialogTitle>
          <DialogDescription>{detail.data?.description}</DialogDescription>
        </DialogHeader>

        {detail.isLoading && <Skeleton className="h-56 w-full" />}

        {detail.data && (
          <div className="grid gap-5">
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-body">Prompt</Label>
              <Textarea
                id="prompt-body"
                rows={14}
                value={body}
                disabled={readOnly}
                onChange={(e) => {
                  setBody(e.target.value);
                  setPreview(null);
                }}
                className="font-mono text-xs"
              />
            </div>

            <div className="grid gap-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Placeholders</p>
              <div className="grid gap-1">
                {detail.data.placeholders.map((ph) => (
                  <p key={ph.name} className="text-xs text-muted-foreground">
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{`{{${ph.name}}}`}</code>{" "}
                    {ph.description}
                    {detail.data!.required.includes(ph.name) && <span className="ml-1 font-medium text-warning">required</span>}
                  </p>
                ))}
              </div>
            </div>

            {preview && preview.problems.length > 0 && (
              <div className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                {preview.problems.map((p, i) => (
                  <p key={i} className="flex items-start gap-2 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {p.message}
                  </p>
                ))}
              </div>
            )}

            {preview && preview.problems.length === 0 && (
              <div className="grid gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Preview — exactly what the model would receive, with example values
                </p>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
                  {preview.preview}
                </pre>
              </div>
            )}

            {!readOnly && (
              <div className="grid gap-3 border-t border-border pt-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="prompt-note">What changed? (optional)</Label>
                  <Input id="prompt-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Less chirpy, mention blockers first" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
                    Check &amp; preview
                  </Button>
                  {/* Save is gated on a clean preview: a prompt goes live for everyone the moment
                      it's saved, so "I looked at it first" should be the only path. */}
                  <Button size="sm" disabled={!dirty || save.isPending || !preview || preview.problems.length > 0} onClick={() => save.mutate()}>
                    <Check className="h-4 w-4" />Save &amp; make live
                  </Button>
                  {detail.data.activeVersionId && (
                    <Button size="sm" variant="ghost" disabled={activate.isPending} onClick={() => activate.mutate(null)}>
                      <RotateCcw className="h-4 w-4" />Revert to built-in
                    </Button>
                  )}
                </div>
                {dirty && !preview && (
                  <p className="text-xs text-muted-foreground">Run the check first — it validates the placeholders and shows the real prompt.</p>
                )}
              </div>
            )}

            {detail.data.versions.length > 0 && (
              <div className="grid gap-1.5 border-t border-border pt-4">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <History className="h-3.5 w-3.5" />History
                </p>
                {detail.data.versions.map((v) => (
                  <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <span className="font-medium">v{v.version}</span>
                    {v.id === detail.data!.activeVersionId && <Badge variant="success">live</Badge>}
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {v.note ?? v.body.slice(0, 60)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {v.createdBy?.name ?? "—"} · {new Date(v.createdAt).toLocaleDateString()}
                    </span>
                    {!readOnly && v.id !== detail.data!.activeVersionId && (
                      <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={activate.isPending} onClick={() => activate.mutate(v.id)}>
                        Make live
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

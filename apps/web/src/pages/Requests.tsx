/**
 * The Requests page — the intake inbox and the form builder behind it.
 *
 * WHY THE INBOX IS SUBMISSIONS AND NOT A QUEUE OF THINGS TO CREATE: a submission becomes a ticket
 * at submit time (see request-form-public.controller.ts). Holding real requests in a queue nobody
 * watches is how intake systems quietly lose work. What this page decides is whether the ticket
 * that already exists needs attention — accept clears the review flag, reject soft-deletes it —
 * not whether the request is allowed to exist at all.
 *
 * WHY THE BUILDER IS A LIST AND NOT A DRAG-AND-DROP CANVAS: the thing that makes these forms
 * useful is the conditional rules, and a rule reads as a sentence ("show this when Type is Bug").
 * A canvas optimises for arranging boxes, which is the part nobody struggles with. Order is
 * load-bearing here too — a rule may only reference a question above it — so an explicit
 * up/down list makes the constraint visible rather than something the server rejects later.
 *
 * WHO renders this: `App.tsx` at `/app/requests`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  Globe,
  Inbox,
  Link2,
  Loader2,
  Lock,
  Plus,
  Trash2,
  XCircle
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { permissions } from "@timesheet/shared";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { cn } from "../lib/utils";
import { usePlanningFeatures } from "../lib/use-planning";
import { useAuthStore } from "../store/auth";
import {
  planningApi,
  projectApi,
  requestFormApi,
  REQUEST_FIELD_TYPES,
  type RequestFormFieldRow,
  type RequestFormRow
} from "../services/api";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const blankField = (index: number): RequestFormFieldRow => ({
  key: `question_${index + 1}`,
  label: "",
  type: "TEXT",
  required: false
});

export function RequestsPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { features } = usePlanningFeatures();
  const canConfigure = Boolean(user?.permissions.includes(permissions.FORMS_CONFIGURE));
  const canTriage = Boolean(user?.permissions.includes(permissions.TICKETS_ASSIGN));

  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [editing, setEditing] = useState<RequestFormRow | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);

  const config = useQuery({ queryKey: ["planning", "settings"], queryFn: planningApi.settings });
  const forms = useQuery({ queryKey: ["request-forms"], queryFn: requestFormApi.list, enabled: canConfigure });
  const submissions = useQuery({
    queryKey: ["request-forms", "submissions", statusFilter],
    queryFn: () => requestFormApi.submissions({ status: statusFilter })
  });

  const accept = useMutation({
    mutationFn: (id: string) => requestFormApi.accept(id),
    onSuccess: () => {
      toast.success("Accepted");
      queryClient.invalidateQueries({ queryKey: ["request-forms", "submissions"] });
    },
    onError: (err: any) => toast.error("Could not accept", { description: serverMessage(err, "Try again.") })
  });
  const reject = useMutation({
    mutationFn: (id: string) => requestFormApi.reject(id),
    onSuccess: () => {
      toast.success("Rejected", { description: "The ticket it created has been removed." });
      queryClient.invalidateQueries({ queryKey: ["request-forms", "submissions"] });
    },
    onError: (err: any) => toast.error("Could not reject", { description: serverMessage(err, "Try again.") })
  });
  const publish = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) => requestFormApi.publish(id, next),
    onSuccess: (_r, vars) => {
      toast.success(vars.next ? "Published" : "Link withdrawn", {
        description: vars.next ? undefined : "The old URL is dead — republishing mints a new one."
      });
      queryClient.invalidateQueries({ queryKey: ["request-forms"] });
    },
    onError: (err: any) => toast.error("Could not change publishing", { description: serverMessage(err, "Try again.") })
  });
  const remove = useMutation({
    mutationFn: (id: string) => requestFormApi.remove(id),
    onSuccess: (result) => {
      toast.success(result.deleted ? "Form deleted" : "Form deactivated", {
        description: result.deleted ? undefined : `It has ${result.submissions} submission(s), so it was hidden rather than deleted.`
      });
      queryClient.invalidateQueries({ queryKey: ["request-forms"] });
    },
    onError: (err: any) => toast.error("Could not remove", { description: serverMessage(err, "Try again.") })
  });

  if (config.isLoading) return <Skeleton className="h-96 w-full" />;

  if (!features.requestForms) {
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 sm:p-6">
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            <Inbox className="mx-auto h-8 w-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Request forms aren&apos;t switched on</h1>
            <p className="text-sm text-muted-foreground">
              A super admin can turn them on in Workspace Settings → Planning.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows = submissions.data ?? [];

  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Inbox className="h-5 w-5 text-primary" />
            Requests
          </h1>
          <p className="text-sm text-muted-foreground">
            Intake forms and what people have sent through them. Every submission is already a ticket — this is where
            you decide whether it needs a second look.
          </p>
        </div>
        {canConfigure && (
          <Button
            onClick={() => {
              setEditing(null);
              setBuilderOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            New form
          </Button>
        )}
      </div>

      <Tabs defaultValue="inbox" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
        <TabsList className="w-full justify-start sm:w-auto">
          <TabsTrigger value="inbox">Inbox</TabsTrigger>
          {canConfigure && <TabsTrigger value="forms">Forms</TabsTrigger>}
        </TabsList>

        <TabsContent value="inbox">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
              <div>
                <CardTitle className="text-base">Submissions</CardTitle>
                <CardDescription>Newest first.</CardDescription>
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PENDING">Needs review</SelectItem>
                  <SelectItem value="ACCEPTED">Accepted</SelectItem>
                  <SelectItem value="REJECTED">Rejected</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent className="grid gap-2">
              {submissions.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing here.</p>
              ) : (
                rows.map((row) => (
                  <div key={row.id} className="grid gap-2 rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {row.ticket && (
                        <button
                          type="button"
                          className="font-mono text-xs text-primary hover:underline"
                          onClick={() => navigate(`/app/tickets?open=${row.ticket!.id}`)}
                        >
                          {row.ticket.key}
                        </button>
                      )}
                      <span className="truncate text-sm font-medium">{row.ticket?.title ?? "(no ticket)"}</span>
                      <Badge variant="outline">{row.form.name}</Badge>
                      {row.status === "PENDING" && <Badge variant="warning">Needs review</Badge>}
                      {row.status === "ACCEPTED" && <Badge variant="success">Accepted</Badge>}
                      {row.status === "REJECTED" && <Badge variant="destructive">Rejected</Badge>}
                    </div>

                    <div className="grid gap-0.5 text-xs text-muted-foreground">
                      {(row.submitterName || row.submitterEmail) && (
                        <span>
                          From {row.submitterName ?? "someone"}
                          {row.submitterEmail ? ` <${row.submitterEmail}>` : ""}
                        </span>
                      )}
                      <span>{new Date(row.createdAt).toLocaleString()}</span>
                    </div>

                    {/* Answers verbatim, as text. The content was written by a stranger. */}
                    <div className="grid gap-0.5 rounded border border-border bg-muted/30 p-2 text-xs">
                      {Object.entries(row.answers).map(([key, value]) => {
                        const field = row.form.schema?.fields?.find((f) => f.key === key);
                        return (
                          <div key={key}>
                            <span className="text-muted-foreground">{field?.label ?? key}: </span>
                            <span>{Array.isArray(value) ? value.join(", ") : String(value)}</span>
                          </div>
                        );
                      })}
                    </div>

                    {canTriage && row.status === "PENDING" && (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={accept.isPending} onClick={() => accept.mutate(row.id)}>
                          <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                          Accept
                        </Button>
                        <Button size="sm" variant="outline" disabled={reject.isPending} onClick={() => reject.mutate(row.id)}>
                          <XCircle className="mr-1.5 h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {canConfigure && (
          <TabsContent value="forms">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Forms</CardTitle>
                <CardDescription>
                  Publishing puts a form on a public URL that needs no account. That is a separate, deliberate step from
                  creating one.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                {forms.isLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : (forms.data ?? []).length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No forms yet.</p>
                ) : (
                  forms.data!.map((form) => {
                    const url = form.publicToken ? `${window.location.origin}/request/${form.publicToken}` : null;
                    return (
                      <div key={form.id} className="grid gap-2 rounded-lg border border-border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{form.name}</span>
                          <Badge variant="outline">{form.project?.code ?? "—"}</Badge>
                          <Badge variant="secondary">{form.schema?.fields?.length ?? 0} questions</Badge>
                          {form.isPublic ? <Badge variant="success">Public</Badge> : <Badge variant="outline">Internal</Badge>}
                          {!form.isActive && <Badge variant="outline">Inactive</Badge>}
                          <span className="text-xs text-muted-foreground">{form._count?.submissions ?? 0} submissions</span>
                        </div>

                        {url && (
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="truncate rounded bg-muted px-2 py-1 text-[11px]">{url}</code>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7"
                              onClick={() => {
                                navigator.clipboard?.writeText(url);
                                toast.success("Link copied");
                              }}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditing(form);
                              setBuilderOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant={form.isPublic ? "outline" : "default"}
                            disabled={publish.isPending}
                            onClick={() => publish.mutate({ id: form.id, next: !form.isPublic })}
                          >
                            {form.isPublic ? <Lock className="mr-1.5 h-3.5 w-3.5" /> : <Globe className="mr-1.5 h-3.5 w-3.5" />}
                            {form.isPublic ? "Withdraw link" : "Publish"}
                          </Button>
                          {url && (
                            <Button size="sm" variant="ghost" onClick={() => window.open(url, "_blank", "noopener")}>
                              <Link2 className="mr-1.5 h-3.5 w-3.5" />
                              Open
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(form.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      <FormBuilderDialog open={builderOpen} onOpenChange={setBuilderOpen} editing={editing} />
    </div>
  );
}

function FormBuilderDialog({
  open,
  onOpenChange,
  editing
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: RequestFormRow | null;
}) {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list, enabled: open });

  const [meta, setMeta] = useState({ name: "", slug: "", projectId: "", ticketType: "BUG", intro: "", confirmation: "" });
  const [fields, setFields] = useState<RequestFormFieldRow[]>([]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setMeta({
        name: editing.name,
        slug: editing.slug,
        projectId: editing.projectId,
        ticketType: editing.ticketType,
        intro: editing.schema?.intro ?? "",
        confirmation: editing.schema?.confirmation ?? ""
      });
      setFields(editing.schema?.fields ?? []);
    } else {
      setMeta({ name: "", slug: "", projectId: "", ticketType: "BUG", intro: "", confirmation: "" });
      // A new form starts with the one question every form must have — the one that becomes the
      // ticket title — so the required mapping is satisfied by default rather than discovered as
      // a validation error on save.
      setFields([{ key: "summary", label: "What do you need?", type: "TEXT", required: true, mapsTo: "title" }]);
    }
  }, [open, editing]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: meta.name.trim(),
        slug: meta.slug.trim(),
        projectId: meta.projectId,
        ticketType: meta.ticketType,
        schema: {
          fields: fields.map((f) => ({ ...f, options: f.options?.filter(Boolean) })),
          intro: meta.intro.trim() || undefined,
          confirmation: meta.confirmation.trim() || undefined
        }
      };
      return editing ? requestFormApi.update(editing.id, payload) : requestFormApi.create(payload);
    },
    onSuccess: () => {
      toast.success(editing ? "Form saved" : "Form created");
      queryClient.invalidateQueries({ queryKey: ["request-forms"] });
      onOpenChange(false);
    },
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Check the questions and try again.") })
  });

  const update = (index: number, patch: Partial<RequestFormFieldRow>) =>
    setFields((current) => current.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  const move = (index: number, delta: number) =>
    setFields((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const hasTitle = fields.some((f) => f.mapsTo === "title");
  const invalid = !meta.name.trim() || !meta.slug.trim() || !meta.projectId || fields.length === 0 || !hasTitle || fields.some((f) => !f.label.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,760px)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit form" : "New request form"}</DialogTitle>
          <DialogDescription>
            A question can only be shown based on a question ABOVE it — that is what keeps the rules readable and makes
            circular conditions impossible.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Name</Label>
              <Input
                value={meta.name}
                placeholder="Marketing request"
                onChange={(e) =>
                  setMeta({
                    ...meta,
                    name: e.target.value,
                    slug: meta.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
                  })
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Slug</Label>
              <Input value={meta.slug} placeholder="marketing-request" onChange={(e) => setMeta({ ...meta, slug: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>Requests land in</Label>
              <Select value={meta.projectId} onValueChange={(v) => setMeta({ ...meta, projectId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a project" />
                </SelectTrigger>
                <SelectContent>
                  {(projects.data ?? []).map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.code} — {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Created as</Label>
              <Input value={meta.ticketType} onChange={(e) => setMeta({ ...meta, ticketType: e.target.value })} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Intro text</Label>
              <Textarea rows={2} value={meta.intro} onChange={(e) => setMeta({ ...meta, intro: e.target.value })} placeholder="Optional" />
            </div>
            <div className="grid gap-1.5">
              <Label>Thank-you text</Label>
              <Textarea rows={2} value={meta.confirmation} onChange={(e) => setMeta({ ...meta, confirmation: e.target.value })} placeholder="Optional" />
            </div>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase text-muted-foreground">Questions</Label>
              <Button size="sm" variant="outline" onClick={() => setFields([...fields, blankField(fields.length)])}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add
              </Button>
            </div>

            {!hasTitle && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" />
                One question must be marked as the ticket title, or requests arrive with no name.
              </p>
            )}

            {fields.map((field, index) => (
              <div key={index} className={cn("grid gap-2 rounded-lg border border-border p-2.5", field.mapsTo === "title" && "border-primary/40")}>
                <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto]">
                  <Input value={field.label} placeholder="Question" onChange={(e) => update(index, { label: e.target.value })} />
                  <Select value={field.type} onValueChange={(v) => update(index, { type: v as any })}>
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REQUEST_FIELD_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t.toLowerCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-0.5">
                    <Button size="sm" variant="ghost" className="h-9 px-1.5" onClick={() => move(index, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-9 px-1.5" onClick={() => move(index, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-9 px-1.5" onClick={() => setFields(fields.filter((_, i) => i !== index))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {(field.type === "SELECT" || field.type === "MULTISELECT") && (
                  <Input
                    className="h-8 text-xs"
                    value={(field.options ?? []).join(", ")}
                    placeholder="Options, comma separated"
                    onChange={(e) => update(index, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })}
                  />
                )}

                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <label className="flex items-center gap-1.5">
                    <Switch checked={Boolean(field.required)} onCheckedChange={(v) => update(index, { required: v })} />
                    Required
                  </label>
                  <Select value={field.mapsTo ?? "__none__"} onValueChange={(v) => update(index, { mapsTo: v === "__none__" ? undefined : v })}>
                    <SelectTrigger className="h-7 w-[150px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Just an answer</SelectItem>
                      <SelectItem value="title">Becomes the title</SelectItem>
                      <SelectItem value="description">Becomes the description</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* A rule may only reference an EARLIER question — the picker enforces it, so the
                      constraint is visible while building rather than a rejection on save. */}
                  {index > 0 && (
                    <Select
                      value={field.showWhen?.[0]?.field ?? "__always__"}
                      onValueChange={(v) =>
                        update(index, {
                          showWhen: v === "__always__" ? undefined : [{ field: v, operator: "equals", value: field.showWhen?.[0]?.value ?? "" }]
                        })
                      }
                    >
                      <SelectTrigger className="h-7 w-[170px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__always__">Always shown</SelectItem>
                        {fields.slice(0, index).map((prior) => (
                          <SelectItem key={prior.key} value={prior.key}>
                            Show when &ldquo;{prior.label || prior.key}&rdquo; is…
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {field.showWhen?.[0] && (
                    <Input
                      className="h-7 w-[120px] text-xs"
                      value={field.showWhen[0].value ?? ""}
                      placeholder="equals…"
                      onChange={(e) => update(index, { showWhen: [{ ...field.showWhen![0], value: e.target.value }] })}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={invalid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

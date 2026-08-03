/**
 * The public request form — what someone outside the workspace sees at `/request/:token`.
 *
 * WHY IT LIVES OUTSIDE `/app`, like the shared attestation viewer: the person opening it has no
 * account and no session. Rendering it inside `AppLayout` would assume an authenticated user and
 * bounce them to the login screen, which is precisely the wrong outcome for the one page whose
 * whole purpose is to be usable by a stranger.
 *
 * WHY THE CONDITIONAL LOGIC IS EVALUATED HERE AS WELL AS ON THE SERVER: the browser decides what
 * to DRAW; the server decides what COUNTS. Both need the rules. Duplicating the evaluator would
 * be a drift risk, so this is a deliberately small mirror of `visibleFields` — the same
 * declaration-order walk, the same "a field whose controller is hidden is hidden too" rule — and
 * the server independently re-runs it on submit, so a divergence here can only ever cost a
 * confusing form, never a bad write.
 *
 * WHY NO AUTHORED HTML ANYWHERE: intro and confirmation text are rendered as plain text. They are
 * workspace-authored rather than stranger-authored, so the risk is lower, but a public page is
 * the wrong place to start trusting markup.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { publicFormApi, type RequestFormFieldRow, type RequestFormVisibilityRule } from "../services/api";

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
};

function ruleHolds(rule: RequestFormVisibilityRule, answers: Record<string, unknown>): boolean {
  const raw = answers[rule.field];
  const text = asText(raw).toLowerCase();
  const target = (rule.value ?? "").toLowerCase();
  switch (rule.operator) {
    case "isAnswered":
      return Array.isArray(raw) ? raw.length > 0 : raw !== undefined && raw !== null && raw !== "";
    case "equals":
      return Array.isArray(raw) ? raw.map((v) => asText(v).toLowerCase()).includes(target) : text === target;
    case "notEquals":
      return Array.isArray(raw) ? !raw.map((v) => asText(v).toLowerCase()).includes(target) : text !== target;
    case "contains":
      return text.includes(target);
    default:
      return true;
  }
}

/** Mirror of the server's `visibleFields` — same declaration-order walk, same rule that a field
 *  whose controller is hidden is hidden too. */
function visibleFields(fields: RequestFormFieldRow[], answers: Record<string, unknown>): RequestFormFieldRow[] {
  const out: RequestFormFieldRow[] = [];
  const shownKeys = new Set<string>();
  for (const field of fields) {
    const rules = field.showWhen ?? [];
    const shown = rules.length === 0 || rules.every((r) => shownKeys.has(r.field) && ruleHolds(r, answers));
    if (shown) {
      out.push(field);
      shownKeys.add(field.key);
    }
  }
  return out;
}

export function PublicRequestFormPage() {
  const { token = "" } = useParams();
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [submitter, setSubmitter] = useState({ name: "", email: "" });
  const [reference, setReference] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string>("");

  const form = useQuery({ queryKey: ["public-form", token], queryFn: () => publicFormApi.get(token), retry: false });

  const shown = useMemo(() => (form.data ? visibleFields(form.data.fields, answers) : []), [form.data, answers]);

  const submit = useMutation({
    mutationFn: () =>
      publicFormApi.submit(token, {
        submitterName: submitter.name.trim() || undefined,
        submitterEmail: submitter.email.trim() || undefined,
        // Only what is on screen. A stale answer to a question they navigated away from is not
        // theirs to send, and the server drops it anyway.
        answers: Object.fromEntries(shown.map((f) => [f.key, answers[f.key]]).filter(([, v]) => v !== undefined && v !== ""))
      }),
    onSuccess: (result) => {
      setReference(result.reference);
      setConfirmation(result.confirmation);
    }
  });

  const set = (key: string, value: unknown) => setAnswers((current) => ({ ...current, [key]: value }));

  if (form.isLoading) {
    return (
      <div className="mx-auto grid w-full max-w-2xl gap-4 p-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // One generic message for every "you may not have this" case, matching the API — an inactive
  // form, an unpublished one and a bad token must not be distinguishable from out here.
  if (form.isError || !form.data) {
    return (
      <div className="mx-auto grid w-full max-w-lg gap-4 p-6">
        <Card>
          <CardContent className="grid gap-3 p-10 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold">This form isn&apos;t available</h1>
            <p className="text-sm text-muted-foreground">
              The link may have expired or been withdrawn. If someone sent it to you, ask them for a current one.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (reference) {
    return (
      <div className="mx-auto grid w-full max-w-lg gap-4 p-6">
        <Card>
          <CardContent className="grid gap-3 p-10 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            <h1 className="text-lg font-semibold">Request received</h1>
            <p className="text-sm text-muted-foreground">{confirmation}</p>
            <p className="text-sm">
              Your reference is <Badge variant="secondary">{reference}</Badge>
            </p>
            <p className="text-xs text-muted-foreground">Keep it handy if you need to follow this up.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const missingRequired = shown.some((f) => {
    if (!f.required) return false;
    const v = answers[f.key];
    return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  });

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>{form.data.name}</CardTitle>
          {(form.data.description || form.data.intro) && (
            <CardDescription className="whitespace-pre-line">{form.data.intro || form.data.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="grid gap-4">
          {shown.map((field) => (
            <div key={field.key} className="grid gap-1.5">
              <Label>
                {field.label}
                {field.required && <span className="ml-1 text-destructive">*</span>}
              </Label>

              {field.type === "TEXTAREA" ? (
                <Textarea rows={4} value={String(answers[field.key] ?? "")} onChange={(e) => set(field.key, e.target.value)} />
              ) : field.type === "SELECT" ? (
                <Select value={String(answers[field.key] ?? "")} onValueChange={(v) => set(field.key, v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose one" />
                  </SelectTrigger>
                  <SelectContent>
                    {(field.options ?? []).map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === "MULTISELECT" ? (
                <div className="grid gap-1.5">
                  {(field.options ?? []).map((option) => {
                    const picked = Array.isArray(answers[field.key]) ? (answers[field.key] as string[]) : [];
                    return (
                      <label key={option} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={picked.includes(option)}
                          onCheckedChange={(checked) =>
                            set(field.key, checked ? [...picked, option] : picked.filter((p) => p !== option))
                          }
                        />
                        {option}
                      </label>
                    );
                  })}
                </div>
              ) : field.type === "CHECKBOX" ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={Boolean(answers[field.key])} onCheckedChange={(c) => set(field.key, Boolean(c))} />
                  Yes
                </label>
              ) : (
                <Input
                  type={field.type === "NUMBER" ? "number" : field.type === "DATE" ? "date" : field.type === "EMAIL" ? "email" : "text"}
                  value={String(answers[field.key] ?? "")}
                  onChange={(e) => set(field.key, e.target.value)}
                />
              )}

              {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
            </div>
          ))}

          <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Your name</Label>
              <Input value={submitter.name} onChange={(e) => setSubmitter({ ...submitter, name: e.target.value })} placeholder="Optional" />
            </div>
            <div className="grid gap-1.5">
              <Label>Your email</Label>
              <Input
                type="email"
                value={submitter.email}
                onChange={(e) => setSubmitter({ ...submitter, email: e.target.value })}
                placeholder="Optional — so we can reply"
              />
            </div>
          </div>

          {submit.isError && (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {(submit.error as any)?.response?.data?.message ?? "Something went wrong. Please try again."}
            </p>
          )}

          <Button className="justify-self-start" disabled={missingRequired || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Send request
          </Button>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">Powered by TimeSphere</p>
    </div>
  );
}

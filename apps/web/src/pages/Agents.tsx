/**
 * The agent roster — named teammates, what each is allowed to do, what it has been doing, and what
 * it has spent.
 *
 * WHY THE AUTONOMY LEVEL IS ON EVERY CAPABILITY CHIP AND NOT SUMMARISED PER AGENT: a bundle's
 * capabilities can sit at different levels — one proposing, one applying — and a single headline
 * badge would round that off in whichever direction reads better. The level shown is the RESOLVED
 * one from the server, clamps included, so the roster cannot advertise authority a run would not
 * actually get.
 *
 * WHY A GALLERY OF TEMPLATES RATHER THAN AN EMPTY "create agent" FORM: the interesting question for
 * somebody arriving here is "what could one of these do for me", and a blank form answers it with
 * homework. The templates are assembled only from capabilities that already exist, and installing
 * one produces an ordinary profile the admin owns and can edit.
 *
 * WHY EVERY NEW AGENT LANDS SWITCHED OFF: an administrator should read the resolved autonomy of the
 * bundle on this page before anything runs. Nothing here turns itself on.
 *
 * WHO renders this: `App.tsx` at `/app/agents`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Ban,
  Bot,
  CheckCircle2,
  Coins,
  Loader2,
  Lock,
  Plus,
  ShieldAlert,
  Sparkles,
  Trash2,
  Zap
} from "lucide-react";
import { useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Progress } from "../components/ui/progress";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { Switch } from "../components/ui/switch";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import { agentRosterApi, type AgentRosterEntry, type AgentTemplateRow } from "../services/api";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

/** Autonomy level → how it reads to a human. The wording matters more than the enum: "proposes,
 *  never applies" is a promise somebody can hold the product to. */
const LEVEL_COPY: Record<string, { label: string; blurb: string; tone: "secondary" | "warning" | "destructive" }> = {
  OFF: { label: "Off", blurb: "Does nothing at all.", tone: "secondary" },
  SUGGEST: { label: "Proposes", blurb: "Writes a proposal a human accepts row by row. Applies nothing itself.", tone: "secondary" },
  AUTO_APPLY: { label: "Applies", blurb: "Applies its own changes within the guardrails, and every one is undoable.", tone: "warning" },
  AUTONOMOUS: { label: "Autonomous", blurb: "Runs unattended. Only ever granted to capabilities that change no records.", tone: "destructive" }
};

const RUN_TONE: Record<string, string> = {
  COMPLETED: "text-success",
  PARTIAL: "text-warning-foreground",
  BLOCKED: "text-warning-foreground",
  FAILED: "text-destructive",
  ABORTED: "text-muted-foreground",
  RUNNING: "text-primary",
  QUEUED: "text-muted-foreground"
};

/** Four decimals only where they carry information. A model call can cost $0.0007, so rounding
 *  small spend to cents would render real usage as zero — but rendering an actual zero as "$0.0000"
 *  reads as a suspiciously precise nothing. */
const usd = (n: number) => (n === 0 ? "$0.00" : `$${n.toFixed(n < 1 ? 4 : 2)}`);

const relative = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export function AgentsPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const [galleryOpen, setGalleryOpen] = useState(false);

  const roster = useQuery({ queryKey: ["agents"], queryFn: agentRosterApi.list, retry: false });
  const catalogue = useQuery({ queryKey: ["agents", "catalogue"], queryFn: agentRosterApi.catalogue, enabled: galleryOpen });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["agents"] });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => agentRosterApi.update(id, { enabled }),
    onSuccess: (entry) => {
      toast.success(entry.enabled ? `${entry.name} is on` : `${entry.name} is off`, {
        description: entry.enabled
          ? "It will run at the autonomy each capability resolves to — nothing higher."
          : "It will not run again until switched back on."
      });
      invalidate();
    },
    onError: (err) => toast.error("Could not change that", { description: serverMessage(err, "Try again.") })
  });

  const install = useMutation({
    mutationFn: (templateKey: string) => agentRosterApi.install(templateKey),
    onSuccess: (entry) => {
      toast.success(`${entry.name} added`, { description: "It arrives switched off. Review what it can do, then turn it on." });
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["agents", "catalogue"] });
    },
    onError: (err) => toast.error("Could not add that", { description: serverMessage(err, "Try again.") })
  });

  const retire = useMutation({
    mutationFn: (id: string) => agentRosterApi.retire(id),
    onSuccess: () => {
      toast.success("Agent retired", { description: "Its past runs and audit trail are kept — the identity is deactivated, not deleted." });
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["agents", "catalogue"] });
    },
    onError: (err) => toast.error("Could not retire", { description: serverMessage(err, "Try again.") })
  });

  // A 403 here is the entitlement, not a bug — the roster is part of the AI copilot family.
  const gateMessage = (roster.error as any)?.response?.status === 403 ? serverMessage(roster.error, "") : null;

  const entries = roster.data ?? [];
  const enabledCount = entries.filter((e) => e.enabled).length;
  const spentToday = entries.reduce((sum, e) => sum + e.spentTodayUsd, 0);
  const runsToday = entries.reduce((sum, e) => sum + e.runs.total, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Bot className="h-6 w-6 text-primary" />
            Agents
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Named teammates built from capabilities this workspace already has. Each one shows exactly what it may do, what
            it has done, and what it cost.
          </p>
        </div>
        {isSuperAdmin && !gateMessage && (
          <Button onClick={() => setGalleryOpen(true)} className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            Add a teammate
          </Button>
        )}
      </div>

      {gateMessage && (
        <Card className="animate-fade-in">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
              <Lock className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">Agents are not part of this plan</p>
              <p className="max-w-md text-sm text-muted-foreground">{gateMessage}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {roster.isLoading && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-48" />
        </div>
      )}

      {!gateMessage && !roster.isLoading && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="On the roster" value={`${enabledCount} of ${entries.length} on`} icon={<Bot className="h-4 w-4" />} />
            <StatCard label="Runs, all time" value={String(runsToday)} icon={<Activity className="h-4 w-4" />} />
            <StatCard label="Spent today" value={usd(spentToday)} icon={<Coins className="h-4 w-4" />} />
          </div>

          {entries.length === 0 ? (
            <Card className="animate-fade-in">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary" aria-hidden>
                  <Sparkles className="h-5 w-5" />
                </span>
                <div className="space-y-1">
                  <p className="font-medium">No teammates yet</p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    The gallery has six, each assembled from capabilities that already run here. They arrive switched off.
                  </p>
                </div>
                {isSuperAdmin && (
                  <Button onClick={() => setGalleryOpen(true)}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    Browse the gallery
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {entries.map((entry) => (
                <AgentCard
                  key={entry.id}
                  entry={entry}
                  canManage={isSuperAdmin}
                  busy={toggle.isPending || retire.isPending}
                  onToggle={(enabled) => toggle.mutate({ id: entry.id, enabled })}
                  onRetire={() => retire.mutate(entry.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <Dialog open={galleryOpen} onOpenChange={setGalleryOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add a teammate</DialogTitle>
            <DialogDescription>
              Each template bundles capabilities that already exist in this workspace. Adding one creates it switched off —
              nothing runs until you say so.
            </DialogDescription>
          </DialogHeader>
          {catalogue.isLoading && <Skeleton className="h-64" />}
          <div className="space-y-2">
            {(catalogue.data?.templates ?? []).map((t) => (
              <TemplateRow
                key={t.key}
                template={t}
                busy={install.isPending}
                onInstall={() => install.mutate(t.key)}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TemplateRow({ template, busy, onInstall }: Readonly<{ template: AgentTemplateRow; busy: boolean; onInstall: () => void }>) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 transition-colors duration-200",
        template.installed ? "bg-muted/40" : "hover:border-primary/40"
      )}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-lg" aria-hidden>
        {template.emoji}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          {template.name}
          {template.installed && (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <CheckCircle2 className="h-2.5 w-2.5" />
              On the roster
            </Badge>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{template.description}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {template.capabilities.map((c) => (
            <span key={c} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {c}
            </span>
          ))}
        </div>
      </div>
      <Button size="sm" variant={template.installed ? "ghost" : "outline"} disabled={template.installed || busy} onClick={onInstall}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : template.installed ? "Added" : "Add"}
      </Button>
    </div>
  );
}

function AgentCard({
  entry,
  canManage,
  busy,
  onToggle,
  onRetire
}: Readonly<{
  entry: AgentRosterEntry;
  canManage: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRetire: () => void;
}>) {
  const budgetPct =
    entry.maxCostUsdPerDay && entry.maxCostUsdPerDay > 0
      ? Math.min(100, Math.round((entry.spentTodayUsd / entry.maxCostUsdPerDay) * 100))
      : null;

  return (
    <Card className={cn("animate-fade-in transition-shadow duration-200 hover:shadow-md", !entry.enabled && "opacity-80")}>
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-lg text-xl transition-colors",
                entry.enabled ? "bg-primary/10" : "bg-muted"
              )}
              aria-hidden
            >
              {entry.emoji}
            </span>
            <div className="min-w-0">
              <CardTitle className="flex flex-wrap items-center gap-1.5 text-base">
                {entry.name}
                <Badge variant={entry.enabled ? "success" : "secondary"} className="text-[10px]">
                  {entry.enabled ? "On" : "Off"}
                </Badge>
              </CardTitle>
              <CardDescription className="mt-0.5 text-xs">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help font-mono">{entry.identity.email}</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Its own identity, so its actions appear under this name in the audit trail and it can be assigned work.
                    It holds no seat, cannot sign in, and has no mailbox — the address is on a domain reserved never to
                    resolve.
                  </TooltipContent>
                </Tooltip>
              </CardDescription>
            </div>
          </div>
          {canManage && (
            <div className="flex shrink-0 items-center gap-2">
              <Switch checked={entry.enabled} disabled={busy} onCheckedChange={onToggle} aria-label={`Enable ${entry.name}`} />
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {entry.description && <p className="text-sm text-muted-foreground">{entry.description}</p>}

        {/* What it may actually do. One chip per capability, each carrying its RESOLVED level. */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">What it may do</p>
          <div className="flex flex-wrap gap-1.5">
            {entry.capabilities.map((c) => {
              const copy = LEVEL_COPY[c.autonomy.effectiveLevel] ?? LEVEL_COPY.SUGGEST;
              return (
                <Tooltip key={c.id}>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
                      {c.actsOnUntrustedInput && <ShieldAlert className="h-3 w-3 text-warning-foreground" />}
                      <span className="font-medium">{c.title}</span>
                      <Badge variant={copy.tone} className="ml-0.5 px-1 py-0 text-[9px]">
                        {copy.label}
                      </Badge>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs space-y-1">
                    <p>{c.description}</p>
                    <p className="text-muted-foreground">{copy.blurb}</p>
                    {c.autonomy.clampedReason && <p className="text-warning-foreground">Clamped: {c.autonomy.clampedReason}</p>}
                    {c.actsOnUntrustedInput && (
                      <p className="text-muted-foreground">
                        Reads text written outside this workspace, so a run that touches any drops to proposing for the rest
                        of its life.
                      </p>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>

        {/* Spend against its own ceiling. */}
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Spent today</span>
            <span className="tabular-nums">
              {usd(entry.spentTodayUsd)}
              {entry.maxCostUsdPerDay ? <span className="text-muted-foreground"> of {usd(entry.maxCostUsdPerDay)}</span> : null}
            </span>
          </div>
          {budgetPct !== null && <Progress value={budgetPct} className="h-1.5" aria-label={`${entry.name} budget used`} />}
        </div>

        {/* What it has been doing. Empty is a sentence, not a blank. */}
        <div className="space-y-1.5">
          <p className="flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Recent runs</span>
            <span className="tabular-nums">{entry.runs.total} all time</span>
          </p>
          {entry.runs.recent.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {entry.enabled ? "Nothing yet — it runs when its trigger fires." : "Nothing yet. It is switched off."}
            </p>
          ) : (
            <ul className="space-y-1">
              {entry.runs.recent.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                  <span className={cn("font-medium", RUN_TONE[r.status] ?? "text-foreground")}>{r.status}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{r.capability}</span>
                  <span className="text-muted-foreground">· {r.trigger}</span>
                  {r.tainted && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="warning" className="gap-1 px-1 py-0 text-[9px]">
                          <ShieldAlert className="h-2.5 w-2.5" />
                          clamped
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        This run read text authored outside the workspace, so its authority dropped to proposing for the
                        rest of its life — however it was configured.
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {r.costUsd !== null && <span className="tabular-nums text-muted-foreground">{usd(r.costUsd)}</span>}
                  <span className="ml-auto text-muted-foreground">{relative(r.createdAt)}</span>
                  {r.error && (
                    <span className="w-full truncate text-[11px] text-destructive" title={r.error}>
                      {r.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {!entry.enabled && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Ban className="h-3 w-3" />
                Switched off — nothing will run
              </span>
            )}
            {entry.enabled && entry.capabilities.some((c) => c.autonomy.effectiveLevel === "AUTO_APPLY") && (
              <span className="inline-flex items-center gap-1 text-[11px] text-warning-foreground">
                <Zap className="h-3 w-3" />
                Applies its own changes, within guardrails
              </span>
            )}
            <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={onRetire} disabled={busy}>
              <Trash2 className="mr-1 h-3 w-3" />
              Retire
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

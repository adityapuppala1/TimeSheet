/**
 * WHAT: the Workspace Settings card for change management — the master switch, the approval SLA,
 * the optional face check on approvals, and the approval policies that decide who signs off what.
 *
 * WHY THE SWITCH STILL MOVES WHEN THE PLAN DOES NOT INCLUDE THE MODULE: the same reasoning the
 * planning toggles follow. The preference is real and survives an upgrade, so saving it is honest;
 * what would be dishonest is pretending it does anything today, which is what the lock badge says.
 * The API refuses the feature either way, so nothing here can over-grant.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changeBands, changeKinds, type ChangeBand, type ChangeKind } from "@timesheet/shared";
import { Lock, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { changeApi, type ChangeApprovalPolicyRow } from "../../services/api";
import { humanizeChange } from "../../lib/change-visuals";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

export function ChangeManagementSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["changes", "settings"], queryFn: changeApi.settings.get });

  const update = useMutation({
    mutationFn: (payload: Record<string, unknown>) => changeApi.settings.update(payload),
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["changes"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  if (config.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!config.data) return null;

  const { settings, entitlements } = config.data;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Change management
            {!entitlements.changeManagementEnabled && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="gap-1">
                    <Lock className="h-3 w-3" />
                    Not in your plan
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Your preference is saved and takes effect the moment the plan includes this — but until then the API
                  refuses the feature, so leaving the switch on changes nothing.
                </TooltipContent>
              </Tooltip>
            )}
            {settings.enableChangeManagement && entitlements.changeManagementEnabled && <Badge variant="success">Active</Badge>}
          </CardTitle>
          <CardDescription>
            A controlled path for changes that need sign-off before they ship — risk assessment, approval, a scheduled
            window, and a review afterwards. Off until you turn it on.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <div className="grid gap-1">
              <span className="text-sm font-medium">Enable change management</span>
              <p className="text-xs text-muted-foreground">
                Adds Changes to the sidebar and lets people raise changes. Existing tickets are untouched.
              </p>
            </div>
            <Switch
              checked={settings.enableChangeManagement}
              disabled={readOnly || update.isPending}
              onCheckedChange={(v) => update.mutate({ enableChangeManagement: v })}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="approval-sla">Approval SLA (hours)</Label>
            <Input
              id="approval-sla"
              type="number"
              min={1}
              max={720}
              disabled={readOnly}
              defaultValue={settings.approvalSlaHours}
              onBlur={(e) => {
                const value = Number(e.target.value);
                if (value && value !== settings.approvalSlaHours) update.mutate({ approvalSlaHours: value });
              }}
            />
            <p className="text-xs text-muted-foreground">
              How long an approval may sit undecided before the approver — then their manager — is nudged.
            </p>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <div className="grid gap-1">
              <span className="text-sm font-medium">Require a face check to approve</span>
              <p className="text-xs text-muted-foreground">
                Signing off a production change is exactly the action the identity check exists for. Needs face
                verification enabled and entitled; ignored for external approvers, who have no enrolled face.
              </p>
            </div>
            <Switch
              checked={settings.requireFaceOnApproval}
              disabled={readOnly || update.isPending}
              onCheckedChange={(v) => update.mutate({ requireFaceOnApproval: v })}
            />
          </div>
        </CardContent>
      </Card>

      <ApprovalPolicies readOnly={readOnly} maxPolicies={entitlements.maxChangePolicies} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Policies
 * ------------------------------------------------------------------ */

function describeMatch(policy: ChangeApprovalPolicyRow): string {
  if (policy.isCatchAll) return "Anything nothing else matched";
  const parts: string[] = [];
  if (policy.matchKind) parts.push(`${humanizeChange(policy.matchKind).toLowerCase()} changes`);
  if (policy.matchRiskLevel) parts.push(`${humanizeChange(policy.matchRiskLevel).toLowerCase()} risk`);
  return parts.length > 0 ? parts.join(" · ") : "Everything";
}

function describeSteps(policy: ChangeApprovalPolicyRow): string {
  const labels = policy.steps.map((s) => {
    if (s.kind === "MANAGER_OF_IMPLEMENTER") return "the implementer's manager";
    if (s.kind === "ROLE") return `any ${s.value}`;
    if (s.kind === "GUEST") return s.value ?? "an external approver";
    return "a named person";
  });
  const joined = labels.join(policy.isSequential ? " → " : " + ");
  return policy.quorum ? `${joined} (any ${policy.quorum})` : joined;
}

function ApprovalPolicies({ readOnly, maxPolicies }: { readOnly: boolean; maxPolicies: number }) {
  const queryClient = useQueryClient();
  const policies = useQuery({ queryKey: ["changes", "policies"], queryFn: changeApi.policies.list });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    matchKind: "any" as ChangeKind | "any",
    matchRiskLevel: "any" as ChangeBand | "any",
    approverRole: "ADMIN",
    quorum: ""
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["changes", "policies"] });

  const create = useMutation({
    mutationFn: () =>
      changeApi.policies.create({
        name: draft.name,
        order: (policies.data?.length ?? 0) * 10,
        matchKind: draft.matchKind === "any" ? null : draft.matchKind,
        matchRiskLevel: draft.matchRiskLevel === "any" ? null : draft.matchRiskLevel,
        isSequential: false,
        quorum: draft.quorum ? Number(draft.quorum) : null,
        steps: [{ kind: "ROLE", value: draft.approverRole }]
      }),
    onSuccess: () => {
      toast.success("Policy added");
      setAdding(false);
      setDraft({ name: "", matchKind: "any", matchRiskLevel: "any", approverRole: "ADMIN", quorum: "" });
      invalidate();
    },
    onError: (err: any) => toast.error("Could not add the policy", { description: serverMessage(err, "Try again.") })
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => changeApi.policies.update(id, { enabled }),
    onSuccess: invalidate,
    onError: (err: any) => toast.error("Could not update", { description: serverMessage(err, "Try again.") })
  });

  const remove = useMutation({
    mutationFn: (id: string) => changeApi.policies.remove(id),
    onSuccess: () => {
      toast.success("Policy removed");
      invalidate();
    },
    onError: (err: any) => toast.error("Could not remove", { description: serverMessage(err, "Try again.") })
  });

  const rows = policies.data ?? [];
  const atCap = rows.length >= maxPolicies;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Approval policies</CardTitle>
        <CardDescription>
          Which chain a change earns. Evaluated top to bottom — <strong>the first match wins</strong> — and the
          catch-all is the floor: it cannot be disabled, because a change with nobody to approve it is a change nobody
          can close.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {policies.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          rows.map((policy) => (
            <div key={policy.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0 grid gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{policy.name}</span>
                  {policy.isCatchAll && <Badge variant="secondary">Catch-all</Badge>}
                  {!policy.enabled && <Badge variant="muted">Disabled</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  Matches: {describeMatch(policy)} · Asks: {describeSteps(policy)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={policy.enabled}
                  // A disabled catch-all would silently strand every change that reached it, so the
                  // switch is not offered rather than offered and refused.
                  disabled={readOnly || policy.isCatchAll || toggle.isPending}
                  onCheckedChange={(v) => toggle.mutate({ id: policy.id, enabled: v })}
                />
                {!policy.isCatchAll && (
                  <Button size="sm" variant="ghost" disabled={readOnly || remove.isPending} onClick={() => remove.mutate(policy.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))
        )}

        {adding ? (
          <div className="grid gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <div className="grid gap-1.5">
              <Label htmlFor="policy-name">Name</Label>
              <Input id="policy-name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="High-risk database changes" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="policy-kind">Applies to type</Label>
                <Select value={draft.matchKind} onValueChange={(v) => setDraft((d) => ({ ...d, matchKind: v as ChangeKind | "any" }))}>
                  <SelectTrigger id="policy-kind"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any type</SelectItem>
                    {changeKinds.map((k) => <SelectItem key={k} value={k}>{humanizeChange(k)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="policy-risk">Applies to risk</Label>
                <Select value={draft.matchRiskLevel} onValueChange={(v) => setDraft((d) => ({ ...d, matchRiskLevel: v as ChangeBand | "any" }))}>
                  <SelectTrigger id="policy-risk"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any risk</SelectItem>
                    {changeBands.map((b) => <SelectItem key={b} value={b}>{humanizeChange(b)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="policy-role">Ask everyone with this role</Label>
                <Select value={draft.approverRole} onValueChange={(v) => setDraft((d) => ({ ...d, approverRole: v }))}>
                  <SelectTrigger id="policy-role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["SUPER_ADMIN", "ADMIN", "MANAGER", "TEAM_LEAD"].map((r) => (
                      <SelectItem key={r} value={r}>{r.replace("_", " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="policy-quorum">How many must approve</Label>
                <Input
                  id="policy-quorum"
                  type="number"
                  min={1}
                  placeholder="All of them"
                  value={draft.quorum}
                  onChange={(e) => setDraft((d) => ({ ...d, quorum: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">Leave blank to require everyone. 1 is the emergency pattern.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button size="sm" disabled={!draft.name.trim() || create.isPending} onClick={() => create.mutate()}>
                Add policy
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" variant="outline" disabled={readOnly || atCap} onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add policy
            </Button>
            {atCap && (
              <p className="mt-2 text-xs text-muted-foreground">
                This plan allows {maxPolicies} {maxPolicies === 1 ? "policy" : "policies"}. Upgrade to add more.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

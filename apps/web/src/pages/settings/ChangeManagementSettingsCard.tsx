/**
 * WHAT: the Workspace Settings card for change management — the master switch, the approval SLA, the
 * optional face check on approvals, and every catalogue behind a change's dropdowns.
 *
 * WHY THE SWITCH STILL MOVES WHEN THE PLAN DOES NOT INCLUDE THE MODULE: the same reasoning the
 * planning toggles follow. The preference is real and survives an upgrade, so saving it is honest;
 * what would be dishonest is pretending it does anything today, which is what the lock badge says.
 * The API refuses the feature either way, so nothing here can over-grant.
 *
 * WHAT USED TO BE HERE AND IS NOT: an "Approval policies" editor — ordered rules deciding who signs
 * off what. That engine was never built. Approval in this module routes to the REQUESTER'S MANAGER,
 * falling back to every active super admin, which is the requirement as stated; the policy table was
 * dropped in the same migration that settled it. The card, its API client and its types survived the
 * removal and went on calling `GET /changes/config/policies`, which has never existed — a 404 on
 * every visit to this tab. Removed rather than implemented, because the simpler rule is the one
 * that was asked for.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, ShieldCheck } from "lucide-react";
import { changeApi } from "../../services/api";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { ChangeCatalogueEditor } from "../../components/change/ChangeCatalogueEditor";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dropdowns &amp; scoring</CardTitle>
          <CardDescription>
            Everything a change's form offers, and the two things that score it. Disabling a row takes it out of the
            form and leaves every change already filed under it readable — which is why deleting one is refused when
            anything still points at it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ChangeCatalogueEditor
            kind="categories"
            title="Categories"
            description="What kind of thing is being changed. A category can also force a security approver onto the chain."
            readOnly={readOnly}
          />
          <ChangeCatalogueEditor
            kind="sources"
            title="Sources"
            description="What prompted the change — an incident, a project, routine maintenance."
            readOnly={readOnly}
          />
          <ChangeCatalogueEditor
            kind="applications"
            title="Applications"
            description="The systems changes are raised against. Used to suggest a technical owner and to spot two changes booked on the same application at once."
            readOnly={readOnly}
          />
          <ChangeCatalogueEditor
            kind="risk-parameters"
            title="Risk parameters"
            description="The weighted questions behind every risk score. Scores normalise against the sum of ACTIVE weights, so adding a parameter does not deflate the scale — but a complete assessment is required to submit, so each one you add is one more question every requester must answer."
            readOnly={readOnly}
          />
          <ChangeCatalogueEditor
            kind="sla"
            title="SLA stages"
            description="How long each stage gets, and when it starts warning rather than breaching. A disabled stage has no clock at all rather than a zero-hour one."
            readOnly={readOnly}
          />
          <ChangeCatalogueEditor
            kind="maintenance-windows"
            title="Maintenance windows"
            description="When change is welcome. Times are UTC minutes past midnight, so a window may cross midnight without needing a second row."
            readOnly={readOnly}
          />
          <ChangeCatalogueEditor
            kind="blackouts"
            title="Blackout periods"
            description="When change is refused. Drawn under the change calendar rather than filtering it, because a change scheduled inside a freeze is exactly what somebody needs to see."
            readOnly={readOnly}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Policies
 * ------------------------------------------------------------------ */


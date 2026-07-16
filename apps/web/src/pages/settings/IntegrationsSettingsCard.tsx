/**
 * WHAT: the "Integrations" tab in Workspace Settings — currently SCIM provisioning (inbound,
 * see scim.controller.ts). Split out as its own file for the same reason every other settings
 * domain is (SecurityDevOpsSettingsCard.tsx, ChatIntegrationsSettingsCard.tsx, ...):
 * WorkspaceSettings.tsx is already large.
 * WHY Calendar sync isn't here yet: it needs the org's own Google/Microsoft OAuth App
 * credentials (same bring-your-own-app-registration model GitConnection uses) — tracked in
 * docs/ROADMAP.md's "Integrations" theme, not built yet.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, ShieldOff, UserCog } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { SERVER_ORIGIN, settingsApi } from "../../services/api";

function CopyableUrl({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs">{url}</code>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            navigator.clipboard.writeText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

export function IntegrationsSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const scim = useQuery({ queryKey: ["settings", "scim"], queryFn: settingsApi.getScim });
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const toggleEnabled = useMutation({
    mutationFn: (value: boolean) => settingsApi.updateScimEnabled(value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "scim"] }),
    onError: () => toast.error("Could not update SCIM", { description: "Try again." })
  });

  const rotate = useMutation({
    mutationFn: settingsApi.rotateScimToken,
    onSuccess: (res) => {
      setRevealedToken(res.token);
      queryClient.invalidateQueries({ queryKey: ["settings", "scim"] });
      toast.success("SCIM token generated", { description: "Copy it now — it won't be shown again." });
    },
    onError: () => toast.error("Could not generate a token", { description: "Try again." })
  });

  const disable = useMutation({
    mutationFn: settingsApi.disableScim,
    onSuccess: () => {
      setRevealedToken(null);
      queryClient.invalidateQueries({ queryKey: ["settings", "scim"] });
      toast.success("SCIM disabled");
    },
    onError: () => toast.error("Could not disable SCIM", { description: "Try again." })
  });

  const baseUrl = scim.data ? `${SERVER_ORIGIN || window.location.origin}${scim.data.baseUrl}` : "";

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCog className="h-4 w-4 text-primary" />
            SCIM provisioning
          </CardTitle>
          <CardDescription>
            Let your identity provider (Okta, Azure AD/Entra, OneLogin, ...) automatically create, deactivate, and reactivate users here
            when they're provisioned/deprovisioned in your IdP. Covers the Users resource (create, list, update, deactivate) — Groups
            aren't supported yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {scim.isLoading && <Skeleton className="h-32 w-full" />}
          {!scim.isLoading && scim.data && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={scim.data.isEnabled && scim.data.tokenSet ? "success" : "muted"}>
                  {scim.data.isEnabled && scim.data.tokenSet ? "SCIM enabled" : "SCIM disabled"}
                </Badge>
                {!scim.data.tokenSet && <span className="text-xs text-muted-foreground">Generate a token below to enable provisioning.</span>}
              </div>

              <CopyableUrl label="SCIM base URL" url={baseUrl} />

              <Alert>
                <AlertTitle className="text-sm">Configure your IdP's SCIM connector</AlertTitle>
                <AlertDescription className="text-xs">
                  Paste the base URL above and the bearer token below into your IdP's SCIM app config. New users provisioned from your
                  IdP are created here with the EMPLOYEE role (promote them afterward if needed) and an unusable local password —
                  they're expected to sign in via SSO. Deactivating a user in your IdP sets their status to Inactive here; it does not
                  delete their history.
                </AlertDescription>
              </Alert>

              {revealedToken && (
                <Alert>
                  <KeyRound className="h-4 w-4" />
                  <AlertTitle className="text-sm">Your new bearer token (copy it now — shown once)</AlertTitle>
                  <AlertDescription>
                    <div className="mt-1 flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                      <code className="min-w-0 flex-1 select-all truncate text-xs">{revealedToken}</code>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          navigator.clipboard.writeText(revealedToken);
                          toast.success("Copied");
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium">Enable SCIM provisioning</p>
                  <p className="text-xs text-muted-foreground">Requires a generated token below — toggling this without one has no effect.</p>
                </div>
                <Switch
                  checked={scim.data.isEnabled}
                  disabled={readOnly || toggleEnabled.isPending}
                  onCheckedChange={(v) => toggleEnabled.mutate(v)}
                />
              </div>

              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
                    <KeyRound className="h-3.5 w-3.5" />
                    {scim.data.tokenSet ? "Rotate token" : "Generate token"}
                  </Button>
                  {scim.data.tokenSet && (
                    <Button size="sm" variant="outline" onClick={() => disable.mutate()} disabled={disable.isPending}>
                      <ShieldOff className="h-3.5 w-3.5" />
                      Disable SCIM
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Calendar sync</CardTitle>
          <CardDescription>Not built yet — needs your own Google/Microsoft OAuth App credentials. Tracked in the roadmap.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

/**
 * WHAT: the "Security & DevOps" tab in Workspace Settings — generates/rotates the bearer token
 * external CI/security tools use to POST findings and test runs to
 * `controllers/devops-webhook.controller.ts`, shows the webhook URLs to paste into CI config,
 * and the ticket-closed digest email toggle.
 * WHY split into its own file: same reasoning as `ChatIntegrationsSettingsCard.tsx`'s header
 * comment — `WorkspaceSettings.tsx` is already large, each settings domain gets its own file.
 * WHY the token is only ever shown once: same write-only-secret convention as every other
 * generated credential in this app (see settings.controller.ts's POST /rotate-token comment) —
 * copy it into your CI config now, or rotate again if you lose it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileUp, GitBranch, KeyRound, ShieldOff, ShieldQuestion, Sparkles, Ticket, Unlink } from "lucide-react";
import { useState } from "react";
import { notificationPreferenceKeys, type NotificationPreferences } from "@timesheet/shared";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { projectApi, SERVER_ORIGIN, settingsApi } from "../../services/api";

const VAPT_SAMPLE_JSON = `[
  {
    "title": "Reflected XSS in search parameter",
    "severity": "HIGH",
    "description": "The 'q' query parameter is reflected unescaped into the page.",
    "cwe": "CWE-79",
    "filePath": "apps/web/src/pages/Search.tsx"
  }
]`;

function webhookUrl(path: string): string {
  const origin = SERVER_ORIGIN || window.location.origin;
  return `${origin}${path}`;
}

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

export function SecurityDevOpsSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const git = useQuery({ queryKey: ["settings", "git"], queryFn: settingsApi.getGitConnection });
  const [gitClientId, setGitClientId] = useState("");
  const [gitClientSecret, setGitClientSecret] = useState("");

  const saveGitCredentials = useMutation({
    mutationFn: () => settingsApi.saveGitAppCredentials({ clientId: gitClientId.trim(), clientSecret: gitClientSecret.trim() }),
    onSuccess: () => {
      toast.success("Saved — click Connect to authorize");
      setGitClientSecret("");
      queryClient.invalidateQueries({ queryKey: ["settings", "git"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });
  const connectGit = useMutation({
    mutationFn: () => settingsApi.getGitConnectUrl(),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err: any) => toast.error("Could not start connection", { description: err?.response?.data?.message ?? "Save your OAuth App credentials first." })
  });
  const disconnectGit = useMutation({
    mutationFn: () => settingsApi.disconnectGit(),
    onSuccess: () => {
      toast.success("Disconnected");
      queryClient.invalidateQueries({ queryKey: ["settings", "git"] });
    },
    onError: () => toast.error("Could not disconnect", { description: "Try again." })
  });
  const [revealedWebhookSecret, setRevealedWebhookSecret] = useState<string | null>(null);
  const rotateWebhookSecret = useMutation({
    mutationFn: () => settingsApi.rotateGitWebhookSecret(),
    onSuccess: (data) => {
      setRevealedWebhookSecret(data.secret);
      queryClient.invalidateQueries({ queryKey: ["settings", "git"] });
    },
    onError: () => toast.error("Could not generate secret", { description: "Try again." })
  });

  const ingestion = useQuery({ queryKey: ["settings", "security-ingestion"], queryFn: settingsApi.getSecurityIngestion });
  const notifications = useQuery({ queryKey: ["settings", "notifications"], queryFn: settingsApi.getNotifications });
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list });
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const updateFallbackProject = useMutation({
    mutationFn: (fallbackProjectId: string | null) => settingsApi.updateSecurityIngestionFallbackProject(fallbackProjectId),
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["settings", "security-ingestion"] });
    },
    onError: () => toast.error("Could not save", { description: "Try again." })
  });

  const toggleAutoReopen = useMutation({
    mutationFn: (enabled: boolean) => settingsApi.updateSecurityIngestionAutoReopen(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "security-ingestion"] }),
    onError: () => toast.error("Could not update auto-reopen", { description: "Try again." })
  });

  const [vaptAssessor, setVaptAssessor] = useState("");
  const [vaptJson, setVaptJson] = useState("");
  const uploadVapt = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(vaptJson);
      } catch {
        throw new Error("That's not valid JSON — check for a trailing comma or missing bracket.");
      }
      // Accept either a bare findings array or {assessor, findings} — the assessor field
      // above always wins if both are present, so pasting a report someone else prepared
      // doesn't require editing its embedded assessor name to match.
      const findings = Array.isArray(parsed) ? parsed : (parsed as any)?.findings;
      if (!Array.isArray(findings) || findings.length === 0) {
        throw new Error('Expected a JSON array of findings, or {"assessor": "...", "findings": [...]}.');
      }
      return settingsApi.uploadVaptReport({ assessor: vaptAssessor.trim(), findings });
    },
    onSuccess: (res) => {
      toast.success(`${res.created} finding(s) uploaded`, {
        description: res.ticketAttached > 0 ? `${res.ticketAttached} attached to an existing ticket via ticketKey.` : undefined
      });
      setVaptJson("");
      setVaptAssessor("");
    },
    onError: (err: any) => toast.error("Upload failed", { description: err?.message ?? err?.response?.data?.message ?? "Try again." })
  });

  function handleVaptFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setVaptJson(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  const rotate = useMutation({
    mutationFn: settingsApi.rotateSecurityIngestionToken,
    onSuccess: (res) => {
      setRevealedToken(res.token);
      queryClient.invalidateQueries({ queryKey: ["settings", "security-ingestion"] });
      toast.success("Ingestion token generated", { description: "Copy it now — it won't be shown again." });
    },
    onError: () => toast.error("Could not generate a token", { description: "Try again." })
  });

  const disable = useMutation({
    mutationFn: settingsApi.disableSecurityIngestion,
    onSuccess: () => {
      setRevealedToken(null);
      queryClient.invalidateQueries({ queryKey: ["settings", "security-ingestion"] });
      toast.success("Ingestion disabled");
    },
    onError: () => toast.error("Could not disable ingestion", { description: "Try again." })
  });

  const toggleDigest = useMutation({
    mutationFn: (value: boolean) => settingsApi.updateNotifications({ emailTicketClosedDigest: value } as Partial<NotificationPreferences>),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "notifications"] }),
    onError: () => toast.error("Could not update the digest setting", { description: "Try again." })
  });

  // Defensive — matches this app's existing convention of the shared package being the single
  // source of truth for which toggle keys exist (see WorkspaceSettings.tsx's emailRows list).
  const digestKeySupported = notificationPreferenceKeys.includes("emailTicketClosedDigest");

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Security & CI ingestion</CardTitle>
          <CardDescription>
            Ingest-only: point Semgrep, OWASP ZAP, Gitleaks, Syft, your test runner, or any other CI/security tool at these webhook
            URLs. TimeSphere never runs a scanner itself — it just stores and reports on whatever your own pipeline sends.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {ingestion.isLoading && <Skeleton className="h-32 w-full" />}
          {!ingestion.isLoading && ingestion.data && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={ingestion.data.tokenSet ? "success" : "muted"}>
                  {ingestion.data.tokenSet ? "Ingestion enabled" : "Ingestion disabled"}
                </Badge>
                {!ingestion.data.tokenSet && (
                  <span className="text-xs text-muted-foreground">Generate a token below to start accepting findings/test runs.</span>
                )}
              </div>

              <CopyableUrl label="Findings webhook (SAST / DAST / SSAT / SSCT)" url={webhookUrl(ingestion.data.findingsWebhookPath)} />
              <CopyableUrl label="Test-run webhook" url={webhookUrl(ingestion.data.testRunsWebhookPath)} />

              <Alert>
                <AlertTitle className="text-sm">Authenticate every POST with a bearer token</AlertTitle>
                <AlertDescription className="text-xs">
                  Send <code>Authorization: Bearer &lt;token&gt;</code>. Findings/test runs that reference a ticket key (e.g.{" "}
                  <code>"ticketKey": "WEB-123"</code>) attach to that ticket's Security tab automatically; omit it for a repo-wide scan
                  not tied to one ticket yet. VAPT reports (periodic, human-led) aren't sent here. See{" "}
                  <code>docs/SECURITY_DEVOPS_INTEGRATIONS.md</code> for GitHub Actions / GitLab CI / Jenkins / Bitbucket / internal-git examples.
                </AlertDescription>
              </Alert>

              {revealedToken && (
                <Alert>
                  <KeyRound className="h-4 w-4" />
                  <AlertTitle className="text-sm">Your new token (copy it now — shown once)</AlertTitle>
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

              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
                    <KeyRound className="h-3.5 w-3.5" />{ingestion.data.tokenSet ? "Rotate token" : "Generate token"}
                  </Button>
                  {ingestion.data.tokenSet && (
                    <Button size="sm" variant="outline" onClick={() => disable.mutate()} disabled={disable.isPending}>
                      <ShieldOff className="h-3.5 w-3.5" />Disable ingestion
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
          <CardTitle className="flex items-center gap-2 text-base">
            <Ticket className="h-4 w-4 text-primary" />
            Auto-create tickets from findings
          </CardTitle>
          <CardDescription>
            A CRITICAL or HIGH-severity finding that arrives with no <code>ticketKey</code> (nothing to attach it to) automatically
            opens a ticket here, severity mapped to priority, reported by a dedicated system account. Set to "Off" to only ever store
            findings without creating tickets from them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(ingestion.isLoading || projects.isLoading) && <Skeleton className="h-10 w-full" />}
          {!ingestion.isLoading && !projects.isLoading && (
            <div className="grid gap-1.5">
              <Select
                value={ingestion.data?.fallbackProjectId ?? "__off__"}
                onValueChange={(value) => updateFallbackProject.mutate(value === "__off__" ? null : value)}
                disabled={readOnly || updateFallbackProject.isPending}
              >
                <SelectTrigger className="sm:w-80">
                  <SelectValue placeholder="Off" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__off__">Off — never auto-create tickets</SelectItem>
                  {(projects.data ?? []).map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Auto-assigned via that project's own module-assignee rules (Workspace Settings → Email intake), if any module has one
                configured.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auto-reopen on regression</CardTitle>
          <CardDescription>
            When a FAILED test run references (via <code>ticketKey</code>) a ticket that's already RESOLVED or CLOSED, reopen it
            automatically. Deterministic — no AI involved — and always audit-logged with the assignee notified, since this is the one
            place an automated process changes ticket state without a human click.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ingestion.isLoading && <Skeleton className="h-10 w-full" />}
          {!ingestion.isLoading && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">Reopen tickets on CI regression</p>
                <p className="text-xs text-muted-foreground">Off by default.</p>
              </div>
              <Switch
                checked={Boolean(ingestion.data?.autoReopenEnabled)}
                onCheckedChange={(value) => toggleAutoReopen.mutate(value)}
                disabled={readOnly || toggleAutoReopen.isPending}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldQuestion className="h-4 w-4 text-primary" />
            VAPT report upload
          </CardTitle>
          <CardDescription>
            VAPT (Vulnerability Assessment &amp; Penetration Testing) is a periodic, human-led assessment — it never arrives through the
            CI ingestion webhook above. Upload its findings as structured JSON (converted from whatever your assessor delivered) and
            they land in the same findings table as the automated types, rendering identically in the ticket Security tab and reports.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="vapt-assessor">Assessor / firm name</Label>
            <Input
              id="vapt-assessor"
              value={vaptAssessor}
              onChange={(e) => setVaptAssessor(e.target.value)}
              placeholder="e.g. Acme Security Consulting, Q3 2026"
              disabled={readOnly}
            />
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="vapt-json">Findings (JSON)</Label>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-primary hover:underline">
                <FileUp className="h-3.5 w-3.5" />
                Load from file
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  disabled={readOnly}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleVaptFile(file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <Textarea
              id="vapt-json"
              rows={8}
              spellCheck={false}
              className="font-mono text-xs"
              value={vaptJson}
              onChange={(e) => setVaptJson(e.target.value)}
              placeholder={VAPT_SAMPLE_JSON}
              disabled={readOnly}
            />
            <p className="text-xs text-muted-foreground">
              An array of <code>{`{title, severity, description?, cwe?, filePath?, lineNumber?, ticketKey?}`}</code>. A finding whose{" "}
              <code>ticketKey</code> matches a real ticket (e.g. <code>WEB-123</code>) attaches to it automatically.
            </p>
          </div>
          {!readOnly && (
            <Button
              onClick={() => uploadVapt.mutate()}
              disabled={uploadVapt.isPending || !vaptAssessor.trim() || !vaptJson.trim()}
              className="justify-self-start"
            >
              <FileUp className="h-3.5 w-3.5" />
              {uploadVapt.isPending ? "Uploading…" : "Upload findings"}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ticket-close security digest</CardTitle>
          <CardDescription>
            When a ticket with findings or test runs is closed, email a summary to whoever closed it, their manager, and this
            workspace's admins (Cc) — scoped to that ticket only, never a workspace-wide digest.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {notifications.isLoading && <Skeleton className="h-10 w-full" />}
          {!notifications.isLoading && digestKeySupported && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <Sparkles className="h-4 w-4 shrink-0 text-info" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Email a digest when a ticket closes</p>
                  <p className="text-xs text-muted-foreground">Off by default — turn on once you've connected a scan source above.</p>
                </div>
              </div>
              <Switch
                checked={Boolean(notifications.data?.emailTicketClosedDigest)}
                onCheckedChange={(value) => toggleDigest.mutate(value)}
                disabled={readOnly || toggleDigest.isPending}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch className="h-4 w-4 text-primary" />
            Git provider (GitHub)
          </CardTitle>
          <CardDescription>
            Bring your own GitHub OAuth App (Settings → Developer settings → OAuth Apps on GitHub — set its
            "Authorization callback URL" to{" "}
            <code className="break-all rounded bg-muted px-1 py-0.5 text-xs [overflow-wrap:anywhere]">
              {`${SERVER_ORIGIN || window.location.origin}/api/git/callback`}
            </code>
            ). Once connected, the ticket Dev tab can pick a live branch/PR instead of typing one in.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {git.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : git.data?.connected ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/40 bg-success/5 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">Connected as {git.data.accountLogin}</p>
                  <p className="text-xs text-muted-foreground">
                    {git.data.connectedAt ? `Since ${new Date(git.data.connectedAt).toLocaleDateString()}` : null}
                  </p>
                </div>
                {!readOnly && (
                  <Button variant="outline" size="sm" onClick={() => disconnectGit.mutate()} disabled={disconnectGit.isPending}>
                    <Unlink className="h-3.5 w-3.5" />Disconnect
                  </Button>
                )}
              </div>
              <div className="grid gap-2 rounded-md border border-dashed border-border p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Auto-sync branches/PRs (optional)
                </p>
                <p className="text-xs text-muted-foreground">
                  Add a webhook to each repo you want auto-synced: repo → Settings → Webhooks → Add webhook. Content
                  type <code className="rounded bg-muted px-1 py-0.5">application/json</code>, events: pushes + pull
                  requests.
                </p>
                <CopyableUrl label="Webhook URL" url={git.data.webhookUrl} />
                {revealedWebhookSecret && (
                  <div className="grid gap-1">
                    <span className="text-xs font-semibold text-warning">Copy this secret now — it won't be shown again.</span>
                    <div className="flex min-w-0 items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
                      <code className="min-w-0 flex-1 truncate text-xs">{revealedWebhookSecret}</code>
                    </div>
                  </div>
                )}
                {!readOnly && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="justify-self-start"
                    onClick={() => rotateWebhookSecret.mutate()}
                    disabled={rotateWebhookSecret.isPending}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    {git.data.webhookSecretSet ? "Rotate webhook secret" : "Generate webhook secret"}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              {!readOnly && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input value={gitClientId} onChange={(e) => setGitClientId(e.target.value)} placeholder="OAuth App Client ID" />
                  <Input
                    value={gitClientSecret}
                    onChange={(e) => setGitClientSecret(e.target.value)}
                    placeholder="OAuth App Client Secret"
                    type="password"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!gitClientId.trim() || !gitClientSecret.trim() || saveGitCredentials.isPending}
                    onClick={() => saveGitCredentials.mutate()}
                  >
                    Save
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2.5">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                  {git.data?.clientIdSet ? "Credentials saved — connect to authorize." : "Save your OAuth App credentials above first."}
                </p>
                {!readOnly && (
                  <Button size="sm" disabled={!git.data?.clientIdSet || connectGit.isPending} onClick={() => connectGit.mutate()}>
                    <GitBranch className="h-3.5 w-3.5" />Connect
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

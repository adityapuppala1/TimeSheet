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
import { Check, Copy, FileUp, GitBranch, KeyRound, ShieldAlert, ShieldOff, ShieldQuestion, Sparkles, Ticket, Unlink } from "lucide-react";
import { useState } from "react";
import { notificationPreferenceKeys } from "@timesheet/shared";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { GitHubMark } from "../../components/ui/connector-marks";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { projectApi, SERVER_ORIGIN, settingsApi } from "../../services/api";
import { copyText } from "../../lib/clipboard";

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
            copyText(url).then(() => {
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
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
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

  const toggleCodeownersAssign = useMutation({
    mutationFn: (enabled: boolean) => settingsApi.updateSecurityIngestionCodeownersAssign(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "security-ingestion"] }),
    onError: () => toast.error("Could not update CODEOWNERS assignment", { description: "Try again." })
  });

  const toggleAutoCreateTicketOnCiFailure = useMutation({
    mutationFn: (enabled: boolean) => settingsApi.updateSecurityIngestionAutoCreateTicketOnCiFailure(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "security-ingestion"] }),
    onError: () => toast.error("Could not update CI-failure ticket creation", { description: "Try again." })
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

  // These two categories are READ-ONLY here on purpose. Both are ordinary rows in Workspace
  // settings → Email channels, which is now the single place every email is switched on and
  // given an audience; a second switch for the same column meant two screens that could each
  // look authoritative while disagreeing. The status badge stays so this card still tells you
  // whether the scan-source work above will actually reach anyone.
  //
  // Defensive — matches this app's existing convention of the shared package being the single
  // source of truth for which toggle keys exist (see WorkspaceSettings.tsx's emailRows list).
  const digestKeySupported = notificationPreferenceKeys.includes("emailTicketClosedDigest");
  const securityWeeklyDigestKeySupported = notificationPreferenceKeys.includes("emailSecurityWeeklyDigest");

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
              <CopyableUrl label="SARIF findings webhook (GitHub Code Scanning / CodeQL / Azure DevOps)" url={webhookUrl(ingestion.data.sarifFindingsWebhookPath)} />
              <CopyableUrl label="Test-run webhook" url={webhookUrl(ingestion.data.testRunsWebhookPath)} />
              <CopyableUrl label="SBOM webhook (SPDX / CycloneDX)" url={webhookUrl(ingestion.data.sbomWebhookPath)} />
              <CopyableUrl label="Error-tracking webhook (Sentry / Rollbar / raw)" url={webhookUrl(ingestion.data.errorEventsWebhookPath)} />

              <Alert>
                <AlertTitle className="text-sm">Authenticate every POST with a bearer token</AlertTitle>
                <AlertDescription className="text-xs">
                  Send <code>Authorization: Bearer &lt;token&gt;</code>. Findings/test runs that reference a ticket key (e.g.{" "}
                  <code>"ticketKey": "WEB-123"</code>) attach to that ticket's Security tab automatically; omit it for a repo-wide scan
                  not tied to one ticket yet. VAPT reports (periodic, human-led) aren't sent here. See{" "}
                  <code>docs/SECURITY_DEVOPS_INTEGRATIONS.md</code> for GitHub Actions / GitLab CI / Jenkins / Bitbucket / internal-git examples.
                </AlertDescription>
              </Alert>

              <Alert>
                <Sparkles className="h-4 w-4" />
                <AlertTitle className="text-sm">Already producing SARIF? Skip the translation step</AlertTitle>
                <AlertDescription className="text-xs">
                  GitHub Code Scanning, <code>codeql-action</code>, <code>semgrep --sarif</code>, and Azure DevOps' native scan tasks all
                  output SARIF 2.1.0 — POST that file as-is to the SARIF webhook above (same bearer token) and it's translated
                  automatically, no <code>jq</code> mapping needed. Send either the raw SARIF log, or{" "}
                  <code>{`{ sarif: {...}, type, repository, branch, prUrl, ticketKey }`}</code> to attach repo/PR/ticket context the SARIF
                  format itself has no room for.
                </AlertDescription>
              </Alert>

              <Alert>
                <ShieldAlert className="h-4 w-4" />
                <AlertTitle className="text-sm">Error-tracking: auto-reopen by crash fingerprint, not just ticket key</AlertTitle>
                <AlertDescription className="text-xs">
                  Point Sentry/Rollbar's outbound webhook (or your own error-tracking setup) at the error-tracking webhook above with{" "}
                  <code>{`{ source, fingerprint, message, stackTrace?, level?, ticketKey? }`}</code>. If <code>ticketKey</code> is omitted
                  and a RESOLVED/CLOSED ticket was previously linked to that same <code>fingerprint</code>, it reopens automatically —
                  "the same crash came back" is detected without anyone re-linking it by hand. Needs the auto-reopen toggle below turned
                  on, same as every other regression trigger on this page.
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
                          void copyText(revealedToken);
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
            When a FAILED test run, or a new/reintroduced finding, references (via <code>ticketKey</code>) a ticket that's already
            RESOLVED or CLOSED, reopen it automatically — the same behavior Black Duck's Jira plugin calls "auto-reopen on policy
            violation." Deterministic — no AI involved — and always audit-logged with the assignee notified, since this is the one
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
          <CardTitle className="text-base">Create a ticket from an untracked CI failure</CardTitle>
          <CardDescription>
            A FAILED test run reported with no <code>ticketKey</code> at all today just sits in the log — this creates one in the
            fallback project above, the same way an untracked CRITICAL/HIGH finding does. Guarded against flaky-test spam: a repeat
            failure on the same provider/branch within 24h gets a comment on the existing ticket instead of a duplicate, and (when AI
            CI-failure triage is on and a failure log was supplied) a failure already flagged as likely-flaky skips ticket creation
            entirely on its first sighting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ingestion.isLoading && <Skeleton className="h-10 w-full" />}
          {!ingestion.isLoading && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">Auto-create a ticket for untracked CI failures</p>
                <p className="text-xs text-muted-foreground">Off by default — needs a fallback project configured above.</p>
              </div>
              <Switch
                checked={Boolean(ingestion.data?.autoCreateTicketOnCiFailureEnabled)}
                onCheckedChange={(value) => toggleAutoCreateTicketOnCiFailure.mutate(value)}
                disabled={readOnly || toggleAutoCreateTicketOnCiFailure.isPending}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch className="h-4 w-4 text-primary" />
            CODEOWNERS-based auto-assignment
          </CardTitle>
          <CardDescription>
            When an auto-created security ticket (above) has no module-assignee-rule match, resolve an assignee from the finding's
            repo <code>CODEOWNERS</code> file for its file path, or failing that the last GitHub committer on that file — matched to a
            TimeSphere user via their <strong>GitHub username</strong> (set per user on the Users page). When a <code>CODEOWNERS</code>{" "}
            line lists several people, the one who has historically resolved security tickets fastest is picked. Requires a connected
            GitHub account below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {ingestion.isLoading && <Skeleton className="h-10 w-full" />}
          {!ingestion.isLoading && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">Assign via CODEOWNERS / last committer</p>
                <p className="text-xs text-muted-foreground">
                  Off by default — needs a connected GitHub account and at least one user's GitHub username set to do anything.
                </p>
              </div>
              <Switch
                checked={Boolean(ingestion.data?.codeownersAssignEnabled)}
                onCheckedChange={(value) => toggleCodeownersAssign.mutate(value)}
                disabled={readOnly || toggleCodeownersAssign.isPending}
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
                  <p className="text-xs text-muted-foreground">
                    Turn on once you've connected a scan source above. Delivery and audience are set in Email channels.
                  </p>
                </div>
              </div>
              <Badge variant={notifications.data?.emailTicketClosedDigest ? "success" : "muted"}>
                {notifications.data?.emailTicketClosedDigest ? "On" : "Off"}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI weekly security digest</CardTitle>
          <CardDescription>
            Every Monday morning, an AI-authored org-wide recap (open findings, risk score trend, tickets past SLA) is emailed to
            every admin — needs both the AI toggle (Workspace Settings → AI → "AI weekly security digest") and this delivery toggle
            on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {notifications.isLoading && <Skeleton className="h-10 w-full" />}
          {!notifications.isLoading && securityWeeklyDigestKeySupported && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <Sparkles className="h-4 w-4 shrink-0 text-info" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Email the weekly security digest to admins</p>
                  <p className="text-xs text-muted-foreground">
                    Skips weeks with nothing to report. Delivery and audience are set in Email channels.
                  </p>
                </div>
              </div>
              <Badge variant={notifications.data?.emailSecurityWeeklyDigest ? "success" : "muted"}>
                {notifications.data?.emailSecurityWeeklyDigest ? "On" : "Off"}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitHubMark className="h-4 w-4 text-primary" />
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch className="h-4 w-4 text-primary" />
            Other git providers — branch/PR auto-sync
          </CardTitle>
          <CardDescription>
            GitLab, Bitbucket Cloud, Gitea, Forgejo and Azure DevOps can push branch and pull-request
            events straight into ticket Dev tabs — no OAuth needed. Add a webhook in the repo (pushes +
            pull/merge requests, JSON) using the URL for your provider and the <strong>same webhook
            secret</strong> as GitHub above: GitLab takes it as the "Secret token", Gitea/Forgejo as the
            HMAC secret, Bitbucket as the webhook "Secret", Azure DevOps as the basic-auth password (or
            append <code className="rounded bg-muted px-1 py-0.5 text-xs">?token=…</code>). Branches are
            matched to tickets by a ticket key in the branch name, e.g.{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">WEB-123-fix-login</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {git.data?.providerWebhookUrls ? (
            <>
              {Object.entries(git.data.providerWebhookUrls).map(([provider, url]) => (
                <CopyableUrl
                  key={provider}
                  label={provider === "azure-devops" ? "Azure DevOps" : provider.charAt(0).toUpperCase() + provider.slice(1)}
                  url={url}
                />
              ))}
              {/* An org can use these providers WITHOUT ever connecting GitHub, so the secret has
                  to be generatable here too — it's the same secret, shown once, either place. */}
              {!git.data.webhookSecretSet && !readOnly && (
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-self-start"
                  onClick={() => rotateWebhookSecret.mutate()}
                  disabled={rotateWebhookSecret.isPending}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  Generate webhook secret
                </Button>
              )}
              {revealedWebhookSecret && !git.data.connected && (
                <div className="grid gap-1">
                  <span className="text-xs font-semibold text-warning">Copy this secret now — it won't be shown again.</span>
                  <div className="flex min-w-0 items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
                    <code className="min-w-0 flex-1 truncate text-xs">{revealedWebhookSecret}</code>
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                The AI PR-review summary stays GitHub-only for now (it needs the provider's API to read
                the diff). AWS CodeCommit isn't supported — AWS closed it to new customers in July 2024 —
                and SourceForge has no usable webhook API; for both, the Dev tab's manual branch/PR links
                work as always.
              </p>
            </>
          ) : (
            <Skeleton className="h-16 w-full" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

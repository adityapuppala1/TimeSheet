/**
 * WHAT: the "Chat integrations" tab in Workspace Settings — per-platform connection settings
 * (Slack/Microsoft Teams/Google Chat/Telegram: bot tokens, signing secrets, webhook URLs,
 * default project) plus channel/command routing rules, mirroring `EmailIntakeSettingsCard`'s
 * shape in `WorkspaceSettings.tsx` for the email-intake equivalent.
 * WHY split into its own file rather than folded into `WorkspaceSettings.tsx`: that file is
 * already very large — a fifth settings domain (after reminders/email/ticketing/AI/email-intake/
 * SSO) was the point where a new tab got its own file instead of growing the monolith further.
 * WHO calls the backing API: `controllers/chat-integrations.controller.ts`, via `chatIntegrationsApi`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatIntegrationRow, ChatMatchType, ChatPlatform } from "@timesheet/shared";
import { Badge } from "../../components/ui/badge";
import { CHAT_PLATFORM_MARKS } from "../../components/ui/connector-marks";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { apiUrl, chatIntegrationsApi, projectApi } from "../../services/api";

const PLATFORM_LABEL: Record<ChatPlatform, string> = {
  SLACK: "Slack",
  MICROSOFT_TEAMS: "Microsoft Teams",
  GOOGLE_CHAT: "Google Chat",
  TELEGRAM: "Telegram"
};

const CHAT_MATCH_TYPES: ChatMatchType[] = ["CHANNEL_ID", "COMMAND_PREFIX"];

export function ChatIntegrationsSettingsCard({ readOnly }: { readOnly: boolean }) {
  const settings = useQuery({ queryKey: ["settings", "chat-integrations"], queryFn: chatIntegrationsApi.getSettings });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const routingRules = useQuery({ queryKey: ["chat-integrations", "routing-rules"], queryFn: chatIntegrationsApi.routingRules.list });

  return (
    <div className="grid gap-5">
      {settings.isLoading && <Skeleton className="h-40 w-full" />}
      {!settings.isLoading &&
        settings.data?.integrations.map((row) => (
          <PlatformCard
            key={row.platform}
            row={row}
            allowed={settings.data!.allowedPlatforms.includes(row.platform)}
            projects={projects.data ?? []}
            readOnly={readOnly}
          />
        ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Routing rules</CardTitle>
          <CardDescription>First active match (in creation order) wins. No match falls back to that platform's default project above.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!readOnly && <NewRoutingRuleRow projects={projects.data ?? []} />}
          <div className="divide-y divide-border rounded-lg border border-border">
            {(routingRules.data ?? []).map((rule) => (
              <RoutingRuleRow key={rule.id} rule={rule} readOnly={readOnly} />
            ))}
            {(routingRules.data ?? []).length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No routing rules yet — messages land in each platform's default project.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function PlatformCard({
  row,
  allowed,
  projects,
  readOnly
}: {
  row: ChatIntegrationRow;
  allowed: boolean;
  projects: Array<{ id: string; name: string }>;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [teamsAppId, setTeamsAppId] = useState(row.teamsAppId ?? "");
  const [teamsAppPassword, setTeamsAppPassword] = useState("");
  const [googleChatWebhookUrl, setGoogleChatWebhookUrl] = useState(row.googleChatWebhookUrl ?? "");
  const [defaultProjectId, setDefaultProjectId] = useState(row.defaultProjectId ?? "");

  useEffect(() => {
    setTeamsAppId(row.teamsAppId ?? "");
    setGoogleChatWebhookUrl(row.googleChatWebhookUrl ?? "");
    setDefaultProjectId(row.defaultProjectId ?? "");
  }, [row.teamsAppId, row.googleChatWebhookUrl, row.defaultProjectId]);

  const save = useMutation({
    mutationFn: (payload: Parameters<typeof chatIntegrationsApi.updateSettings>[1]) => chatIntegrationsApi.updateSettings(row.platform, payload),
    onSuccess: () => {
      toast.success("Saved");
      setBotToken("");
      setSigningSecret("");
      setTeamsAppPassword("");
      queryClient.invalidateQueries({ queryKey: ["settings", "chat-integrations"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const CONFIGURED_CHECK: Record<ChatPlatform, () => boolean> = {
    GOOGLE_CHAT: () => Boolean(row.googleChatWebhookUrl && row.signingSecretSet),
    MICROSOFT_TEAMS: () => Boolean(row.teamsAppId && row.teamsAppPasswordSet),
    SLACK: () => Boolean(row.botTokenSet),
    TELEGRAM: () => Boolean(row.botTokenSet)
  };
  const fullyConfigured = CONFIGURED_CHECK[row.platform]();

  const WEBHOOK_PATH: Partial<Record<ChatPlatform, string>> = {
    SLACK: "/chat/slack/events/<your-workspace-slug>",
    MICROSOFT_TEAMS: "/chat/teams/messages/<your-workspace-slug>",
    GOOGLE_CHAT: "/chat/google/events/<your-workspace-slug>"
  };
  const webhookPath = WEBHOOK_PATH[row.platform];
  const webhookUrlHint = webhookPath ? apiUrl(webhookPath) : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {/* The platform's own mark, not a shared speech bubble — with four of these cards on
                  screen the icon was the one thing that could tell them apart at a glance and it
                  was identical on all four. CHAT_PLATFORM_MARKS is keyed by the same enum the row
                  carries, so the card, the picker and the rule badge below cannot disagree. */}
              {(() => {
                const Mark = CHAT_PLATFORM_MARKS[row.platform];
                return <Mark className="h-4 w-4" />;
              })()}
              {PLATFORM_LABEL[row.platform]}
            </CardTitle>
            <CardDescription>
              {!allowed
                ? "Not available on this workspace's current plan."
                : "Messages sent to your bot are AI-triaged into tickets automatically."}
            </CardDescription>
          </div>
          {fullyConfigured && row.isEnabled && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-semibold text-success">
              <Check className="h-3 w-3" />Active
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {webhookUrlHint && (
          <div className="grid gap-1.5">
            <Label>Webhook URL (give this to {PLATFORM_LABEL[row.platform]}'s app configuration)</Label>
            <Input readOnly value={webhookUrlHint} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <p className="text-xs text-muted-foreground">Replace &lt;your-workspace-slug&gt; with this workspace's actual subdomain.</p>
          </div>
        )}

        <div className="flex items-start gap-4 rounded-lg border border-border p-4">
          <div className="flex-1">
            <Label>Enabled</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">Start turning {PLATFORM_LABEL[row.platform]} messages into tickets.</p>
          </div>
          <Switch
            checked={row.isEnabled}
            disabled={readOnly || !allowed || !fullyConfigured}
            onCheckedChange={(v) => save.mutate({ isEnabled: v })}
          />
        </div>

        {(row.platform === "SLACK" || row.platform === "TELEGRAM") && (
          <div className="grid gap-1.5">
            <Label>Bot token {row.botTokenSet && <span className="font-normal text-muted-foreground">(saved)</span>}</Label>
            <Input
              type="password"
              value={botToken}
              disabled={readOnly}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={row.botTokenSet ? "•••••••••••••••• (unchanged)" : row.platform === "SLACK" ? "xoxb-..." : "123456:ABC-DEF..."}
            />
          </div>
        )}

        {row.platform === "SLACK" && (
          <div className="grid gap-1.5">
            <Label>Signing secret {row.signingSecretSet && <span className="font-normal text-muted-foreground">(saved)</span>}</Label>
            <Input
              type="password"
              value={signingSecret}
              disabled={readOnly}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder={row.signingSecretSet ? "•••••••••••••••• (unchanged)" : "From Slack app's Basic Information page"}
            />
          </div>
        )}

        {row.platform === "MICROSOFT_TEAMS" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Bot Framework app ID</Label>
              <Input value={teamsAppId} disabled={readOnly} onChange={(e) => setTeamsAppId(e.target.value)} placeholder="Azure Bot app registration ID" />
            </div>
            <div className="grid gap-1.5">
              <Label>App password {row.teamsAppPasswordSet && <span className="font-normal text-muted-foreground">(saved)</span>}</Label>
              <Input
                type="password"
                value={teamsAppPassword}
                disabled={readOnly}
                onChange={(e) => setTeamsAppPassword(e.target.value)}
                placeholder={row.teamsAppPasswordSet ? "•••••••••••••••• (unchanged)" : "Client secret"}
              />
            </div>
          </div>
        )}

        {row.platform === "GOOGLE_CHAT" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Incoming webhook URL</Label>
              <Input
                value={googleChatWebhookUrl}
                disabled={readOnly}
                onChange={(e) => setGoogleChatWebhookUrl(e.target.value)}
                placeholder="https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=..."
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Verification token {row.signingSecretSet && <span className="font-normal text-muted-foreground">(saved)</span>}</Label>
              <Input
                type="password"
                value={signingSecret}
                disabled={readOnly}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder={row.signingSecretSet ? "•••••••••••••••• (unchanged)" : "Set in Google Cloud console's Chat app config"}
              />
            </div>
          </div>
        )}

        <div className="grid gap-1.5 sm:w-1/2">
          <Label>Default project</Label>
          <Select value={defaultProjectId || "none"} onValueChange={(v) => setDefaultProjectId(v === "none" ? "" : v)} disabled={readOnly}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None — drop unmatched messages</SelectItem>
              {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {row.lastError && <p className="text-xs text-destructive">Last error: {row.lastError}</p>}

        <Button
          size="sm"
          className="w-fit"
          disabled={readOnly}
          onClick={() =>
            save.mutate({
              teamsAppId: teamsAppId || null,
              googleChatWebhookUrl: googleChatWebhookUrl || null,
              defaultProjectId: defaultProjectId || null,
              ...(botToken ? { botToken } : {}),
              ...(signingSecret ? { signingSecret } : {}),
              ...(teamsAppPassword ? { teamsAppPassword } : {})
            })
          }
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function NewRoutingRuleRow({ projects }: { projects: Array<{ id: string; name: string; modules?: Array<{ id: string; name: string }> }> }) {
  const queryClient = useQueryClient();
  const [rule, setRule] = useState({ platform: "SLACK" as ChatPlatform, matchType: "CHANNEL_ID" as ChatMatchType, matchValue: "", projectId: "", defaultModuleId: "" });

  const create = useMutation({
    mutationFn: () =>
      chatIntegrationsApi.routingRules.create({
        platform: rule.platform,
        matchType: rule.matchType,
        matchValue: rule.matchValue,
        projectId: rule.projectId,
        defaultModuleId: rule.defaultModuleId || undefined
      }),
    onSuccess: () => {
      toast.success("Routing rule added");
      setRule({ platform: "SLACK", matchType: "CHANNEL_ID", matchValue: "", projectId: "", defaultModuleId: "" });
      queryClient.invalidateQueries({ queryKey: ["chat-integrations", "routing-rules"] });
    },
    onError: (err: any) => toast.error("Could not add rule", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="grid gap-2 sm:grid-cols-6 sm:items-end">
      <div className="grid gap-1.5">
        <Label className="text-xs">Platform</Label>
        <Select value={rule.platform} onValueChange={(v) => setRule({ ...rule, platform: v as ChatPlatform })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {(["SLACK", "MICROSOFT_TEAMS", "GOOGLE_CHAT", "TELEGRAM"] as ChatPlatform[]).map((p) => (
              <SelectItem key={p} value={p}>
                    <span className="inline-flex items-center gap-2">
                      {(() => {
                        const Mark = CHAT_PLATFORM_MARKS[p];
                        return <Mark className="h-4 w-4 shrink-0" />;
                      })()}
                      {PLATFORM_LABEL[p]}
                    </span>
                  </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Match on</Label>
        <Select value={rule.matchType} onValueChange={(v) => setRule({ ...rule, matchType: v as ChatMatchType })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {CHAT_MATCH_TYPES.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Value</Label>
        <Input
          value={rule.matchValue}
          onChange={(e) => setRule({ ...rule, matchValue: e.target.value })}
          placeholder={rule.matchType === "COMMAND_PREFIX" ? "/ticket" : "channel/space ID"}
        />
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Project</Label>
        <Select value={rule.projectId} onValueChange={(v) => setRule({ ...rule, projectId: v, defaultModuleId: "" })}>
          <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
          <SelectContent>
            {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Module (optional)</Label>
        <Select value={rule.defaultModuleId} onValueChange={(v) => setRule({ ...rule, defaultModuleId: v })} disabled={!rule.projectId}>
          <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
          <SelectContent>
            {projects.find((p) => p.id === rule.projectId)?.modules?.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" disabled={!rule.matchValue.trim() || !rule.projectId || create.isPending} onClick={() => create.mutate()}>
        <Plus className="h-4 w-4" />Add rule
      </Button>
    </div>
  );
}

function RoutingRuleRow({
  rule,
  readOnly
}: {
  rule: { id: string; platform: ChatPlatform; matchType: ChatMatchType; matchValue: string; project: { name: string }; defaultModule: { name: string } | null; isActive: boolean };
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (isActive: boolean) => chatIntegrationsApi.routingRules.update(rule.id, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["chat-integrations", "routing-rules"] }),
    onError: (err: any) => toast.error("Could not update rule", { description: err?.response?.data?.message ?? "Try again." })
  });
  const remove = useMutation({
    mutationFn: () => chatIntegrationsApi.routingRules.remove(rule.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["chat-integrations", "routing-rules"] }),
    onError: (err: any) => toast.error("Could not remove rule", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 text-sm">
      <Badge variant="muted" className="gap-1.5">
        {(() => {
          const Mark = CHAT_PLATFORM_MARKS[rule.platform];
          return <Mark className="h-3.5 w-3.5 shrink-0" />;
        })()}
        {PLATFORM_LABEL[rule.platform]}
      </Badge>
      <Badge variant="muted">{rule.matchType.replace(/_/g, " ")}</Badge>
      <span className="font-mono text-xs">{rule.matchValue}</span>
      <span className="flex-1 text-muted-foreground">
        &rarr; {rule.project.name}
        {rule.defaultModule ? ` / ${rule.defaultModule.name}` : ""}
      </span>
      {!readOnly && (
        <>
          <Switch checked={rule.isActive} onCheckedChange={(v) => toggle.mutate(v)} />
          <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => remove.mutate()}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

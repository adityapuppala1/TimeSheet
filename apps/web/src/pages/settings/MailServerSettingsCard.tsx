/**
 * WHAT: the "Mail server" tab in Workspace Settings — configure outbound SMTP (host/port/user/
 * password/from-address) from the UI instead of only via apps/api/.env, with a live "test
 * connection" check and a transport-status banner.
 * WHY split into its own file: same reasoning as `ChatIntegrationsSettingsCard.tsx`'s and
 * `SecurityDevOpsSettingsCard.tsx`'s header comments — each settings domain gets its own file
 * once `WorkspaceSettings.tsx` has enough tabs.
 * WHY a saved password is never round-tripped: same write-only-secret convention as
 * `EmailIntakeSettingsCard`'s IMAP password — GET only ever returns `passwordSet: boolean`.
 * WHO calls the backing API: `controllers/settings.controller.ts`'s `/mail*` routes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Mail, PlugZap, Save, ServerCog } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { settingsApi } from "../../services/api";

interface Draft {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromAddress: string;
}

export function MailServerSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "mail"], queryFn: settingsApi.getMail });
  const status = useQuery({ queryKey: ["settings", "mail", "transport-status"], queryFn: settingsApi.getMailTransportStatus, refetchInterval: 30_000 });

  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (settings.data) {
      setDraft({
        host: settings.data.host ?? "",
        port: settings.data.port,
        secure: settings.data.secure,
        user: settings.data.user ?? "",
        password: "",
        fromAddress: settings.data.fromAddress ?? ""
      });
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      settingsApi.updateMail({
        host: draft!.host || null,
        port: draft!.port,
        secure: draft!.secure,
        user: draft!.user || null,
        password: draft!.password || undefined,
        fromAddress: draft!.fromAddress || null
      }),
    onSuccess: () => {
      toast.success("Saved");
      setDraft((d) => (d ? { ...d, password: "" } : d));
      queryClient.invalidateQueries({ queryKey: ["settings", "mail"] });
      queryClient.invalidateQueries({ queryKey: ["settings", "mail", "transport-status"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const testConnection = useMutation({
    mutationFn: () =>
      settingsApi.testMailConnection(
        draft
          ? { host: draft.host || undefined, port: draft.port, secure: draft.secure, user: draft.user || undefined, password: draft.password || undefined }
          : undefined
      ),
    onSuccess: (res) => {
      if (res.ok) toast.success("Connection succeeded", { description: res.message });
      else toast.error("Connection failed", { description: res.message });
    },
    onError: (err: any) => toast.error("Could not test connection", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="grid gap-5">
      <TransportStatusBanner status={status.data} loading={status.isLoading} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4 text-primary" />
            SMTP connection
          </CardTitle>
          <CardDescription>
            Configure outbound email here to override <code>apps/api/.env</code>'s <code>SMTP_*</code> vars — leave everything blank to keep
            using the .env values (useful for a self-hosted deployment that manages secrets outside the app).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings.isLoading || !draft ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>SMTP host</Label>
                  <Input value={draft.host} disabled={readOnly} onChange={(e) => setDraft({ ...draft, host: e.target.value })} placeholder="smtp.gmail.com" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Port</Label>
                  <Input
                    type="number"
                    value={draft.port}
                    disabled={readOnly}
                    onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || 587 })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Username</Label>
                  <Input value={draft.user} disabled={readOnly} onChange={(e) => setDraft({ ...draft, user: e.target.value })} placeholder="you@yourdomain.com" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Password {settings.data?.passwordSet && <span className="font-normal text-muted-foreground">(saved — leave blank to keep)</span>}</Label>
                  <Input
                    type="password"
                    value={draft.password}
                    disabled={readOnly}
                    onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                    placeholder={settings.data?.passwordSet ? "••••••••" : "App password or SMTP password"}
                  />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label>From address</Label>
                  <Input
                    value={draft.fromAddress}
                    disabled={readOnly}
                    onChange={(e) => setDraft({ ...draft, fromAddress: e.target.value })}
                    placeholder='TimeSphere <no-reply@yourdomain.com>'
                  />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium">Use TLS (port 465)</p>
                  <p className="text-xs text-muted-foreground">Off for STARTTLS on port 587 (most providers, including Gmail) — on for implicit TLS on 465.</p>
                </div>
                <Switch checked={draft.secure} onCheckedChange={(value) => setDraft({ ...draft, secure: value })} disabled={readOnly} />
              </div>

              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => save.mutate()} disabled={save.isPending}>
                    {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save
                  </Button>
                  <Button variant="outline" onClick={() => testConnection.mutate()} disabled={testConnection.isPending || !draft.host}>
                    {testConnection.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}Test connection
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TransportStatusBanner({ status, loading }: { status?: import("../../services/api").MailTransportStatus; loading: boolean }) {
  if (loading || !status) return null;

  if (!status.configured) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>No SMTP configured anywhere — emails will NOT be delivered</AlertTitle>
        <AlertDescription>
          Neither this page nor <code>apps/api/.env</code> has SMTP credentials set. Fill in the form below, or set{" "}
          <code>SMTP_HOST</code>/<code>SMTP_PORT</code>/<code>SMTP_USER</code>/<code>SMTP_PASS</code> in <code>apps/api/.env</code> and restart.
        </AlertDescription>
      </Alert>
    );
  }

  if (status.verified === false) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>SMTP transport reachable but verification failed</AlertTitle>
        <AlertDescription>
          <p>
            Connected to <strong>{status.host}:{status.port}</strong> (secure: {String(status.secure)}, user: {status.user ?? "—"}, source:{" "}
            <Badge variant="muted">{status.configSource}</Badge>) but authentication or TLS negotiation failed:
          </p>
          <p className="mt-2 rounded-md bg-background/40 p-2 font-mono text-xs">{status.verifyError}</p>
        </AlertDescription>
      </Alert>
    );
  }

  if (status.fromIssues.length > 0) {
    return (
      <Alert variant="warning">
        <AlertCircle />
        <AlertTitle>SMTP works but the From address will likely be dropped or marked as spam</AlertTitle>
        <AlertDescription>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {status.fromIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="success">
      <ServerCog />
      <AlertTitle>SMTP transport verified</AlertTitle>
      <AlertDescription>
        Sending via <strong>{status.host}:{status.port}</strong> as <strong>{status.from}</strong> — source: <Badge variant="info">{status.configSource}</Badge>
      </AlertDescription>
    </Alert>
  );
}

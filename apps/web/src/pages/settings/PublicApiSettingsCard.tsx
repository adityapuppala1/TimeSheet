/**
 * WHAT: the "Public API" tab in Workspace Settings — generate/revoke bearer API keys for
 * `GET/POST /api/public/v1/*` (external integrations reading or creating tickets/timesheets),
 * and configure outbound webhooks that fire on ticket/timesheet events.
 * WHY split into its own file: same reasoning as SecurityDevOpsSettingsCard.tsx's header
 * comment — each settings domain gets its own file rather than growing WorkspaceSettings.tsx.
 * WHY keys/secrets are only ever shown once: same write-only-secret convention as every other
 * generated credential in this app (security-ingestion token, BYOK AI key, IMAP password) —
 * copy it now, or revoke/regenerate if you lose it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, KeyRound, Plus, RotateCcw, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { apiKeyScopes, outboundWebhookEvents, type ApiKeyScope, type OutboundWebhookEvent } from "@timesheet/shared";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { SERVER_ORIGIN, settingsApi, type WebhookDeliveryRow } from "../../services/api";
import { copyText } from "../../lib/clipboard";

const EVENT_LABEL: Record<OutboundWebhookEvent, string> = {
  "ticket.created": "Ticket created",
  "ticket.status_changed": "Ticket status changed",
  "ticket.closed": "Ticket closed",
  "timesheet.submitted": "Timesheet submitted",
  "timesheet.approved": "Timesheet approved"
};

function CopyableSecret({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          copyText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

const DELIVERY_STATUS_TONE: Record<WebhookDeliveryRow["status"], string> = {
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  exhausted: "bg-destructive/10 text-destructive",
  delivered: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
};

/** Collapsed by default — most webhooks have nothing to show here, and this is a secondary
 *  concern next to the delivery-status summary already on the row. See
 *  workers/webhook-retry.worker.ts for what "pending" (awaiting the next automatic retry) vs.
 *  "exhausted" (hit the attempt cap, needs a human's attention) actually mean. */
function WebhookDeliveries({ webhookId, readOnly }: { webhookId: string; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const deliveries = useQuery({
    queryKey: ["settings", "webhooks", webhookId, "deliveries"],
    queryFn: () => settingsApi.listWebhookDeliveries(webhookId),
    enabled: open
  });
  const retry = useMutation({
    mutationFn: (deliveryId: string) => settingsApi.retryWebhookDelivery(webhookId, deliveryId),
    onSuccess: (result) => {
      toast[result.status === "delivered" ? "success" : "error"](
        result.status === "delivered" ? "Delivered" : "Still failing — scheduled for another automatic retry"
      );
      queryClient.invalidateQueries({ queryKey: ["settings", "webhooks", webhookId, "deliveries"] });
    },
    onError: () => toast.error("Could not retry delivery", { description: "Try again." })
  });

  const rows = deliveries.data ?? [];

  return (
    <div className="mt-1">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Failed deliveries
      </button>
      {open && (
        <div className="mt-1.5 grid gap-1.5">
          {deliveries.isLoading && <Skeleton className="h-8 w-full" />}
          {!deliveries.isLoading && rows.length === 0 && (
            <p className="text-xs text-muted-foreground">Nothing pending or exhausted — every recent delivery succeeded.</p>
          )}
          {rows.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs">
              <Badge className={DELIVERY_STATUS_TONE[d.status]} variant="secondary">
                {d.status}
              </Badge>
              <span className="font-medium">{d.event}</span>
              <span className="text-muted-foreground">attempt {d.attempt}</span>
              {d.lastError && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={d.lastError}>
                  <AlertTriangle className="mr-1 inline h-3 w-3 text-destructive" />
                  {d.lastError}
                </span>
              )}
              {d.nextAttemptAt && d.status === "pending" && (
                <span className="text-muted-foreground">next try {new Date(d.nextAttemptAt).toLocaleTimeString()}</span>
              )}
              {!readOnly && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 px-2"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(d.id)}
                >
                  <RotateCcw className="h-3 w-3" />
                  Retry now
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PublicApiSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["settings", "api-keys"], queryFn: settingsApi.listApiKeys });
  const webhooks = useQuery({ queryKey: ["settings", "webhooks"], queryFn: settingsApi.listWebhooks });

  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScope, setNewKeyScope] = useState<ApiKeyScope>("READ");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const createKey = useMutation({
    mutationFn: () => settingsApi.createApiKey({ name: newKeyName.trim(), scope: newKeyScope }),
    onSuccess: (created) => {
      setRevealedKey(created.key);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: ["settings", "api-keys"] });
    },
    onError: (err: any) => toast.error("Could not create key", { description: err?.response?.data?.message ?? "Try again." })
  });
  const revokeKey = useMutation({
    mutationFn: (id: string) => settingsApi.revokeApiKey(id),
    onSuccess: () => {
      toast.success("Key revoked");
      queryClient.invalidateQueries({ queryKey: ["settings", "api-keys"] });
    },
    onError: () => toast.error("Could not revoke key", { description: "Try again." })
  });

  const [newHookName, setNewHookName] = useState("");
  const [newHookUrl, setNewHookUrl] = useState("");
  const [newHookEvents, setNewHookEvents] = useState<OutboundWebhookEvent[]>([]);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const createWebhook = useMutation({
    mutationFn: () => settingsApi.createWebhook({ name: newHookName.trim(), url: newHookUrl.trim(), events: newHookEvents }),
    onSuccess: (created) => {
      setRevealedSecret(created.secret);
      setNewHookName("");
      setNewHookUrl("");
      setNewHookEvents([]);
      queryClient.invalidateQueries({ queryKey: ["settings", "webhooks"] });
    },
    onError: (err: any) => toast.error("Could not create webhook", { description: err?.response?.data?.message ?? "Try again." })
  });
  const toggleWebhook = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => settingsApi.updateWebhook(id, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "webhooks"] }),
    onError: () => toast.error("Could not update webhook", { description: "Try again." })
  });
  const deleteWebhook = useMutation({
    mutationFn: (id: string) => settingsApi.deleteWebhook(id),
    onSuccess: () => {
      toast.success("Webhook removed");
      queryClient.invalidateQueries({ queryKey: ["settings", "webhooks"] });
    },
    onError: () => toast.error("Could not remove webhook", { description: "Try again." })
  });

  const apiBaseUrl = `${SERVER_ORIGIN || window.location.origin}/api/public/v1`;

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" />
            API keys
          </CardTitle>
          <CardDescription>
            Bearer keys for <code className="rounded bg-muted px-1 py-0.5 text-xs">{apiBaseUrl}</code> — read
            tickets/timesheets, or (write-scoped) create a ticket. See docs/API.md's "Public API" section for the
            full endpoint reference.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {keys.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              {revealedKey && (
                <div className="grid gap-1.5 rounded-md border border-warning/40 bg-warning/5 p-3">
                  <p className="text-xs font-semibold text-warning">
                    Copy this key now — it won't be shown again.
                  </p>
                  <CopyableSecret value={revealedKey} />
                </div>
              )}
              <div className="grid gap-1.5">
                {(keys.data ?? []).filter((k) => !k.revokedAt).map((k) => (
                  <div key={k.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <span className="font-medium">{k.name}</span>
                    <code className="text-xs text-muted-foreground">{k.keyPrefix}…</code>
                    <Badge variant={k.scope === "WRITE" ? "warning" : "muted"}>{k.scope}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "Never used"}
                    </span>
                    {!readOnly && (
                      <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => revokeKey.mutate(k.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
                {(keys.data ?? []).filter((k) => !k.revokedAt).length === 0 && (
                  <p className="py-2 text-center text-sm text-muted-foreground">No active API keys yet.</p>
                )}
              </div>
              {!readOnly && (
                <div className="flex gap-2">
                  <Input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="Key name (e.g. Zapier)" />
                  <Select value={newKeyScope} onValueChange={(v) => setNewKeyScope(v as ApiKeyScope)}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {apiKeyScopes.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" disabled={!newKeyName.trim() || createKey.isPending} onClick={() => createKey.mutate()}>
                    <Plus className="h-4 w-4" />Generate
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Webhook className="h-4 w-4 text-primary" />
            Outbound webhooks
          </CardTitle>
          <CardDescription>
            POST a signed JSON payload to your own endpoint when a subscribed event happens. Verify
            <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">X-TimeSphere-Signature</code>
            (HMAC-SHA256 of the raw body, using the secret shown once below) before trusting a delivery.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {webhooks.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              {revealedSecret && (
                <div className="grid gap-1.5 rounded-md border border-warning/40 bg-warning/5 p-3">
                  <p className="text-xs font-semibold text-warning">
                    Copy this signing secret now — it won't be shown again.
                  </p>
                  <CopyableSecret value={revealedSecret} />
                </div>
              )}
              <div className="grid gap-1.5">
                {(webhooks.data ?? []).map((hook) => (
                  <div key={hook.id} className="grid gap-1 rounded-md border border-border px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{hook.name}</span>
                      <Badge variant={hook.isActive ? "success" : "muted"}>{hook.isActive ? "Active" : "Paused"}</Badge>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {hook.lastDeliveryAt
                          ? `Last delivery: ${hook.lastDeliveryStatus} (${new Date(hook.lastDeliveryAt).toLocaleString()})`
                          : "No deliveries yet"}
                      </span>
                      {!readOnly && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => toggleWebhook.mutate({ id: hook.id, isActive: !hook.isActive })}>
                            {hook.isActive ? "Pause" : "Resume"}
                          </Button>
                          <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => deleteWebhook.mutate(hook.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                    <code className="truncate text-xs text-muted-foreground">{hook.url}</code>
                    <div className="flex flex-wrap gap-1">
                      {hook.events.map((e) => (
                        <Badge key={e} variant="muted">{EVENT_LABEL[e]}</Badge>
                      ))}
                    </div>
                    <WebhookDeliveries webhookId={hook.id} readOnly={readOnly} />
                  </div>
                ))}
                {(webhooks.data ?? []).length === 0 && (
                  <p className="py-2 text-center text-sm text-muted-foreground">No webhooks configured yet.</p>
                )}
              </div>
              {!readOnly && (
                <div className="grid gap-2 rounded-md border border-dashed border-border p-3">
                  <div className="flex gap-2">
                    <Input value={newHookName} onChange={(e) => setNewHookName(e.target.value)} placeholder="Webhook name" />
                    <Input value={newHookUrl} onChange={(e) => setNewHookUrl(e.target.value)} placeholder="https://your-endpoint.example.com/hook" />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {outboundWebhookEvents.map((e) => (
                      <label key={e} className="flex items-center gap-1.5 text-sm">
                        <Checkbox
                          checked={newHookEvents.includes(e)}
                          onCheckedChange={(checked) =>
                            setNewHookEvents((prev) => (checked ? [...prev, e] : prev.filter((x) => x !== e)))
                          }
                        />
                        {EVENT_LABEL[e]}
                      </label>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    className="justify-self-start"
                    disabled={!newHookName.trim() || !newHookUrl.trim() || newHookEvents.length === 0 || createWebhook.isPending}
                    onClick={() => createWebhook.mutate()}
                  >
                    <Plus className="h-4 w-4" />Add webhook
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

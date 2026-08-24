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

/**
 * How long a new key should live.
 *
 * OFFERED AS A DURATION, NOT A DATE PICKER, on purpose: the question an admin is actually asking
 * is "how long should this integration keep working", and a calendar makes them do arithmetic to
 * answer it. The absolute instant is computed here and sent as `expiresAt`, because the SERVER must
 * own what the date means — a duration sent to the API would be re-interpreted against the server's
 * clock and could land somewhere the admin never saw.
 *
 * "Never" is kept and is NOT the default. It has to exist: every key issued before expiry existed
 * is non-expiring, and some integrations genuinely are permanent fixtures. But defaulting to it is
 * what made this a finding in the first place, so the default is 90 days and choosing forever is a
 * deliberate act.
 */
const KEY_LIFETIMES = [
  { value: "30", label: "Expires in 30 days" },
  { value: "90", label: "Expires in 90 days" },
  { value: "365", label: "Expires in 1 year" },
  { value: "never", label: "Never expires" }
] as const;

type KeyLifetime = (typeof KEY_LIFETIMES)[number]["value"];

/** `undefined` for "never" — the field is omitted from the request rather than sent as null. */
function expiryFromLifetime(lifetime: KeyLifetime): string | undefined {
  if (lifetime === "never") return undefined;
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + Number(lifetime));
  return expiry.toISOString();
}

/**
 * The at-a-glance state of a key's expiry, in the list.
 *
 * An EXPIRED key still appears here — it is not revoked, so it is still a row in the table, and
 * silently rendering it identically to a working one is how someone spends an afternoon debugging
 * an integration that the server is refusing on purpose. The 14-day warning exists so that
 * afternoon is pre-empted rather than merely explained afterwards.
 */
function expiryBadge(expiresAt: string | null) {
  if (!expiresAt) return null;
  const when = new Date(expiresAt);
  const days = Math.ceil((when.getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return <Badge variant="destructive">Expired</Badge>;
  if (days <= 14) return <Badge variant="warning">Expires in {days}d</Badge>;
  return (
    <span className="text-xs text-muted-foreground">Expires {when.toLocaleDateString()}</span>
  );
}

export function PublicApiSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["settings", "api-keys"], queryFn: settingsApi.listApiKeys });
  const webhooks = useQuery({ queryKey: ["settings", "webhooks"], queryFn: settingsApi.listWebhooks });

  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScope, setNewKeyScope] = useState<ApiKeyScope>("READ");
  const [newKeyLifetime, setNewKeyLifetime] = useState<KeyLifetime>("90");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const createKey = useMutation({
    mutationFn: () =>
      settingsApi.createApiKey({
        name: newKeyName.trim(),
        scope: newKeyScope,
        // Omitted entirely for "never" — the server reads a missing field as "no expiry", which is
        // also what every key issued before expiry existed carries.
        expiresAt: expiryFromLifetime(newKeyLifetime)
      }),
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
                    {expiryBadge(k.expiresAt)}
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
              {/* `flex-wrap`, and the name field allowed to shrink, because this row grew a third
                  control (the lifetime picker) and a 390px phone cannot seat Input + w-32 + w-36 +
                  button on one line — it pushed Workspace Settings 9px past the viewport, which is
                  exactly what responsive.spec.ts's "no tab widens the page" guard exists to catch.
                  `min-w-0` on the input is the load-bearing half: a flex item refuses to shrink
                  below its intrinsic content width without it, so wrapping alone would not have been
                  enough. Same fix, same reason, as the 3.1.0 maintenance-tile overflow. */}
              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  <Input
                    className="min-w-0 flex-1 basis-48"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Key name (e.g. Zapier)"
                  />
                  <Select value={newKeyScope} onValueChange={(v) => setNewKeyScope(v as ApiKeyScope)}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {apiKeyScopes.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={newKeyLifetime} onValueChange={(v) => setNewKeyLifetime(v as KeyLifetime)}>
                    <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {KEY_LIFETIMES.map((l) => (
                        <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
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

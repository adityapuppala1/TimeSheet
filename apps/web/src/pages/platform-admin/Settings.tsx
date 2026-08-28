/**
 * Platform settings: the relay the deployment sends from, who can sign in to this console, the
 * sessions this account holds elsewhere, and the control-plane audit trail. Stripe lives with the
 * plan tiers it prices; the retention policy lives on the retention page next to its queue.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, ListChecks, MonitorSmartphone, Plus, Send, ServerCog, ShieldCheck, UserX } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { toast } from "../../components/ui/toaster";
import { platformAdminConsoleApi, type PlatformMailSettings } from "../../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../../store/platform-admin-auth";
import { ConsolePage, ConsoleSection, EmptyState, shortDateTime } from "./console-ui";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

/* ----------------------------------------------------------------------------------------- */
/* Mail server                                                                                */
/* ----------------------------------------------------------------------------------------- */

function MailServerCard({ settings }: { settings: PlatformMailSettings }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ host: settings.host, port: String(settings.port), secure: settings.secure, user: settings.user, password: "", fromAddress: settings.fromAddress, replyTo: settings.replyTo });
  const [testTo, setTestTo] = useState("");
  const save = useMutation({
    mutationFn: () =>
      platformAdminConsoleApi.updateMailSettings({
        host: form.host,
        port: Number(form.port),
        secure: form.secure,
        user: form.user,
        ...(form.password ? { password: form.password } : {}),
        fromAddress: form.fromAddress,
        replyTo: form.replyTo
      }),
    onSuccess: () => {
      toast.success("Mail settings saved");
      setForm((f) => ({ ...f, password: "" }));
      queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
    },
    onError: (e) => toast.error("Could not save", { description: errorMessageOf(e) })
  });
  const test = useMutation({
    mutationFn: () => platformAdminConsoleApi.testMail(testTo),
    onSuccess: (r) => toast.success(`Test sent to ${r.to}`),
    onError: (e) => toast.error("Test NOT delivered", { description: errorMessageOf(e) })
  });
  const eff = settings.effective;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <ServerCog className="h-4 w-4 text-muted-foreground" />
        {eff.configured ? (
          <>
            <span>
              Sending through <span className="font-mono">{eff.host}:{eff.port}</span> as <span className="font-mono">{eff.from}</span>
            </span>
            <Badge variant={eff.source === "database" ? "info" : "muted"}>{eff.source === "database" ? "from these settings" : "from apps/api/.env"}</Badge>
          </>
        ) : (
          <span className="text-warning">No relay configured — every platform email is recorded as skipped until one is.</span>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="pm-host">SMTP host</Label>
          <Input id="pm-host" value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} placeholder="smtp.example.com" />
        </div>
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pm-port">Port</Label>
            <Input id="pm-port" type="number" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
          </div>
          <label className="flex h-10 items-center gap-2 text-sm">
            <Switch checked={form.secure} onCheckedChange={(v) => setForm((f) => ({ ...f, secure: v }))} />
            TLS (465)
          </label>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pm-user">Username</Label>
          <Input id="pm-user" value={form.user} onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))} autoComplete="off" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pm-pass" className="flex items-center gap-2">
            Password {settings.passwordSet && <Badge variant="success">set</Badge>}
          </Label>
          <Input id="pm-pass" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder={settings.passwordSet ? "•••••••• (leave blank to keep)" : ""} autoComplete="new-password" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pm-from">From address</Label>
          <Input id="pm-from" value={form.fromAddress} onChange={(e) => setForm((f) => ({ ...f, fromAddress: e.target.value }))} placeholder="TimeSphere <no-reply@timesphere.app>" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pm-reply">Reply-to (optional)</Label>
          <Input id="pm-reply" value={form.replyTo} onChange={(e) => setForm((f) => ({ ...f, replyTo: e.target.value }))} placeholder="hello@timesphere.app" />
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-4">
        <div className="flex items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="pm-test" className="text-xs">
              Send a test to
            </Label>
            <Input id="pm-test" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" className="h-9 w-64" />
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={!testTo.includes("@") || test.isPending} onClick={() => test.mutate()}>
            <Send className="h-3.5 w-3.5" />
            {test.isPending ? "Sending…" : "Send test"}
          </Button>
        </div>
        <Button size="sm" className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save mail settings"}
        </Button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Platform admins                                                                            */
/* ----------------------------------------------------------------------------------------- */

function AdminsCard() {
  const queryClient = useQueryClient();
  const me = usePlatformAdminAuthStore((s) => s.admin);
  const admins = useQuery({ queryKey: ["platform-admin", "admins"], queryFn: platformAdminConsoleApi.admins });
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ email: "", name: "" });
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => platformAdminConsoleApi.createAdmin(form),
    onSuccess: (r) => {
      setCreated({ email: r.email, temporaryPassword: r.temporaryPassword });
      setForm({ email: "", name: "" });
      queryClient.invalidateQueries({ queryKey: ["platform-admin", "admins"] });
    },
    onError: (e) => toast.error("Could not create", { description: errorMessageOf(e) })
  });
  const setStatus = useMutation({
    mutationFn: (args: { id: string; status: "ACTIVE" | "INACTIVE" }) => platformAdminConsoleApi.setAdminStatus(args.id, args.status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platform-admin", "admins"] }),
    onError: (e) => toast.error("Not changed", { description: errorMessageOf(e) })
  });
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <Button size="sm" className="gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />New platform admin
        </Button>
      </div>
      {admins.isLoading && <Skeleton className="h-40 w-full" />}
      {admins.data && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="text-right">Live sessions</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {admins.data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">
                    {a.name}
                    {a.id === me?.id && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{a.email}</TableCell>
                  <TableCell>
                    <Badge variant={a.status === "ACTIVE" ? "success" : "muted"}>{a.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{a.lastLoginAt ? shortDateTime(a.lastLoginAt) : "never"}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{a.liveSessions}</TableCell>
                  <TableCell className="text-right">
                    {a.id !== me?.id && (
                      <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => setStatus.mutate({ id: a.id, status: a.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" })} disabled={setStatus.isPending}>
                        {a.status === "ACTIVE" ? (
                          <>
                            <UserX className="h-3.5 w-3.5" />Deactivate
                          </>
                        ) : (
                          <>
                            <ShieldCheck className="h-3.5 w-3.5" />Reactivate
                          </>
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setCreated(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New platform admin</DialogTitle>
            <DialogDescription>A generated one-time password is shown once. They change it on first sign-in — the console nags them until they do.</DialogDescription>
          </DialogHeader>
          {!created ? (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="pa-new-name">Name</Label>
                <Input id="pa-new-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="pa-new-email">Email</Label>
                <Input id="pa-new-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button className="bg-accent text-accent-foreground hover:bg-accent/90" disabled={form.name.length < 2 || !form.email.includes("@") || create.isPending} onClick={() => create.mutate()}>
                  {create.isPending ? "Creating…" : "Create"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="grid gap-3">
              <p className="text-sm">
                <span className="font-medium">{created.email}</span> can sign in with this password, once:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 select-all rounded-md border border-accent/40 bg-muted px-3 py-2 font-mono text-base tracking-wide">{created.temporaryPassword}</code>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => {
                    navigator.clipboard?.writeText(created.temporaryPassword).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1800);
                    });
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <DialogFooter>
                <Button className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => setCreateOpen(false)}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Sessions + audit                                                                           */
/* ----------------------------------------------------------------------------------------- */

function SessionsCard() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ["platform-admin", "sessions"], queryFn: platformAdminConsoleApi.sessions });
  const end = useMutation({
    mutationFn: (id: string) => platformAdminConsoleApi.endSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platform-admin", "sessions"] }),
    onError: (e) => toast.error("Not ended", { description: errorMessageOf(e) })
  });
  if (sessions.isLoading) return <Skeleton className="h-32 w-full" />;
  if (!sessions.data?.length) return <EmptyState title="No live sessions" />;
  return (
    <ul className="divide-y divide-border">
      {sessions.data.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm">
              <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">{s.userAgent ?? "unknown client"}</span>
              {s.current && <Badge variant="info">this one</Badge>}
            </p>
            <p className="text-xs text-muted-foreground">
              {s.ipAddress ?? "—"} · started {shortDateTime(s.createdAt)} · expires {shortDateTime(s.expiresAt)}
            </p>
          </div>
          {!s.current && (
            <Button size="sm" variant="outline" className="h-7" onClick={() => end.mutate(s.id)} disabled={end.isPending}>
              End session
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function AuditCard() {
  const audit = useQuery({ queryKey: ["platform-admin", "audit"], queryFn: () => platformAdminConsoleApi.audit({ limit: 120 }) });
  if (audit.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!audit.data?.length) return <EmptyState title="Nothing recorded yet" />;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Entity</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {audit.data.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{shortDateTime(r.createdAt)}</TableCell>
              <TableCell className="font-mono text-xs">{r.action}</TableCell>
              <TableCell className="text-xs">
                {r.entity}
                {r.entityId && <span className="ml-1 font-mono text-[10px] text-muted-foreground">{r.entityId.slice(0, 8)}</span>}
              </TableCell>
              <TableCell className="text-xs">
                <Badge variant={r.actorType === "SYSTEM" ? "muted" : r.actorType === "CUSTOMER" ? "info" : "success"}>{r.actorType.toLowerCase().replace("_", " ")}</Badge>
                {r.actorLabel && <span className="ml-1.5 text-muted-foreground">{r.actorLabel}</span>}
              </TableCell>
              <TableCell className="max-w-[360px] truncate font-mono text-[11px] text-muted-foreground" title={r.metadata ? JSON.stringify(r.metadata) : ""}>
                {r.metadata ? JSON.stringify(r.metadata) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function PlatformAdminSettings() {
  const mail = useQuery({ queryKey: ["platform-admin", "mail-settings"], queryFn: platformAdminConsoleApi.mailSettings });
  return (
    <ConsolePage eyebrow="Platform" title="Settings" description="The relay the platform sends from, who can open this console, your other sessions, and everything the control plane has recorded.">
      <Tabs defaultValue="mail" className="grid gap-4">
        <TabsList className="w-fit">
          <TabsTrigger value="mail" className="gap-1.5">
            <ServerCog className="h-3.5 w-3.5" />Mail server
          </TabsTrigger>
          <TabsTrigger value="admins" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />Platform admins
          </TabsTrigger>
          <TabsTrigger value="sessions" className="gap-1.5">
            <MonitorSmartphone className="h-3.5 w-3.5" />My sessions
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5">
            <ListChecks className="h-3.5 w-3.5" />Audit trail
          </TabsTrigger>
        </TabsList>
        <TabsContent value="mail">
          <ConsoleSection title="Platform mail server" description="Used for signup codes and the retention programme — anything sent to somebody whose workspace is not there to send from. Falls back to the SMTP_* variables in apps/api/.env when empty.">
            {mail.isLoading && <Skeleton className="h-64 w-full" />}
            {mail.data && <MailServerCard key={mail.data.updatedAt ?? "initial"} settings={mail.data} />}
          </ConsoleSection>
        </TabsContent>
        <TabsContent value="admins">
          <ConsoleSection title="Platform admins" description="Accounts that can open this console. Separate from every tenant; a compromised tenant database can never yield one of these.">
            <AdminsCard />
          </ConsoleSection>
        </TabsContent>
        <TabsContent value="sessions">
          <ConsoleSection title="Your sessions" description="Everywhere this account is signed in. Ending one signs that browser out on its next request.">
            <SessionsCard />
          </ConsoleSection>
        </TabsContent>
        <TabsContent value="audit">
          <ConsoleSection title="Control-plane audit trail" description="Actions taken on tenants from outside them — provisioning, rescues, retention decisions, settings changes — and what customers did through the retention emails.">
            <AuditCard />
          </ConsoleSection>
        </TabsContent>
      </Tabs>
    </ConsolePage>
  );
}

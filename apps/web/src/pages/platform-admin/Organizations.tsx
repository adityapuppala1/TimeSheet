/**
 * WHAT: the platform-admin console's org lifecycle screen — table of every tenant org
 * (PROVISIONING/ACTIVE/SUSPENDED/ARCHIVED), create-new-org, and (for a PROVISIONING org) the
 * "Provision" action that physically stands up its database.
 * WHY provisioning is a separate explicit step from creation: creating the control-plane
 * `Organization` row and physically creating+migrating+seeding its database are different
 * blast-radius operations — see `services/provisioning.service.ts`'s header for why every step
 * of the latter is deliberately retry-safe.
 * WHO calls the backing API: `controllers/platform-admin.controller.ts`, via `platformAdminOrgApi`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Check, Copy, LifeBuoy, Plus } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { DataTable } from "../../components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { DomainsDialog } from "./DomainsDialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { platformAdminOrgApi, type OrgListRow, type OrgStatus, type PlanTier, type ResetAdminPasswordResult } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, OrgStatusPill } from "./console-ui";

/* The status pill is `console-ui.tsx`'s `OrgStatusPill` now — one map for the whole console. The
   local copy here was missing GRACE entirely (it renders `undefined` as a variant), which is
   exactly the drift a shared component removes. */

export function PlatformAdminOrganizations() {
  const queryClient = useQueryClient();
  const orgs = useQuery({ queryKey: ["platform-admin", "organizations"], queryFn: platformAdminOrgApi.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<OrgListRow | null>(null);
  const [provisioning, setProvisioning] = useState<OrgListRow | null>(null);
  const [domainsFor, setDomainsFor] = useState<OrgListRow | null>(null);
  const [rescuing, setRescuing] = useState<OrgListRow | null>(null);

  const columns: ColumnDef<OrgListRow, any>[] = [
    { accessorKey: "name", header: "Name", cell: (info) => <span className="font-medium text-foreground">{info.getValue()}</span> },
    { accessorKey: "slug", header: "Slug", cell: (info) => <span className="font-mono text-xs text-muted-foreground">{info.getValue()}</span> },
    { accessorKey: "status", header: "Status", cell: (info) => <OrgStatusPill status={info.getValue() as OrgStatus} /> },
    { accessorKey: "planTier", header: "Plan", cell: (info) => <Badge variant="info">{info.getValue() as string}</Badge> },
    {
      id: "database",
      accessorFn: (row) => (row.database ? `${row.database.host} / ${row.database.databaseName}` : "Not provisioned"),
      header: "Database",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.database ? `${row.original.database.host} / ${row.original.database.databaseName}` : "Not provisioned"}
        </span>
      )
    },
    {
      id: "actions",
      header: () => <span className="block text-right">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          {row.original.status === "PROVISIONING" && (
            <Button size="sm" className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => setProvisioning(row.original)}>
              Provision
            </Button>
          )}
          {/* Only for a workspace that is actually serving traffic. A custom domain on a
              PROVISIONING or ARCHIVED org points at nothing, and offering it there invites
              somebody to spend a DNS change on a workspace that cannot answer. */}
          {row.original.status !== "PROVISIONING" && (
            <Button
              size="sm"
              variant="outline"
              className="border-border text-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setDomainsFor(row.original)}
            >
              Domains
            </Button>
          )}
          {/* Only an ACTIVE workspace has an administrator to rescue; a suspended one is a
              billing conversation, not a password one, and the server refuses it anyway. */}
          {row.original.status === "ACTIVE" && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 border-border text-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setRescuing(row.original)}
            >
              <LifeBuoy className="h-3.5 w-3.5" />Rescue admin
            </Button>
          )}
          <Button size="sm" variant="outline" className="border-border text-foreground hover:bg-muted hover:text-foreground" onClick={() => setEditing(row.original)}>
            Manage
          </Button>
        </div>
      )
    }
  ];

  return (
    <ConsolePage
      eyebrow="Tenants"
      title="Organizations"
      description="Every tenant on the platform — lifecycle, plan tier, database registration, custom domains, and the rescue for a locked-out administrator."
      actions={
        <Button className="gap-2 bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />New organization
        </Button>
      }
    >
      <ConsoleSection title="All organizations" description={`${orgs.data?.length ?? 0} total`}>
        {orgs.isLoading && <Skeleton className="h-40 w-full" />}
        {!orgs.isLoading && orgs.data && (
          <DataTable columns={columns} data={orgs.data} searchPlaceholder="Search organizations..." emptyMessage="No organizations yet." pageSize={20} />
        )}
      </ConsoleSection>

      <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={() => queryClient.invalidateQueries({ queryKey: ["platform-admin", "organizations"] })} />
      <EditOrgDialog
        org={editing}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          queryClient.invalidateQueries({ queryKey: ["platform-admin", "organizations"] });
        }}
      />
      <DomainsDialog org={domainsFor} onOpenChange={(open) => !open && setDomainsFor(null)} />
      <RescueAdminDialog org={rescuing} onOpenChange={(open) => !open && setRescuing(null)} />
      <ProvisionOrgDialog
        org={provisioning}
        onOpenChange={(open) => !open && setProvisioning(null)}
        onProvisioned={() => {
          setProvisioning(null);
          queryClient.invalidateQueries({ queryKey: ["platform-admin", "organizations"] });
        }}
      />
    </ConsolePage>
  );
}

function ProvisionOrgDialog({ org, onOpenChange, onProvisioned }: { org: OrgListRow | null; onOpenChange: (open: boolean) => void; onProvisioned: () => void }) {
  if (!org) return null;
  return <ProvisionOrgDialogInner key={org.id} org={org} onOpenChange={onOpenChange} onProvisioned={onProvisioned} />;
}

function ProvisionOrgDialogInner({ org, onOpenChange, onProvisioned }: { org: OrgListRow; onOpenChange: (open: boolean) => void; onProvisioned: () => void }) {
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");

  const provision = useMutation({
    mutationFn: () => platformAdminOrgApi.provision(org.id, { adminEmail, adminName, adminPassword }),
    onSuccess: (result) => {
      toast.success("Organization provisioned", {
        description: [
          `Database "${result.databaseName}" created, migrated, and seeded — the org is now ACTIVE.`,
          result.url ? `Sign-in: ${result.url}` : null,
          // The URL and the welcome are mailed; the password never is — that still travels out-of-band.
          result.welcomeSent
            ? `${adminEmail} has been sent the welcome email with that link. Hand over the initial password separately.`
            : `The welcome email could not be sent — check outbound mail, then give ${adminEmail} the link and initial password out-of-band.`
        ]
          .filter(Boolean)
          .join(" "),
        duration: 12000
      });
      onProvisioned();
    },
    onError: (err: any) => toast.error("Provisioning failed", { description: err?.response?.data?.message ?? "Try again — every step here is safe to retry." })
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card text-foreground">
        <DialogHeader>
          <DialogTitle>
            Provision {org.name} <span className="font-mono text-sm font-normal text-muted-foreground">({org.slug})</span>
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Creates this organization's own database and runs every migration against it. Safe to re-run.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="text-xs text-muted-foreground">
            This physically creates the tenant database, runs every migration against it, seeds baseline roles/settings, and creates the one admin account below — then flips this
            organization ACTIVE. No demo data is included.
          </p>
          <div className="grid gap-1.5">
            <Label className="text-foreground">First admin name</Label>
            <Input className="border-border bg-background text-foreground" value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Jane Doe" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-foreground">First admin email</Label>
            <Input className="border-border bg-background text-foreground" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="jane@acme.com" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-foreground">First admin password</Label>
            <Input type="password" className="border-border bg-background text-foreground" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="At least 8 characters" />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!adminEmail || !adminName || adminPassword.length < 8 || provision.isPending}
            className="bg-accent text-accent-foreground hover:bg-accent/90"
            onClick={() => provision.mutate()}
          >
            {provision.isPending ? "Provisioning..." : "Provision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RescueAdminDialog({ org, onOpenChange }: { org: OrgListRow | null; onOpenChange: (open: boolean) => void }) {
  if (!org) return null;
  return <RescueAdminDialogInner key={org.id} org={org} onOpenChange={onOpenChange} />;
}

/**
 * The console-side rescue for a workspace whose only super admin is locked out. Two screens in one
 * dialog: ask for the email, then show the one-time password — ONCE. It is not kept in any query
 * cache or store; closing the dialog is the end of it, which is the point. The customer replaces
 * it at first sign-in (the tenant app flags `mustChangePassword`).
 */
function RescueAdminDialogInner({ org, onOpenChange }: { org: OrgListRow; onOpenChange: (open: boolean) => void }) {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<ResetAdminPasswordResult | null>(null);
  const [copied, setCopied] = useState(false);

  const rescue = useMutation({
    mutationFn: () => platformAdminOrgApi.resetAdminPassword(org.id, email),
    onSuccess: (data) => setResult(data),
    onError: (err: any) => toast.error("Could not reset that account", { description: err?.response?.data?.message ?? "Try again." })
  });

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Clipboard unavailable - select the password and copy it by hand.");
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card text-foreground">
        <DialogHeader>
          <DialogTitle>
            Rescue an administrator of {org.name} <span className="font-mono text-sm font-normal text-muted-foreground">({org.slug})</span>
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            For a super admin who cannot sign in and cannot use Forgot password. Issues a one-time password and signs them out everywhere.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <>
            <div className="grid gap-4">
              <p className="text-xs text-muted-foreground">
                Only an existing super admin of this workspace can be reset from here - this never creates an account. Confirm who is asking through a channel you
                trust first: you are about to hand out access to their whole workspace.
              </p>
              <div className="grid gap-1.5">
                <Label className="text-foreground">Super admin email</Label>
                <Input className="border-border bg-background text-foreground" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@acme.com" />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={!email.includes("@") || rescue.isPending}
                className="bg-accent text-accent-foreground hover:bg-accent/90"
                onClick={() => rescue.mutate()}
              >
                {rescue.isPending ? "Issuing..." : "Issue one-time password"}
              </Button>
            </DialogFooter>
          </>
        )}

        {result && (
          <>
            <div className="grid gap-4">
              <p className="text-sm text-foreground">
                <span className="font-medium text-foreground">{result.name}</span> ({result.email}) has been signed out everywhere and will be asked to choose a new
                password at sign-in.
              </p>
              <div className="grid gap-1.5">
                <Label className="text-foreground">One-time password - shown once, never stored</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 select-all rounded-md border border-accent/40 bg-background px-3 py-2 font-mono text-base tracking-wide text-accent">
                    {result.temporaryPassword}
                  </code>
                  <Button size="sm" variant="outline" className="gap-1.5 border-border text-foreground hover:bg-muted hover:text-foreground" onClick={copy}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Sign-in: <span className="font-mono text-muted-foreground">{result.url}</span>. Give both to the customer by whatever channel you trust - this dialog will not show
                the password again.
              </p>
            </div>
            <DialogFooter>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateOrgDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [planTier, setPlanTier] = useState<PlanTier>("STARTER");

  const create = useMutation({
    mutationFn: () => platformAdminOrgApi.create({ name, slug, planTier }),
    onSuccess: () => {
      toast.success("Organization created", { description: "Control-plane row created in PROVISIONING status — physical database setup still needs to happen (see Phase B8)." });
      setName("");
      setSlug("");
      setPlanTier("STARTER");
      onOpenChange(false);
      onCreated();
    },
    onError: (err: any) => toast.error("Could not create organization", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card text-foreground">
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Registers a new tenant. It won't have a database until you provision one.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label className="text-foreground">Name</Label>
            <Input className="border-border bg-background text-foreground" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corporation" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-foreground">Slug (subdomain)</Label>
            <Input className="border-border bg-background text-foreground font-mono" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="acme" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-foreground">Plan tier</Label>
            <Select value={planTier} onValueChange={(v) => setPlanTier(v as PlanTier)}>
              <SelectTrigger className="border-border bg-background text-foreground"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="STARTER">Starter</SelectItem>
                <SelectItem value="TEAM">Team</SelectItem>
                <SelectItem value="ENTERPRISE">Enterprise</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            This registers the organization in the control plane only. A platform operator still needs to provision its physical database, run tenant migrations, and seed an initial admin
            user before it can go ACTIVE.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={!name || !slug || create.isPending} className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => create.mutate()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditOrgDialog({ org, onOpenChange, onSaved }: { org: OrgListRow | null; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  if (!org) return null;
  return <EditOrgDialogInner key={org.id} org={org} onOpenChange={onOpenChange} onSaved={onSaved} />;
}

function EditOrgDialogInner({ org, onOpenChange, onSaved }: { org: OrgListRow; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [status, setStatus] = useState<OrgStatus>(org.status);
  const [planTier, setPlanTier] = useState<PlanTier>(org.planTier);
  const [suspendedReason, setSuspendedReason] = useState(org.suspendedReason ?? "");
  const [seatLimitOverride, setSeatLimitOverride] = useState(org.seatLimitOverride?.toString() ?? "");
  const [aiBudgetOverride, setAiBudgetOverride] = useState(org.aiMonthlyBudgetCeilingOverride ?? "");

  const save = useMutation({
    mutationFn: () =>
      platformAdminOrgApi.update(org.id, {
        status,
        planTier,
        suspendedReason: status === "SUSPENDED" ? suspendedReason || null : null,
        seatLimitOverride: seatLimitOverride ? Number(seatLimitOverride) : null,
        aiMonthlyBudgetCeilingOverride: aiBudgetOverride ? Number(aiBudgetOverride) : null
      }),
    onSuccess: () => {
      toast.success("Saved");
      onSaved();
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card text-foreground">
        <DialogHeader>
          <DialogTitle>
            {org.name} <span className="font-mono text-sm font-normal text-muted-foreground">({org.slug})</span>
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Plan tier, status and per-organization limits for this tenant.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="text-foreground">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as OrgStatus)}>
                <SelectTrigger className="border-border bg-background text-foreground"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PROVISIONING">Provisioning</SelectItem>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  {/* GRACE resolves like ACTIVE and is shut everywhere past authentication — the
                      state a lapsed trial or a failed renewal sits in. It was missing here, so an
                      org the lifecycle worker had put in grace could not be read or set back. */}
                  <SelectItem value="GRACE">Grace (lapsed, billing still reachable)</SelectItem>
                  <SelectItem value="SUSPENDED">Suspended</SelectItem>
                  <SelectItem value="ARCHIVED">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-foreground">Plan tier</Label>
              <Select value={planTier} onValueChange={(v) => setPlanTier(v as PlanTier)}>
                <SelectTrigger className="border-border bg-background text-foreground"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="STARTER">Starter</SelectItem>
                  <SelectItem value="TEAM">Team</SelectItem>
                  <SelectItem value="ENTERPRISE">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {status === "SUSPENDED" && (
            <div className="grid gap-1.5">
              <Label className="text-foreground">Suspension reason</Label>
              <Textarea className="border-border bg-background text-foreground" rows={2} value={suspendedReason} onChange={(e) => setSuspendedReason(e.target.value)} />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="text-foreground">Seat limit override</Label>
              <Input
                className="border-border bg-background text-foreground"
                type="number"
                value={seatLimitOverride}
                onChange={(e) => setSeatLimitOverride(e.target.value)}
                placeholder={`Tier default`}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-foreground">AI budget override ($/mo)</Label>
              <Input
                className="border-border bg-background text-foreground"
                type="number"
                value={aiBudgetOverride}
                onChange={(e) => setAiBudgetOverride(e.target.value)}
                placeholder="Tier default"
              />
            </div>
          </div>

          {org.database && (
            <p className="text-xs text-muted-foreground">
              Database: <span className="font-mono">{org.database.host} / {org.database.databaseName}</span>
              {org.database.schemaVersion ? ` — schema ${org.database.schemaVersion}` : " — not yet migrated"}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

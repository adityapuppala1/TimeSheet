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
import { Plus } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { DataTable } from "../../components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { DomainsDialog } from "./DomainsDialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { platformAdminOrgApi, type OrgListRow, type OrgStatus, type PlanTier } from "../../services/platform-admin-api";

// Dark slate/amber chrome, distinct from the app's normal theme (this console is always dark
// regardless of the tenant app's light/dark toggle) — DataTable's default classes use the
// semantic border-border/text-muted-foreground tokens, so this page overrides them via
// className/rowClassName to keep the same visual language the rest of this file already uses.
const DARK_TABLE_CLASSNAME = "[&_thead_tr]:border-slate-800 [&_th]:text-slate-400 [&>div]:border-slate-800";
const DARK_ROW_CLASSNAME = "border-slate-800 hover:bg-slate-800/40";

const STATUS_VARIANT: Record<OrgStatus, "success" | "warning" | "destructive" | "muted"> = {
  ACTIVE: "success",
  PROVISIONING: "warning",
  SUSPENDED: "destructive",
  ARCHIVED: "muted"
};

export function PlatformAdminOrganizations() {
  const queryClient = useQueryClient();
  const orgs = useQuery({ queryKey: ["platform-admin", "organizations"], queryFn: platformAdminOrgApi.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<OrgListRow | null>(null);
  const [provisioning, setProvisioning] = useState<OrgListRow | null>(null);
  const [domainsFor, setDomainsFor] = useState<OrgListRow | null>(null);

  const columns: ColumnDef<OrgListRow, any>[] = [
    { accessorKey: "name", header: "Name", cell: (info) => <span className="font-medium text-slate-100">{info.getValue()}</span> },
    { accessorKey: "slug", header: "Slug", cell: (info) => <span className="font-mono text-xs text-slate-400">{info.getValue()}</span> },
    { accessorKey: "status", header: "Status", cell: (info) => <Badge variant={STATUS_VARIANT[info.getValue() as OrgStatus]}>{info.getValue() as string}</Badge> },
    { accessorKey: "planTier", header: "Plan", cell: (info) => <Badge variant="info">{info.getValue() as string}</Badge> },
    {
      id: "database",
      accessorFn: (row) => (row.database ? `${row.database.host} / ${row.database.databaseName}` : "Not provisioned"),
      header: "Database",
      cell: ({ row }) => (
        <span className="text-xs text-slate-400">
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
            <Button size="sm" className="bg-amber-500 text-slate-950 hover:bg-amber-400" onClick={() => setProvisioning(row.original)}>
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
              className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              onClick={() => setDomainsFor(row.original)}
            >
              Domains
            </Button>
          )}
          <Button size="sm" variant="outline" className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100" onClick={() => setEditing(row.original)}>
            Manage
          </Button>
        </div>
      )
    }
  ];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Organizations</h1>
          <p className="mt-1 text-sm text-slate-400">Every tenant on the platform — lifecycle, plan tier, and database registration.</p>
        </div>
        <Button className="gap-2 bg-amber-500 text-slate-950 hover:bg-amber-400" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />New organization
        </Button>
      </div>

      <Card className="border-slate-800 bg-slate-900/60">
        <CardHeader>
          <CardTitle className="text-base text-slate-100">All organizations</CardTitle>
          <CardDescription className="text-slate-400">{orgs.data?.length ?? 0} total</CardDescription>
        </CardHeader>
        <CardContent>
          {orgs.isLoading && <Skeleton className="h-40 w-full bg-slate-800" />}
          {!orgs.isLoading && orgs.data && (
            <DataTable
              columns={columns}
              data={orgs.data}
              className={DARK_TABLE_CLASSNAME}
              rowClassName={DARK_ROW_CLASSNAME}
              searchPlaceholder="Search organizations..."
              emptyMessage="No organizations yet."
              pageSize={20}
            />
          )}
        </CardContent>
      </Card>

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
      <ProvisionOrgDialog
        org={provisioning}
        onOpenChange={(open) => !open && setProvisioning(null)}
        onProvisioned={() => {
          setProvisioning(null);
          queryClient.invalidateQueries({ queryKey: ["platform-admin", "organizations"] });
        }}
      />
    </div>
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
      <DialogContent className="border-slate-800 bg-slate-900 text-slate-100">
        <DialogHeader>
          <DialogTitle>
            Provision {org.name} <span className="font-mono text-sm font-normal text-slate-500">({org.slug})</span>
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Creates this organization's own database and runs every migration against it. Safe to re-run.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="text-xs text-slate-500">
            This physically creates the tenant database, runs every migration against it, seeds baseline roles/settings, and creates the one admin account below — then flips this
            organization ACTIVE. No demo data is included.
          </p>
          <div className="grid gap-1.5">
            <Label className="text-slate-300">First admin name</Label>
            <Input className="border-slate-700 bg-slate-950 text-slate-100" value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Jane Doe" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-slate-300">First admin email</Label>
            <Input className="border-slate-700 bg-slate-950 text-slate-100" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="jane@acme.com" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-slate-300">First admin password</Label>
            <Input type="password" className="border-slate-700 bg-slate-950 text-slate-100" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="At least 8 characters" />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!adminEmail || !adminName || adminPassword.length < 8 || provision.isPending}
            className="bg-amber-500 text-slate-950 hover:bg-amber-400"
            onClick={() => provision.mutate()}
          >
            {provision.isPending ? "Provisioning..." : "Provision"}
          </Button>
        </DialogFooter>
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
      <DialogContent className="border-slate-800 bg-slate-900 text-slate-100">
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription className="text-slate-400">
            Registers a new tenant. It won't have a database until you provision one.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label className="text-slate-300">Name</Label>
            <Input className="border-slate-700 bg-slate-950 text-slate-100" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corporation" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-slate-300">Slug (subdomain)</Label>
            <Input className="border-slate-700 bg-slate-950 text-slate-100 font-mono" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="acme" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-slate-300">Plan tier</Label>
            <Select value={planTier} onValueChange={(v) => setPlanTier(v as PlanTier)}>
              <SelectTrigger className="border-slate-700 bg-slate-950 text-slate-100"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="STARTER">Starter</SelectItem>
                <SelectItem value="TEAM">Team</SelectItem>
                <SelectItem value="ENTERPRISE">Enterprise</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-slate-500">
            This registers the organization in the control plane only. A platform operator still needs to provision its physical database, run tenant migrations, and seed an initial admin
            user before it can go ACTIVE.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={!name || !slug || create.isPending} className="bg-amber-500 text-slate-950 hover:bg-amber-400" onClick={() => create.mutate()}>
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
      <DialogContent className="border-slate-800 bg-slate-900 text-slate-100">
        <DialogHeader>
          <DialogTitle>
            {org.name} <span className="font-mono text-sm font-normal text-slate-500">({org.slug})</span>
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Plan tier, status and per-organization limits for this tenant.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="text-slate-300">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as OrgStatus)}>
                <SelectTrigger className="border-slate-700 bg-slate-950 text-slate-100"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PROVISIONING">Provisioning</SelectItem>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="SUSPENDED">Suspended</SelectItem>
                  <SelectItem value="ARCHIVED">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-slate-300">Plan tier</Label>
              <Select value={planTier} onValueChange={(v) => setPlanTier(v as PlanTier)}>
                <SelectTrigger className="border-slate-700 bg-slate-950 text-slate-100"><SelectValue /></SelectTrigger>
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
              <Label className="text-slate-300">Suspension reason</Label>
              <Textarea className="border-slate-700 bg-slate-950 text-slate-100" rows={2} value={suspendedReason} onChange={(e) => setSuspendedReason(e.target.value)} />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="text-slate-300">Seat limit override</Label>
              <Input
                className="border-slate-700 bg-slate-950 text-slate-100"
                type="number"
                value={seatLimitOverride}
                onChange={(e) => setSeatLimitOverride(e.target.value)}
                placeholder={`Tier default`}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-slate-300">AI budget override ($/mo)</Label>
              <Input
                className="border-slate-700 bg-slate-950 text-slate-100"
                type="number"
                value={aiBudgetOverride}
                onChange={(e) => setAiBudgetOverride(e.target.value)}
                placeholder="Tier default"
              />
            </div>
          </div>

          {org.database && (
            <p className="text-xs text-slate-500">
              Database: <span className="font-mono">{org.database.host} / {org.database.databaseName}</span>
              {org.database.schemaVersion ? ` — schema ${org.database.schemaVersion}` : " — not yet migrated"}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} className="bg-amber-500 text-slate-950 hover:bg-amber-400" onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

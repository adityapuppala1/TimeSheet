/**
 * WHAT: the platform-admin console's org lifecycle screen — table of every tenant org
 * (PROVISIONING/ACTIVE/GRACE/SUSPENDED/ARCHIVED), create-new-org, and (for a PROVISIONING org) the
 * "Provision" action that physically stands up its database.
 * WHY provisioning is a separate explicit step from creation: creating the control-plane
 * `Organization` row and physically creating+migrating+seeding its database are different
 * blast-radius operations — see `services/provisioning.service.ts`'s header for why every step
 * of the latter is deliberately retry-safe.
 * WHO calls the backing API: `controllers/platform-admin.controller.ts`, via `platformAdminOrgApi`.
 *
 * WHY THIS PAGE NO LONGER RENDERS `<DataTable>` (the 3.12.x console layout pass): DataTable is the
 * app-wide table and owns its own geometry — a `<Table>` with no minimum width, plus a phone
 * card-list fallback. Neither is right in this console. With no minimum width the six columns
 * squashed into three-line wraps at 1024px instead of the container scrolling (and the last column
 * was silently clipped off the right edge), and the card list turned ten orgs into a metre of
 * scrolling on a phone. `ConsoleTable` owns that geometry for every console page and DataTable
 * takes no `minWidth`, so the list pipeline lives here instead. It is deliberately the SAME
 * behaviour, not less: search across every rendered column, a sort cycle of asc → desc → original
 * order, 20 rows a page with the same 10/20/50/100 choices, and the same "Showing x-y of n".
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Building2, Check, ChevronLeft, ChevronRight, Copy, Globe, LifeBuoy, MoreHorizontal, Plus, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { DomainsDialog } from "./DomainsDialog";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { platformAdminOrgApi, type OrgListRow, type OrgStatus, type PlanTier, type ResetAdminPasswordResult } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, Field, FieldGrid, OrgStatusPill, PRIMARY_BTN, TierPill, Toolbar } from "./console-ui";

/* The status pill is `console-ui.tsx`'s `OrgStatusPill` now — one map for the whole console. The
   local copy here was missing GRACE entirely (it renders `undefined` as a variant), which is
   exactly the drift a shared component removes. The plan badge is its `TierPill` for the same
   reason: this page used to paint every tier the same "info" blue, so the column carried no
   information the word itself did not already carry. */

const PAGE_SIZES = [10, 20, 50, 100];

/**
 * A pill column only lines up if the PILLS line up: "PROVISIONING" is five characters longer than
 * "GRACE" and a badge hugs its text, so left-aligned pills gave the column a ragged right edge and
 * the eye no baseline to scan. The kit's pills take no `className`, so the width floor goes on a
 * wrapper that stretches whatever badge it contains.
 */
const PILL_SLOT = "inline-flex [&>*]:w-full [&>*]:justify-center";

/** What the Database column shows — one definition, so search and sort agree with the cell. */
const databaseLabel = (row: OrgListRow) => (row.database ? `${row.database.host} / ${row.database.databaseName}` : "Not provisioned");

type SortKey = "name" | "slug" | "status" | "planTier" | "database";
type SortState = { key: SortKey; dir: "asc" | "desc" } | null;

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

const SORT_VALUE: Record<SortKey, (row: OrgListRow) => string> = {
  name: (r) => r.name,
  slug: (r) => r.slug,
  status: (r) => r.status,
  planTier: (r) => r.planTier,
  database: databaseLabel
};

export function PlatformAdminOrganizations() {
  const queryClient = useQueryClient();
  const orgs = useQuery({ queryKey: ["platform-admin", "organizations"], queryFn: platformAdminOrgApi.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<OrgListRow | null>(null);
  const [provisioning, setProvisioning] = useState<OrgListRow | null>(null);
  const [domainsFor, setDomainsFor] = useState<OrgListRow | null>(null);
  const [rescuing, setRescuing] = useState<OrgListRow | null>(null);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    const all = orgs.data ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q ? all.filter((o) => [o.name, o.slug, o.status, o.planTier, databaseLabel(o)].join(" ").toLowerCase().includes(q)) : all;
    if (!sort) return filtered;
    const read = SORT_VALUE[sort.key];
    // Copy before sorting: with an empty search box `filtered` IS the query cache's array, and
    // sorting in place would mutate what react-query handed us.
    return [...filtered].sort((a, b) => read(a).localeCompare(read(b)) * (sort.dir === "asc" ? 1 : -1));
  }, [orgs.data, query, sort]);

  // The page index is DERIVED rather than corrected in an effect: filtering down to three rows
  // while sitting on page 4 must not render an empty table for a frame.
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageIndex = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
  // `data === undefined` after loading means the query FAILED. Show neither a table nor an empty
  // state then: "No organizations yet." over a network error is a lie the operator would act on.
  const loaded = !orgs.isLoading && orgs.data !== undefined;

  // asc → desc → back to the order the API returned, the same three-step cycle the shared
  // DataTable offers, so nobody has to reload the page to get the original ordering back.
  const toggleSort = (key: SortKey) =>
    setSort((current) => {
      if (current?.key !== key) return { key, dir: "asc" };
      return current.dir === "asc" ? { key, dir: "desc" } : null;
    });

  return (
    <ConsolePage
      eyebrow="Tenants"
      title="Organizations"
      description="Every tenant on the platform — lifecycle, plan tier, database registration, custom domains, and the rescue for a locked-out administrator."
      actions={
        <Button size="sm" className={cn("gap-2", PRIMARY_BTN)} onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />New organization
        </Button>
      }
    >
      <ConsoleSection
        title="All organizations"
        description={`${orgs.data?.length ?? 0} total`}
        bodyClassName="grid gap-3"
        actions={
          <Toolbar>
            {/* The search box belongs to the section, not to a floating strip above the table:
                sitting in the body it read as a control with no owner and left a gap between
                itself and the rows it filters. */}
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
                aria-label="Search organizations"
                placeholder="Search organizations..."
                className="h-9 pl-9"
              />
            </div>
          </Toolbar>
        }
      >
        {orgs.isLoading && <Skeleton className="h-40 w-full" />}

        {loaded && rows.length === 0 && (
          <EmptyState
            icon={Building2}
            title={query ? "Nothing matches that search" : "No organizations yet."}
            description={query ? "Try a name, a slug, a status or a database host." : "Register the first tenant, then provision its database."}
            action={
              query ? (
                <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Button size="sm" className={cn("gap-2", PRIMARY_BTN)} onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" />New organization
                </Button>
              )
            }
          />
        )}

        {loaded && rows.length > 0 && (
          /* `[&_th]:normal-case`: the shared `TableHead` uppercases, but the sortable headers wrap
             their label in a <button>, and a browser's UA stylesheet sets `text-transform: none`
             on form controls — which beats an INHERITED uppercase. So five headers rendered
             "Name/Slug/…" while the one plain header shouted "ACTIONS". Title Case for all six. */
          <ConsoleTable minWidth={960} className="[&_th]:normal-case">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHeader label="Name" column="name" sort={sort} onSort={toggleSort} />
                <SortHeader label="Slug" column="slug" sort={sort} onSort={toggleSort} />
                <SortHeader label="Status" column="status" sort={sort} onSort={toggleSort} className="w-[9rem]" />
                <SortHeader label="Plan" column="planTier" sort={sort} onSort={toggleSort} className="w-[8rem]" />
                <SortHeader label="Database" column="database" sort={sort} onSort={toggleSort} />
                <TableHead className="w-[12rem] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((org) => (
                <TableRow key={org.id}>
                  <TableCell className="font-medium text-foreground">{org.name}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{org.slug}</TableCell>
                  <TableCell>
                    <span className={cn(PILL_SLOT, "w-[7rem]")}>
                      <OrgStatusPill status={org.status} />
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className={cn(PILL_SLOT, "w-[6rem]")}>
                      <TierPill tier={org.planTier} />
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{databaseLabel(org)}</TableCell>
                  <TableCell className="text-right">
                    <RowActions
                      org={org}
                      onProvision={() => setProvisioning(org)}
                      onDomains={() => setDomainsFor(org)}
                      onRescue={() => setRescuing(org)}
                      onManage={() => setEditing(org)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        )}

        {loaded && rows.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              Showing {pageIndex * pageSize + 1}-{Math.min((pageIndex + 1) * pageSize, rows.length)} of {rows.length}
            </p>
            <div className="flex items-center gap-2">
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v));
                  setPage(0);
                }}
              >
                <SelectTrigger className="h-8 w-[90px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>{size} / page</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" aria-label="Previous page" onClick={() => setPage(pageIndex - 1)} disabled={pageIndex === 0}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {pageIndex + 1} of {pageCount}
              </span>
              <Button variant="outline" size="sm" aria-label="Next page" onClick={() => setPage(pageIndex + 1)} disabled={pageIndex >= pageCount - 1}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
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

/** A sortable column header. The arrow is always present (dimmed when inactive) so the header row
 *  keeps one height and the labels do not shift by an icon width when a sort is applied. */
function SortHeader({ label, column, sort, onSort, className }: { label: string; column: SortKey; sort: SortState; onSort: (key: SortKey) => void; className?: string }) {
  // Narrow to the state object rather than to a boolean, so `active.dir` needs no non-null assertion.
  const active = sort && sort.key === column ? sort : null;
  const ariaSort = active ? ARIA_SORT[active.dir] : "none";
  return (
    <TableHead className={className} aria-sort={ariaSort}>
      <button type="button" className="focus-ring inline-flex items-center gap-1 rounded-sm hover:text-foreground" onClick={() => onSort(column)}>
        {label}
        {!active && <ArrowUpDown className="h-3 w-3 opacity-40" />}
        {active?.dir === "asc" && <ArrowUp className="h-3 w-3" />}
        {active?.dir === "desc" && <ArrowDown className="h-3 w-3" />}
      </button>
    </TableHead>
  );
}

/**
 * One row's actions, in two FIXED slots so the column reads as a column.
 *
 * WHY: this used to render two or three variable-width buttons right-aligned, so "Domains" began at
 * a different x on every row and the whole column looked shredded — the eye reads that raggedness
 * before it reads any label. Now the row's ONE urgent action fills a fixed-width slot (Provision
 * while the org has no database, Manage once it does) and everything else lives behind the overflow
 * menu, which is where the retention page already puts its per-row secondaries. Nothing was
 * removed: every action is still one click away and still gated by exactly the same status rules.
 */
function RowActions({
  org,
  onProvision,
  onDomains,
  onRescue,
  onManage
}: {
  org: OrgListRow;
  onProvision: () => void;
  onDomains: () => void;
  onRescue: () => void;
  onManage: () => void;
}) {
  const unprovisioned = org.status === "PROVISIONING";
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="w-[6.5rem] shrink-0">
        {unprovisioned ? (
          <Button size="sm" className={cn("w-full", PRIMARY_BTN)} onClick={onProvision}>
            Provision
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="w-full" onClick={onManage}>
            Manage
          </Button>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="w-8 shrink-0 px-0" aria-label={`More actions for ${org.name}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {unprovisioned && (
            <DropdownMenuItem onSelect={onManage}>
              <SlidersHorizontal className="h-4 w-4" />Manage
            </DropdownMenuItem>
          )}
          {/* Only for a workspace that is actually serving traffic. A custom domain on a
              PROVISIONING or ARCHIVED org points at nothing, and offering it there invites
              somebody to spend a DNS change on a workspace that cannot answer. */}
          {!unprovisioned && (
            <DropdownMenuItem onSelect={onDomains}>
              <Globe className="h-4 w-4" />Domains
            </DropdownMenuItem>
          )}
          {/* Only an ACTIVE workspace has an administrator to rescue; a suspended one is a
              billing conversation, not a password one, and the server refuses it anyway. */}
          {org.status === "ACTIVE" && (
            <DropdownMenuItem onSelect={onRescue}>
              <LifeBuoy className="h-4 w-4" />Rescue admin
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Provision {org.name} <span className="font-mono text-sm font-normal text-muted-foreground">({org.slug})</span>
          </DialogTitle>
          <DialogDescription>
            Creates this organization's own database and runs every migration against it. Safe to re-run.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="text-xs text-muted-foreground">
            This physically creates the tenant database, runs every migration against it, seeds baseline roles/settings, and creates the one admin account below — then flips this
            organization ACTIVE. No demo data is included.
          </p>
          <FieldGrid>
            <Field label="First admin name" htmlFor="provision-admin-name">
              <Input id="provision-admin-name" value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Jane Doe" />
            </Field>
            <Field label="First admin email" htmlFor="provision-admin-email">
              <Input id="provision-admin-email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="jane@acme.com" />
            </Field>
            <Field label="First admin password" htmlFor="provision-admin-password" className="sm:col-span-2">
              <Input
                id="provision-admin-password"
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </Field>
          </FieldGrid>
        </div>
        <DialogFooter>
          <Button
            disabled={!adminEmail || !adminName || adminPassword.length < 8 || provision.isPending}
            className={PRIMARY_BTN}
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Rescue an administrator of {org.name} <span className="font-mono text-sm font-normal text-muted-foreground">({org.slug})</span>
          </DialogTitle>
          <DialogDescription>
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
              <FieldGrid cols={1}>
                <Field label="Super admin email" htmlFor="rescue-email">
                  <Input id="rescue-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@acme.com" />
                </Field>
              </FieldGrid>
            </div>
            <DialogFooter>
              <Button disabled={!email.includes("@") || rescue.isPending} className={PRIMARY_BTN} onClick={() => rescue.mutate()}>
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
              <Field
                label="One-time password - shown once, never stored"
                hint={
                  <>
                    Sign-in: <span className="font-mono">{result.url}</span>. Give both to the customer by whatever channel you trust - this dialog will not show the
                    password again.
                  </>
                }
              >
                <div className="flex items-center gap-2">
                  {/* NEVER `truncate` here. This is a one-time password, shown exactly once and
                      stored only as a hash — an ellipsis in the middle of it is unrecoverable, and
                      the operator would not know they had read out a partial string. It wraps. */}
                  <code className="min-w-0 flex-1 select-all break-all rounded-md border border-accent/40 bg-background px-3 py-2 font-mono text-base tracking-wide text-accent">
                    {result.temporaryPassword}
                  </code>
                  <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={copy}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </Field>
            </div>
            <DialogFooter>
              <Button className={PRIMARY_BTN} onClick={() => onOpenChange(false)}>
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>
            Registers a new tenant. It won't have a database until you provision one.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FieldGrid>
            {/* The name is the long one, so it takes the full row and the two short controls pair
                up beneath it — a half-width name field next to an empty cell reads as a mistake. */}
            <Field label="Name" htmlFor="create-org-name" className="sm:col-span-2">
              <Input id="create-org-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corporation" />
            </Field>
            <Field label="Slug (subdomain)" htmlFor="create-org-slug">
              <Input id="create-org-slug" className="font-mono" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="acme" />
            </Field>
            <Field label="Plan tier" htmlFor="create-org-tier">
              <Select value={planTier} onValueChange={(v) => setPlanTier(v as PlanTier)}>
                <SelectTrigger id="create-org-tier"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="STARTER">Starter</SelectItem>
                  <SelectItem value="TEAM">Team</SelectItem>
                  <SelectItem value="ENTERPRISE">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGrid>
          <p className="text-xs text-muted-foreground">
            This registers the organization in the control plane only. A platform operator still needs to provision its physical database, run tenant migrations, and seed an initial admin
            user before it can go ACTIVE.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={!name || !slug || create.isPending} className={PRIMARY_BTN} onClick={() => create.mutate()}>
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {org.name} <span className="font-mono text-sm font-normal text-muted-foreground">({org.slug})</span>
          </DialogTitle>
          <DialogDescription>
            Plan tier, status and per-organization limits for this tenant.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {/* One grid for all five controls rather than two grids with a lone textarea between
              them: the suspension reason only appears for SUSPENDED, and when it did appear as its
              own block it shifted the two rows below it out of alignment with the two above. */}
          <FieldGrid>
            <Field label="Status" htmlFor="edit-org-status">
              <Select value={status} onValueChange={(v) => setStatus(v as OrgStatus)}>
                <SelectTrigger id="edit-org-status"><SelectValue /></SelectTrigger>
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
            </Field>

            <Field label="Plan tier" htmlFor="edit-org-tier">
              <Select value={planTier} onValueChange={(v) => setPlanTier(v as PlanTier)}>
                <SelectTrigger id="edit-org-tier"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="STARTER">Starter</SelectItem>
                  <SelectItem value="TEAM">Team</SelectItem>
                  <SelectItem value="ENTERPRISE">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {status === "SUSPENDED" && (
              <Field label="Suspension reason" htmlFor="edit-org-reason" className="sm:col-span-2">
                <Textarea id="edit-org-reason" rows={2} value={suspendedReason} onChange={(e) => setSuspendedReason(e.target.value)} />
              </Field>
            )}

            <Field label="Seat limit override" htmlFor="edit-org-seats">
              <Input id="edit-org-seats" type="number" value={seatLimitOverride} onChange={(e) => setSeatLimitOverride(e.target.value)} placeholder="Tier default" />
            </Field>

            <Field label="AI budget override ($/mo)" htmlFor="edit-org-budget">
              <Input id="edit-org-budget" type="number" value={aiBudgetOverride} onChange={(e) => setAiBudgetOverride(e.target.value)} placeholder="Tier default" />
            </Field>
          </FieldGrid>

          {org.database && (
            <p className="text-xs text-muted-foreground">
              Database: <span className="font-mono">{org.database.host} / {org.database.databaseName}</span>
              {org.database.schemaVersion ? ` — schema ${org.database.schemaVersion}` : " — not yet migrated"}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} className={PRIMARY_BTN} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

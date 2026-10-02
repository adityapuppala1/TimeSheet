/**
 * WHAT: Tenants → Company domains (signup Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.4) — which
 * workspace a stranger from each company is sent to when they try to sign up.
 *
 * A CLAIM IS A ROUTING DECISION ABOUT PEOPLE. Pointing acme.com at the wrong workspace sends Acme's
 * next hire into somebody else's company, so Reassign and Release ask why (the console's reason
 * prompt) and every change is audited with the previous holder.
 *
 * THE BACKFILL NEVER CHOOSES. Workspaces made before claims existed are claimed from their owner's
 * address — but when two workspaces share a domain, picking one (the oldest? the paying one?) is a
 * guess about which of two companies a stranger belongs to. The preview names every conflict, Apply
 * claims only the unambiguous ones, and a person resolves the rest here with Assign.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, GitMerge, Plus, Unlink } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { platformAdminConsoleApi, platformAdminOrgApi, type CompanyDomainBackfillPlan, type CompanyDomainClaim } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, OrgStatusPill, shortDate } from "./console-ui";
import { runInBackground } from "../../lib/run-in-background";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const CLAIMS_KEY = ["platform-admin", "company-domains"] as const;

const SOURCE_LABEL: Record<string, string> = { SIGNUP: "Self-serve signup", BACKFILL: "Backfill", ADMIN: "Set by an operator" };

/** Assign a domain to a workspace — a new claim, or a reassignment when `domain` is fixed. */
function AssignDialog({ open, fixedDomain, currentOrgId, onClose }: { open: boolean; fixedDomain: string | null; currentOrgId?: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [orgId, setOrgId] = useState("");
  const orgs = useQuery({ queryKey: ["platform-admin", "organizations"], queryFn: platformAdminOrgApi.list, enabled: open });
  const choices = (orgs.data ?? []).filter((o) => o.status !== "ARCHIVED" && o.id !== currentOrgId);
  const target = fixedDomain ?? domain.trim().toLowerCase();
  const verb = fixedDomain ? "Reassign" : "Assign";

  const assign = useMutation({
    mutationFn: () => platformAdminConsoleApi.assignCompanyDomain(target, orgId),
    onSuccess: (rows) => {
      queryClient.setQueryData(CLAIMS_KEY, rows);
      toast.success(`${target} now points at ${choices.find((o) => o.id === orgId)?.name ?? "the workspace"}`);
      close();
    },
    onError: (error) => toast.error("Could not assign the domain", { description: errorMessageOf(error) })
  });
  const close = () => {
    setDomain("");
    setOrgId("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{fixedDomain ? `Reassign ${fixedDomain}` : "Assign a company domain"}</DialogTitle>
          <DialogDescription>
            People who sign up with an address at this domain will be offered a request to join the workspace you choose. You'll be asked why.
          </DialogDescription>
        </DialogHeader>
        {!fixedDomain && (
          <div className="grid gap-1.5">
            <Label htmlFor="claim-domain">Domain</Label>
            <Input id="claim-domain" placeholder="acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus />
            <p className="text-xs text-muted-foreground">The company domain itself — eng.acme.com is covered by acme.com.</p>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="claim-org">Workspace</Label>
          <Select value={orgId} onValueChange={setOrgId}>
            <SelectTrigger id="claim-org">
              <SelectValue placeholder={orgs.isLoading ? "Loading workspaces…" : "Choose a workspace"} />
            </SelectTrigger>
            <SelectContent>
              {choices.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name} · {o.slug}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => assign.mutate()} disabled={!orgId || target.length < 3 || assign.isPending}>
            {assign.isPending ? "Saving…" : verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackfillDialog({ plan, onClose }: { plan: CompanyDomainBackfillPlan | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const apply = useMutation({
    mutationFn: platformAdminConsoleApi.backfillApply,
    onSuccess: (result) => {
      runInBackground(queryClient.invalidateQueries({ queryKey: CLAIMS_KEY }));
      toast.success(`Claimed ${plural(result.claimed, "domain")}`, {
        description: result.conflicts ? `${plural(result.conflicts, "conflict")} left for you to decide.` : "No conflicts."
      });
      onClose();
    },
    onError: (error) => toast.error("Backfill failed", { description: errorMessageOf(error) })
  });

  return (
    <Dialog open={Boolean(plan)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Backfill from signup emails</DialogTitle>
          <DialogDescription>
            Each existing workspace is claimed for its owner's company domain. Where two workspaces share a domain, neither is claimed — an operator has to
            choose, and nothing here picks one for you.
          </DialogDescription>
        </DialogHeader>
        {plan && (
          <div className="grid gap-4 text-sm">
            <div className="grid gap-1.5">
              <p className="font-semibold">Would claim ({plan.toClaim.length})</p>
              {plan.toClaim.length === 0 ? (
                <p className="text-muted-foreground">Nothing to claim.</p>
              ) : (
                <ul className="grid gap-1">
                  {plan.toClaim.map((c) => (
                    <li key={c.domain} className="flex min-w-0 justify-between gap-3">
                      <span className="truncate font-mono text-xs">{c.domain}</span>
                      <span className="truncate text-muted-foreground">{c.orgName}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="grid gap-1.5">
              <p className="font-semibold">Conflicts — you decide ({plan.conflicts.length})</p>
              {plan.conflicts.length === 0 ? (
                <p className="text-muted-foreground">None.</p>
              ) : (
                <ul className="grid gap-2">
                  {plan.conflicts.map((c) => (
                    <li key={c.domain} className="rounded-lg border border-warning/40 bg-warning/5 p-2.5">
                      <p className="font-mono text-xs font-semibold">{c.domain}</p>
                      <p className="text-xs text-muted-foreground">Shared by {c.orgs.map((o) => `${o.name} (${o.slug})`).join(", ")}. Assign it by hand once you know which company is which.</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {plan.skipped} workspace(s) skipped: a personal owner address, no company domain, or a domain already claimed. Workspaces with no owner address on record are not considered.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => apply.mutate()} disabled={!plan || plan.toClaim.length === 0 || apply.isPending}>
            {apply.isPending ? "Claiming…" : `Claim ${plan?.toClaim.length ?? 0}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PlatformAdminCompanyDomains() {
  const queryClient = useQueryClient();
  const claims = useQuery({ queryKey: CLAIMS_KEY, queryFn: platformAdminConsoleApi.companyDomains });
  const [assigning, setAssigning] = useState<{ domain: string | null; currentOrgId?: string } | null>(null);
  const [plan, setPlan] = useState<CompanyDomainBackfillPlan | null>(null);

  const preview = useMutation({
    mutationFn: platformAdminConsoleApi.backfillPreview,
    onSuccess: setPlan,
    onError: (error) => toast.error("Could not plan the backfill", { description: errorMessageOf(error) })
  });
  const release = useMutation({
    mutationFn: (claim: CompanyDomainClaim) => platformAdminConsoleApi.releaseCompanyDomain(claim.domain),
    onSuccess: (_result, claim) => {
      runInBackground(queryClient.invalidateQueries({ queryKey: CLAIMS_KEY }));
      toast.success(`${claim.domain} released`, { description: "People from it can start a workspace of their own again." });
    },
    onError: (error) => toast.error("Could not release the domain", { description: errorMessageOf(error) })
  });

  return (
    <ConsolePage
      eyebrow="Tenants"
      title="Company domains"
      description="Which workspace people from each company are sent to when they sign up. The second person from acme.com is offered a request to join, not a second workspace."
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => preview.mutate()} disabled={preview.isPending}>
            <GitMerge className="h-3.5 w-3.5" />
            Backfill from signup emails
          </Button>
          <Button size="sm" onClick={() => setAssigning({ domain: null })}>
            <Plus className="h-3.5 w-3.5" />
            Assign a domain
          </Button>
        </>
      }
    >
      {claims.isLoading && <Skeleton className="h-64 w-full" />}
      {claims.data && (
        <ConsoleSection
          title={`Claimed domains (${claims.data.length})`}
          description="Unverified for now — a claim comes from a signup, the backfill or an operator. Proving a domain by DNS arrives in a later phase."
          flush
        >
          {claims.data.length === 0 ? (
            <div className="p-5">
              <EmptyState icon={AtSign} title="No domain is claimed yet" description="A self-serve signup claims its company's domain. For workspaces made before that, run the backfill." />
            </div>
          ) : (
            <ConsoleTable minWidth={760} className="rounded-none border-x-0 border-b-0">
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Since</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {claims.data.map((claim) => (
                  <TableRow key={claim.domain}>
                    <TableCell className="font-mono text-sm">{claim.domain}</TableCell>
                    <TableCell>
                      {claim.organization ? (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <Link to={`/platform-admin/organizations/${claim.organization.id}`} className="focus-ring rounded font-medium hover:underline">
                            {claim.organization.name}
                          </Link>
                          <OrgStatusPill status={claim.organization.status} />
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={claim.status === "VERIFIED" ? "success" : "outline"}>{claim.status === "VERIFIED" ? "Verified" : "Unverified"}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{SOURCE_LABEL[claim.source] ?? claim.source}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{shortDate(claim.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setAssigning({ domain: claim.domain, currentOrgId: claim.organization?.id })}>
                          Reassign
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => release.mutate(claim)} disabled={release.isPending}>
                          <Unlink className="h-3.5 w-3.5" />
                          Release
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ConsoleTable>
          )}
        </ConsoleSection>
      )}

      <AssignDialog open={Boolean(assigning)} fixedDomain={assigning?.domain ?? null} currentOrgId={assigning?.currentOrgId} onClose={() => setAssigning(null)} />
      <BackfillDialog plan={plan} onClose={() => setPlan(null)} />
    </ConsolePage>
  );
}

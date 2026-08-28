/**
 * Custom domains for one workspace — add a hostname, publish a TXT record, verify it.
 *
 * WHY THE RECORD IS THE HERO OF THIS DIALOG. The only hard part of this flow happens somewhere else
 * entirely: in a DNS console the platform operator cannot see, usually by a different person, often
 * a day later. So the two values that have to be copied EXACTLY are given their own row, in mono,
 * each with its own copy button, and the failure message from the last check is shown verbatim
 * underneath rather than flattened into "verification failed" — "a TXT record exists but its value
 * doesn't match" and "no TXT record found" send somebody to different places.
 *
 * VERIFICATION IS A ONE-WAY LATCH, which is worth knowing while reading this: a verified domain is
 * never re-checked and never un-verified. DNS is not always reachable, and taking a live workspace
 * off its own domain because of a resolver hiccup is a worse failure than a stale `verifiedAt`.
 * Removing a domain is the deliberate act, and it is right there in the list.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Globe, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { platformAdminOrgApi, type OrgDomainRow } from "../../services/platform-admin-api";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1">
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground">
          {value}
        </code>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 border-border text-foreground hover:bg-muted"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function DomainCard({ orgId, row, onChanged }: { orgId: string; row: OrgDomainRow; onChanged: () => void }) {
  const verify = useMutation({
    mutationFn: () => platformAdminOrgApi.verifyDomain(orgId, row.id),
    onSuccess: (updated) => {
      onChanged();
      if (updated.verified) toast.success(`${updated.domain} verified`, { description: "Traffic to it now reaches this workspace." });
      else toast.error("Not verified yet", { description: updated.lastCheckError ?? "The record wasn't found." });
    },
    onError: (err: any) => toast.error("Check failed", { description: err?.response?.data?.message ?? "Try again." })
  });

  const remove = useMutation({
    mutationFn: () => platformAdminOrgApi.removeDomain(orgId, row.id),
    onSuccess: () => {
      onChanged();
      toast.success(`${row.domain} removed`);
    },
    onError: (err: any) => toast.error("Could not remove", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-background/60 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 font-medium text-foreground">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {row.domain}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
            row.verified ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-accent"
          }`}
        >
          {row.verified ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
          {row.verified ? "Verified" : "Awaiting DNS"}
        </span>
      </div>

      {!row.verified && (
        <>
          <p className="text-xs leading-5 text-muted-foreground">
            Publish this TXT record on the customer's DNS, then check again. Records can take a few minutes to
            propagate — some providers take longer.
          </p>
          <CopyField label="Record name" value={row.recordName} />
          <CopyField label="Record value" value={row.recordValue} />
          {/* Verbatim, not summarised: "exists but doesn't match" and "not found" send somebody to
              two different places, and flattening them into one message costs a round trip. */}
          {row.lastCheckError && <p className="text-xs leading-5 text-accent">{row.lastCheckError}</p>}
        </>
      )}

      {row.verified && (
        <p className="text-xs text-muted-foreground">
          Sign-in at <span className="font-mono text-foreground">https://{row.domain}/login</span> resolves to this
          workspace, ahead of its subdomain.
        </p>
      )}

      <div className="flex items-center gap-2">
        {!row.verified && (
          <Button size="sm" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {verify.isPending ? "Checking DNS…" : "Check DNS"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:bg-muted hover:text-red-300"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </Button>
      </div>
    </div>
  );
}

export function DomainsDialog({
  org,
  onOpenChange
}: {
  org: { id: string; name: string; slug: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");

  const query = useQuery({
    queryKey: ["platform-admin", "domains", org?.id],
    queryFn: () => platformAdminOrgApi.listDomains(org!.id),
    enabled: Boolean(org)
  });

  const add = useMutation({
    mutationFn: () => platformAdminOrgApi.addDomain(org!.id, domain),
    onSuccess: () => {
      setDomain("");
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "domains", org?.id] });
      toast.success("Domain added", { description: "Publish the TXT record shown, then check DNS." });
    },
    onError: (err: any) => toast.error("Could not add", { description: err?.response?.data?.message ?? "Try again." })
  });

  if (!org) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-card text-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Custom domains — {org.name}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            A verified domain resolves to this workspace ahead of its{" "}
            <span className="font-mono text-foreground">{org.slug}</span> subdomain. Until it is verified it does
            nothing at all.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (domain.trim()) add.mutate();
            }}
          >
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="new-domain" className="text-foreground">
                Add a domain
              </Label>
              <Input
                id="new-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="time.acme.com"
                className="border-border bg-background text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <Button type="submit" disabled={add.isPending || !domain.trim()}>
              {add.isPending ? "Adding…" : "Add"}
            </Button>
          </form>

          {query.isLoading && <Skeleton className="h-24 w-full" />}

          {!query.isLoading && query.data?.domains.length === 0 && (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              No custom domains yet. This workspace is reachable at its subdomain.
            </p>
          )}

          {query.data?.domains.map((row) => (
            <DomainCard
              key={row.id}
              orgId={org.id}
              row={row}
              onChanged={() => queryClient.invalidateQueries({ queryKey: ["platform-admin", "domains", org.id] })}
            />
          ))}

          {/* Stated because it is the most common way this feature is misunderstood: verifying the
              TXT record proves ownership, and does not point the hostname at anything. */}
          <p className="text-xs leading-5 text-muted-foreground">
            Verification proves the customer owns the domain. They still need a CNAME or A record pointing it at this
            deployment for traffic to arrive.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

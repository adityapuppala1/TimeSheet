/**
 * WHAT: Workspace Settings → Single sign-on → Company domains. The email domains that send people to
 * THIS workspace when they try to sign up (signup Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.2): the
 * second person from acme.com is offered "ask to join" rather than a workspace of their own.
 *
 * Read-only by design. Moving a claim strands a company's people, so it is an operator action on the
 * platform console; proving a domain by DNS is a later phase. Next to sign-in because it answers the
 * same question — who gets in, and how.
 */
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { companyDomainApi } from "../../services/api";

export function CompanyDomainsCard() {
  const domains = useQuery({ queryKey: ["company-domains"], queryFn: companyDomainApi.list });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
          Company domains
        </CardTitle>
        <CardDescription>
          When someone signs up with an address at one of these domains, they're offered a request to join this workspace instead of a new one.
          Requests wait on Users → Requests.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {domains.data && domains.data.length > 0 ? (
          <ul className="grid gap-2">
            {domains.data.map((claim) => (
              <li key={claim.domain} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
                <span className="min-w-0 truncate font-medium">{claim.domain}</span>
                <Badge variant="outline">{claim.status === "VERIFIED" ? "Verified" : "Unverified — people from this domain can ask to join"}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{domains.isLoading ? "Loading…" : "No domain routes people here yet."}</p>
        )}
        <p className="text-xs text-muted-foreground">Domain verification arrives later; ask the TimeSphere team to change a claim.</p>
      </CardContent>
    </Card>
  );
}

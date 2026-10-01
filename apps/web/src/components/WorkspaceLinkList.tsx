/**
 * WHAT: the list of workspaces an address belongs to, each a link to its sign-in page. Rendered by
 * "Find your workspace" and by signup's `member` answer — the same list, so the two pages cannot
 * drift into linking somewhere different.
 *
 * Plain anchors, not router Links: each workspace is a DIFFERENT ORIGIN, and a client-side
 * navigation would keep the browser on this host and resolve the wrong tenant.
 */
import { ArrowRight } from "lucide-react";
import type { SignupWorkspaceLink } from "../utils/signup-flow";

export function WorkspaceLinkList({ workspaces }: { workspaces: SignupWorkspaceLink[] }) {
  return (
    <>
      {workspaces.map((workspace) => (
        <a
          key={workspace.slug}
          href={`${workspace.url}/login`}
          className="focus-ring flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5 text-left transition hover:border-primary/40 hover:shadow-sm"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{workspace.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{workspace.url.replace(/^https?:\/\//, "")}</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </a>
      ))}
    </>
  );
}

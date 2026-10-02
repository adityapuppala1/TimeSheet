/**
 * The org-detail flag for a workspace whose Microsoft sign-in accepts ANY directory (audit C1, staged
 * rollout step d). Read-only on purpose: pinning a tenant is the customer admin's decision, made on
 * their Single sign-on tab with the same directory list in front of them — the console's job is to
 * show operators which workspaces are still exposed, and to whom pinning would close the door.
 *
 * Self-contained so the org profile gains one line. Renders nothing for a workspace that is pinned or
 * does not use Microsoft sign-in.
 */
import { ShieldAlert } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import type { OrgDetail } from "../../services/platform-admin-api";
import { ConsoleSection } from "./console-ui";

export function MicrosoftSignInFlag({ exposure }: { exposure: OrgDetail["microsoftSignIn"] }) {
  if (!exposure?.acceptsAnyDirectory) return null;
  const directories = exposure.observedDirectories;
  return (
    <ConsoleSection
      title={
        <span className="inline-flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />
          Microsoft sign-in accepts any directory
        </span>
      }
      description="No Directory (tenant) ID is set, so a token from any Microsoft directory is accepted and matched to people by email. The workspace's admin can restrict it from their Single sign-on settings."
      actions={<Badge variant="warning">Exposed</Badge>}
    >
      {directories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Microsoft sign-ins recorded yet.</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {directories.map((directory) => (
            <li key={directory.tenantId} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <code className="break-all text-xs">{directory.tenantId}</code>
              <span className="text-xs text-muted-foreground">
                {directory.count} sign-in{directory.count === 1 ? "" : "s"} · {directory.emailDomains.map((entry) => entry.domain).join(", ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ConsoleSection>
  );
}

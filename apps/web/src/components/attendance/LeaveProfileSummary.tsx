/**
 * 7.0.0 — leave on the Profile page and the People (Users) edit dialog: balances, who approves the
 * person's leave, and a link to attendance history.
 *
 * VISIBILITY: on Profile it is your own balance (GET /leave/me/balances). In the People dialog the
 * balance comes from GET /leave/admin/balances/:userId, which is super-admin-only, so only a super
 * admin sees another person's balance there; anyone else sees the approver line and nothing more.
 * No request, reason or ledger line is shown. Renders nothing while leave is off.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { leaveAdminApi, leaveApi, type LeaveBalance } from "../../services/leave-api";
import { useAuthStore } from "../../store/auth";
import { useLeaveEnabled } from "./use-leave";

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Pure: who decides this person's leave. A person with no manager falls to the admin pool. */
export function approverLine(manager: { name: string } | null | undefined): string {
  return manager?.name ? manager.name : "Workspace admins (no manager set)";
}

export function LeaveProfileSummary({ userId, manager }: Readonly<{ userId?: string; manager: { name: string } | null | undefined }>) {
  const leaveOn = useLeaveEnabled();
  const viewer = useAuthStore((s) => s.user);
  const self = !userId || userId === viewer?.id;
  const mayReadOther = viewer?.role === "SUPER_ADMIN";
  const balances = useQuery({
    queryKey: self ? ["leave", "balances"] : ["leave", "admin", "balances", userId],
    queryFn: async (): Promise<LeaveBalance[]> => (self ? (await leaveApi.balances()).balances : (await leaveAdminApi.balancesFor(userId!)).balances),
    enabled: leaveOn && (self || mayReadOther),
    staleTime: 30_000
  });
  if (!leaveOn) return null;
  const rows = (balances.data ?? []).filter((b) => b.leaveType.isPaid || b.available !== 0);
  return (
    <div className="grid gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="leave-profile-summary">
      <div className="flex items-center justify-between gap-2">
        <span>Leave approver</span>
        <span className="font-semibold text-foreground">{approverLine(manager)}</span>
      </div>
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Leave balance</span>
          {rows.map((b) => (
            <span key={b.leaveType.id} className="font-semibold tabular-nums text-foreground" title={b.leaveType.name}>
              {b.leaveType.code} {fmt(b.available)}
            </span>
          ))}
        </div>
      )}
      <Link to={self ? "/app/attendance" : "/app/attendance/team"} className="focus-ring font-medium text-primary underline-offset-2 hover:underline">
        {self ? "Your attendance history →" : "Team attendance →"}
      </Link>
    </div>
  );
}

/**
 * Shared reads for the attendance and leave screens (V17 UI v2): whether leave is on, the viewer's
 * balances, and their holiday list. One query key each, so the sidebar, the rail and the apply form
 * share a single request.
 */
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../../store/auth";
import { attendanceApi } from "../../services/attendance-api";
import { LEAVE_STATUS_KEY, leaveApi } from "../../services/leave-api";

export function useLeaveEnabled(): boolean {
  const user = useAuthStore((s) => s.user);
  const status = useQuery({ queryKey: LEAVE_STATUS_KEY, queryFn: leaveApi.status, enabled: Boolean(user), staleTime: 60_000, retry: false });
  return Boolean(status.data?.enabled);
}

export function useLeaveBalances(enabled: boolean) {
  return useQuery({ queryKey: ["leave", "balances"], queryFn: () => leaveApi.balances(), enabled, staleTime: 30_000 });
}

export function useMyHolidays(from: string, to: string, enabled = true) {
  return useQuery({ queryKey: ["attendance", "me", "holidays", from, to], queryFn: () => attendanceApi.myHolidays(from, to), enabled, staleTime: 5 * 60_000 });
}

/** The CSS colour for a leave type's colour token ("primary", "warning" …), falling back to the brand. */
export function leaveColour(token: string | null | undefined): string {
  return `hsl(var(--${token && /^[a-z][a-z0-9-]*$/.test(token) ? token : "primary"}))`;
}

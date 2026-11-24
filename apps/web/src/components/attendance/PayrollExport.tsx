/**
 * 7.0.0 — the monthly payroll export (admins): per person, working days, holidays, present, absent,
 * leave by type, paid vs unpaid (LOP), comp-off, logged hours. Preview the totals, download the CSV.
 * A month whose leave year is closed is flagged: late leave changes re-settle into the next year,
 * so treat that month's export as final.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Lock } from "lucide-react";
import { useState } from "react";
import { saveBlob } from "../../lib/download";
import { runInBackground } from "../../lib/run-in-background";
import { api } from "../../services/api";
import { useAuthStore } from "../../store/auth";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/toaster";
import { CardError, SectionCard, todayKey } from "./attendance-ui";

interface PayrollReport {
  month: string;
  leaveYearClosed: boolean;
  rows: Array<{ userId: string; workingDays: number; present: number; absent: number; paidLeave: number; unpaidLeave: number; loggedHours: number }>;
}

/** Pure: the month before `today` as YYYY-MM (payroll is run for the month that just ended). */
export function lastMonth(today: string): string {
  const [y, m] = today.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function PayrollExportCard() {
  const role = useAuthStore((s) => s.user?.role);
  const [month, setMonth] = useState(lastMonth(todayKey()));
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const admin = role === "ADMIN" || role === "SUPER_ADMIN";
  const q = useQuery({ queryKey: ["leave", "payroll", month], queryFn: async () => (await api.get<PayrollReport>("/leave/payroll", { params: { month } })).data, enabled: admin && valid });
  const download = useMutation({
    mutationFn: async () => (await api.get("/leave/payroll", { params: { month, format: "csv" }, responseType: "blob" })).data as Blob,
    onSuccess: (blob) => saveBlob(blob, `payroll-${month}.csv`),
    onError: () => toast.error("Could not download the payroll CSV", { description: "Try again." })
  });
  if (!admin) return null;
  const rows = q.data?.rows ?? [];
  const sum = (k: "paidLeave" | "unpaidLeave" | "loggedHours" | "absent") => Math.round(rows.reduce((s, r) => s + r[k], 0) * 100) / 100;
  return (
    <SectionCard title="Payroll export" description="One row per person for a month: working days, holidays, present, absent, leave by type (paid and unpaid), comp-off and logged hours.">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="payroll-month">Month</Label>
            <Input id="payroll-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="min-h-[44px] w-44" />
          </div>
          <Button className="min-h-[44px]" disabled={!valid || download.isPending} onClick={() => download.mutate()}>
            <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Download CSV
          </Button>
        </div>
        {q.isLoading && <Skeleton className="h-12 w-full" />}
        {q.isError && <CardError message="The payroll preview could not be loaded." onRetry={() => runInBackground(q.refetch())} />}
        {q.data && (
          <>
            {q.data.leaveYearClosed && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                This month's leave year is closed. Treat this export as final.
              </p>
            )}
            <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              {[
                ["People", String(rows.length)],
                ["Paid leave days", String(sum("paidLeave"))],
                ["Unpaid (LOP) days", String(sum("unpaidLeave"))],
                ["Logged hours", String(sum("loggedHours"))]
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border border-border p-2">
                  <dd className="text-lg font-black tabular-nums">{value}</dd>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </SectionCard>
  );
}

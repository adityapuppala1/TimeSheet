/**
 * 7.0.0 approval delegation: "cover my approvals from … to …". The delegate sees and decides the
 * leave and comp-off requests waiting on the approver while the range covers today; the decision is
 * recorded on the approver's behalf. Administrators can set cover for anyone (pick the approver too).
 * The server refuses self-delegation, loops and ineligible people; the form only helps.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserCheck } from "lucide-react";
import { useState } from "react";
import { runInBackground } from "../../lib/run-in-background";
import { delegationApi, type DelegationRow } from "../../services/leave-api";
import { useAuthStore } from "../../store/auth";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/toaster";
import { CardError, SectionCard, todayKey } from "./attendance-ui";

const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

/** "Priya covers Ravi, 1 Dec – 5 Dec" style line (pure, exported for the unit test). */
export function delegationLine(d: Pick<DelegationRow, "delegator" | "delegate" | "startDate" | "endDate">, viewerId: string): string {
  const who = d.delegator.id === viewerId ? `${d.delegate.name} covers your approvals` : d.delegate.id === viewerId ? `You cover ${d.delegator.name}` : `${d.delegate.name} covers ${d.delegator.name}`;
  return `${who}, ${d.startDate} to ${d.endDate}`;
}

export function ApprovalDelegations() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const admin = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";
  const viewerId = user?.id ?? "";
  const list = useQuery({ queryKey: ["leave", "delegations", admin ? "all" : "mine"], queryFn: () => delegationApi.list(admin ? "all" : "mine") });
  const people = useQuery({ queryKey: ["leave", "delegations", "candidates"], queryFn: () => delegationApi.candidates(), staleTime: 60_000 });
  const [delegateId, setDelegateId] = useState("");
  const [delegatorId, setDelegatorId] = useState("");
  const [startDate, setStart] = useState(todayKey());
  const [endDate, setEnd] = useState(todayKey());

  const refresh = () => runInBackground(qc.invalidateQueries({ queryKey: ["leave"] }));
  const create = useMutation({
    mutationFn: () => delegationApi.create({ delegateId, startDate, endDate, ...(admin && delegatorId ? { delegatorId } : {}) }),
    onSuccess: () => {
      toast.success("Cover set", { description: "They see the requests waiting on the approver while it lasts." });
      setDelegateId("");
      refresh();
    },
    onError: (err) => toast.error("Could not set cover", { description: serverMessage(err, "Try again.") })
  });
  const revoke = useMutation({
    mutationFn: (id: string) => delegationApi.revoke(id),
    onSuccess: () => {
      toast.success("Cover ended");
      refresh();
    },
    onError: (err) => toast.error("Could not end cover", { description: serverMessage(err, "Try again.") })
  });

  const rows = (list.data ?? []).filter((d) => !d.revoked && d.endDate >= todayKey());
  const choices = people.data ?? [];

  return (
    <SectionCard title="Approval cover" description="Away? Let someone decide the leave and comp-off requests waiting on you, for a date range." headingId="att-delegation">
      <div className="grid gap-3">
        {admin && (
          <div className="grid gap-1.5">
            <Label htmlFor="del-from">Whose approvals (admins: anyone)</Label>
            <Select value={delegatorId || "me"} onValueChange={(v) => setDelegatorId(v === "me" ? "" : v)}>
              <SelectTrigger id="del-from" className="min-h-[44px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Mine</SelectItem>
                {choices.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="del-to">Covered by</Label>
          <Select value={delegateId} onValueChange={setDelegateId}>
            <SelectTrigger id="del-to" className="min-h-[44px]">
              <SelectValue placeholder="Choose a manager, lead or admin" />
            </SelectTrigger>
            <SelectContent>
              {choices
                .filter((p) => p.id !== (delegatorId || viewerId))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="del-start">From</Label>
            <Input id="del-start" type="date" min={todayKey()} value={startDate} onChange={(e) => setStart(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="del-end">To</Label>
            <Input id="del-end" type="date" min={startDate} value={endDate} onChange={(e) => setEnd(e.target.value)} className="min-h-[44px]" />
          </div>
        </div>
        <Button className="min-h-[44px] justify-self-start" disabled={!delegateId || !startDate || !endDate || endDate < startDate || create.isPending} onClick={() => create.mutate()}>
          Set cover
        </Button>

        {list.isLoading && <Skeleton className="h-12 w-full" />}
        {list.isError && <CardError message="Cover could not be loaded." onRetry={() => runInBackground(list.refetch())} />}
        {list.data && rows.length === 0 && <EmptyState compact icon={UserCheck} title="No cover set" description="Current and upcoming cover shows up here." />}
        {rows.length > 0 && (
          <ul className="grid gap-2" aria-label="Approval cover">
            {rows.map((d) => (
              <li key={d.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
                <p className="min-w-0 flex-1">
                  {delegationLine(d, viewerId)}
                  {d.active && <span className="ml-1 text-xs text-muted-foreground">(in force now)</span>}
                </p>
                <Button variant="ghost" size="sm" className="min-h-[44px] sm:min-h-8" disabled={revoke.isPending} onClick={() => revoke.mutate(d.id)}>
                  End
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}

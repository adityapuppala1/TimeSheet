/**
 * WHAT: Users → Requests — people from the company's email domain who asked to join this workspace
 * instead of opening a second one (signup Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.3).
 *
 * WHO: anyone who may create users (`users:manage`), because approving creates an account. Granting
 * more than EMPLOYEE is a super admin's call; the picker offers it only to them and the server
 * enforces it for everyone.
 *
 * What an admin needs at the moment of deciding, and nothing else: who, what they said, how long the
 * request has left, and — on approve — what it costs in seats. A plan with no free seat says so before
 * the click, and a 402 after it says the same thing with the way to Billing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Inbox, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { EmptyState } from "../components/ui/empty-state";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { billingApi, joinRequestApi, type JoinRequestRow } from "../services/api";
import { useAuthStore } from "../store/auth";
import { approveErrorMessage, expiresInLabel, grantableRoles, seatLine } from "../utils/join-requests";
import { runInBackground } from "../lib/run-in-background";

export const PENDING_JOIN_REQUESTS_KEY = ["join-requests", "pending"] as const;

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const roleLabel = (role: string) => role.replace("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const decidedByLabel = (row: JoinRequestRow) => (row.status === "EXPIRED" ? "Nobody in time" : (row.decidedBy?.name ?? "—"));

const STATUS_VARIANT: Record<JoinRequestRow["status"], "success" | "secondary" | "outline"> = {
  PENDING: "outline",
  APPROVED: "success",
  DECLINED: "secondary",
  EXPIRED: "outline"
};

function ApproveDialog({ request, onClose }: { request: JoinRequestRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const viewerRole = useAuthStore((s) => s.user?.role);
  const roles = grantableRoles(viewerRole);
  const [role, setRole] = useState<string>("EMPLOYEE");
  const [refusal, setRefusal] = useState<{ text: string; billing: boolean } | null>(null);
  const billing = useQuery({ queryKey: ["billing", "status"], queryFn: billingApi.status, enabled: Boolean(request) });
  const seats = billing.data ? seatLine(billing.data.seatLimit, billing.data.activeSeats) : null;

  const approve = useMutation({
    mutationFn: () => joinRequestApi.approve(request!.id, role === "EMPLOYEE" ? undefined : role),
    onSuccess: (result) => {
      toast.success(result.linked ? `${request!.name} already had an account — linked` : `${request!.name} was added`, {
        description: result.linked ? "No new seat was used." : "They've been emailed a link to choose their password."
      });
      runInBackground(queryClient.invalidateQueries({ queryKey: ["join-requests"] }));
      runInBackground(queryClient.invalidateQueries({ queryKey: ["users"] }));
      runInBackground(queryClient.invalidateQueries({ queryKey: ["billing", "status"] }));
      onClose();
    },
    onError: (err) => setRefusal(approveErrorMessage(err))
  });

  const close = () => {
    setRole("EMPLOYEE");
    setRefusal(null);
    onClose();
  };

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add {request?.name}?</DialogTitle>
          <DialogDescription>{request?.email}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="join-role">Role</Label>
          <Select value={role} onValueChange={setRole} disabled={roles.length === 1}>
            <SelectTrigger id="join-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((option) => (
                <SelectItem key={option} value={option}>
                  {roleLabel(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {roles.length === 1 && <p className="text-xs text-muted-foreground">Only a super admin can add someone as more than an Employee.</p>}
        </div>
        {seats && <p className={`text-sm ${seats.full ? "text-destructive" : "text-muted-foreground"}`}>{seats.text}</p>}
        {refusal && (
          <p className="text-sm text-destructive">
            {refusal.text}{" "}
            {refusal.billing &&
              (viewerRole === "SUPER_ADMIN" ? (
                <a href="/app/settings?tab=billing" className="font-semibold underline">
                  Open Billing
                </a>
              ) : (
                "Ask a super admin."
              ))}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => approve.mutate()} disabled={approve.isPending || Boolean(seats?.full)}>
            <Check className="h-4 w-4" />
            {approve.isPending ? "Adding…" : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeclineDialog({ request, onClose }: { request: JoinRequestRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const decline = useMutation({
    mutationFn: () => joinRequestApi.decline(request!.id, note.trim()),
    onSuccess: () => {
      toast.success(`Declined ${request!.name}'s request`, { description: "They've been told by email." });
      runInBackground(queryClient.invalidateQueries({ queryKey: ["join-requests"] }));
      setNote("");
      onClose();
    },
    onError: (err: any) => toast.error("Couldn't decline the request", { description: err?.response?.data?.message })
  });

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Decline {request?.name}'s request?</DialogTitle>
          <DialogDescription>They'll get an email saying an administrator reviewed it. Your note, if you leave one, goes with it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="decline-note">
            Note <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea id="decline-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Please use your client's workspace instead." />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => decline.mutate()} disabled={decline.isPending}>
            <X className="h-4 w-4" />
            {decline.isPending ? "Declining…" : "Decline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PendingTable({ rows, onApprove, onDecline }: { rows: JoinRequestRow[]; onApprove: (row: JoinRequestRow) => void; onDecline: (row: JoinRequestRow) => void }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead className="hidden md:table-cell">Message</TableHead>
            <TableHead className="hidden md:table-cell">Asked</TableHead>
            <TableHead className="hidden md:table-cell">Expires</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="min-w-0 align-top">
                <div className="font-medium">{row.name}</div>
                <div className="break-all text-xs text-muted-foreground">{row.email}</div>
                {/* Below md the columns fold in here: a five-column table on a phone gave the
                    message one word per line and pushed the buttons off-screen. */}
                <div className="mt-1.5 grid gap-1 text-xs text-muted-foreground md:hidden">
                  {row.message && <p className="whitespace-pre-wrap text-foreground/80">{row.message}</p>}
                  <span>
                    Asked {formatDate(row.createdAt)} · expires {expiresInLabel(row.expiresAt)}
                  </span>
                </div>
              </TableCell>
              <TableCell className="hidden max-w-xs whitespace-pre-wrap text-sm text-muted-foreground md:table-cell">{row.message || "—"}</TableCell>
              <TableCell className="hidden whitespace-nowrap text-sm md:table-cell">{formatDate(row.createdAt)}</TableCell>
              <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">{expiresInLabel(row.expiresAt)}</TableCell>
              <TableCell className="align-top text-right">
                <div className="flex flex-col items-end gap-2 sm:flex-row sm:justify-end">
                  <Button size="sm" variant="outline" onClick={() => onDecline(row)}>
                    Decline
                  </Button>
                  <Button size="sm" onClick={() => onApprove(row)}>
                    Approve
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DecidedTable({ rows }: { rows: JoinRequestRow[] }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead className="hidden md:table-cell">By</TableHead>
            <TableHead className="hidden md:table-cell">When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="min-w-0 align-top">
                <div className="font-medium">{row.name}</div>
                <div className="break-all text-xs text-muted-foreground">{row.email}</div>
                <div className="mt-1 text-xs text-muted-foreground md:hidden">
                  {decidedByLabel(row)} · {formatDate(row.decidedAt ?? row.expiresAt)}
                </div>
              </TableCell>
              <TableCell className="align-top">
                <Badge variant={STATUS_VARIANT[row.status]}>{roleLabel(row.status)}</Badge>
                {row.roleGranted && <span className="ml-2 text-xs text-muted-foreground">as {roleLabel(row.roleGranted)}</span>}
                {row.decisionNote && <div className="mt-1 max-w-xs text-xs text-muted-foreground">“{row.decisionNote}”</div>}
              </TableCell>
              <TableCell className="hidden text-sm md:table-cell">{decidedByLabel(row)}</TableCell>
              <TableCell className="hidden whitespace-nowrap text-sm md:table-cell">{formatDate(row.decidedAt ?? row.expiresAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function JoinRequestsPanel() {
  const [approving, setApproving] = useState<JoinRequestRow | null>(null);
  const [declining, setDeclining] = useState<JoinRequestRow | null>(null);
  const pending = useQuery({ queryKey: PENDING_JOIN_REQUESTS_KEY, queryFn: () => joinRequestApi.list("pending"), refetchInterval: 60_000 });
  const decided = useQuery({ queryKey: ["join-requests", "decided"], queryFn: () => joinRequestApi.list("decided") });

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Waiting for a decision</CardTitle>
          <CardDescription>
            People who proved an address at your company's email domain and asked to join, rather than opening a workspace of their own. Unanswered
            requests expire on their own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.data && pending.data.length > 0 ? (
            <PendingTable rows={pending.data} onApprove={setApproving} onDecline={setDeclining} />
          ) : (
            <EmptyState
              compact
              icon={pending.isLoading ? UserPlus : Inbox}
              title={pending.isLoading ? "Loading requests…" : "No one is waiting"}
              description={pending.isLoading ? undefined : "When someone from your company asks to join, they'll appear here and super admins are notified."}
            />
          )}
        </CardContent>
      </Card>

      {decided.data && decided.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Decided</CardTitle>
            <CardDescription>The most recent approvals, declines and expiries.</CardDescription>
          </CardHeader>
          <CardContent>
            <DecidedTable rows={decided.data} />
          </CardContent>
        </Card>
      )}

      <ApproveDialog request={approving} onClose={() => setApproving(null)} />
      <DeclineDialog request={declining} onClose={() => setDeclining(null)} />
    </div>
  );
}

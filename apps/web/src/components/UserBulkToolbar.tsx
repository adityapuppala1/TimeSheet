/**
 * WHAT: the filter/search toolbar and the bulk-action bar for the user-management table.
 *
 * WHY SELECTION HAS TWO MODES, and this is the part worth reading: ticking every checkbox on the
 * page selects that page. It does NOT select the other four hundred people who match the same
 * filter, and a table that blurs those two things is how somebody deactivates a department while
 * believing they deactivated a screenful. So when the whole page is ticked and more rows match,
 * the bar offers "select all N matching" as a separate, explicit choice — and in that mode the
 * request carries the FILTER rather than a list of ids, so the server re-derives the set with the
 * same query the table used. Sending ten thousand ids from a browser is not workable, and any
 * client-side approximation of "everything matching" can disagree with the server's answer.
 *
 * WHY DESTRUCTIVE ACTIONS TYPE-TO-CONFIRM: delete and deactivate are the two that cannot be
 * undone from this screen, and the count is the thing people misread — "3" and "30" look alike in
 * a toolbar. Typing the number is a deliberate re-reading of it.
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, X } from "lucide-react";

import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { cn } from "../lib/utils";
import type { UserBulkAction, UserPageQuery } from "../services/api";

const ANY = "any";

export interface UserFilters {
  search: string;
  roleId: string;
  designation: string;
  status: string;
  online: string;
}

export const EMPTY_FILTERS: UserFilters = { search: "", roleId: ANY, designation: ANY, status: ANY, online: ANY };

/** Strips the "any" sentinels so the query string carries only real constraints. */
export function toQuery(f: UserFilters): UserPageQuery {
  return {
    search: f.search.trim() || undefined,
    roleId: f.roleId === ANY ? undefined : f.roleId,
    designation: f.designation === ANY ? undefined : f.designation,
    status: f.status === ANY ? undefined : (f.status as UserPageQuery["status"]),
    online: f.online === ANY ? undefined : (f.online as UserPageQuery["online"])
  };
}

export function hasAnyFilter(f: UserFilters): boolean {
  return f.search.trim() !== "" || f.roleId !== ANY || f.designation !== ANY || f.status !== ANY || f.online !== ANY;
}

const ACTION_LABEL: Record<UserBulkAction, string> = {
  DEACTIVATE: "Deactivate",
  ACTIVATE: "Reactivate",
  RESET_PASSWORD: "Reset password",
  RESEND_WELCOME: "Resend welcome email",
  FORCE_LOGOUT: "Sign out everywhere",
  DELETE: "Delete"
};

/** The two that end access and cannot be undone from this screen. */
const DESTRUCTIVE: UserBulkAction[] = ["DELETE", "DEACTIVATE"];

export function UserFilterBar({
  filters,
  onChange,
  roles,
  designations,
  total
}: {
  filters: UserFilters;
  onChange: (next: UserFilters) => void;
  roles: Array<{ id: string; name: string }>;
  designations: string[];
  total: number;
}) {
  const set = <K extends keyof UserFilters>(key: K, value: UserFilters[K]) => onChange({ ...filters, [key]: value });

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <Input
        value={filters.search}
        onChange={(e) => set("search", e.target.value)}
        placeholder="Search name, email, job title or role…"
        className="h-9 w-full sm:w-72"
        aria-label="Search users"
      />

      <Select value={filters.roleId} onValueChange={(v) => set("roleId", v)}>
        <SelectTrigger className="h-9 w-[9.5rem]"><SelectValue placeholder="Any role" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any role</SelectItem>
          {roles.map((r) => (
            <SelectItem key={r.id} value={r.id}>{r.name.replace(/_/g, " ")}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.designation} onValueChange={(v) => set("designation", v)}>
        <SelectTrigger className="h-9 w-[10.5rem]"><SelectValue placeholder="Any job title" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any job title</SelectItem>
          {designations.map((d) => (
            <SelectItem key={d} value={d}>{d}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.status} onValueChange={(v) => set("status", v)}>
        <SelectTrigger className="h-9 w-[9rem]"><SelectValue placeholder="Any status" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any status</SelectItem>
          <SelectItem value="ACTIVE">Active</SelectItem>
          <SelectItem value="INACTIVE">Inactive</SelectItem>
          <SelectItem value="PENDING_VERIFICATION">Pending</SelectItem>
        </SelectContent>
      </Select>

      <Select value={filters.online} onValueChange={(v) => set("online", v)}>
        <SelectTrigger className="h-9 w-[8.5rem]"><SelectValue placeholder="Anyone" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Online or not</SelectItem>
          <SelectItem value="online">Online now</SelectItem>
          <SelectItem value="offline">Offline</SelectItem>
        </SelectContent>
      </Select>

      {hasAnyFilter(filters) && (
        <Button variant="ghost" size="sm" className="h-9" onClick={() => onChange(EMPTY_FILTERS)}>
          <X className="h-3.5 w-3.5" />
          Clear
        </Button>
      )}

      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {total} {total === 1 ? "person" : "people"}
      </span>
    </div>
  );
}

export function UserBulkBar({
  selectedCount,
  total,
  pageCount,
  allMatchingSelected,
  onSelectAllMatching,
  onClear,
  onRun,
  running
}: {
  selectedCount: number;
  total: number;
  /** Rows on the current page — used to decide whether "select all matching" is worth offering. */
  pageCount: number;
  allMatchingSelected: boolean;
  onSelectAllMatching: () => void;
  onClear: () => void;
  onRun: (action: UserBulkAction, password?: string) => void;
  running: boolean;
}) {
  const [confirming, setConfirming] = useState<UserBulkAction | null>(null);
  const [typed, setTyped] = useState("");
  // Empty by default: the server then generates a random one-time password PER PERSON and
  // returns the list once. The old default here was the fixed "Admin@12345" — documented in
  // this repo's README, so effectively public.
  const [password, setPassword] = useState("");

  const effectiveCount = allMatchingSelected ? total : selectedCount;
  const needsTyping = confirming ? DESTRUCTIVE.includes(confirming) : false;
  const confirmOk = !needsTyping || typed.trim() === String(effectiveCount);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
        <span className="text-sm font-medium">
          {effectiveCount} selected
          {allMatchingSelected && <span className="text-muted-foreground"> (everyone matching this filter)</span>}
        </span>

        {/* Offered only when it would actually select MORE than the page — otherwise it is a
            button that appears to do something and does nothing. */}
        {!allMatchingSelected && selectedCount === pageCount && total > pageCount && (
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onSelectAllMatching}>
            Select all {total} matching this filter
          </Button>
        )}

        <div className="ml-auto flex flex-wrap gap-1.5">
          {(Object.keys(ACTION_LABEL) as UserBulkAction[]).map((action) => (
            <Button
              key={action}
              size="sm"
              variant={DESTRUCTIVE.includes(action) ? "destructive" : "outline"}
              disabled={running}
              onClick={() => {
                setTyped("");
                setConfirming(action);
              }}
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {ACTION_LABEL[action]}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={onClear} disabled={running}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {confirming && DESTRUCTIVE.includes(confirming) && <AlertTriangle className="h-4 w-4 text-destructive" />}
              {confirming ? ACTION_LABEL[confirming] : ""} {effectiveCount} {effectiveCount === 1 ? "person" : "people"}?
            </DialogTitle>
            <DialogDescription>
              {confirming === "DELETE" &&
                "They stop being able to sign in and disappear from pickers. Their timesheets, tickets and history are kept — deleting those would break the records that reference them."}
              {confirming === "DEACTIVATE" && "They're signed out everywhere immediately and can't sign back in."}
              {confirming === "ACTIVATE" && "They'll be able to sign in again. Existing sessions stay signed out."}
              {confirming === "RESET_PASSWORD" &&
                "Their current password stops working immediately and they're signed out on every device. Tell them the new one yourself — this doesn't email it."}
              {confirming === "RESEND_WELCOME" && "Sends the welcome email again. Anyone who isn't active is skipped."}
              {confirming === "FORCE_LOGOUT" && "Ends every session they have. They can sign straight back in."}
            </DialogDescription>
          </DialogHeader>

          {confirming === "RESET_PASSWORD" && (
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-password">New password (optional)</Label>
              <Input
                id="bulk-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave empty — each person gets their own random one-time password"
              />
              <p className="text-xs text-muted-foreground">
                Empty: a random password per person, shown to you once after the reset. Typed: the same
                password for everyone (min 8 characters). Either way they're prompted to change it at next
                sign-in.
              </p>
            </div>
          )}

          {needsTyping && (
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-confirm">
                Type <span className="font-mono font-semibold">{effectiveCount}</span> to confirm
              </Label>
              <Input
                id="bulk-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Not a formality — “3” and “30” look the same in a toolbar, and this one can't be undone here.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant={confirming && DESTRUCTIVE.includes(confirming) ? "destructive" : "default"}
              disabled={!confirmOk || running}
              onClick={() => {
                if (!confirming) return;
                // Empty or too-short → omit, and the server generates per-person passwords
                // (its schema refuses anything 1-7 chars, so never send those).
                onRun(confirming, confirming === "RESET_PASSWORD" && password.length >= 8 ? password : undefined);
                setConfirming(null);
              }}
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {confirming ? ACTION_LABEL[confirming] : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Page N of M with the two controls that matter. Kept dumb — the page state lives with the query. */
export function TablePager({
  page,
  pageSize,
  total,
  onPage,
  onPageSize
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
      <p className="text-xs text-muted-foreground">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
          <SelectTrigger className="h-8 w-[6.5rem]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[25, 50, 100, 200].map((n) => (
              <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-8" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          {page} / {pages}
        </span>
        <Button size="sm" variant="outline" className="h-8" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
          <ChevronDown className={cn("h-3.5 w-3.5 -rotate-90")} />
        </Button>
      </div>
    </div>
  );
}

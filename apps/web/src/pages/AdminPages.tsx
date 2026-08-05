/**
 * WHAT: four admin pages in one file — `UsersPage` (user CRUD/roles/manager assignment/invite/
 * reset), `ProjectsPage` (project CRUD + member assignment), `ApprovalsPage` (manager's
 * timesheet approve/reject queue), `ReportsPage` (exportable CSV/PDF reports).
 * WHY grouped in one file rather than four: these four screens share the same "admin console"
 * visual shell and are only ever reached via the same Admin nav section — splitting them
 * wouldn't reduce coupling, just add import overhead for no real benefit.
 * WHO renders this: `App.tsx`'s admin routes (`/app/admin/users`, `/app/admin/projects`,
 * `/app/admin/approvals`, `/app/admin/reports`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Archive,
  Check,
  DollarSign,
  Download,
  FileSpreadsheet,
  FileText,
  FolderTree,
  Layers,
  LogOut,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Share2,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Trash2,
  UploadCloud,
  Users2,
  UsersRound,
  X
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "../components/ui/alert-dialog";
import { ProjectBudgetPanel } from "../components/ProjectBudgetPanel";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { CsvBulkUploadDialog } from "../components/CsvBulkUploadDialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { DataTable } from "../components/ui/data-table";
import { TimesheetReportPanel } from "../components/TimesheetReportPanel";
import { DateRangePicker } from "../components/ui/date-range-picker";
import { TimesheetAnalyticsPanel } from "../components/TimesheetAnalyticsPanel";
import {
  EMPTY_FILTERS,
  TablePager,
  UserBulkBar,
  UserFilterBar,
  hasAnyFilter,
  toQuery,
  type UserFilters
} from "../components/UserBulkToolbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../components/ui/dropdown-menu";
import { copyText } from "../lib/clipboard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { ScrollArea } from "../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { computeTrend } from "../lib/trend";
import {
  attestationApi,
  faceApi,
  fileUrl,
  projectApi,
  reportApi,
  timesheetApi,
  userApi,
  type AttestationPayload,
  type AttestationRow,
  type ProjectAssignmentMember,
  type UserRow
} from "../services/api";
import { FaceVerificationDialog } from "../components/FaceVerificationDialog";
import { useFaceStatus } from "../lib/use-face-status";
import { useAuthStore } from "../store/auth";

const roles = ["SUPER_ADMIN", "ADMIN", "MANAGER", "TEAM_LEAD", "EMPLOYEE"];

const BULK_USER_COLUMNS: Array<{
  key: "name" | "email" | "role" | "managerEmail" | "designation" | "githubUsername" | "password";
  label: string;
  required?: boolean;
}> = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email", required: true },
  { key: "role", label: "Role", required: true },
  { key: "managerEmail", label: "Manager email" },
  { key: "designation", label: "Designation" },
  { key: "githubUsername", label: "GitHub username" },
  { key: "password", label: "Password" }
];

const BULK_USER_SAMPLE_CSV = `# TimeSphere bulk user upload — instructions
# 1. Keep the header row exactly as-is: name,email,role,managerEmail,designation,githubUsername,password
# 2. role must be one of: SUPER_ADMIN, ADMIN, MANAGER, TEAM_LEAD, EMPLOYEE
# 3. managerEmail is optional — leave blank for no manager. It can reference someone
#    ELSE in this same file (e.g. a manager and their reports uploaded together) —
#    upload order inside the file does not matter.
# 4. designation is optional free text (e.g. "Senior Backend Engineer") — it's just a
#    display label shown alongside the person's name; it has no effect on permissions.
# 5. githubUsername is optional (no leading @) — lets security-ingestion's CODEOWNERS/
#    last-committer auto-assignment (Workspace Settings → Security & DevOps) resolve a
#    finding back to this person.
# 6. password is optional — leave blank to auto-generate a random one (the user resets
#    it via the "Forgot password" flow, or an admin uses "Reset password" afterward).
# 7. Delete these instruction lines (or leave them — lines starting with # are ignored)
#    and replace the example rows below with your own data, then upload.
name,email,role,managerEmail,designation,githubUsername,password
Priya Sharma,priya.sharma@example.com,MANAGER,,Engineering Manager,priyasharma,
Rahul Verma,rahul.verma@example.com,EMPLOYEE,priya.sharma@example.com,Backend Engineer,rahulverma,
Ananya Iyer,ananya.iyer@example.com,EMPLOYEE,priya.sharma@example.com,Frontend Engineer,ananyaiyer,
`;

const BULK_PROJECT_COLUMNS: Array<{ key: "projectCode" | "projectName" | "moduleName" | "submoduleName"; label: string; required?: boolean }> = [
  { key: "projectCode", label: "Project code", required: true },
  { key: "projectName", label: "Project name", required: true },
  { key: "moduleName", label: "Module name" },
  { key: "submoduleName", label: "Submodule name" }
];

const BULK_PROJECT_SAMPLE_CSV = `# TimeSphere bulk project/module/submodule upload — instructions
# 1. Keep the header row exactly as-is: projectCode,projectName,moduleName,submoduleName
# 2. One row per (project, module, submodule) combination — repeat projectCode/projectName
#    on every row for that project, same way a spreadsheet handles a one-to-many hierarchy.
# 3. moduleName and submoduleName are optional — leave both blank to create just the
#    project itself; leave submoduleName blank to create a module with no submodules yet.
# 4. Safe to re-run: uploading the same project/module/submodule again does nothing (it
#    already exists), so you can add new rows to a previously-uploaded file and re-upload.
# 5. Delete these instruction lines (or leave them — lines starting with # are ignored)
#    and replace the example rows below with your own data, then upload.
projectCode,projectName,moduleName,submoduleName
WEB,Web Platform,Frontend,Checkout
WEB,Web Platform,Frontend,Login
WEB,Web Platform,Backend,
MOB,Mobile App,,
`;

function serverMessage(err: any, fallback: string) {
  return err?.response?.data?.message ?? fallback;
}

function initialsFor(name?: string) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/* ============================== USERS ============================== */
/** "just now" / "4 min ago" for presence; falls back to a compact date for anything older. */
function formatRelativeSeen(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes <= 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Compact login timestamp — "Aug 3, 02:31 AM", with the year only when it isn't this year. */
function formatLoginTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function UsersPage() {
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore((s) => s.user?.id);
  // 30s refetch keeps the presence dots honest — the server's picture itself moves in 5-minute
  // lastSeenAt increments, so polling faster would only pretend to more precision.
  // Server-side filtering, sorting and pagination. The old call fetched the first 50 users and
  // filtered them in the browser, which quietly meant that in an org with more than 50 people the
  // search box could not find most of them — it was searching a page, not the company.
  const [filters, setFilters] = useState<UserFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);

  // Typing shouldn't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search), 250);
    return () => clearTimeout(t);
  }, [filters.search]);

  const query = { ...toQuery({ ...filters, search: debouncedSearch }), page, pageSize };
  const users = useQuery({
    queryKey: ["users", "paged", query],
    queryFn: () => userApi.paged(query),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous
  });
  const rolesQuery = useQuery({ queryKey: ["roles"], queryFn: userApi.roles });

  const rows = users.data?.items ?? [];
  const total = users.data?.total ?? 0;

  // Any change to what is being looked at invalidates a selection that was made against the old
  // view. Carrying it over is how somebody acts on rows they can no longer see.
  useEffect(() => {
    setSelected(new Set());
    setAllMatchingSelected(false);
  }, [debouncedSearch, filters.roleId, filters.designation, filters.status, filters.online, page, pageSize]);

  const bulk = useMutation({
    mutationFn: (payload: { action: any; password?: string }) =>
      userApi.bulkAction({
        action: payload.action,
        password: payload.password,
        // Filter-based when "all matching" is on, explicit ids otherwise — see UserBulkToolbar's
        // header for why the two are kept distinct.
        ...(allMatchingSelected
          ? { filter: toQuery({ ...filters, search: debouncedSearch, online: "any" }) }
          : { userIds: [...selected] })
      }),
    onSuccess: (result) => {
      setSelected(new Set());
      setAllMatchingSelected(false);
      queryClient.invalidateQueries({ queryKey: ["users"] });
      // Bulk reset without an explicit password: each person got their OWN random one-time
      // password, and this response is the only place it will ever exist in plaintext.
      if (result.generatedPasswords?.length) {
        setBulkGenerated(result.generatedPasswords);
      }
      if (result.skipped.length === 0) {
        toast.success(`Applied to ${result.applied} ${result.applied === 1 ? "person" : "people"}`);
      } else {
        // Naming the first few is the difference between "some failed" and knowing what to do.
        toast.warning(`Applied to ${result.applied} of ${result.requested}`, {
          description: result.skipped
            .slice(0, 3)
            .map((sk) => `${sk.name}: ${sk.reason}`)
            .join(" · ") + (result.skipped.length > 3 ? ` · and ${result.skipped.length - 3} more` : "")
        });
      }
    },
    onError: (err: any) => toast.error("Bulk action failed", { description: serverMessage(err, "Try again.") })
  });

  function toggleRow(id: string) {
    setAllMatchingSelected(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const [draft, setDraft] = useState({
    name: "",
    email: "",
    role: "EMPLOYEE",
    password: "Admin@12345",
    managerId: "none",
    designation: "",
    githubUsername: "",
    faceVerificationRequired: false
  });
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [pendingReset, setPendingReset] = useState<{ id: string; name: string } | null>(null);
  /** The one-time password the server just generated — shown until dismissed, because it is
   *  never retrievable again (only its hash is stored). */
  const [generatedReset, setGeneratedReset] = useState<{ name: string; email: string; password: string } | null>(null);
  /** Same, for a bulk reset: one random password per person, shown once. */
  const [bulkGenerated, setBulkGenerated] = useState<Array<{ id: string; name: string; email: string; password: string }> | null>(null);
  const [pendingLogout, setPendingLogout] = useState<{ id: string; name: string } | null>(null);
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);

  // Deliberately NOT derived from the table's current page. "Who can I assign as a manager" is a
  // picker question, and answering it from page 3 of a filtered table would silently omit most of
  // the eligible people — the exact bug the separate list endpoint exists to avoid.
  const allUsers = useQuery({ queryKey: ["users"], queryFn: userApi.list });
  const eligibleManagers = useMemo(
    () => (allUsers.data ?? []).filter((u: any) => ["MANAGER", "TEAM_LEAD", "ADMIN", "SUPER_ADMIN"].includes(u.role?.name)),
    [allUsers.data]
  );

  const create = useMutation({
    mutationFn: userApi.create,
    onSuccess: (created: any) => {
      const welcome = created?.welcomeEmail;
      if (welcome?.sent) {
        toast.success("User created", { description: `Welcome email delivered to ${created.email}.` });
      } else {
        toast.warning("User created — welcome email NOT delivered", {
          description: welcome?.errorMessage ?? "SMTP refused the message. Check Email Templates → welcome → Recent sends for details.",
          duration: 10_000
        });
      }
      setDraft({ name: "", email: "", role: "EMPLOYEE", password: "Admin@12345", managerId: "none", designation: "", githubUsername: "", faceVerificationRequired: false });
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: any) => toast.error("Unable to create user", { description: serverMessage(err, "Try again.") })
  });

  const resendWelcome = useMutation({
    mutationFn: (id: string) => userApi.resendWelcome(id),
    onSuccess: (data: any) => toast.success("Welcome email resent", { description: `Delivered to ${data.to}.` }),
    onError: (err: any) => {
      const status = err?.response?.status;
      const message = err?.response?.data?.message ?? "Try again.";
      if (status === 502) {
        toast.error("Email NOT delivered", { description: message, duration: 10_000 });
      } else {
        toast.error("Resend failed", { description: message });
      }
    }
  });

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) => userApi.update(id, payload),
    onSuccess: () => {
      toast.success("User updated");
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: any) => toast.error("Update failed", { description: serverMessage(err, "Try again.") })
  });

  const remove = useMutation({
    mutationFn: userApi.remove,
    onSuccess: () => {
      toast.success("User deactivated");
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: any) => toast.error("Delete failed", { description: serverMessage(err, "Try again.") }),
    onSettled: () => setPendingDelete(null)
  });

  // No password passed: the server generates a random one-time password per person and returns
  // it exactly once (only the hash is stored). The old client sent the fixed "Admin@12345" —
  // documented in this repo's README, so effectively public.
  const resetPwd = useMutation({
    mutationFn: (id: string) => userApi.resetPassword(id),
    onSuccess: (result, id) => {
      const who = users.data?.items?.find((u: { id: string }) => u.id === id) as { name?: string; email?: string } | undefined;
      setGeneratedReset({
        name: who?.name ?? pendingReset?.name ?? "the user",
        email: who?.email ?? "",
        password: result.generatedPassword ?? ""
      });
      toast.success("Password reset", { description: "A one-time password was generated — copy it now, it is shown only once." });
    },
    onError: (err: any) => toast.error("Reset failed", { description: serverMessage(err, "Try again.") }),
    onSettled: () => setPendingReset(null)
  });

  const forceLogout = useMutation({
    mutationFn: (id: string) => userApi.forceLogout(id),
    onSuccess: ({ revokedSessions }) => {
      toast.success(
        revokedSessions === 0 ? "No active sessions — already signed out" : `Signed out ${revokedSessions} session${revokedSessions === 1 ? "" : "s"}`
      );
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: any) => toast.error("Sign-out failed", { description: serverMessage(err, "Try again.") }),
    onSettled: () => setPendingLogout(null)
  });

  function handleCreate() {
    create.mutate({
      name: draft.name,
      email: draft.email,
      role: draft.role,
      password: draft.password,
      managerId: draft.managerId === "none" ? null : draft.managerId,
      designation: draft.designation.trim() || null,
      faceVerificationRequired: draft.faceVerificationRequired,
      githubUsername: draft.githubUsername.trim() || null
    });
  }

  const allOnPageSelected = rows.length > 0 && rows.every((r: any) => selected.has(r.id));

  const userColumns = useMemo<ColumnDef<any, any>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        // The card layout repeats every header as a per-row label, which would turn one
        // select-all control into one per card. See data-table.tsx.
        meta: { cardLabel: false },
        header: () => (
          <input
            type="checkbox"
            aria-label="Select everyone on this page"
            className="h-4 w-4 cursor-pointer accent-[hsl(var(--primary))]"
            checked={allOnPageSelected}
            onChange={() => {
              setAllMatchingSelected(false);
              setSelected((prev) => {
                if (rows.every((r: any) => prev.has(r.id))) return new Set();
                return new Set(rows.map((r: any) => r.id));
              });
            }}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.name}`}
            className="h-4 w-4 cursor-pointer accent-[hsl(var(--primary))]"
            checked={allMatchingSelected || selected.has(row.original.id)}
            onChange={() => toggleRow(row.original.id)}
          />
        )
      },
      {
        id: "person",
        accessorFn: (row: any) => row.name,
        header: "Person",
        cell: ({ row }) => {
          const avatarSrc = fileUrl(row.original.avatarUrl);
          return (
            <div className="flex items-center gap-2">
              <Avatar className="h-7 w-7">
                {avatarSrc ? <AvatarImage src={avatarSrc} alt={row.original.name} /> : null}
                <AvatarFallback>{initialsFor(row.original.name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate font-medium">{row.original.name}</p>
                {row.original.designation && <p className="truncate text-xs text-muted-foreground">{row.original.designation}</p>}
              </div>
            </div>
          );
        }
      },
      { accessorKey: "email", header: "Email", cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span> },
      {
        id: "role",
        accessorFn: (row: any) => row.role?.name,
        header: "Role",
        cell: ({ row }) => <Badge variant="info">{row.original.role?.name?.replace("_", " ")}</Badge>
      },
      {
        id: "manager",
        accessorFn: (row: any) => row.manager?.name ?? "",
        header: "Manager",
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.manager?.name ?? "—"}</span>
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: (info) => <Badge variant={info.getValue() === "ACTIVE" ? "success" : "warning"}>{info.getValue() as string}</Badge>
      },
      {
        id: "presence",
        accessorFn: (row: any) => (row.online ? 1 : 0),
        header: "Online",
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${row.original.online ? "bg-success" : "bg-muted-foreground/30"}`}
              aria-hidden
            />
            {row.original.online ? (
              <span className="font-medium text-success">Online</span>
            ) : (
              <span className="text-muted-foreground">{row.original.lastSeenAt ? formatRelativeSeen(row.original.lastSeenAt) : "Offline"}</span>
            )}
          </span>
        )
      },
      {
        id: "firstLogin",
        accessorFn: (row: any) => row.firstLoginAt ?? "",
        header: "First login",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground" title={row.original.firstLoginAt ?? undefined}>
            {formatLoginTime(row.original.firstLoginAt)}
          </span>
        )
      },
      {
        id: "lastLogin",
        accessorFn: (row: any) => row.lastLoginAt ?? "",
        header: "Last login",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground" title={row.original.lastLoginAt ?? undefined}>
            {formatLoginTime(row.original.lastLoginAt)}
          </span>
        )
      },
      {
        id: "actions",
        header: () => <span className="block text-right">Actions</span>,
        enableSorting: false,
        // One labeled menu instead of six cryptic icon buttons: the icon row was the widest
        // cell in the table (it alone forced horizontal scroll at 100% zoom) and six unlabeled
        // glyphs made the destructive ones too easy to fat-finger. A menu is narrow, labeled,
        // and puts Delete behind an extra deliberate step.
        cell: ({ row }) => {
          const user = row.original;
          return (
            <div className="flex justify-end">
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={`Actions for ${user.name}`}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => setEditing(user)}>
                    <Pencil /> Edit details
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={resendWelcome.isPending && resendWelcome.variables === user.id}
                    onClick={() => resendWelcome.mutate(user.id)}
                  >
                    <Mail /> Resend welcome email
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => update.mutate({ id: user.id, payload: { status: user.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" } })}
                  >
                    {user.status === "ACTIVE" ? (
                      <>
                        <X /> Deactivate
                      </>
                    ) : (
                      <>
                        <Check /> Activate
                      </>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setPendingReset({ id: user.id, name: user.name })}>
                    <RotateCcw /> Reset password
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setPendingLogout({ id: user.id, name: user.name })}>
                    <LogOut /> Sign out everywhere
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                    onClick={() => setPendingDelete({ id: user.id, name: user.name })}
                  >
                    <Trash2 /> Delete user
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        }
      }
    ],
    [resendWelcome, update]
  );

  return (
    <Workspace title="User Management" subtitle="Create, edit, deactivate, reset, and map users into the manager hierarchy." icon={<Users2 className="h-5 w-5" />}>
      <Card data-tour="invite-user">
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="min-w-0">
            <CardTitle>Invite a teammate</CardTitle>
            <CardDescription>New users get the default password and must change it on first login.</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setBulkUploadOpen(true)}>
            <UploadCloud className="h-3.5 w-3.5" />Bulk upload
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <FieldShell label="Full name">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Aanya Sharma" />
            </FieldShell>
            <FieldShell label="Email">
              <Input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="aanya@company.com" />
            </FieldShell>
            <FieldShell label="Role">
              <Select value={draft.role} onValueChange={(value) => setDraft({ ...draft, role: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roles.map((role) => <SelectItem key={role} value={role}>{role.replace("_", " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </FieldShell>
            <FieldShell label="Manager">
              <Select value={draft.managerId} onValueChange={(value) => setDraft({ ...draft, managerId: value })}>
                <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No manager</SelectItem>
                  {eligibleManagers.map((manager: any) => (
                    <SelectItem key={manager.id} value={manager.id}>{manager.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldShell>
            <FieldShell label="Designation">
              <Input
                value={draft.designation}
                onChange={(e) => setDraft({ ...draft, designation: e.target.value })}
                placeholder="e.g. Senior Backend Engineer"
              />
            </FieldShell>
            <FieldShell label="GitHub username">
              <Input
                value={draft.githubUsername}
                onChange={(e) => setDraft({ ...draft, githubUsername: e.target.value })}
                placeholder="e.g. octocat (no @)"
              />
            </FieldShell>
            <FieldShell label="Require face verification">
              <div className="flex h-10 items-center gap-2">
                <Switch
                  checked={draft.faceVerificationRequired}
                  onCheckedChange={(v) => setDraft({ ...draft, faceVerificationRequired: v })}
                />
                <span className="text-xs text-muted-foreground">
                  Camera identity check on submit (only while enabled workspace-wide)
                </span>
              </div>
            </FieldShell>
            <FieldShell label="Temporary password">
              <Input value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
            </FieldShell>
            <div className="flex items-end">
              <Button className="w-full" onClick={handleCreate} disabled={!draft.name || !draft.email || create.isPending}>
                <Plus />Create user
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-3 p-4">
          <UserFilterBar
            filters={filters}
            onChange={(next) => {
              setFilters(next);
              setPage(1);
            }}
            roles={rolesQuery.data ?? []}
            designations={users.data?.designations ?? []}
            total={total}
          />

          {(selected.size > 0 || allMatchingSelected) && (
            <UserBulkBar
              selectedCount={selected.size}
              total={total}
              pageCount={rows.length}
              allMatchingSelected={allMatchingSelected}
              onSelectAllMatching={() => setAllMatchingSelected(true)}
              onClear={() => {
                setSelected(new Set());
                setAllMatchingSelected(false);
              }}
              onRun={(action, password) => bulk.mutate({ action, password })}
              running={bulk.isPending}
            />
          )}

          {users.data?.onlineFilterApplied && users.data.filteredOnPage < rows.length + 1 && (
            <p className="text-xs text-muted-foreground">
              Online status is checked against live sessions after the other filters, so this page can show fewer than{" "}
              {pageSize} rows.
            </p>
          )}

          {/* The table's own search and pagination are off: both now happen on the server, and two
              search boxes that filter different sets is worse than one that filters the right one. */}
          <DataTable
            columns={userColumns}
            data={rows}
            isLoading={users.isLoading}
            enableSearch={false}
            emptyMessage={hasAnyFilter(filters) ? "Nobody matches these filters." : "No users yet."}
            pageSize={200}
          />

          <TablePager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
        </CardContent>
      </Card>

      <UserEditDialog
        user={editing}
        onClose={() => setEditing(null)}
        eligibleManagers={eligibleManagers}
        onSubmit={(payload) => {
          if (!editing) return;
          update.mutate({ id: editing.id, payload }, { onSuccess: () => setEditing(null) });
        }}
      />

      <CsvBulkUploadDialog
        open={bulkUploadOpen}
        onOpenChange={setBulkUploadOpen}
        title="Bulk upload users"
        description="Upload a CSV to create many users at once, with manager mapping resolved by email — no need to create managers first."
        columns={BULK_USER_COLUMNS}
        sampleCsv={BULK_USER_SAMPLE_CSV}
        sampleFileName="timesphere-users-sample.csv"
        validateRow={(row) => (roles.includes(row.role?.trim()) ? null : `Invalid role "${row.role}" — must be one of ${roles.join(", ")}`)}
        onUpload={(rows) =>
          userApi.bulkCreate(
            rows.map((r) => ({
              name: r.name,
              email: r.email,
              role: r.role.trim(),
              managerEmail: r.managerEmail || undefined,
              designation: r.designation || undefined,
              githubUsername: r.githubUsername || undefined,
              password: r.password || undefined
            }))
          )
        }
        onUploaded={() => queryClient.invalidateQueries({ queryKey: ["users"] })}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes the user. They lose access immediately, but historic timesheets and audit entries remain intact for compliance.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
              className="bg-destructive text-destructive-foreground hover:brightness-110"
            >
              Delete user
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingLogout} onOpenChange={(open) => !open && setPendingLogout(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out {pendingLogout?.name} everywhere?</AlertDialogTitle>
            <AlertDialogDescription>
              Revokes every active session they have, on every device — their next action lands on the
              sign-in page and unsaved work is lost. They can sign back in immediately with the same
              password.
              {pendingLogout?.id === currentUserId &&
                " This is YOUR account — you'll be signed out of this session too."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingLogout && forceLogout.mutate(pendingLogout.id)}
              className="bg-destructive text-destructive-foreground hover:brightness-110"
            >
              Sign out everywhere
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingReset} onOpenChange={(open) => !open && setPendingReset(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset password for {pendingReset?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              A random one-time password is generated and shown to you exactly once — share it securely.
              They'll be prompted to choose their own at next sign-in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingReset && resetPwd.mutate(pendingReset.id)}>Reset password</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!generatedReset} onOpenChange={(open) => !open && setGeneratedReset(null)}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogHeader>
            <DialogTitle>One-time password for {generatedReset?.name}</DialogTitle>
            <DialogDescription>
              Shown only once — the server keeps just a hash. Copy it now and share it securely
              {generatedReset?.email ? ` with ${generatedReset.email}` : ""}. They'll be prompted to
              choose their own password at next sign-in.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm">
              {generatedReset?.password}
            </code>
            <Button
              variant="outline"
              onClick={async () => {
                const ok = generatedReset ? await copyText(generatedReset.password) : false;
                if (ok) toast.success("Copied");
                else toast.error("Copy failed — select the text and copy manually");
              }}
            >
              Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!bulkGenerated} onOpenChange={(open) => !open && setBulkGenerated(null)}>
        <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>One-time passwords ({bulkGenerated?.length})</DialogTitle>
            <DialogDescription>
              Each person got their own random password. This list is shown exactly once — the server keeps
              only hashes. Everyone will be prompted to choose their own password at next sign-in.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {bulkGenerated?.map((row) => (
              <div key={row.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{row.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{row.email}</p>
                </div>
                <code className="select-all font-mono text-sm">{row.password}</code>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            onClick={async () => {
              const text = (bulkGenerated ?? []).map((r) => `${r.name} <${r.email}>: ${r.password}`).join("\n");
              const ok = await copyText(text);
              if (ok) toast.success("All copied — paste somewhere safe, then delete after sharing");
              else toast.error("Copy failed — select the rows and copy manually");
            }}
          >
            Copy all
          </Button>
        </DialogContent>
      </Dialog>
    </Workspace>
  );
}

function UserEditDialog({
  user,
  onClose,
  eligibleManagers,
  onSubmit
}: {
  user: UserRow | null;
  onClose: () => void;
  eligibleManagers: any[];
  onSubmit: (payload: any) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    role: "EMPLOYEE",
    status: "ACTIVE" as "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION",
    managerId: "none",
    designation: "",
    githubUsername: "",
    faceVerificationRequired: false
  });
  // Key the form re-initialization on the user's stable id, not the whole
  // user object. This way a background refetch of the users list (which
  // produces a new object reference for the same record) does NOT clobber
  // unsaved edits in the dialog.
  useEffect(() => {
    if (user) {
      setForm({
        name: user.name,
        email: user.email,
        role: user.role.name,
        status: user.status,
        managerId: user.managerId ?? "none",
        designation: user.designation ?? "",
        githubUsername: user.githubUsername ?? "",
        faceVerificationRequired: user.faceVerificationRequired ?? false
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const eligible = eligibleManagers.filter((m: any) => m.id !== user?.id);

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(95vw,560px)] max-w-none">
        {user && (
          <>
            <DialogHeader>
              <DialogTitle>Edit {user.name}</DialogTitle>
              <DialogDescription>
                Change details, swap roles, or re-assign their manager. All changes are recorded in the audit log.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ue-name">Full name</Label>
                <Input id="ue-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ue-email">Email</Label>
                <Input id="ue-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Role</Label>
                  <Select value={form.role} onValueChange={(value) => setForm({ ...form, role: value })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {roles.map((role) => <SelectItem key={role} value={role}>{role.replace("_", " ")}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>Status</Label>
                  <Select value={form.status} onValueChange={(value) => setForm({ ...form, status: value as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="INACTIVE">Inactive</SelectItem>
                      <SelectItem value="PENDING_VERIFICATION">Pending verification</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="ue-designation">Designation</Label>
                  <Input
                    id="ue-designation"
                    value={form.designation}
                    onChange={(e) => setForm({ ...form, designation: e.target.value })}
                    placeholder="e.g. Senior Backend Engineer"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ue-github">GitHub username</Label>
                  <Input
                    id="ue-github"
                    value={form.githubUsername}
                    onChange={(e) => setForm({ ...form, githubUsername: e.target.value })}
                    placeholder="e.g. octocat (no @)"
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3 sm:col-span-2">
                  <div className="space-y-0.5 pr-4">
                    <Label htmlFor="ue-face">Require face verification</Label>
                    <p className="text-xs text-muted-foreground">
                      Ask this person to confirm their identity with a camera check when submitting. Only applies while face
                      verification is enabled in Workspace Settings and set to &ldquo;selected users&rdquo;.
                    </p>
                  </div>
                  <Switch
                    id="ue-face"
                    checked={form.faceVerificationRequired}
                    onCheckedChange={(v) => setForm({ ...form, faceVerificationRequired: v })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>Reports to</Label>
                <Select value={form.managerId} onValueChange={(value) => setForm({ ...form, managerId: value })}>
                  <SelectTrigger><SelectValue placeholder="No manager" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No manager</SelectItem>
                    {eligible.map((manager: any) => (
                      <SelectItem key={manager.id} value={manager.id}>
                        {manager.name} <span className="text-muted-foreground">({manager.role?.name?.replace("_", " ")})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                onClick={() =>
                  onSubmit({
                    name: form.name.trim(),
                    email: form.email.trim(),
                    role: form.role,
                    status: form.status,
                    managerId: form.managerId === "none" ? null : form.managerId,
                    designation: form.designation.trim() || null,
                    githubUsername: form.githubUsername.trim() || null,
                    faceVerificationRequired: form.faceVerificationRequired
                  })
                }
                disabled={!form.name.trim() || !form.email.trim()}
              >
                Save changes
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ============================== PROJECTS ============================== */
export function ProjectsPage() {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list });
  const [draft, setDraft] = useState({ code: "", name: "", description: "" });
  const [moduleDraft, setModuleDraft] = useState({ projectId: "", name: "" });
  const [submoduleDraft, setSubmoduleDraft] = useState({ moduleId: "", name: "" });
  const [pendingArchive, setPendingArchive] = useState<{ id: string; name: string } | null>(null);
  const [managingTeam, setManagingTeam] = useState<{ id: string; name: string } | null>(null);
  const [billingProject, setBillingProject] = useState<any | null>(null);
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);

  const create = useMutation({
    mutationFn: projectApi.create,
    onSuccess: () => {
      toast.success("Project created");
      setDraft({ code: "", name: "", description: "" });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err: any) => toast.error("Create failed", { description: serverMessage(err, "Try again.") })
  });
  const archive = useMutation({
    mutationFn: projectApi.remove,
    onSuccess: () => {
      toast.success("Project archived");
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err: any) => toast.error("Archive failed", { description: serverMessage(err, "Try again.") }),
    onSettled: () => setPendingArchive(null)
  });
  const addModule = useMutation({
    mutationFn: () => projectApi.createModule(moduleDraft.projectId, moduleDraft.name),
    onSuccess: () => {
      toast.success("Module added");
      setModuleDraft((d) => ({ ...d, name: "" }));
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err: any) => toast.error("Could not add module", { description: serverMessage(err, "Try again.") })
  });
  const addSubmodule = useMutation({
    mutationFn: () => projectApi.createSubmodule(submoduleDraft.moduleId, submoduleDraft.name),
    onSuccess: () => {
      toast.success("Submodule added");
      setSubmoduleDraft((d) => ({ ...d, name: "" }));
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err: any) => toast.error("Could not add submodule", { description: serverMessage(err, "Try again.") })
  });

  const modules = (projects.data ?? []).flatMap((p: any) =>
    p.modules.map((m: any) => ({ ...m, projectName: p.name }))
  );

  const projectColumns = useMemo<ColumnDef<any, any>[]>(
    () => [
      { accessorKey: "code", header: "Code", cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span> },
      { accessorKey: "name", header: "Name", cell: (info) => <span className="font-medium">{info.getValue()}</span> },
      {
        accessorKey: "status",
        header: "Status",
        cell: (info) => <Badge variant={info.getValue() === "ACTIVE" ? "success" : "warning"}>{info.getValue() as string}</Badge>
      },
      {
        id: "hierarchy",
        accessorFn: (row: any) => row.modules?.length ?? 0,
        header: "Hierarchy",
        cell: ({ row }) => (
          <span className="text-muted-foreground"><Layers className="mr-1 inline h-3 w-3" />{row.original.modules?.length ?? 0} modules</span>
        )
      },
      {
        id: "team",
        accessorFn: (row: any) => row.assignments?.length ?? 0,
        header: "Team",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex -space-x-2">
            {(row.original.assignments ?? []).slice(0, 4).map((a: any) => {
              const src = fileUrl(a.user?.avatarUrl);
              return (
                <Avatar key={a.user?.id} className="h-7 w-7 ring-2 ring-background">
                  {src ? <AvatarImage src={src} alt={a.user?.name} /> : null}
                  <AvatarFallback className="text-[10px]">{initialsFor(a.user?.name)}</AvatarFallback>
                </Avatar>
              );
            })}
            {(row.original.assignments?.length ?? 0) > 4 && (
              <div className="grid h-7 w-7 place-items-center rounded-full bg-muted text-[10px] font-semibold ring-2 ring-background">
                +{row.original.assignments.length - 4}
              </div>
            )}
            {(row.original.assignments?.length ?? 0) === 0 && <span className="text-xs text-muted-foreground">No one assigned</span>}
          </div>
        )
      },
      {
        id: "actions",
        header: () => <span className="block text-right">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => setManagingTeam({ id: row.original.id, name: row.original.name })}>
              <UsersRound className="h-3.5 w-3.5" />Manage team
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setBillingProject(row.original)}>
              <DollarSign className="h-3.5 w-3.5" />Billing
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setPendingArchive({ id: row.original.id, name: row.original.name })}
            >
              <Archive className="h-3.5 w-3.5" />Archive
            </Button>
          </div>
        )
      }
    ],
    []
  );

  return (
    <Workspace title="Project Management" subtitle="Create projects, modules, submodules, and assign who can log time on each." icon={<FolderTree className="h-5 w-5" />}>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="min-w-0">
            <CardTitle>Create a project</CardTitle>
            <CardDescription>
              Pick a short code (e.g. <span className="font-mono">HICS-OPS</span>) — it appears across reports, exports, and audit trails.
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setBulkUploadOpen(true)}>
            <UploadCloud className="h-3.5 w-3.5" />Bulk upload
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1.4fr_2fr_auto]">
            <FieldShell label="Code"><Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="HICS-OPS" /></FieldShell>
            <FieldShell label="Project name"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="HICS Operations Platform" /></FieldShell>
            <FieldShell label="Description"><Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What's this initiative for?" /></FieldShell>
            <div className="flex items-end">
              <Button className="w-full" onClick={() => create.mutate(draft)} disabled={!draft.code || !draft.name || create.isPending}>
                <Plus />Create
              </Button>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add module</p>
              <Select value={moduleDraft.projectId} onValueChange={(value) => setModuleDraft({ ...moduleDraft, projectId: value })}>
                <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
                <SelectContent>
                  {projects.data?.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input placeholder="Module name" value={moduleDraft.name} onChange={(e) => setModuleDraft({ ...moduleDraft, name: e.target.value })} />
              <Button onClick={() => addModule.mutate()} disabled={!moduleDraft.projectId || !moduleDraft.name || addModule.isPending}>
                <Plus />Add module
              </Button>
            </div>
            <div className="grid gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add submodule</p>
              <Select value={submoduleDraft.moduleId} onValueChange={(value) => setSubmoduleDraft({ ...submoduleDraft, moduleId: value })}>
                <SelectTrigger><SelectValue placeholder="Select module" /></SelectTrigger>
                <SelectContent>
                  {modules.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.projectName} / {m.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input placeholder="Submodule name" value={submoduleDraft.name} onChange={(e) => setSubmoduleDraft({ ...submoduleDraft, name: e.target.value })} />
              <Button onClick={() => addSubmodule.mutate()} disabled={!submoduleDraft.moduleId || !submoduleDraft.name || addSubmodule.isPending}>
                <Plus />Add submodule
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <DataTable
            columns={projectColumns}
            data={projects.data ?? []}
            isLoading={projects.isLoading}
            searchPlaceholder="Search projects..."
            emptyMessage="No projects yet."
            pageSize={20}
          />
        </CardContent>
      </Card>

      <ProjectTeamDialog project={managingTeam} onClose={() => setManagingTeam(null)} />

      <ProjectBillingDialog project={billingProject} onClose={() => setBillingProject(null)} />

      <CsvBulkUploadDialog
        open={bulkUploadOpen}
        onOpenChange={setBulkUploadOpen}
        title="Bulk upload projects"
        description="Upload a CSV to create many projects, modules, and submodules at once — one row per (project, module, submodule) combination. Safe to re-run."
        columns={BULK_PROJECT_COLUMNS}
        sampleCsv={BULK_PROJECT_SAMPLE_CSV}
        sampleFileName="timesphere-projects-sample.csv"
        validateRow={() => null}
        onUpload={(rows) =>
          projectApi.bulkCreate(
            rows.map((r) => ({
              projectCode: r.projectCode,
              projectName: r.projectName,
              moduleName: r.moduleName || undefined,
              submoduleName: r.submoduleName || undefined
            }))
          )
        }
        onUploaded={() => queryClient.invalidateQueries({ queryKey: ["projects"] })}
      />

      <AlertDialog open={!!pendingArchive} onOpenChange={(open) => !open && setPendingArchive(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {pendingArchive?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Archived projects disappear from new timesheet entries, but stay visible on history and reports.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingArchive && archive.mutate(pendingArchive.id)}>Archive project</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Workspace>
  );
}

/**
 * Per-project client-billing settings — the rate an approved timesheet on this project snapshots
 * (see api/src/services/billing-rate.service.ts) and the client name printed on a Verified Work
 * Attestation. Deliberately a small dialog rather than a new page: these are three optional fields
 * on an existing entity, not a new domain.
 */
function ProjectBillingDialog({ project, onClose }: { project: any | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    clientName: "",
    defaultHourlyRate: "",
    billingCurrency: "",
    // Planning layer (V6). Budget lives here rather than in a new dialog because it is the same
    // conversation as the rate — what this engagement costs and what it was sold for.
    budgetAmount: "",
    budgetCurrency: "",
    budgetAlertPct: "",
    plannedStartDate: "",
    plannedEndDate: ""
  });

  // Re-seed whenever a different project is opened, so the dialog never shows stale values from
  // the previously-opened row.
  useEffect(() => {
    if (!project) return;
    setDraft({
      clientName: project.clientName ?? "",
      defaultHourlyRate: project.defaultHourlyRate != null ? String(project.defaultHourlyRate) : "",
      billingCurrency: project.billingCurrency ?? "",
      budgetAmount: project.budgetAmount != null ? String(project.budgetAmount) : "",
      budgetCurrency: project.budgetCurrency ?? "",
      budgetAlertPct: project.budgetAlertPct != null ? String(project.budgetAlertPct) : "",
      plannedStartDate: project.plannedStartDate ? String(project.plannedStartDate).slice(0, 10) : "",
      plannedEndDate: project.plannedEndDate ? String(project.plannedEndDate).slice(0, 10) : ""
    });
  }, [project?.id]);

  const save = useMutation({
    mutationFn: () =>
      projectApi.update(project.id, {
        // Empty string means "clear it" — sent as null so the backend falls back to the
        // individual's own rate / the workspace default currency rather than storing "".
        clientName: draft.clientName.trim() || null,
        defaultHourlyRate: draft.defaultHourlyRate.trim() === "" ? null : Number(draft.defaultHourlyRate),
        billingCurrency: draft.billingCurrency.trim() ? draft.billingCurrency.trim().toUpperCase() : null,
        budgetAmount: draft.budgetAmount.trim() === "" ? null : Number(draft.budgetAmount),
        budgetCurrency: draft.budgetCurrency.trim() ? draft.budgetCurrency.trim().toUpperCase() : null,
        budgetAlertPct: draft.budgetAlertPct.trim() === "" ? null : Number(draft.budgetAlertPct),
        plannedStartDate: draft.plannedStartDate || null,
        plannedEndDate: draft.plannedEndDate || null
      }),
    onSuccess: () => {
      toast.success("Billing settings saved");
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  const rateInvalid = draft.defaultHourlyRate.trim() !== "" && !(Number(draft.defaultHourlyRate) >= 0);
  const currencyInvalid =
    (draft.billingCurrency.trim() !== "" && draft.billingCurrency.trim().length !== 3) ||
    (draft.budgetCurrency.trim() !== "" && draft.budgetCurrency.trim().length !== 3) ||
    // Refused rather than swapped: a swap guesses which of the two the author meant.
    (draft.plannedStartDate !== "" && draft.plannedEndDate !== "" && draft.plannedEndDate < draft.plannedStartDate);

  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,560px)] max-w-none overflow-y-auto">
        {project && (
          <>
            <DialogHeader>
              <DialogTitle>Billing &amp; budget — {project.name}</DialogTitle>
              <DialogDescription>
                Used when a timesheet on this project is approved: the rate is frozen onto that entry so later pay changes never
                rewrite what past work cost. All three are optional.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <FieldShell label="Client name">
                <Input
                  value={draft.clientName}
                  onChange={(e) => setDraft({ ...draft, clientName: e.target.value })}
                  placeholder="Acme Corp"
                />
              </FieldShell>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldShell label="Project hourly rate">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={draft.defaultHourlyRate}
                    onChange={(e) => setDraft({ ...draft, defaultHourlyRate: e.target.value })}
                    placeholder="Falls back to each person's rate"
                  />
                </FieldShell>
                <FieldShell label="Currency">
                  <Input
                    value={draft.billingCurrency}
                    onChange={(e) => setDraft({ ...draft, billingCurrency: e.target.value })}
                    placeholder="USD"
                    maxLength={3}
                  />
                </FieldShell>
              </div>
              <p className="text-xs text-muted-foreground">
                Leave the rate blank to bill each person at their own hourly rate. Leave currency blank to use the workspace
                default. An attestation refuses to mix currencies in one period rather than silently summing them.
              </p>

              {/* Planning layer (V6). Burn against this budget is never stored — it is summed
                  live from the rate snapshots above, so the figure here and the figure on an
                  attestation cannot drift apart. */}
              <div className="grid gap-4 border-t border-border pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Budget &amp; planned dates</p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <FieldShell label="Budget">
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      value={draft.budgetAmount}
                      onChange={(e) => setDraft({ ...draft, budgetAmount: e.target.value })}
                      placeholder="No budget"
                    />
                  </FieldShell>
                  <FieldShell label="Budget currency">
                    <Input
                      value={draft.budgetCurrency}
                      onChange={(e) => setDraft({ ...draft, budgetCurrency: e.target.value })}
                      placeholder="Falls back to billing"
                      maxLength={3}
                    />
                  </FieldShell>
                  <FieldShell label="Alert at %">
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={draft.budgetAlertPct}
                      onChange={(e) => setDraft({ ...draft, budgetAlertPct: e.target.value })}
                      placeholder="80"
                    />
                  </FieldShell>
                </div>
                <FieldShell label="Planned window">
                  <DateRangePicker
                    className="w-full"
                    value={{ from: draft.plannedStartDate, to: draft.plannedEndDate }}
                    onChange={(range) => setDraft({ ...draft, plannedStartDate: range.from, plannedEndDate: range.to })}
                    placeholder="No planned window"
                  />
                </FieldShell>
                <p className="text-xs text-muted-foreground">
                  The planned window is what the portfolio compares the real schedule against — the gap between the two is
                  where a project goes wrong quietly.
                </p>
              </div>

              {project.id && <ProjectBudgetPanel projectId={project.id} />}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending || rateInvalid || currencyInvalid}>
                <Save className="h-4 w-4" />Save
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProjectTeamDialog({ project, onClose }: { project: { id: string; name: string } | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: userApi.list, enabled: Boolean(project) });
  const assignments = useQuery({
    queryKey: ["project-assignments", project?.id],
    queryFn: () => projectApi.assignments(project!.id),
    enabled: Boolean(project)
  });
  const [filter, setFilter] = useState("");
  const [dragOverSide, setDragOverSide] = useState<"available" | "assigned" | null>(null);

  const assignedIds = useMemo(() => new Set((assignments.data ?? []).map((a) => a.userId)), [assignments.data]);
  const available = useMemo(() => {
    const list: UserRow[] = (users.data ?? []) as UserRow[];
    return list
      .filter((u) => u.status === "ACTIVE" && !assignedIds.has(u.id))
      .filter((u) => !filter.trim() || `${u.name} ${u.email}`.toLowerCase().includes(filter.toLowerCase()));
  }, [users.data, assignedIds, filter]);

  const assigned = useMemo(() => {
    return (assignments.data ?? []).map((a) => a.user);
  }, [assignments.data]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["project-assignments", project?.id] });
    queryClient.invalidateQueries({ queryKey: ["projects"] });
  }

  const assign = useMutation({
    mutationFn: (userId: string) => projectApi.assign(project!.id, userId),
    onSuccess: () => invalidate(),
    onError: (err: any) => toast.error("Could not assign", { description: serverMessage(err, "Try again.") })
  });
  const unassign = useMutation({
    mutationFn: (userId: string) => projectApi.unassign(project!.id, userId),
    onSuccess: () => invalidate(),
    onError: (err: any) => toast.error("Could not remove", { description: serverMessage(err, "Try again.") })
  });

  function onDragStart(event: React.DragEvent<HTMLDivElement>, userId: string, from: "available" | "assigned") {
    event.dataTransfer.setData("text/plain", `${from}:${userId}`);
    event.dataTransfer.effectAllowed = "move";
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>, to: "available" | "assigned") {
    event.preventDefault();
    setDragOverSide(null);
    const payload = event.dataTransfer.getData("text/plain");
    const [from, userId] = payload.split(":");
    if (!userId || from === to) return;
    if (to === "assigned") assign.mutate(userId);
    else unassign.mutate(userId);
  }

  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,920px)] max-w-none overflow-y-auto">
        {project && (
          <>
            <DialogHeader>
              <DialogTitle>Manage team — {project.name}</DialogTitle>
              <DialogDescription>
                Drag users between the columns or click + / × to assign. Only assigned users will see this project on their timesheet form.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter available users by name or email..."
              />

              <div className="grid gap-3 sm:grid-cols-2">
                {/* Available */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOverSide("available"); }}
                  onDragLeave={() => setDragOverSide(null)}
                  onDrop={(e) => onDrop(e, "available")}
                  className={`grid gap-1 rounded-lg border border-dashed p-2 transition ${
                    dragOverSide === "available" ? "border-primary bg-primary/5" : "border-border bg-muted/30"
                  }`}
                >
                  <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Available ({available.length})
                  </p>
                  <ScrollArea className="h-72">
                    <div className="grid gap-1">
                      {available.map((user) => (
                        <UserChip
                          key={user.id}
                          user={user}
                          actionLabel="Add to project"
                          actionIcon={<Plus className="h-3.5 w-3.5" />}
                          onAction={() => assign.mutate(user.id)}
                          onDragStart={(e) => onDragStart(e, user.id, "available")}
                        />
                      ))}
                      {available.length === 0 && (
                        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                          {users.isLoading ? "Loading users…" : "Everyone's already on the team."}
                        </p>
                      )}
                    </div>
                  </ScrollArea>
                </div>

                {/* Assigned */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOverSide("assigned"); }}
                  onDragLeave={() => setDragOverSide(null)}
                  onDrop={(e) => onDrop(e, "assigned")}
                  className={`grid gap-1 rounded-lg border border-dashed p-2 transition ${
                    dragOverSide === "assigned" ? "border-primary bg-primary/5" : "border-border bg-background"
                  }`}
                >
                  <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Assigned ({assigned.length})
                  </p>
                  <ScrollArea className="h-72">
                    <div className="grid gap-1">
                      {assigned.map((user) => (
                        <UserChip
                          key={user.id}
                          user={user}
                          actionLabel="Remove"
                          actionIcon={<X className="h-3.5 w-3.5" />}
                          variant="destructive"
                          onAction={() => unassign.mutate(user.id)}
                          onDragStart={(e) => onDragStart(e, user.id, "assigned")}
                        />
                      ))}
                      {assigned.length === 0 && (
                        <p className="px-2 py-6 text-center text-xs text-muted-foreground">No one assigned yet.</p>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserChip({
  user,
  actionLabel,
  actionIcon,
  variant = "primary",
  onAction,
  onDragStart
}: {
  user: ProjectAssignmentMember | UserRow;
  actionLabel: string;
  actionIcon: ReactNode;
  variant?: "primary" | "destructive";
  onAction: () => void;
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  const src = fileUrl(user.avatarUrl);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="flex cursor-grab items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 transition active:cursor-grabbing hover:border-primary/40"
    >
      <Avatar className="h-7 w-7">
        {src ? <AvatarImage src={src} alt={user.name} /> : null}
        <AvatarFallback className="text-[10px]">{initialsFor(user.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">{user.name}</p>
        <p className="truncate text-xs text-muted-foreground">{user.role?.name?.replace("_", " ")} · {user.email}</p>
      </div>
      <Button
        type="button"
        size="icon"
        variant={variant === "destructive" ? "ghost" : "ghost"}
        className={`h-9 w-9 ${variant === "destructive" ? "text-destructive hover:bg-destructive/10 hover:text-destructive" : "text-primary hover:bg-primary/10 hover:text-primary"}`}
        aria-label={actionLabel}
        title={actionLabel}
        onClick={onAction}
      >
        {actionIcon}
      </Button>
    </div>
  );
}

/* ============================== APPROVALS ============================== */
export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const timesheets = useQuery({ queryKey: ["timesheets"], queryFn: timesheetApi.list });
  const [rejectTarget, setRejectTarget] = useState<{ id: string; user: string } | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const approve = useMutation({
    mutationFn: ({ id, faceVerificationId }: { id: string; faceVerificationId?: string }) =>
      timesheetApi.approve(id, faceVerificationId),
    onSuccess: () => {
      toast.success("Approved", { description: "Employee will receive an in-app + email confirmation." });
      queryClient.invalidateQueries({ queryKey: ["timesheets"] });
    },
    onError: (err: any) => toast.error("Approval failed", { description: serverMessage(err, "Try again.") })
  });

  // Face (identity) verification on the APPROVER, when the workspace requires it — approval is
  // where hours become payable. The row is parked while the check runs. Rejection is ungated
  // (see the server-side comment in timesheet.controller.ts).
  const faceStatus = useFaceStatus();
  const [pendingApproveId, setPendingApproveId] = useState<string | null>(null);
  const requestApprove = (id: string) => {
    if (faceStatus.data?.requiredForApproval) {
      setPendingApproveId(id);
      return;
    }
    approve.mutate({ id });
  };
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => timesheetApi.reject(id, reason),
    onSuccess: () => {
      toast.success("Rejected with reason", { description: "The submitter has been notified." });
      queryClient.invalidateQueries({ queryKey: ["timesheets"] });
      setRejectTarget(null);
      setRejectReason("");
    },
    onError: (err: any) => toast.error("Rejection failed", { description: serverMessage(err, "Try again.") })
  });

  // Same authenticated-blob pattern as the report DownloadButton below — the route needs a
  // bearer token, which a bare <a href>/window.open can't attach.
  const downloadEvidencePack = async (timesheetId: string) => {
    try {
      const blob = await faceApi.downloadEvidencePack(timesheetId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `identity-evidence-${timesheetId.slice(0, 8)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success("Evidence pack downloaded");
    } catch (err: any) {
      toast.error("Could not download evidence pack", { description: serverMessage(err, "Try again.") });
    }
  };

  const pending = (timesheets.data ?? []).filter((row: any) => row.status === "SUBMITTED");

  const approvalColumns = useMemo<ColumnDef<any, any>[]>(
    () => [
      { id: "employee", accessorFn: (row: any) => row.user?.name, header: "Employee", cell: ({ row }) => <span className="font-medium">{row.original.user?.name}</span> },
      {
        id: "date",
        accessorFn: (row: any) => row.workDate,
        header: "Date",
        cell: ({ row }) => <span className="text-muted-foreground">{String(row.original.workDate).slice(0, 10)}</span>
      },
      { id: "project", accessorFn: (row: any) => row.project?.name, header: "Project" },
      { accessorKey: "activityType", header: "Activity" },
      {
        id: "hours",
        accessorFn: (row: any) => Number(row.totalHours),
        header: "Hours",
        cell: ({ row }) => <span className="font-semibold">{Number(row.original.totalHours).toFixed(2)}</span>
      },
      { accessorKey: "status", header: "Status", cell: (info) => <Badge variant="warning">{info.getValue() as string}</Badge> },
      {
        id: "identity",
        header: "Identity",
        enableSorting: false,
        // Three distinguishable states so absence is never ambiguous: verified (face check spent
        // on this row), "unverified" (the policy covers this person but the row predates it or
        // slipped through a gap — worth a manager's glance), or a quiet dash (not covered).
        cell: ({ row }) =>
          row.original.identityVerified ? (
            <div className="flex items-center gap-1">
              <Badge
                variant="success"
                title={row.original.identityVerifiedAt ? `Face check passed ${new Date(row.original.identityVerifiedAt).toLocaleString()}` : undefined}
              >
                <ShieldCheck className="mr-1 h-3 w-3" />Verified
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Download the dispute-ready identity evidence pack for this entry"
                onClick={() => downloadEvidencePack(row.original.id)}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : row.original.identityVerificationApplies ? (
            <Badge variant="outline" title="This person is covered by face verification, but this entry carries no identity check (it may predate the policy).">
              Unverified
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
      },
      {
        id: "decision",
        header: () => <span className="block text-right">Decision</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-2">
            <Button variant="success" size="sm" onClick={() => requestApprove(row.original.id)}>
              <Check className="h-4 w-4" />Approve
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRejectTarget({ id: row.original.id, user: row.original.user?.name })}>
              <ShieldX className="h-4 w-4" />Reject
            </Button>
          </div>
        )
      }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestApprove closes over stable refs
    [approve, faceStatus.data?.requiredForApproval, downloadEvidencePack]
  );

  return (
    <Workspace title="Timesheet Approvals" subtitle="Review submitted work logs with attachments and audit-friendly actions." icon={<Check className="h-5 w-5" />}>
      <Card>
        <CardContent className="p-4">
          <DataTable
            columns={approvalColumns}
            data={pending}
            isLoading={timesheets.isLoading}
            enableSearch={false}
            emptyMessage="Nothing pending — you're all caught up."
            pageSize={20}
          />
        </CardContent>
      </Card>

      <Dialog open={!!rejectTarget} onOpenChange={(open) => { if (!open) { setRejectTarget(null); setRejectReason(""); } }}>
        <DialogContent className="w-[min(95vw,520px)] max-w-none">
          <DialogHeader>
            <DialogTitle>Reject {rejectTarget?.user}'s timesheet</DialogTitle>
            <DialogDescription>Provide a clear reason — it's shown to the employee and recorded in the audit log.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="reject-reason">Rejection reason</Label>
            <Textarea
              id="reject-reason"
              rows={4}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="e.g. Activity should be 'Bug Fixing' rather than 'Development' for this ticket."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejectTarget(null); setRejectReason(""); }}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length < 5 || reject.isPending}
              onClick={() => rejectTarget && reject.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })}
            >
              <ShieldX className="h-4 w-4" />Confirm rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FaceVerificationDialog
        open={pendingApproveId !== null}
        onOpenChange={(open) => !open && setPendingApproveId(null)}
        context="APPROVAL"
        actionLabel="approve this timesheet"
        onVerified={(verificationId) => {
          const id = pendingApproveId;
          setPendingApproveId(null);
          if (id) approve.mutate({ id, faceVerificationId: verificationId });
        }}
      />
    </Workspace>
  );
}

/* ============================== REPORTS ============================== */
export function ReportsPage() {
  const analytics = useQuery({ queryKey: ["admin-summary"], queryFn: reportApi.admin, refetchInterval: 30_000 });
  const ticketAnalytics = useQuery({ queryKey: ["ticket-summary"], queryFn: reportApi.tickets, refetchInterval: 30_000 });
  const projectData = (analytics.data?.byProject ?? []).map((row: any) => ({ name: row.project, hours: Number(row._sum?.totalHours ?? 0) }));
  const priorityData = (ticketAnalytics.data?.byPriority ?? []).map((row) => ({ name: row.priority, count: row._count }));
  const slaBreached = analytics.data?.slaBreached ?? 0;
  const openEscalations = analytics.data?.openEscalations ?? 0;
  const approvedThisWeek = analytics.data?.approvedThisWeek ?? 0;
  const openTickets = (ticketAnalytics.data?.byStatus ?? [])
    .filter((row) => row.status !== "RESOLVED" && row.status !== "CLOSED")
    .reduce((sum, row) => sum + row._count, 0);

  return (
    <Workspace title="Reports & Exports" subtitle="Download operational reports and inspect utilization analytics." icon={<FileSpreadsheet className="h-5 w-5" />}>
      <div data-tour="reports-exports" className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Users"
          value={analytics.data?.users ?? 0}
          trend={computeTrend(analytics.data?.users ?? 0, analytics.data?.usersYesterday ?? 0, true)}
          trendLabel="vs yesterday"
        />
        <StatCard
          label="Projects"
          value={analytics.data?.projects ?? 0}
          trend={computeTrend(analytics.data?.projects ?? 0, analytics.data?.projectsYesterday ?? 0, true)}
          trendLabel="vs yesterday"
        />
        <StatCard
          label="Pending approvals"
          value={analytics.data?.pendingApprovals ?? 0}
          tone={(analytics.data?.pendingApprovals ?? 0) > 0 ? "warning" : "default"}
          trend={computeTrend(analytics.data?.pendingApprovals ?? 0, analytics.data?.pendingApprovalsYesterday ?? 0, false)}
          trendLabel="vs yesterday"
        />
        <StatCard
          label="Approved this week"
          value={approvedThisWeek}
          tone="success"
          trend={computeTrend(approvedThisWeek, analytics.data?.approvedLastWeek ?? 0, true)}
          trendLabel="vs last week"
        />
        <StatCard
          label="SLA breaches"
          value={slaBreached}
          tone={slaBreached > 0 ? "warning" : "default"}
          trend={computeTrend(slaBreached, analytics.data?.slaBreachedYesterday ?? 0, false)}
          trendLabel="vs yesterday"
        />
        <StatCard
          label="Open escalations"
          value={openEscalations}
          tone={openEscalations > 0 ? "warning" : "default"}
          trend={computeTrend(openEscalations, analytics.data?.openEscalationsYesterday ?? 0, false)}
          trendLabel="vs yesterday"
        />
      </div>
      {/* The report leads: the point is usually a question ("where did Apollo's hours go?"), and
          answering it on screen means most people never need the download at all. */}
      <TimesheetReportPanel />

      {/* Sits under the report because it answers the follow-up question. The report says where
          the hours went; this says whether that was a reasonable amount of them. */}
      <TimesheetAnalyticsPanel />

      <Card>
        <CardHeader className="flex-col items-start justify-between gap-3 space-y-0 sm:flex-row sm:items-center">
          <div>
            <CardTitle>Project hours</CardTitle>
            <CardDescription>Aggregate across the workspace — drill into a project from the table view.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={projectData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <RTooltip
                  contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }}
                />
                <Bar dataKey="hours" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
        <StatCard label="Open tickets" value={openTickets} tone={openTickets > 0 ? "warning" : "default"} />
        <StatCard
          label="Ticket SLA breaches"
          value={ticketAnalytics.data?.openSlaBreaches ?? 0}
          tone={(ticketAnalytics.data?.openSlaBreaches ?? 0) > 0 ? "destructive" : "default"}
          trend={computeTrend(ticketAnalytics.data?.openSlaBreaches ?? 0, ticketAnalytics.data?.openSlaBreachesYesterday ?? 0, false)}
          trendLabel="vs yesterday"
        />
        <StatCard
          label="Resolved this week"
          value={ticketAnalytics.data?.resolvedThisWeek ?? 0}
          tone="success"
          trend={computeTrend(ticketAnalytics.data?.resolvedThisWeek ?? 0, ticketAnalytics.data?.resolvedLastWeek ?? 0, true)}
          trendLabel="vs last week"
        />
        <StatCard
          label="Avg. resolution time"
          value={`${ticketAnalytics.data?.avgResolutionHours ?? 0}h`}
          trend={computeTrend(
            ticketAnalytics.data?.avgResolutionHours ?? 0,
            ticketAnalytics.data?.avgResolutionHoursLastWeek ?? 0,
            false
          )}
          trendLabel="vs last week"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Tickets by priority</CardTitle>
          <CardDescription>Open, in-progress, and closed tickets across the workspace, grouped by priority.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={priorityData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
                <RTooltip
                  contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }}
                />
                <Bar dataKey="count" fill="hsl(var(--accent))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
      <StatusReportCard />
      <AttestationsCard />
    </Workspace>
  );
}

/** First day of the current month / today, as YYYY-MM-DD — the default attestation period, since
 *  a monthly billing cycle is the common case. */
function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: fmt(first), end: fmt(now) };
}

/**
 * Verified Work Attestation — issue a client-facing artifact proving approved hours map to real
 * tickets, done by identity-verified people, approved by a named manager, at a frozen rate.
 * See api/src/services/attestation.service.ts.
 *
 * Follows StatusReportCard's convention for the disabled case: a 403 because the workspace hasn't
 * enabled the feature is shown as a friendly inline note, not an error toast — "not turned on
 * yet" isn't a failure.
 */
function AttestationsCard() {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list });
  const [projectId, setProjectId] = useState("");
  const [period, setPeriod] = useState(defaultPeriod);
  const [preview, setPreview] = useState<AttestationPayload | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [voiding, setVoiding] = useState<AttestationRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [sharing, setSharing] = useState<AttestationRow | null>(null);

  const issued = useQuery({
    queryKey: ["attestations", projectId],
    queryFn: () => attestationApi.list(projectId),
    enabled: Boolean(projectId) && !disabled
  });

  function handleGateError(err: any, fallbackTitle: string) {
    if (err?.response?.status === 403) {
      setDisabled(true);
      return;
    }
    toast.error(fallbackTitle, { description: serverMessage(err, "Try again.") });
  }

  const runPreview = useMutation({
    mutationFn: () => attestationApi.preview({ projectId, periodStart: period.start, periodEnd: period.end }),
    onSuccess: (data) => {
      setPreview(data.payload);
      setDisabled(false);
    },
    onError: (err: any) => handleGateError(err, "Couldn't build the preview")
  });

  const issue = useMutation({
    mutationFn: () => attestationApi.issue({ projectId, periodStart: period.start, periodEnd: period.end }),
    onSuccess: (row) => {
      toast.success(`Attestation ${row.reference} issued`);
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ["attestations", projectId] });
    },
    onError: (err: any) => handleGateError(err, "Couldn't issue the attestation")
  });

  const voidMutation = useMutation({
    mutationFn: () => attestationApi.void(voiding!.id, voidReason.trim()),
    onSuccess: () => {
      toast.success("Attestation voided");
      setVoiding(null);
      setVoidReason("");
      queryClient.invalidateQueries({ queryKey: ["attestations", projectId] });
    },
    onError: (err: any) => toast.error("Couldn't void it", { description: serverMessage(err, "Try again.") })
  });

  // Authenticated blob download — the access token is in memory only, so a bare <a href> would
  // hit the route unauthenticated. Same pattern as DownloadButton below.
  async function download(row: AttestationRow, kind: "json" | "pdf") {
    setDownloadingId(`${row.id}:${kind}`);
    try {
      const blob = kind === "pdf" ? await attestationApi.downloadPdf(row.id) : await attestationApi.downloadJson(row.id);
      const url = URL.createObjectURL(blob as Blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `attestation-${row.reference}.${kind}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error("Download failed", { description: serverMessage(err, "Try again.") });
    } finally {
      setDownloadingId(null);
    }
  }

  const canRun = Boolean(projectId) && Boolean(period.start) && Boolean(period.end);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          Verified work attestation
        </CardTitle>
        <CardDescription>
          A client-facing record that approved hours map to real tickets, done by identity-verified people and approved by a named
          manager, priced at the rate frozen when each entry was approved.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {disabled && (
          <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            Attestations are off for this workspace. A super admin can turn them on under Workspace Settings → Ticketing.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_auto]">
          <div className="grid gap-1.5">
            <Label>Project</Label>
            <Select value={projectId} onValueChange={(v) => { setProjectId(v); setPreview(null); }}>
              <SelectTrigger><SelectValue placeholder="Select a project" /></SelectTrigger>
              <SelectContent>
                {(projects.data ?? []).map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="attestation-period">Period</Label>
            {/* An attestation is a client-facing document about a specific period, so an unbounded
                range is not a meaningful choice here. */}
            <DateRangePicker
              id="attestation-period"
              className="w-full"
              value={{ from: period.start, to: period.end }}
              onChange={(range) => { setPeriod({ start: range.from, end: range.to }); setPreview(null); }}
              allowAllTime={false}
            />
          </div>
          <div className="flex items-end">
            <Button className="w-full" variant="outline" onClick={() => runPreview.mutate()} disabled={!canRun || runPreview.isPending}>
              {runPreview.isPending ? "Building…" : "Preview"}
            </Button>
          </div>
        </div>

        {preview && (
          <div className="grid gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
            <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
              <div>
                <p className="text-xs uppercase text-muted-foreground">Approved entries</p>
                <p className="text-xl font-black">{preview.summary.entryCount}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Total hours</p>
                <p className="text-xl font-black">{preview.summary.totalHours.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Amount</p>
                <p className="text-xl font-black">{preview.summary.totalAmount.toFixed(2)} {preview.attestation.currency}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Identity verified</p>
                <p className="text-xl font-black">{preview.summary.identityVerifiedEntries}/{preview.summary.entryCount}</p>
              </div>
            </div>
            {preview.caveats.length > 0 && (
              <ul className="grid gap-1 text-xs text-muted-foreground">
                {preview.caveats.map((c, i) => <li key={i}>• {c}</li>)}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => issue.mutate()} disabled={issue.isPending || preview.summary.entryCount === 0}>
                <Check className="h-3.5 w-3.5" />Issue attestation
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Discard preview</Button>
            </div>
            {preview.summary.entryCount === 0 && (
              <p className="text-xs text-muted-foreground">Nothing approved in this period — there's nothing to attest to yet.</p>
            )}
          </div>
        )}

        {projectId && !disabled && (
          <div className="grid gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Issued attestations</p>
            {issued.isLoading && <Skeleton className="h-16 w-full" />}
            {!issued.isLoading && (issued.data ?? []).length === 0 && (
              <p className="py-3 text-sm text-muted-foreground">None issued for this project yet.</p>
            )}
            {(issued.data ?? []).map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <Badge variant={row.status === "VOID" ? "muted" : "success"}>{row.status}</Badge>
                <span className="font-mono text-xs">{row.reference}</span>
                <span className="text-muted-foreground">
                  {row.periodStart.slice(0, 10)} → {row.periodEnd.slice(0, 10)} · {row.totalHours.toFixed(2)}h ·{" "}
                  {row.totalAmount.toFixed(2)} {row.currency}
                </span>
                <div className="ml-auto flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" disabled={downloadingId === `${row.id}:pdf`} onClick={() => download(row, "pdf")}>
                    <Download className="h-3.5 w-3.5" />PDF
                  </Button>
                  <Button size="sm" variant="ghost" disabled={downloadingId === `${row.id}:json`} onClick={() => download(row, "json")}>
                    <Download className="h-3.5 w-3.5" />JSON
                  </Button>
                  {row.status === "ISSUED" && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setSharing(row)}>
                        <Share2 className="h-3.5 w-3.5" />Share
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setVoiding(row)}>
                        Void
                      </Button>
                    </>
                  )}
                </div>
                {row.voidReason && <p className="w-full text-xs text-muted-foreground">Voided: {row.voidReason}</p>}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <AttestationShareDialog attestation={sharing} onClose={() => setSharing(null)} />

      <Dialog open={Boolean(voiding)} onOpenChange={(open) => { if (!open) { setVoiding(null); setVoidReason(""); } }}>
        <DialogContent className="w-[min(96vw,480px)] max-w-none">
          <DialogHeader>
            <DialogTitle>Void {voiding?.reference}</DialogTitle>
            <DialogDescription>
              The record is kept, not deleted — a client may already hold a copy, so why it was withdrawn is itself part of the
              audit trail. Issue a replacement afterwards if the work still needs attesting.
            </DialogDescription>
          </DialogHeader>
          <FieldShell label="Reason">
            <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. superseded by a corrected period" />
          </FieldShell>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setVoiding(null); setVoidReason(""); }}>Cancel</Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={voidReason.trim().length < 3 || voidMutation.isPending}
              onClick={() => voidMutation.mutate()}
            >
              Void attestation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** On-demand AI stakeholder update for one project — see ai.service.ts#generateStatusReport.
 *  Silently omitted if the workspace hasn't turned the feature on (403 from the endpoint is
 *  shown as a friendly inline message instead of a toast, since "not enabled yet" isn't really
 *  an error). */
/**
 * Mint / revoke public share links for one attestation — the "client verifies it without an
 * account" path. SUPER_ADMIN-only server-side and additionally gated on a separate workspace
 * toggle, so a non-super-admin or a workspace with sharing off gets a friendly inline note rather
 * than an error toast (same convention as StatusReportCard's 403 handling).
 */
function AttestationShareDialog({ attestation, onClose }: { attestation: AttestationRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<"SUMMARY" | "FULL">("SUMMARY");
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [minted, setMinted] = useState<{ token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [disabled, setDisabled] = useState(false);

  const links = useQuery({
    queryKey: ["attestation-shares", attestation?.id],
    queryFn: () => attestationApi.shares.list(attestation!.id),
    enabled: Boolean(attestation) && !disabled
  });

  const create = useMutation({
    mutationFn: () => attestationApi.shares.create(attestation!.id, { scope, expiresInDays: Number(expiresInDays) }),
    onSuccess: (data) => {
      setMinted({ token: data.token, expiresAt: data.expiresAt });
      queryClient.invalidateQueries({ queryKey: ["attestation-shares", attestation?.id] });
    },
    onError: (err: any) => {
      if (err?.response?.status === 403) {
        setDisabled(true);
        return;
      }
      toast.error("Couldn't create the link", { description: serverMessage(err, "Try again.") });
    }
  });

  const revoke = useMutation({
    mutationFn: (linkId: string) => attestationApi.shares.revoke(attestation!.id, linkId),
    onSuccess: () => {
      toast.success("Link revoked");
      queryClient.invalidateQueries({ queryKey: ["attestation-shares", attestation?.id] });
    },
    onError: (err: any) => toast.error("Couldn't revoke", { description: serverMessage(err, "Try again.") })
  });

  const shareUrl = minted ? `${window.location.origin}/shared/attestation/${minted.token}` : "";

  function close() {
    setMinted(null);
    setCopied(false);
    onClose();
  }

  return (
    <Dialog open={Boolean(attestation)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,620px)] max-w-none overflow-y-auto">
        {attestation && (
          <>
            <DialogHeader>
              <DialogTitle>Share {attestation.reference}</DialogTitle>
              <DialogDescription>
                Creates an expiring, revocable public link so a client can verify this attestation without a TimeSphere account.
              </DialogDescription>
            </DialogHeader>

            {disabled && (
              <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                Public share links are off for this workspace, or your role can't create them. A super admin can enable them under
                Workspace Settings → Ticketing.
              </p>
            )}

            {!disabled && !minted && (
              <div className="grid gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>What the link shows</Label>
                    <Select value={scope} onValueChange={(v) => setScope(v as "SUMMARY" | "FULL")}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SUMMARY">Summary — totals and per-ticket hours</SelectItem>
                        <SelectItem value="FULL">Full — adds per-entry detail</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Expires in (days)</Label>
                    <Input type="number" min={1} max={90} value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Summary never names an individual alongside their hours or rate. Choose Full only when the client is contractually
                  entitled to a per-person breakdown. Maximum 90 days — a link that never expires is a permanent public exposure.
                </p>
                <Button
                  className="justify-self-start"
                  onClick={() => create.mutate()}
                  disabled={create.isPending || !(Number(expiresInDays) >= 1 && Number(expiresInDays) <= 90)}
                >
                  <Share2 className="h-4 w-4" />Create link
                </Button>
              </div>
            )}

            {minted && (
              <div className="grid gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                <p className="text-xs font-semibold text-warning">Copy this link now — it won't be shown again.</p>
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                  <code className="min-w-0 flex-1 truncate text-xs">{shareUrl}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      copyText(shareUrl).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      });
                    }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Expires {new Date(minted.expiresAt).toLocaleDateString()}.</p>
              </div>
            )}

            {!disabled && (
              <div className="grid gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Existing links</p>
                {links.isLoading && <Skeleton className="h-12 w-full" />}
                {!links.isLoading && (links.data ?? []).length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">No links created yet.</p>
                )}
                {(links.data ?? []).map((link) => {
                  const expired = new Date(link.expiresAt).getTime() < Date.now();
                  const dead = Boolean(link.revokedAt) || expired;
                  return (
                    <div key={link.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
                      <Badge variant={dead ? "muted" : "success"}>{link.revokedAt ? "REVOKED" : expired ? "EXPIRED" : "ACTIVE"}</Badge>
                      <code className="font-mono">{link.tokenPrefix}…</code>
                      <span className="text-muted-foreground">{link.scope}</span>
                      <span className="text-muted-foreground">
                        {link.viewCount} view{link.viewCount === 1 ? "" : "s"} · expires {new Date(link.expiresAt).toLocaleDateString()}
                      </span>
                      {!dead && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-6 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(link.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={close}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatusReportCard() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list });
  const [projectId, setProjectId] = useState("");
  const [periodDays, setPeriodDays] = useState("7");
  const [result, setResult] = useState<{ report: string; projectName: string; periodLabel: string } | null>(null);
  const [disabled, setDisabled] = useState(false);

  const generate = useMutation({
    mutationFn: () => reportApi.statusReport(projectId, Number(periodDays)),
    onSuccess: (data) => {
      setResult(data);
      setDisabled(false);
    },
    onError: (err: any) => {
      if (err?.response?.status === 403) {
        setDisabled(true);
        return;
      }
      toast.error("Couldn't generate the update", { description: serverMessage(err, "Try again.") });
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          AI-drafted status report
        </CardTitle>
        <CardDescription>Generate a plain-language stakeholder update for one project on demand.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {disabled && (
          <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            This feature is off for this workspace. An admin can turn it on under Workspace Settings → AI features.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="grid gap-1.5">
            <Label>Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {(projects.data ?? []).map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Period</Label>
            <Select value={periodDays} onValueChange={setPeriodDays}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Past week</SelectItem>
                <SelectItem value="14">Past 2 weeks</SelectItem>
                <SelectItem value="30">Past month</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button disabled={!projectId || generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? "Generating..." : "Generate update"}
          </Button>
        </div>
        {result && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-4 text-sm leading-relaxed">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">
              {result.projectName} — {result.periodLabel}
            </p>
            <p className="whitespace-pre-wrap">{result.report}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================== HELPERS ============================== */

function Workspace({ title, subtitle, icon, children }: { title: string; subtitle: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-5">
      <div className="flex items-center gap-3">
        {icon && <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">{icon}</div>}
        <div>
          <h1 className="text-2xl font-black tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function FieldShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}


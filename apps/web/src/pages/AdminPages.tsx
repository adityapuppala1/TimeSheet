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
import {
  Archive,
  Check,
  Download,
  FileSpreadsheet,
  FolderTree,
  Layers,
  Mail,
  Pencil,
  Plus,
  RotateCcw,
  ShieldX,
  Trash2,
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
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
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
import { ScrollArea } from "../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import {
  fileUrl,
  projectApi,
  reportApi,
  timesheetApi,
  userApi,
  type ProjectAssignmentMember,
  type UserRow
} from "../services/api";
import { useAuthStore } from "../store/auth";

const roles = ["SUPER_ADMIN", "ADMIN", "MANAGER", "TEAM_LEAD", "EMPLOYEE"];

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
export function UsersPage() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: userApi.list });
  const [draft, setDraft] = useState({ name: "", email: "", role: "EMPLOYEE", password: "Admin@12345", managerId: "none" });
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [pendingReset, setPendingReset] = useState<{ id: string; name: string } | null>(null);

  const eligibleManagers = useMemo(
    () => (users.data ?? []).filter((u: any) => ["MANAGER", "TEAM_LEAD", "ADMIN", "SUPER_ADMIN"].includes(u.role?.name)),
    [users.data]
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
      setDraft({ name: "", email: "", role: "EMPLOYEE", password: "Admin@12345", managerId: "none" });
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

  const resetPwd = useMutation({
    mutationFn: (id: string) => userApi.resetPassword(id, "Admin@12345"),
    onSuccess: () => toast.success("Password reset", { description: "Share the default credentials securely." }),
    onError: (err: any) => toast.error("Reset failed", { description: serverMessage(err, "Try again.") }),
    onSettled: () => setPendingReset(null)
  });

  function handleCreate() {
    create.mutate({
      name: draft.name,
      email: draft.email,
      role: draft.role,
      password: draft.password,
      managerId: draft.managerId === "none" ? null : draft.managerId
    });
  }

  return (
    <Workspace title="User Management" subtitle="Create, edit, deactivate, reset, and map users into the manager hierarchy." icon={<Users2 className="h-5 w-5" />}>
      <Card>
        <CardHeader>
          <CardTitle>Invite a teammate</CardTitle>
          <CardDescription>New users get the default password and must change it on first login.</CardDescription>
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
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Manager</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(users.data ?? []).map((row: any) => {
                const avatarSrc = fileUrl(row.avatarUrl);
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-7 w-7">
                          {avatarSrc ? <AvatarImage src={avatarSrc} alt={row.name} /> : null}
                          <AvatarFallback>{initialsFor(row.name)}</AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{row.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.email}</TableCell>
                    <TableCell><Badge variant="info">{row.role?.name?.replace("_", " ")}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{row.manager?.name ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={row.status === "ACTIVE" ? "success" : "warning"}>{row.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(row)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit details</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              disabled={resendWelcome.isPending && resendWelcome.variables === row.id}
                              onClick={() => resendWelcome.mutate(row.id)}
                            >
                              <Mail className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Resend welcome email</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => update.mutate({ id: row.id, payload: { status: row.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" } })}
                            >
                              {row.status === "ACTIVE" ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{row.status === "ACTIVE" ? "Deactivate" : "Activate"}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPendingReset({ id: row.id, name: row.name })}>
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Reset password</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => setPendingDelete({ id: row.id, name: row.name })}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete user</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {(users.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No users yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
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

      <AlertDialog open={!!pendingReset} onOpenChange={(open) => !open && setPendingReset(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset password for {pendingReset?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The user's password is reset to the workspace default. Share securely and prompt them to change it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingReset && resetPwd.mutate(pendingReset.id)}>Reset password</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    managerId: "none"
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
        managerId: user.managerId ?? "none"
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
                    managerId: form.managerId === "none" ? null : form.managerId
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

  return (
    <Workspace title="Project Management" subtitle="Create projects, modules, submodules, and assign who can log time on each." icon={<FolderTree className="h-5 w-5" />}>
      <Card>
        <CardHeader>
          <CardTitle>Create a project</CardTitle>
          <CardDescription>
            Pick a short code (e.g. <span className="font-mono">HICS-OPS</span>) — it appears across reports, exports, and audit trails.
          </CardDescription>
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
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Hierarchy</TableHead>
                <TableHead>Team</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(projects.data ?? []).map((row: any) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.code}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell><Badge variant={row.status === "ACTIVE" ? "success" : "warning"}>{row.status}</Badge></TableCell>
                  <TableCell className="text-muted-foreground"><Layers className="mr-1 inline h-3 w-3" />{row.modules?.length ?? 0} modules</TableCell>
                  <TableCell>
                    <div className="flex -space-x-2">
                      {(row.assignments ?? []).slice(0, 4).map((a: any) => {
                        const src = fileUrl(a.user?.avatarUrl);
                        return (
                          <Avatar key={a.user?.id} className="h-7 w-7 ring-2 ring-background">
                            {src ? <AvatarImage src={src} alt={a.user?.name} /> : null}
                            <AvatarFallback className="text-[10px]">{initialsFor(a.user?.name)}</AvatarFallback>
                          </Avatar>
                        );
                      })}
                      {(row.assignments?.length ?? 0) > 4 && (
                        <div className="grid h-7 w-7 place-items-center rounded-full bg-muted text-[10px] font-semibold ring-2 ring-background">
                          +{row.assignments.length - 4}
                        </div>
                      )}
                      {(row.assignments?.length ?? 0) === 0 && (
                        <span className="text-xs text-muted-foreground">No one assigned</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setManagingTeam({ id: row.id, name: row.name })}>
                        <UsersRound className="h-3.5 w-3.5" />Manage team
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setPendingArchive({ id: row.id, name: row.name })}
                      >
                        <Archive className="h-3.5 w-3.5" />Archive
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {(projects.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No projects yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ProjectTeamDialog project={managingTeam} onClose={() => setManagingTeam(null)} />

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
        className={`h-7 w-7 ${variant === "destructive" ? "text-destructive hover:bg-destructive/10 hover:text-destructive" : "text-primary hover:bg-primary/10 hover:text-primary"}`}
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
    mutationFn: timesheetApi.approve,
    onSuccess: () => {
      toast.success("Approved", { description: "Employee will receive an in-app + email confirmation." });
      queryClient.invalidateQueries({ queryKey: ["timesheets"] });
    },
    onError: (err: any) => toast.error("Approval failed", { description: serverMessage(err, "Try again.") })
  });
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

  const pending = (timesheets.data ?? []).filter((row: any) => row.status === "SUBMITTED");

  return (
    <Workspace title="Timesheet Approvals" subtitle="Review submitted work logs with attachments and audit-friendly actions." icon={<Check className="h-5 w-5" />}>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead>Hours</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Decision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map((row: any) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.user?.name}</TableCell>
                  <TableCell className="text-muted-foreground">{String(row.workDate).slice(0, 10)}</TableCell>
                  <TableCell>{row.project?.name}</TableCell>
                  <TableCell>{row.activityType}</TableCell>
                  <TableCell className="font-semibold">{Number(row.totalHours).toFixed(2)}</TableCell>
                  <TableCell><Badge variant="warning">{row.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="success" size="sm" onClick={() => approve.mutate(row.id)}>
                        <Check className="h-4 w-4" />Approve
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setRejectTarget({ id: row.id, user: row.user?.name })}>
                        <ShieldX className="h-4 w-4" />Reject
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {pending.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center">
                    <div className="grid justify-items-center gap-2 text-muted-foreground">
                      <div className="grid h-12 w-12 place-items-center rounded-full bg-success/15 text-success"><Check className="h-6 w-6" /></div>
                      <p className="font-semibold text-foreground">All clear</p>
                      <p className="text-xs">No timesheets awaiting your review.</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
    </Workspace>
  );
}

/* ============================== REPORTS ============================== */
export function ReportsPage() {
  const analytics = useQuery({ queryKey: ["admin-summary"], queryFn: reportApi.admin });
  const ticketAnalytics = useQuery({ queryKey: ["ticket-summary"], queryFn: reportApi.tickets });
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
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Users" value={analytics.data?.users ?? 0} />
        <StatCard label="Projects" value={analytics.data?.projects ?? 0} />
        <StatCard label="Pending approvals" value={analytics.data?.pendingApprovals ?? 0} tone={(analytics.data?.pendingApprovals ?? 0) > 0 ? "warning" : "default"} />
        <StatCard label="Approved this week" value={approvedThisWeek} tone="success" />
        <StatCard label="SLA breaches" value={slaBreached} tone={slaBreached > 0 ? "warning" : "default"} />
        <StatCard label="Open escalations" value={openEscalations} tone={openEscalations > 0 ? "warning" : "default"} />
      </div>
      <Card>
        <CardHeader className="flex-col items-start justify-between gap-3 space-y-0 sm:flex-row sm:items-center">
          <div>
            <CardTitle>Project hours</CardTitle>
            <CardDescription>Aggregate across the workspace — drill into a project from the table view.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <DownloadButton type="csv" label="CSV" />
            <DownloadButton type="pdf" label="PDF" />
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

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
        <StatCard label="Open tickets" value={openTickets} tone={openTickets > 0 ? "warning" : "default"} />
        <StatCard label="Ticket SLA breaches" value={ticketAnalytics.data?.openSlaBreaches ?? 0} tone={(ticketAnalytics.data?.openSlaBreaches ?? 0) > 0 ? "destructive" : "default"} />
        <StatCard label="Resolved this week" value={ticketAnalytics.data?.resolvedThisWeek ?? 0} tone="success" />
        <StatCard label="Avg. resolution time" value={`${ticketAnalytics.data?.avgResolutionHours ?? 0}h`} />
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
    </Workspace>
  );
}

/* ============================== HELPERS ============================== */
function DownloadButton({ type, label }: { type: "csv" | "pdf"; label: string }) {
  async function download() {
    try {
      const blob = await reportApi.download(type);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `timesheet-report.${type}`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${label}`);
    } catch (err: any) {
      toast.error("Download failed", { description: serverMessage(err, "Try again.") });
    }
  }
  return (
    <Button variant="outline" onClick={download}>
      <Download />{label}
    </Button>
  );
}

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

function StatCard({ label, value, tone = "default" }: { label: string; value: number | string; tone?: "default" | "warning" | "success" | "destructive" }) {
  const toneClass = tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "";
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`mt-2 text-3xl font-black tracking-tight ${toneClass}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

/**
 * Who can open this console, and what each of them is allowed to do (5.0.0).
 *
 * WHY IT IS ITS OWN PAGE INSTEAD OF A TAB IN SETTINGS, where the account list used to live. Until
 * this release there was nothing to say about a platform admin except "active or not", so a tab
 * beside the SMTP form was the right size for it. Now every account carries a ROLE that decides
 * whether that person can drop a customer's database, and granting one is the single most
 * consequential thing anybody does in this console. It earns a screen, an OWNER-only route
 * (`RequirePlatformRole` in App.tsx), and its own place in the sidebar.
 *
 * TWO ACTIONS, TWO DIFFERENT SHAPES, AND THE DIFFERENCE IS DELIBERATE:
 *  - Creating an account, and changing a role, are QUEUED. They come back as a request another
 *    owner has to countersign on the Approvals page — a single operator must not be able to mint a
 *    colleague or promote one. The temporary password for a new account goes to whoever APPROVES
 *    it, which is why nothing here shows one.
 *  - Deactivating an account happens IMMEDIATELY. It is how a compromised credential gets cut off,
 *    and making that wait for a second person to answer their phone would mean the two-person rule
 *    was protecting the attacker.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldCheck, ShieldQuestion, Smartphone, UserX } from "lucide-react";
import { useState } from "react";
import { PLATFORM_ROLE_LABEL, platformRoles, type PlatformRole } from "@timesheet/shared";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { platformAdminConsoleApi } from "../../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../../store/platform-admin-auth";
import { ConsolePage, ConsoleSection, ConsoleTable, Field, FieldGrid, Num, PRIMARY_BTN, Toolbar, shortDateTime } from "./console-ui";

function errorMessageOf(error: unknown): string {
  return (error as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message ?? (error as Error)?.message ?? "Try again.";
}

/** Amber for OWNER because it is the one role that can grant power; everything else is neutral. A
 *  colour that shouts at four of five rows teaches an operator to ignore it. */
const ROLE_VARIANT: Record<PlatformRole, "success" | "info" | "muted" | "warning"> = {
  OWNER: "warning",
  OPERATOR: "info",
  SUPPORT: "muted",
  BILLING: "muted",
  READ_ONLY: "muted"
};

export function PlatformAdminAccess() {
  const queryClient = useQueryClient();
  const me = usePlatformAdminAuthStore((s) => s.admin);
  const admins = useQuery({ queryKey: ["platform-admin", "admins"], queryFn: platformAdminConsoleApi.admins });

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<{ email: string; name: string; role: PlatformRole }>({ email: "", name: "", role: "READ_ONLY" });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["platform-admin", "admins"] });
    queryClient.invalidateQueries({ queryKey: ["platform-admin", "approvals"] });
  };

  const create = useMutation({
    mutationFn: () => platformAdminConsoleApi.createAdmin(form),
    onSuccess: (queued) => {
      setCreateOpen(false);
      setForm({ email: "", name: "", role: "READ_ONLY" });
      invalidate();
      toast.success("Queued for approval", { description: queued.message });
    },
    onError: (e) => toast.error("Not queued", { description: errorMessageOf(e) })
  });

  const setRole = useMutation({
    mutationFn: (args: { id: string; role: PlatformRole }) => platformAdminConsoleApi.setAdminRole(args.id, args.role),
    onSuccess: (queued) => {
      invalidate();
      toast.success("Queued for approval", { description: queued.message });
    },
    onError: (e) => toast.error("Not queued", { description: errorMessageOf(e) })
  });

  const setStatus = useMutation({
    mutationFn: (args: { id: string; status: "ACTIVE" | "INACTIVE" }) => platformAdminConsoleApi.setAdminStatus(args.id, args.status),
    onSuccess: () => {
      invalidate();
      toast.success("Changed");
    },
    onError: (e) => toast.error("Not changed", { description: errorMessageOf(e) })
  });

  return (
    <ConsolePage
      eyebrow="Platform"
      title="Access"
      description="Accounts that can open this console, and what each one may do. Separate from every tenant; a compromised tenant database can never yield one of these."
    >
      <ConsoleSection
        title="Platform admins"
        description="Creating an account and changing a role are queued for a second owner to countersign. Deactivating is immediate — cutting off a leaked credential must never wait for anybody."
        actions={
          <Toolbar>
            <Button size="sm" className={`gap-1.5 ${PRIMARY_BTN}`} onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" />New platform admin
            </Button>
          </Toolbar>
        }
      >
        {admins.isLoading && <Skeleton className="h-40 w-full" />}
        {admins.data && (
          <ConsoleTable minWidth={1040}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>2FA</TableHead>
                <TableHead className="text-right">Last Sign-In</TableHead>
                <TableHead className="text-right">Live Sessions</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {admins.data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">
                    {a.name}
                    {a.id === me?.id && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{a.email}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant={ROLE_VARIANT[a.role] ?? "muted"}>{a.role.replace("_", " ")}</Badge>
                      <Select value={a.role} onValueChange={(role) => setRole.mutate({ id: a.id, role: role as PlatformRole })} disabled={setRole.isPending}>
                        <SelectTrigger className="h-7 w-[9.5rem] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {platformRoles.map((role) => (
                            <SelectItem key={role} value={role} title={PLATFORM_ROLE_LABEL[role]}>
                              {role.replace("_", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={a.status === "ACTIVE" ? "success" : "muted"}>{a.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {a.mfaEnabled ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Smartphone className="h-3.5 w-3.5" />on
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-warning">
                        <ShieldQuestion className="h-3.5 w-3.5" />off
                      </span>
                    )}
                  </TableCell>
                  <Num className="whitespace-nowrap text-xs text-muted-foreground">{a.lastLoginAt ? shortDateTime(a.lastLoginAt) : "never"}</Num>
                  <Num>{a.liveSessions}</Num>
                  <TableCell className="text-right">
                    {a.id !== me?.id && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5"
                        onClick={() => setStatus.mutate({ id: a.id, status: a.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" })}
                        disabled={setStatus.isPending}
                      >
                        {a.status === "ACTIVE" ? (
                          <>
                            <UserX className="h-3.5 w-3.5" />Deactivate
                          </>
                        ) : (
                          <>
                            <ShieldCheck className="h-3.5 w-3.5" />Reactivate
                          </>
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        )}
      </ConsoleSection>

      <ConsoleSection title="What each role can do" description="The server re-reads a role from the database on every request, so a change takes effect on the next click — no sign-out, no waiting for a token to expire.">
        <ul className="grid gap-2">
          {platformRoles.map((role) => (
            <li key={role} className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
              <Badge variant={ROLE_VARIANT[role] ?? "muted"} className="mt-0.5 shrink-0">
                {role.replace("_", " ")}
              </Badge>
              <span className="text-muted-foreground">{PLATFORM_ROLE_LABEL[role]}</span>
            </li>
          ))}
        </ul>
      </ConsoleSection>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New platform admin</DialogTitle>
            <DialogDescription>
              This is queued, not created. Another owner has to countersign it — creating an account with access to every customer is not something one person does alone. The one-time password goes to
              whoever approves it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <FieldGrid cols={1}>
              <Field label="Name" htmlFor="pa-new-name">
                <Input id="pa-new-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="Email" htmlFor="pa-new-email">
                <Input id="pa-new-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              </Field>
              <Field label="Role" htmlFor="pa-new-role" hint={PLATFORM_ROLE_LABEL[form.role]}>
                <Select value={form.role} onValueChange={(role) => setForm((f) => ({ ...f, role: role as PlatformRole }))}>
                  <SelectTrigger id="pa-new-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {platformRoles.map((role) => (
                      <SelectItem key={role} value={role}>
                        {role.replace("_", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGrid>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button className={PRIMARY_BTN} disabled={form.name.length < 2 || !form.email.includes("@") || create.isPending} onClick={() => create.mutate()}>
                <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                {create.isPending ? "Queueing…" : "Queue for approval"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </ConsolePage>
  );
}

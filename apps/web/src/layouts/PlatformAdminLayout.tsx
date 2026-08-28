import { LayoutDashboard, LogOut, Building2, SlidersHorizontal, ShieldCheck, Menu, KeyRound, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../components/ui/sheet";
import { platformAdminAuthApi } from "../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../store/platform-admin-auth";
import { cn } from "../lib/utils";

/**
 * Deliberately NOT grouped into sections, unlike the tenant sidebar (components/Sidebar.tsx, which
 * groups its 15 items under Work/Team/Analytics/Administration/Configuration headings). Three
 * items don't need wayfinding — headings here would add more chrome than they remove confusion.
 * Revisit only if this console grows past ~7 entries.
 */
const NAV = [
  { to: "/platform-admin", label: "Organizations", icon: Building2, end: true },
  { to: "/platform-admin/plan-tiers", label: "Plan tiers", icon: SlidersHorizontal, end: false },
  { to: "/platform-admin/analytics", label: "Analytics", icon: LayoutDashboard, end: false }
];

function BrandMark() {
  return (
    <div className="mb-6 flex items-center gap-2 px-2">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500 text-slate-950">
        <ShieldCheck className="h-4 w-4" />
      </span>
      <div>
        <p className="text-sm font-black leading-tight">Platform Admin</p>
        <p className="text-[11px] text-slate-500">Control plane</p>
      </div>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="grid gap-1">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-100",
              isActive && "bg-slate-800 text-slate-100"
            )
          }
        >
          <Icon className="h-4 w-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function AccountFooter({ email, onLogout, onChangePassword }: { email?: string; onLogout: () => void; onChangePassword: () => void }) {
  return (
    <div className="mt-auto grid gap-2 border-t border-slate-800 pt-4">
      <p className="truncate px-2 text-xs text-slate-500">{email}</p>
      <Button variant="outline" size="sm" className="justify-start gap-2 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100" onClick={onChangePassword}>
        <KeyRound className="h-4 w-4" />Change password
      </Button>
      <Button variant="outline" size="sm" className="justify-start gap-2 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100" onClick={onLogout}>
        <LogOut className="h-4 w-4" />Sign out
      </Button>
    </div>
  );
}

/**
 * Shown only while the signed-in platform admin still verifies against the password the control
 * seed ships with. That password is in the repository, so any deployment still using it is open to
 * anyone who has read the README — and the previous state of this console was that nothing said so.
 * A banner and not a gate, for the reason written on the tenant PasswordChangeBanner: a modal that
 * blocks work gets defeated with "…1" appended; a persistent reminder gets a real password.
 */
function SeededPasswordBanner({ onChangePassword }: { onChangePassword: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
      <p className="flex min-w-0 items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="min-w-0">
          This console is still using the <span className="font-semibold">seeded bootstrap password</span> — it is printed in the repository. Change it before anyone else finds it.
        </span>
      </p>
      <Button size="sm" className="bg-amber-500 text-slate-950 hover:bg-amber-400" onClick={onChangePassword}>
        Change it now
      </Button>
    </div>
  );
}

function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const admin = usePlatformAdminAuthStore((s) => s.admin);
  const setAdmin = usePlatformAdminAuthStore((s) => s.setAdmin);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
  };

  const mutation = useMutation({
    mutationFn: () => platformAdminAuthApi.changePassword(current, next),
    onSuccess: (result) => {
      // The banner keys off this flag; clearing it locally means it disappears the moment the
      // server accepted the new password, not on the next full reload.
      if (admin) setAdmin({ ...admin, usingSeededPassword: false });
      toast.success(
        result.otherSessionsRevoked > 0
          ? `Password changed. ${result.otherSessionsRevoked} other session${result.otherSessionsRevoked === 1 ? "" : "s"} signed out.`
          : "Password changed."
      );
      reset();
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(message ?? "Could not change the password.");
    }
  });

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length >= 8 && next.length >= 12 && next === confirm && !mutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) reset();
        onOpenChange(value);
      }}
    >
      <DialogContent className="border-slate-800 bg-slate-900 text-slate-100">
        <DialogHeader>
          <DialogTitle>Change your password</DialogTitle>
          <DialogDescription className="text-slate-400">
            Every other session of this console is signed out when it changes. This one stays.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="pa-current" className="text-slate-300">Current password</Label>
            <Input id="pa-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className="bg-slate-950" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pa-next" className="text-slate-300">New password</Label>
            <Input id="pa-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className="bg-slate-950" />
            <p className="text-xs text-slate-500">At least 12 characters. This account can reach every tenant — treat it like the root of the platform.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pa-confirm" className="text-slate-300">Confirm new password</Label>
            <Input id="pa-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="bg-slate-950" aria-invalid={mismatch || undefined} />
            {mismatch && <p className="text-xs text-red-400">The two passwords do not match.</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} className="bg-amber-500 text-slate-950 hover:bg-amber-400">
              {mutation.isPending ? "Changing…" : "Change password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Deliberately distinct dark/amber chrome from the tenant AppLayout — an operator working in
 *  this console (which can see/administer every tenant) should never be able to mistake it for
 *  a normal workspace view, even for a split second.
 *
 *  Sidebar collapses to a hamburger + slide-out drawer below `lg`, mirroring the pattern in
 *  components/Sidebar.tsx/Topbar.tsx (persistent aside there is also `hidden ... lg:flex`) —
 *  this console previously had no mobile/tablet treatment at all, unlike the tenant app. */
export function PlatformAdminLayout() {
  const navigate = useNavigate();
  const admin = usePlatformAdminAuthStore((s) => s.admin);
  const logout = usePlatformAdminAuthStore((s) => s.logout);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const handleLogout = async () => {
    await platformAdminAuthApi.logout().catch(() => undefined);
    logout();
    navigate("/platform-admin/login");
  };

  const openPassword = () => {
    setDrawerOpen(false);
    setPasswordOpen(true);
  };

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60 p-4 lg:flex">
        <BrandMark />
        <NavList />
        <AccountFooter email={admin?.email} onLogout={handleLogout} onChangePassword={openPassword} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-slate-800 bg-slate-950/85 px-4 backdrop-blur-xl lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            onClick={() => setDrawerOpen(true)}
            aria-label="Menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-amber-500 text-slate-950">
            <ShieldCheck className="h-3.5 w-3.5" />
          </span>
          <p className="text-sm font-black">Platform Admin</p>
        </header>

        {admin?.usingSeededPassword && <SeededPasswordBanner onChangePassword={openPassword} />}

        <main className="min-w-0 flex-1 overflow-x-hidden p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="flex w-72 max-w-[85vw] flex-col border-slate-800 bg-slate-900 text-slate-100">
          <SheetTitle className="sr-only">Platform admin navigation</SheetTitle>
          {/* sr-only for the same reason as the tenant drawer's — Radix wires aria-describedby
              from this, and without it a screen-reader user gets a title with no context. */}
          <SheetDescription className="sr-only">Links to the platform administration console.</SheetDescription>
          <BrandMark />
          <NavList onNavigate={() => setDrawerOpen(false)} />
          <AccountFooter email={admin?.email} onLogout={handleLogout} onChangePassword={openPassword} />
        </SheetContent>
      </Sheet>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}

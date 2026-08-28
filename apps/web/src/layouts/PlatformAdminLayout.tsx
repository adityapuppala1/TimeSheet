/**
 * The `/platform-admin` console shell.
 *
 * REBUILT ON THE THEME TOKENS (3.12.0). The first version hard-coded a slate/amber dark palette so
 * an operator could never mistake the console for a workspace. That guarantee is kept — the amber
 * brand band across the top of the sidebar, the amber mark, the "Control plane" label — but the
 * surfaces now follow the same light/dark toggle as everything else, and the toggle lives here.
 * A console that ignores the theme the operator chose everywhere else reads as broken, not as
 * distinct.
 *
 * Grouped navigation, unlike the first three-item version: eight destinations do need wayfinding.
 * Tenants (organizations, tiers, analytics), Growth (retention, emails, feedback), Platform
 * (settings) — the order an operator's day runs in.
 */
import { BarChart3, Building2, HeartHandshake, KeyRound, LayoutDashboard, LogOut, Mails, Menu, MessageSquareHeart, Settings2, ShieldAlert, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { AnimatedThemeToggler } from "../components/ui/animated-theme-toggler";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../components/ui/sheet";
import { platformAdminAuthApi } from "../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../store/platform-admin-auth";
import { cn } from "../lib/utils";

const NAV: Array<{ heading?: string; items: Array<{ to: string; label: string; icon: typeof Building2; end?: boolean }> }> = [
  { items: [{ to: "/platform-admin", label: "Overview", icon: LayoutDashboard, end: true }] },
  {
    heading: "Tenants",
    items: [
      { to: "/platform-admin/organizations", label: "Organizations", icon: Building2 },
      { to: "/platform-admin/plan-tiers", label: "Plan tiers", icon: SlidersHorizontal },
      { to: "/platform-admin/analytics", label: "Analytics", icon: BarChart3 }
    ]
  },
  {
    heading: "Growth",
    items: [
      { to: "/platform-admin/retention", label: "Trial retention", icon: HeartHandshake },
      { to: "/platform-admin/emails", label: "Platform emails", icon: Mails },
      { to: "/platform-admin/feedback", label: "Feedback", icon: MessageSquareHeart }
    ]
  },
  { heading: "Platform", items: [{ to: "/platform-admin/settings", label: "Settings", icon: Settings2 }] }
];

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", !compact && "px-2")}>
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-foreground shadow-sm">
        <ShieldCheck className="h-4 w-4" />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-black text-foreground">Platform Admin</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Control plane</p>
      </div>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="grid gap-4">
      {NAV.map((group, i) => (
        <div key={group.heading ?? i} className="grid gap-1">
          {group.heading && <p className="px-3 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{group.heading}</p>}
          {group.items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  "group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  isActive && "bg-accent/12 text-foreground"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent transition-opacity", isActive ? "opacity-100" : "opacity-0")} />
                  <Icon className={cn("h-4 w-4 transition-colors", isActive ? "text-accent" : "group-hover:text-foreground")} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

function AccountFooter({ email, name, onLogout, onChangePassword }: { email?: string; name?: string; onLogout: () => void; onChangePassword: () => void }) {
  const initials = (name ?? email ?? "?")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
  return (
    <div className="mt-auto grid gap-2 border-t border-border pt-4">
      <div className="flex items-center gap-2.5 px-1">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/15 font-mono text-xs font-bold text-accent">{initials}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{name ?? "Platform admin"}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </div>
        <AnimatedThemeToggler className="shrink-0" />
      </div>
      <Button variant="outline" size="sm" className="justify-start gap-2" onClick={onChangePassword}>
        <KeyRound className="h-4 w-4" />Change password
      </Button>
      <Button variant="outline" size="sm" className="justify-start gap-2" onClick={onLogout}>
        <LogOut className="h-4 w-4" />Sign out
      </Button>
    </div>
  );
}

/**
 * Shown only while the signed-in platform admin still verifies against the password the control
 * seed ships with. A banner and not a gate, for the reason written on the tenant PasswordChangeBanner:
 * a modal that blocks work gets defeated with "…1" appended; a persistent reminder gets a real password.
 */
function SeededPasswordBanner({ onChangePassword }: { onChangePassword: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-foreground">
      <p className="flex min-w-0 items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0">
          This console is still using the <span className="font-semibold">seeded bootstrap password</span> — it is printed in the repository. Change it before anyone else finds it.
        </span>
      </p>
      <Button size="sm" className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={onChangePassword}>
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
      if (admin) setAdmin({ ...admin, usingSeededPassword: false });
      toast.success(result.otherSessionsRevoked > 0 ? `Password changed. ${result.otherSessionsRevoked} other session${result.otherSessionsRevoked === 1 ? "" : "s"} signed out.` : "Password changed.");
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change your password</DialogTitle>
          <DialogDescription>Every other session of this console is signed out when it changes. This one stays.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="pa-current">Current password</Label>
            <Input id="pa-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pa-next">New password</Label>
            <Input id="pa-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            <p className="text-xs text-muted-foreground">At least 12 characters. This account can reach every tenant — treat it like the root of the platform.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pa-confirm">Confirm new password</Label>
            <Input id="pa-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch || undefined} />
            {mismatch && <p className="text-xs text-destructive">The two passwords do not match.</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} className="bg-accent text-accent-foreground hover:bg-accent/90">
              {mutation.isPending ? "Changing…" : "Change password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card lg:flex">
        {/* The amber band: the one thing that says "this is the control plane" in both themes. */}
        <div className="h-1 w-full bg-gradient-to-r from-accent via-accent/70 to-accent/20" aria-hidden />
        <div className="flex flex-1 flex-col gap-6 p-4">
          <BrandMark />
          <NavList />
          <AccountFooter email={admin?.email} name={admin?.name} onLogout={handleLogout} onChangePassword={openPassword} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur-xl lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setDrawerOpen(true)} aria-label="Menu">
            <Menu className="h-5 w-5" />
          </Button>
          <BrandMark compact />
          <div className="ml-auto">
            <AnimatedThemeToggler />
          </div>
        </header>

        {admin?.usingSeededPassword && <SeededPasswordBanner onChangePassword={openPassword} />}

        <main className="min-w-0 flex-1 overflow-x-hidden p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-[1400px]">
            <Outlet />
          </div>
        </main>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="flex w-72 max-w-[85vw] flex-col">
          <SheetTitle className="sr-only">Platform admin navigation</SheetTitle>
          <SheetDescription className="sr-only">Links to the platform administration console.</SheetDescription>
          <BrandMark />
          <div className="mt-6">
            <NavList onNavigate={() => setDrawerOpen(false)} />
          </div>
          <AccountFooter email={admin?.email} name={admin?.name} onLogout={handleLogout} onChangePassword={openPassword} />
        </SheetContent>
      </Sheet>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}

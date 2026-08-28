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
 * Grouped navigation, unlike the first three-item version: ten destinations do need wayfinding.
 * Tenants (organizations, tiers, analytics), Growth (retention, emails, feedback), Operations
 * (monitoring, maintenance, backups), Platform (settings) — the order an operator's day runs in.
 * Operations is its own group rather than more items under Platform because those three are what
 * somebody opens when something is wrong, and a group you reach for under pressure should not be
 * mixed in with the one you reach for once a quarter.
 *
 * THE SHELL OWNS THE GEOMETRY. The sidebar is a hard 16rem column and the content column clips its
 * own horizontal overflow, so a page can never widen the shell: anything wide scrolls inside its
 * own box (`ConsoleTable` in the console kit), which is the repo's rule everywhere. `<main>` sets
 * the one padding scale and the one measure the ten pages share; a page that sets its own is a
 * bug. Read the AccountFooter and column comments below before "simplifying" a `min-w-0` away —
 * each one is load-bearing and each one is there because something visibly broke without it.
 */
import { Activity, BarChart3, Building2, DatabaseBackup, HeartHandshake, KeyRound, LayoutDashboard, LogOut, Mails, Menu, MessageSquareHeart, Radio, Settings2, ShieldAlert, ShieldCheck, SlidersHorizontal } from "lucide-react";
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
/* The shell's own primary buttons come from the console's kit for the same reason the pages' do:
   one amber, defined once. It is the only thing this layout takes from the pages directory. */
import { PRIMARY_BTN } from "../pages/platform-admin/console-ui";
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
  {
    heading: "Operations",
    items: [
      { to: "/platform-admin/monitoring", label: "Monitoring", icon: Activity },
      { to: "/platform-admin/maintenance", label: "Maintenance", icon: Radio },
      { to: "/platform-admin/backups", label: "Backups", icon: DatabaseBackup }
    ]
  },
  {
    heading: "Platform",
    items: [{ to: "/platform-admin/settings", label: "Settings", icon: Settings2 }]
  }
];

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", !compact && "px-2")}>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground shadow-sm">
        <ShieldCheck className="h-4 w-4" />
      </span>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-black text-foreground">Platform Admin</p>
        <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Control plane</p>
      </div>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    /* `grid-cols-1`, not a bare `grid`: an implicit auto track is sized by its widest item and will
       happily grow past a fixed-width sidebar. `repeat(1, minmax(0, 1fr))` gives the track a zero
       floor, which is what lets the labels inside truncate instead of pushing the column open. */
    <nav className="grid min-w-0 grid-cols-1 gap-4">
      {NAV.map((group, i) => (
        <div key={group.heading ?? i} className="grid min-w-0 grid-cols-1 gap-1">
          {group.heading && <p className="px-3 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{group.heading}</p>}
          {group.items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  "group relative flex min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  isActive && "bg-accent/12 text-foreground"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent transition-opacity", isActive ? "opacity-100" : "opacity-0")} />
                  <Icon className={cn("h-4 w-4 shrink-0 transition-colors", isActive ? "text-accent" : "group-hover:text-foreground")} />
                  <span className="truncate">{label}</span>
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
    /*
     * WHY `grid-cols-1` and `min-w-0` everywhere here: this footer used to burst out of the 16rem
     * aside and paint its two buttons over the page. The culprit was the identity row — the email
     * is `truncate`d, but `truncate` includes `white-space: nowrap`, and a nowrap string still
     * reports its full width as the row's intrinsic minimum. A bare `grid` sizes its implicit
     * track from that minimum, the track grew to the width of the address, and the buttons (which
     * stretch to the track) went with it. `grid-cols-1` is `repeat(1, minmax(0, 1fr))` — a track
     * with a zero floor — so the ellipsis can finally do its job. `w-full`/`min-w-0` on the
     * children keep the same promise if this block is ever moved somewhere less forgiving.
     */
    <div className="mt-auto grid w-full min-w-0 grid-cols-1 gap-2 border-t border-border pt-4">
      <div className="flex w-full min-w-0 items-center gap-2.5 px-1">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/15 font-mono text-xs font-bold text-accent">{initials}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{name ?? "Platform admin"}</p>
          <p className="truncate text-xs text-muted-foreground" title={email}>
            {email}
          </p>
        </div>
        <AnimatedThemeToggler className="shrink-0" />
      </div>
      <Button variant="outline" size="sm" className="w-full min-w-0 justify-start gap-2" onClick={onChangePassword}>
        <KeyRound className="h-4 w-4 shrink-0" />
        <span className="truncate">Change password</span>
      </Button>
      <Button variant="outline" size="sm" className="w-full min-w-0 justify-start gap-2" onClick={onLogout}>
        <LogOut className="h-4 w-4 shrink-0" />
        <span className="truncate">Sign out</span>
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
    /* Stacks on a phone — sentence, then button — rather than letting `flex-wrap` drop a stray
       button under a ragged three-line paragraph. The icon aligns to the first line, not to the
       middle of a wrapped block, which is where a centred icon ends up once the text wraps. */
    <div role="alert" className="flex flex-col gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:py-2">
      <p className="flex min-w-0 items-start gap-2 sm:items-center">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning sm:mt-0" />
        <span className="min-w-0">
          This console is still using the <span className="font-semibold">seeded bootstrap password</span> — it is printed in the repository. Change it before anyone else finds it.
        </span>
      </p>
      <Button size="sm" className={cn(PRIMARY_BTN, "shrink-0 self-start sm:self-auto")} onClick={onChangePassword}>
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
            <Button type="submit" disabled={!canSubmit} className={PRIMARY_BTN}>
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
      {/* A strict 16rem column: fixed basis, never grows, never shrinks, and `overflow-x-clip` as
          the backstop so nothing inside can ever paint over the page again. `clip` and not
          `hidden` — `hidden` would turn the aside into a scroll container. */}
      <aside className="hidden w-64 min-w-0 shrink-0 grow-0 flex-col overflow-x-clip border-r border-border bg-card lg:flex">
        {/* The amber band: the one thing that says "this is the control plane" in both themes. */}
        <div className="h-1 w-full bg-gradient-to-r from-accent via-accent/70 to-accent/20" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-6 p-4">
          <BrandMark />
          <NavList />
          <AccountFooter email={admin?.email} name={admin?.name} onLogout={handleLogout} onChangePassword={openPassword} />
        </div>
      </aside>

      {/* `overflow-x-clip`, not `overflow-x-hidden`: hidden on one axis makes the other `auto`, which
          would make this column a scroll container and quietly kill the sticky mobile header above.
          `clip` contains a stray-wide child without creating one — the same trick `body` uses.
          Wide content is still expected to scroll inside its own box (see `ConsoleTable`). */}
      <div className="flex min-w-0 flex-1 flex-col overflow-x-clip">
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

        {/* One padding scale for the whole console — 1rem / 1.5rem / 2rem, tracking the same
            breakpoints the page kit uses — and one measure, so a page never sets its own. */}
        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full min-w-0 max-w-[1400px]">
            <Outlet />
          </div>
        </main>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="flex w-72 min-w-0 max-w-[85vw] flex-col overflow-y-auto">
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

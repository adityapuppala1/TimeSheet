import { LayoutDashboard, LogOut, Building2, SlidersHorizontal, ShieldCheck, Menu } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { Button } from "../components/ui/button";
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

function AccountFooter({ email, onLogout }: { email?: string; onLogout: () => void }) {
  return (
    <div className="mt-auto grid gap-2 border-t border-slate-800 pt-4">
      <p className="truncate px-2 text-xs text-slate-500">{email}</p>
      <Button variant="outline" size="sm" className="justify-start gap-2 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100" onClick={onLogout}>
        <LogOut className="h-4 w-4" />Sign out
      </Button>
    </div>
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

  const handleLogout = async () => {
    await platformAdminAuthApi.logout().catch(() => undefined);
    logout();
    navigate("/platform-admin/login");
  };

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60 p-4 lg:flex">
        <BrandMark />
        <NavList />
        <AccountFooter email={admin?.email} onLogout={handleLogout} />
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
          <AccountFooter email={admin?.email} onLogout={handleLogout} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

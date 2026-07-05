import { LayoutDashboard, LogOut, Building2, SlidersHorizontal, ShieldCheck } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { platformAdminAuthApi } from "../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../store/platform-admin-auth";
import { cn } from "../lib/utils";

const NAV = [
  { to: "/platform-admin", label: "Organizations", icon: Building2, end: true },
  { to: "/platform-admin/plan-tiers", label: "Plan tiers", icon: SlidersHorizontal, end: false },
  { to: "/platform-admin/analytics", label: "Analytics", icon: LayoutDashboard, end: false }
];

/** Deliberately distinct dark/amber chrome from the tenant AppLayout — an operator working in
 *  this console (which can see/administer every tenant) should never be able to mistake it for
 *  a normal workspace view, even for a split second. */
export function PlatformAdminLayout() {
  const navigate = useNavigate();
  const admin = usePlatformAdminAuthStore((s) => s.admin);
  const logout = usePlatformAdminAuthStore((s) => s.logout);

  const handleLogout = async () => {
    await platformAdminAuthApi.logout().catch(() => undefined);
    logout();
    navigate("/platform-admin/login");
  };

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60 p-4">
        <div className="mb-6 flex items-center gap-2 px-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500 text-slate-950">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-black leading-tight">Platform Admin</p>
            <p className="text-[11px] text-slate-500">Control plane</p>
          </div>
        </div>
        <nav className="grid gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
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
        <div className="mt-auto grid gap-2 border-t border-slate-800 pt-4">
          <p className="truncate px-2 text-xs text-slate-500">{admin?.email}</p>
          <Button variant="outline" size="sm" className="justify-start gap-2 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-x-hidden p-6 sm:p-8">
        <Outlet />
      </main>
    </div>
  );
}

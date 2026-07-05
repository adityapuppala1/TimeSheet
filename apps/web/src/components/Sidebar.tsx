/**
 * WHAT: the app's left navigation — exports `Sidebar` (persistent, desktop/laptop/4K) and
 * `MobileNav`/`MobileDrawerNav` (the phone/tablet equivalents, a bottom bar + slide-out drawer).
 * WHY three variants of the same nav: the responsive-layout requirement (phone through 4K,
 * verified by the Playwright suite) means the persistent sidebar pattern doesn't work below a
 * certain width — rather than one component with a lot of conditional CSS, each viewport class
 * gets its own small component sharing the same permission-filtered link list.
 * WHO renders this: `layouts/AppLayout.tsx` (`Sidebar` + `MobileNav`), `components/Topbar.tsx`
 * (`MobileDrawerNav`, opened by the hamburger button).
 */
import {
  BarChart3,
  CalendarDays,
  FileClock,
  FolderKanban,
  LayoutDashboard,
  Mail,
  ScrollText,
  Settings,
  Shield,
  Sparkles,
  Ticket,
  TrendingUp,
  Users,
  Users2
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { permissions } from "@timesheet/shared";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { fileUrl } from "../services/api";

interface NavItem {
  to: string;
  label: string;
  icon: any;
  end?: boolean;
  permission?: string;
  role?: "SUPER_ADMIN";
}

const nav: NavItem[] = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/timesheet", label: "Log timesheet", icon: CalendarDays, permission: permissions.TIMESHEETS_WRITE },
  { to: "/app/tickets", label: "Tickets", icon: Ticket, permission: permissions.TICKETS_VIEW },
  { to: "/app/history", label: "History", icon: FileClock },
  { to: "/app/approvals", label: "Approvals", icon: Shield, permission: permissions.TIMESHEETS_APPROVE },
  { to: "/app/team", label: "My team", icon: Users2, permission: permissions.TIMESHEETS_APPROVE },
  { to: "/app/users", label: "Users", icon: Users, permission: permissions.USERS_MANAGE },
  { to: "/app/projects", label: "Projects", icon: FolderKanban, permission: permissions.PROJECTS_MANAGE },
  { to: "/app/reports", label: "Reports", icon: BarChart3, permission: permissions.REPORTS_VIEW },
  { to: "/app/insights", label: "Insights", icon: TrendingUp, permission: permissions.REPORTS_VIEW },
  { to: "/app/audit", label: "Audit log", icon: ScrollText, permission: permissions.AUDIT_VIEW },
  { to: "/app/ai-activity", label: "AI activity log", icon: Sparkles, permission: permissions.TICKETS_ASSIGN },
  { to: "/app/email-templates", label: "Email templates", icon: Mail, role: "SUPER_ADMIN" },
  { to: "/app/settings", label: "Workspace settings", icon: Settings }
];

function initialsFor(name?: string) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function isVisible(item: NavItem, user?: { role: string; permissions: string[] }): boolean {
  if (item.role && user?.role !== item.role) return false;
  if (item.permission && !user?.permissions.includes(item.permission)) return false;
  return true;
}

/** Shared between the desktop sidebar and the mobile drawer so the two never drift apart. */
function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav className="grid gap-0.5">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end ?? false}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground",
              isActive && "bg-primary/10 text-primary hover:bg-primary/15"
            )
          }
        >
          {({ isActive }) => (
            <>
              <span className={cn("grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition", isActive && "bg-primary/15 text-primary")}>
                <item.icon className="h-4 w-4" />
              </span>
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function BrandMark() {
  return (
    <div className="mb-8 flex items-center gap-3">
      <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary text-lg font-black text-primary-foreground shadow-glow">T</div>
      <div>
        <p className="text-base font-bold tracking-tight">TimeSphere</p>
        <p className="text-xs text-muted-foreground">Enterprise Timesheets</p>
      </div>
    </div>
  );
}

export function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const visible = nav.filter((item) => isVisible(item, user));
  const avatarSrc = fileUrl(user?.avatarUrl);

  return (
    <aside className="hidden w-72 shrink-0 border-r border-border bg-card/60 p-4 backdrop-blur-xl lg:flex lg:flex-col">
      <BrandMark />
      <NavList items={visible} />
      <div className="mt-auto rounded-lg border border-border bg-background p-3">
        <div className="flex items-center gap-3">
          <Avatar>
            {avatarSrc ? <AvatarImage src={avatarSrc} alt={user?.name ?? "Profile photo"} /> : null}
            <AvatarFallback>{initialsFor(user?.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{user?.name ?? "Guest"}</p>
            <p className="truncate text-xs text-muted-foreground">{user?.role?.replace("_", " ")}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * Off-canvas drawer nav for <lg screens — the desktop sidebar above is `hidden` below
 * that breakpoint, and the bottom `MobileNav` tab bar only surfaces 5 of the full item
 * list, so this is the only way to reach Users/Projects/Reports/Insights/Audit Log/etc.
 * on a phone or tablet. Triggered by the hamburger button in Topbar.tsx.
 */
export function MobileDrawerNav({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const user = useAuthStore((s) => s.user);
  const visible = nav.filter((item) => isVisible(item, user));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-72 max-w-[85vw] flex-col overflow-y-auto">
        <SheetTitle className="sr-only">Navigation menu</SheetTitle>
        <BrandMark />
        <NavList items={visible} onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

export function MobileNav() {
  const user = useAuthStore((s) => s.user);
  const visible = nav.filter((item) => isVisible(item, user)).slice(0, 5);
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-background/95 px-1 py-1.5 shadow-soft backdrop-blur-xl lg:hidden">
      {visible.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end ?? false}
          className={({ isActive }) => cn("grid justify-items-center gap-0.5 rounded-md px-1 py-1.5 text-[10px] font-semibold text-muted-foreground transition", isActive && "bg-primary/10 text-primary")}
        >
          <item.icon className="h-4 w-4" />
          <span className="max-w-full truncate">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

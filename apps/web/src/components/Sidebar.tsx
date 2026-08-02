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
  ShieldAlert,
  Sparkles,
  Ticket,
  TrendingUp,
  Users,
  Users2
} from "lucide-react";
import { NavLink } from "react-router";
import { permissions } from "@timesheet/shared";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./ui/sheet";
import { fileUrl } from "../services/api";

/**
 * Section headings group the nav so 15 items don't read as one undifferentiated list.
 *
 * WHY these are STATIC headings and not collapsible sections: `tests/e2e/responsive.spec.ts`'s
 * "full navigation is reachable at every viewport size" asserts the "Workspace settings" link is
 * visible at >=1024px with no interaction at all. Anything collapsed by default fails that, and
 * more importantly it would be a real usability regression — hiding admin nav behind a disclosure
 * costs a click on every visit to save vertical space that the sidebar already has.
 *
 * `null` = the ungrouped lead item(s), rendered with no heading above them.
 */
type NavSection = "Work" | "Team" | "Analytics" | "Administration" | "Configuration";

/** Render order. A section with no visible items after permission filtering is omitted entirely,
 *  heading included — an EMPLOYEE must never see an empty "Administration" label. */
const SECTION_ORDER: NavSection[] = ["Work", "Team", "Analytics", "Administration", "Configuration"];

interface NavItem {
  to: string;
  label: string;
  icon: any;
  end?: boolean;
  permission?: string;
  role?: "SUPER_ADMIN";
  /** Omit for the ungrouped lead item (Dashboard). */
  section?: NavSection;
}

const nav: NavItem[] = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },

  { to: "/app/timesheet", label: "Log timesheet", icon: CalendarDays, permission: permissions.TIMESHEETS_WRITE, section: "Work" },
  { to: "/app/tickets", label: "Tickets", icon: Ticket, permission: permissions.TICKETS_VIEW, section: "Work" },
  { to: "/app/history", label: "History", icon: FileClock, section: "Work" },

  { to: "/app/approvals", label: "Approvals", icon: Shield, permission: permissions.TIMESHEETS_APPROVE, section: "Team" },
  { to: "/app/team", label: "My team", icon: Users2, permission: permissions.TIMESHEETS_APPROVE, section: "Team" },

  { to: "/app/reports", label: "Reports", icon: BarChart3, permission: permissions.REPORTS_VIEW, section: "Analytics" },
  { to: "/app/insights", label: "Insights", icon: TrendingUp, permission: permissions.REPORTS_VIEW, section: "Analytics" },
  { to: "/app/security-insights", label: "Security insights", icon: ShieldAlert, permission: permissions.REPORTS_VIEW, section: "Analytics" },

  { to: "/app/users", label: "Users", icon: Users, permission: permissions.USERS_MANAGE, section: "Administration" },
  { to: "/app/projects", label: "Projects", icon: FolderKanban, permission: permissions.PROJECTS_MANAGE, section: "Administration" },
  { to: "/app/audit", label: "Audit log", icon: ScrollText, permission: permissions.AUDIT_VIEW, section: "Administration" },
  { to: "/app/ai-activity", label: "AI activity log", icon: Sparkles, permission: permissions.TICKETS_ASSIGN, section: "Administration" },

  { to: "/app/email-templates", label: "Email templates", icon: Mail, role: "SUPER_ADMIN", section: "Configuration" },
  // SUPER_ADMIN-only: every workspace-wide enable/disable (AI, biometrics, billing, SSO, DevOps
  // ingestion) is one person's responsibility. Matches the RequireRole gate on the route itself
  // in App.tsx and the same entry in command-palette.tsx — all three must stay in sync.
  { to: "/app/settings", label: "Workspace settings", icon: Settings, role: "SUPER_ADMIN", section: "Configuration" }
];

/**
 * NOTE for MobileNav's bottom tab bar below: it slices the first 5 VISIBLE items. Reordering the
 * array above therefore changes which 5 appear on a phone. The current order keeps
 * Dashboard/Log timesheet/Tickets/History at the front deliberately — those are the
 * everyday-employee destinations. It also keeps "Workspace settings" out of the bottom bar, which
 * matters beyond taste: the Playwright nav test does `getByRole("link", { name: /workspace
 * settings/i })`, and having it visible in both the bottom bar and an open drawer at the same
 * viewport would break strict-mode with a duplicate match.
 */

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

function NavLinkRow({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return (
    <NavLink
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
  );
}

/**
 * Shared between the desktop sidebar and the mobile drawer so the two never drift apart — that
 * sharing is also what makes "auto-close the drawer on navigate" work: the drawer passes
 * `onNavigate`, the desktop sidebar doesn't.
 *
 * Groups by `section`, omitting any section (heading included) whose items are all filtered out by
 * permission, so nobody sees an empty heading for a group they can't access.
 */
function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const ungrouped = items.filter((item) => !item.section);

  return (
    <nav className="grid gap-0.5">
      {ungrouped.map((item) => (
        <NavLinkRow key={item.to} item={item} onNavigate={onNavigate} />
      ))}

      {SECTION_ORDER.map((section) => {
        const sectionItems = items.filter((item) => item.section === section);
        if (sectionItems.length === 0) return null;
        return (
          <div key={section} className="grid gap-0.5">
            <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{section}</p>
            {sectionItems.map((item) => (
              <NavLinkRow key={item.to} item={item} onNavigate={onNavigate} />
            ))}
          </div>
        );
      })}
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
    // `sticky top-0 h-screen` keeps the sidebar pinned while the page scrolls; the nav area gets
    // its own overflow so section headings can't push the user card off-screen on a short viewport
    // (the flat list used to fit without this, the grouped one is ~140px taller).
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 border-r border-border bg-card/60 p-4 backdrop-blur-xl lg:flex lg:flex-col">
      <BrandMark />
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <NavList items={visible} />
      </div>
      <div className="mt-4 shrink-0 rounded-lg border border-border bg-background p-3">
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
        {/* Both are sr-only: sighted users read the drawer directly, but Radix wires
            aria-describedby from this and warns (correctly) when it's absent — a screen-reader
            user otherwise hears a title with no explanation of what the panel contains. */}
        <SheetDescription className="sr-only">Links to every section of the app available to your role.</SheetDescription>
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

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
  Bot,
  Briefcase,
  CalendarDays,
  ClipboardList,
  FileClock,
  FileStack,
  FolderKanban,
  GanttChartSquare,
  Gauge,
  Home,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Mail,
  Mailbox,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  Target,
  Ticket,
  TrendingUp,
  Users,
  Users2,
  Workflow
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink } from "react-router";
import { permissions, type Permission } from "@timesheet/shared";
import { cn } from "../lib/utils";
import { usePlanningFeatures } from "../lib/use-planning";
import type { PlanningEffective } from "../services/api";
import { useAuthStore } from "../store/auth";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { brandingApi, brandingLogoUrl, fileUrl } from "../services/api";

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
type NavSection = "Work" | "Plan" | "Team" | "Analytics" | "Administration" | "Configuration";

/** Render order. A section with no visible items after permission filtering is omitted entirely,
 *  heading included — an EMPLOYEE must never see an empty "Administration" label. The same rule
 *  is what makes the planning layer invisible to a workspace that never enabled it: every item in
 *  "Plan" carries a `feature`, so with planning off the section has no visible items and the
 *  heading disappears with them. */
const SECTION_ORDER: NavSection[] = ["Work", "Plan", "Team", "Analytics", "Administration", "Configuration"];

export interface NavItem {
  to: string;
  label: string;
  icon: any;
  end?: boolean;
  permission?: string;
  /** An alternative label for viewers who LACK this permission — used where one route serves two
   *  audiences and calling it the same thing for both would misdescribe what they actually get.
   *  Typed as `Permission` to match `user.permissions`, so a typo is a compile error. */
  labelWithout?: { permission: Permission; label: string };
  role?: "SUPER_ADMIN";
  /** Omit for the ungrouped lead item (Dashboard). */
  section?: NavSection;
  /** Gate on a planning capability being both switched on AND included in the plan. The value is
   *  a key of the server-computed `effective` object — see lib/use-planning.ts. Omit for items
   *  that are always available. */
  feature?: keyof PlanningEffective;
}

/** Exported so the product tour builds its itinerary from the SAME list and the SAME visibility
 *  rule the sidebar renders from. Duplicating either would let the tour offer someone a page their
 *  role can't open — the one failure a role-aware tour must not have. */
export const nav: NavItem[] = [
  { to: "/app", label: "Home", icon: Home, end: true },

  { to: "/app/timesheet", label: "Log timesheet", icon: CalendarDays, permission: permissions.TIMESHEETS_WRITE, section: "Work" },
  { to: "/app/tickets", label: "Tickets", icon: Ticket, permission: permissions.TICKETS_VIEW, section: "Work" },
  { to: "/app/history", label: "History", icon: FileClock, section: "Work" },
  // First in Work and deliberately ungated: it is where the day starts, and its brief reads
  // definitions that exist whether or not any optional feature is on.
  { to: "/app/inbox", label: "Inbox", icon: Mailbox, section: "Work" },
  { to: "/app/ask-ai", label: "Ask AI", icon: MessagesSquare, permission: permissions.TICKETS_VIEW, section: "Work" },
  { to: "/app/requests", label: "Requests", icon: Inbox, permission: permissions.TICKETS_VIEW, section: "Work", feature: "requestForms" },
  // Carries no `feature` and no permission, for the same reason the Agents roster does not: its
  // gate is a workspace toggle AND a plan entitlement, neither of which the planning `effective`
  // object models, and the page renders its own "switched off" / "not in your plan" state. Hiding
  // the item instead would leave no surface on which to explain what change management is. Reading
  // changes needs no permission at all — a change about to take a service down is not a secret
  // from the people who depend on it.
  { to: "/app/changes", label: "Change Management", icon: ClipboardList, section: "Work" },

  // Planning layer (V6). "My work" is deliberately FIRST and deliberately ungated: it is a
  // personal queue that reads dates every workspace already has, so it is useful before anything
  // is switched on — and for an EMPLOYEE it is the fifth visible item, which fills the phone
  // bottom bar with an everyday destination rather than leaving a gap. The other three carry a
  // `feature`, so they simply do not exist until planning is on.
  { to: "/app/my-work", label: "My work", icon: ListTodo, section: "Plan" },
  // Goals carry their own `goals` feature rather than "planning": they are gated on their own
  // toggle and entitlement, so a workspace can align on outcomes without turning the Gantt on.
  { to: "/app/goals", label: "Goals", icon: Target, section: "Plan", feature: "goals" },
  { to: "/app/timeline", label: "Timeline", icon: GanttChartSquare, permission: permissions.TICKETS_VIEW, section: "Plan", feature: "timeline" },
  { to: "/app/portfolio", label: "Portfolio", icon: Briefcase, permission: permissions.REPORTS_VIEW, section: "Plan", feature: "planning" },
  { to: "/app/workload", label: "Workload", icon: Gauge, permission: permissions.RESOURCES_MANAGE, section: "Plan", feature: "resourceManagement" },
  { to: "/app/blueprints", label: "Blueprints", icon: FileStack, permission: permissions.TICKETS_VIEW, section: "Plan", feature: "planning" },
  { to: "/app/proposals", label: "AI suggestions", icon: Sparkles, permission: permissions.TICKETS_VIEW, section: "Plan", feature: "planning" },
  // The roster carries no `feature`: its gate is the AI copilot ENTITLEMENT, which the planning
  // `effective` object does not model, and the page renders its own upgrade state on a 403. Hiding
  // the nav item instead would leave no surface on which to explain what agents are.
  { to: "/app/agents", label: "Agents", icon: Bot, permission: permissions.TICKETS_VIEW, section: "Plan" },
  { to: "/app/studio", label: "Workflows", icon: Workflow, permission: permissions.TICKETS_VIEW, section: "Plan" },
  // Last of the AI group and SUPER_ADMIN, because it is the map of the four above rather than a fifth
  // surface — and because it reports spend. Sits beside them rather than in Configuration so the person
  // who has just met Agents and Workflows can find the thing that explains how they relate.
  { to: "/app/ai", label: "AI overview", icon: Sparkles, role: "SUPER_ADMIN", section: "Plan" },

  { to: "/app/approvals", label: "Approvals", icon: Shield, permission: permissions.TIMESHEETS_APPROVE, section: "Team" },
  // ONE entry, no permission gate — the page adapts instead of there being two of it. An approver
  // gets the queue, SLA metrics and reports roll-up; everybody else gets the org chart alone, which
  // is why the label follows the permission rather than the route.
  {
    to: "/app/team",
    label: "My team",
    labelWithout: { permission: permissions.TIMESHEETS_APPROVE, label: "Org chart" },
    icon: Users2,
    section: "Team"
  },

  { to: "/app/dashboards", label: "Custom Dashboards", icon: LayoutDashboard, section: "Analytics", feature: "planning" },
  { to: "/app/reports", label: "Reports", icon: BarChart3, permission: permissions.REPORTS_VIEW, section: "Analytics" },
  // Insights and security insights are open to everyone (team leads and employees included) — the
  // matching server endpoints were broadened to match. "Reports" above keeps its reports:view gate.
  { to: "/app/insights", label: "Insights", icon: TrendingUp, section: "Analytics" },
  { to: "/app/security-insights", label: "Security insights", icon: ShieldAlert, section: "Analytics" },

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

export function isVisible(
  item: NavItem,
  user?: { role: string; permissions: string[] },
  features?: PlanningEffective
): boolean {
  if (item.role && user?.role !== item.role) return false;
  if (item.permission && !user?.permissions.includes(item.permission)) return false;
  // A feature-gated item is hidden when `features` hasn't loaded yet, not shown. Flashing a link
  // that then vanishes is worse than a beat of absence, and it matches the layer's default: off
  // until something says otherwise.
  if (item.feature && !features?.[item.feature]) return false;
  return true;
}

function NavLinkRow({ item, onNavigate, slim = false }: { item: NavItem; onNavigate?: () => void; slim?: boolean }) {
  const user = useAuthStore((s) => s.user);
  // One route, two audiences: /app/team is "My team" to an approver and "Org chart" to everybody
  // else, because that is what each of them actually gets when they open it.
  const label =
    item.labelWithout && !user?.permissions.includes(item.labelWithout.permission)
      ? item.labelWithout.label
      : item.label;

  const link = (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground",
          slim && "justify-center px-0",
          isActive && "bg-primary/10 text-primary hover:bg-primary/15"
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition", isActive && "bg-primary/15 text-primary")}>
            <item.icon className="h-4 w-4" />
          </span>
          {/* The label leaves the layout in slim mode rather than being clipped — a truncated
              "Wor…" next to an icon reads as broken, an icon with a tooltip reads as designed. */}
          {!slim && label}
        </>
      )}
    </NavLink>
  );

  if (!slim) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
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
function NavList({ items, onNavigate, slim = false }: { items: NavItem[]; onNavigate?: () => void; slim?: boolean }) {
  const ungrouped = items.filter((item) => !item.section);

  return (
    <nav className="grid gap-0.5">
      {ungrouped.map((item) => (
        <NavLinkRow key={item.to} item={item} onNavigate={onNavigate} slim={slim} />
      ))}

      {SECTION_ORDER.map((section) => {
        const sectionItems = items.filter((item) => item.section === section);
        if (sectionItems.length === 0) return null;
        return (
          <div key={section} className="grid gap-0.5">
            {slim ? (
              // Headings have no room at 68px; a hairline keeps the grouping legible without text.
              <div aria-hidden className="mx-2 mb-1 mt-3 border-t border-border" />
            ) : (
              <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{section}</p>
            )}
            {sectionItems.map((item) => (
              <NavLinkRow key={item.to} item={item} onNavigate={onNavigate} slim={slim} />
            ))}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The workspace's logo and name when one is set, the product mark otherwise.
 *
 * `staleTime: Infinity` deliberately: branding changes when a super admin uploads a file, and that
 * mutation invalidates this exact key — polling for it on every nav would be a request per page
 * view forever to catch something that happens once a year.
 */
function BrandMark({ slim = false, className = "mb-8" }: { slim?: boolean; className?: string }) {
  const branding = useQuery({ queryKey: ["branding"], queryFn: brandingApi.get, staleTime: Infinity });
  const logoSrc = brandingLogoUrl(branding.data);
  const name = branding.data?.displayName?.trim() || "TimeSphere";

  return (
    <div className={cn("flex items-center gap-3", slim && "justify-center", className)}>
      {logoSrc ? (
        // object-contain + a fixed box: an uploaded mark is any aspect ratio, and letting it set
        // its own width would push the collapse control off the header row.
        <img src={logoSrc} alt={name} className="h-10 w-10 shrink-0 rounded-lg object-contain" />
      ) : (
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary text-lg font-black text-primary-foreground shadow-glow">T</div>
      )}
      {!slim && (
        <div className="min-w-0">
          <p className="truncate text-base font-bold tracking-tight">{name}</p>
          <p className="truncate text-xs text-muted-foreground">Enterprise Timesheets</p>
        </div>
      )}
    </div>
  );
}

/** Persisted per browser: a person who works slim works slim every day, and re-choosing daily
 *  would make the control a nag rather than a preference. */
const SIDEBAR_COLLAPSED_KEY = "ts.sidebar.collapsed";

export function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const { features } = usePlanningFeatures();
  const visible = nav.filter((item) => isVisible(item, user, features));
  const avatarSrc = fileUrl(user?.avatarUrl);
  // Defaults to expanded — the responsive e2e suite (and first-time users) must find every link
  // visible with no interaction; slim is an opt-in the browser remembers.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((current) => {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, current ? "0" : "1");
      } catch {
        /* private mode — the preference just doesn't persist */
      }
      return !current;
    });
  };

  return (
    // `sticky top-0 h-screen` keeps the sidebar pinned while the page scrolls; the nav area gets
    // its own overflow so section headings can't push the user card off-screen on a short viewport.
    // The width is the ONLY layout change slim mode makes: the main content is this aside's flex
    // sibling, so it reflows to the freed width on its own — every page adapts with zero page code.
    <aside
      data-tour="sidebar"
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 border-r border-border bg-card/60 backdrop-blur-xl transition-[width] duration-200 lg:flex lg:flex-col",
        collapsed ? "w-[68px] p-2.5" : "w-72 p-4"
      )}
    >
      {/* The collapse control lives in the header row, where slim-sidebar patterns put it —
          a toggle at the bottom is off-screen muscle memory; up here it is the first thing the
          eye meets, next to the brand it is shrinking. Slim mode stacks it under the logo. */}
      <div className={cn("mb-6 flex shrink-0 items-center", collapsed ? "flex-col gap-2" : "justify-between gap-2")}>
        <BrandMark slim={collapsed} className="mb-0" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggle}
              aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
              aria-expanded={!collapsed}
              className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <NavList items={visible} slim={collapsed} />
      </div>

      <div className={cn("mt-2 shrink-0 rounded-lg border border-border bg-background", collapsed ? "p-1.5" : "p-3")}>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex justify-center">
                <Avatar>
                  {avatarSrc ? <AvatarImage src={avatarSrc} alt={user?.name ?? "Profile photo"} /> : null}
                  <AvatarFallback>{initialsFor(user?.name)}</AvatarFallback>
                </Avatar>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {user?.name ?? "Guest"} · {user?.role?.replace("_", " ").toLowerCase()}
            </TooltipContent>
          </Tooltip>
        ) : (
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
        )}
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
  const { features } = usePlanningFeatures();
  const visible = nav.filter((item) => isVisible(item, user, features));

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
  const { features } = usePlanningFeatures();
  const visible = nav.filter((item) => isVisible(item, user, features)).slice(0, 5);
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

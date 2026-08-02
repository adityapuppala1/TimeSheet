/**
 * WHAT: builds the product tour's itinerary for the person actually taking it.
 *
 * WHY IT'S DERIVED, NOT WRITTEN OUT: the steps come from the SAME `nav` array and the SAME
 * `isVisible` rule the sidebar renders from. A hand-maintained list would eventually offer an
 * EMPLOYEE a walkthrough of "Workspace settings" — a page that 403s for them — which is the one
 * failure a role-aware tour cannot have. Deriving it means adding a nav item automatically adds a
 * tour stop, correctly gated, with no second place to remember.
 *
 * The per-destination copy lives in `DESTINATION_COPY` below. A destination with no entry still
 * gets a stop, using its nav label — a missing description is a dull step, not a broken tour.
 */
import { nav, isVisible, type NavItem } from "../components/Sidebar";

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Route to be on before this step can be shown. The engine navigates if needed. */
  route: string;
  /**
   * CSS selector for the element to spotlight. Resolved AFTER navigation, with a retry window —
   * pages fetch their data before rendering, so the target frequently doesn't exist yet at the
   * moment the route changes.
   */
  selector: string;
  /** Falls back to this when `selector` never resolves, so a slow or empty page still gets a
   *  readable step instead of a stuck tour. */
  fallbackSelector?: string;
  /** Tab to activate on arrival, matched by its visible name. */
  tab?: string;
  /** Where the card sits relative to the target when there's room. */
  placement?: "top" | "bottom" | "left" | "right";
}

/** What each destination is FOR, in the second person. Written to be useful to someone who has
 *  never seen the app, not to restate the page title. */
const DESTINATION_COPY: Record<string, { title: string; body: string }> = {
  "/app": {
    title: "Your dashboard",
    body: "Everything waiting on you, in one place — hours still to log, approvals in your queue, and how the week is tracking. It changes shape by role, so you only ever see your own work."
  },
  "/app/timesheet": {
    title: "Log your time",
    body: "Pick the project, module and activity, set the hours, and describe what you did. Overlaps and daily caps are checked as you type, so an entry is right before you submit it rather than after a manager sends it back."
  },
  "/app/tickets": {
    title: "Tickets",
    body: "Bugs, tasks and improvements as a list or a Kanban board. Drag to change status, open one for its full history, and link the branch or pull request where the work actually happened."
  },
  "/app/history": {
    title: "Your history",
    body: "Every entry you've logged, filterable by date, project and status. Drafts and rejected entries can be deleted here; approved ones can't, because they're part of the billing record."
  },
  "/app/approvals": {
    title: "Approvals",
    body: "Submissions from your reports, each with an SLA timer counting down. Approve or reject with a reason — rejections come back to the author with your note attached."
  },
  "/app/team": {
    title: "Your team",
    body: "Who reports to you, their logged hours, and an org chart built from the same reporting lines the approvals queue uses."
  },
  "/app/reports": {
    title: "Reports",
    body: "Export hours by person, project or period as CSV or PDF — the artefact you hand to finance or a client."
  },
  "/app/insights": {
    title: "Insights",
    body: "Velocity, cycle time, SLA compliance and workload, computed from the same rows the approvals ran against — so this and your invoice can't disagree."
  },
  "/app/security-insights": {
    title: "Security insights",
    body: "Findings your CI posted in, rolled up by severity and repository. This product never runs a scanner itself; it turns what yours reports into tickets with owners."
  },
  "/app/users": {
    title: "Users",
    body: "Add people, set roles and reporting lines, and deactivate leavers. Role decides what each person can see — including which of these very pages they get."
  },
  "/app/projects": {
    title: "Projects",
    body: "Projects, their modules and submodules, plus the SLA windows and billing rates that everything downstream reads from."
  },
  "/app/audit": {
    title: "Audit log",
    body: "Every administrative action, who took it and when. Append-only — the record an auditor asks for."
  },
  "/app/ai-activity": {
    title: "AI activity log",
    body: "Every AI-touched ticket, what the model decided, and how confident it was. Rate a decision up or down and that feedback becomes training data for the quality loop."
  },
  "/app/email-templates": {
    title: "Email templates",
    body: "The wording of every notification the system sends, editable without a deploy."
  },
  "/app/settings": {
    title: "Workspace settings",
    body: "Every workspace-wide switch: reminders, AI and its budget, identity verification, integrations and billing. Super Admin only, so one person owns each of these decisions."
  }
};

/** Steps that aren't a nav destination — the shell itself, which people otherwise never notice. */
function shellSteps(): TourStep[] {
  return [
    {
      id: "welcome",
      title: "Let's take two minutes",
      body: "A quick walk through the parts of the app you can use. You can leave at any point with Skip tour, and restart it later from your profile menu.",
      route: "/app",
      // The sidebar on desktop; on a phone it's hidden, so the header is the fallback.
      selector: '[data-tour="sidebar"]',
      fallbackSelector: "h1",
      placement: "right"
    },
    {
      id: "search",
      title: "Jump anywhere",
      body: "Search people, projects and actions from here — or press Ctrl/⌘ K from any page. It's usually faster than the menu.",
      route: "/app",
      selector: '[data-tour="command-search"]',
      fallbackSelector: "h1",
      placement: "bottom"
    },
    {
      id: "notifications",
      title: "What needs you",
      body: "Approvals, SLA breaches and mentions land here, and as email if you've opted in. Per-category preferences live in your profile.",
      route: "/app",
      selector: '[data-tour="notifications"]',
      fallbackSelector: "h1",
      placement: "bottom"
    }
  ];
}

const CLOSING_STEP: TourStep = {
  id: "finish",
  title: "That's the tour",
  body: "Your profile menu has it again whenever you want — plus your notification preferences and personal details.",
  route: "/app",
  selector: '[data-tour="user-menu"]',
  fallbackSelector: "h1",
  placement: "bottom"
};

/**
 * Builds the itinerary for one user.
 *
 * Each visible destination becomes a stop that navigates there and spotlights the page's own
 * heading — so the person sees the real screen with their real data, not a description of it.
 */
export function buildTourSteps(user?: { role: string; permissions: string[] }): TourStep[] {
  const destinations = nav
    .filter((item: NavItem) => isVisible(item, user))
    .map<TourStep>((item) => {
      const copy = DESTINATION_COPY[item.to];
      return {
        id: `nav:${item.to}`,
        title: copy?.title ?? item.label,
        body: copy?.body ?? `The ${item.label.toLowerCase()} area.`,
        route: item.to,
        // The page heading is the one element every page reliably has, which makes it a target
        // that can't go stale as pages are redesigned.
        selector: "main h1",
        fallbackSelector: "main",
        placement: "bottom"
      };
    });

  return [...shellSteps(), ...destinations, CLOSING_STEP];
}

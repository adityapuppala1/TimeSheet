/**
 * WHAT: the large tenant-admin settings page — one tabbed surface over every per-org
 * configuration this app has: reminders/schedule, email channels, ticketing SLA/types, AI
 * provider/toggles/model/budget, email intake + routing rules, chat integrations + routing
 * rules, SSO (Google/Microsoft/SAML/LDAP), BCC/forms.
 * WHY one page with many tabs, not many separate pages: every tab is SUPER_ADMIN-only and reads/
 * writes the same small set of tenant-wide singleton settings rows (`GlobalSettings`,
 * `GlobalAISettings`, `GlobalTicketSettings`, etc.) — one page keeps the "you're editing
 * workspace-wide config" framing consistent instead of scattering it across the nav.
 * ACCESS: this whole page is SUPER_ADMIN-only — gated three ways that must stay in sync:
 * `RequireRole` on the route (App.tsx), `role: "SUPER_ADMIN"` on the nav entries in both
 * Sidebar.tsx and command-palette.tsx, and `requireSuperAdmin` on the backing routes in
 * settings.controller.ts. It previously rendered a read-only view for other roles; that was
 * dropped so responsibility for every workspace-wide enable/disable sits with one person.
 * WHY `readOnly` is still threaded through every card even though it's now always `false`: the
 * plumbing is kept deliberately, so re-introducing a read-only tier (e.g. letting ADMIN view but
 * not change) is a one-line change here rather than re-threading a prop through 14 cards. Cards
 * must keep honouring it.
 * NOTE for non-super-admin pages: they must NOT call `settingsApi.getAI`/`getTicketing` (both
 * super-admin-only now) — read `settingsApi.getEffectiveFlags` instead, a tiny auth-safe
 * projection of the few workspace flags ordinary pages need. See Tickets.tsx / Insights.tsx.
 * WHO calls the backing APIs: `controllers/settings.controller.ts`, `email-intake.controller.ts`,
 * `chat-integrations.controller.ts` — this page is the one UI surface for all three.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  emailMatchTypes,
  isEmailRoleMuted,
  notificationPreferenceKeys,
  type EmailMatchType,
  type EmailRoleMutes,
  type GlobalAISettings,
  type GlobalSettings,
  type GlobalTicketSettings,
  type NotificationPreferences,
  type RoleName
} from "@timesheet/shared";
import {
  AlarmClock,
  BellRing,
  CalendarClock,
  ChevronRight,
  Check,
  Clock,
  FileStack,
  Hourglass,
  Inbox,
  Loader2,
  Mail,
  MailCheck,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Timer,
  Trash2,
  Wrench,
  X,
  Zap, Bot, Target, Workflow, Download
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { AiFeatureUsagePanel } from "../components/AiFeatureUsagePanel";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { DataTable } from "../components/ui/data-table";
import { DateRangePicker, type DateRangeValue } from "../components/ui/date-range-picker";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { toast } from "../components/ui/toaster";
import {
  emailIntakeApi,
  labelApi,
  projectApi,
  settingsApi,
  ticketTypeApi,
  userApi,
  type AIUsageRow,
  type TicketRuleInput
} from "../services/api";
import { useAuthStore } from "../store/auth";
import { ChatIntegrationsSettingsCard } from "./settings/ChatIntegrationsSettingsCard";
import { MailServerSettingsCard } from "./settings/MailServerSettingsCard";
import { PublicApiSettingsCard } from "./settings/PublicApiSettingsCard";
import { McpServerSettingsCard } from "./settings/McpServerSettingsCard";
import { BillingSettingsCard } from "./settings/BillingSettingsCard";
import { ImapMark } from "../components/ui/connector-marks";
import { IntegrationsSettingsCard } from "./settings/IntegrationsSettingsCard";
import { SsoSettingsCard } from "./settings/SsoSettingsCard";
import { AIDatasetsCard } from "./settings/AIDatasetsCard";
import { AIEvalsCard } from "./settings/AIEvalsCard";
import { AIPromptsCard } from "./settings/AIPromptsCard";
import { AIAutonomyCard } from "./settings/AIAutonomyCard";
import { AgentRunsCard } from "./settings/AgentRunsCard";
import { SecurityDevOpsSettingsCard } from "./settings/SecurityDevOpsSettingsCard";
import { FaceVerificationSettingsCard } from "./settings/FaceVerificationSettingsCard";
import { BrandingSettingsCard } from "./settings/BrandingSettingsCard";
import { MaintenanceSettingsCard } from "./settings/MaintenanceSettingsCard";
import { ChangeManagementSettingsCard } from "./settings/ChangeManagementSettingsCard";
import { PlanningSettingsCard } from "./settings/PlanningSettingsCard";
import { StorageAndLogsCard } from "./settings/StorageAndLogsCard";
import { AIProviderListCard } from "./settings/AIProviderListCard";

// Matches the exact chart styling convention used in Insights.tsx (this repo's `dataviz`
// skill): CSS-variable colors only, fixed categorical order never re-cycled by rank.
const AXIS_STYLE = { stroke: "hsl(var(--muted-foreground))", fontSize: 12 };
const TOOLTIP_STYLE = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }
};
const GRID_STYLE = { strokeDasharray: "3 3", stroke: "hsl(var(--border))" };
const MODEL_COLORS = ["hsl(var(--primary))", "hsl(var(--info))", "hsl(var(--accent))", "hsl(var(--warning))", "hsl(var(--success))"];

function formatWeek(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** yyyy-mm-dd in LOCAL time, matching DateRangePicker's own ISO shape — `toISOString()` would
 *  shift near midnight for any timezone ahead of UTC. */
function localIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Columns for the AI usage table — one row per provider×model combination actually used in the
 *  picked range. Module-level, matching Tickets.tsx's ticketColumns convention. */
const usageColumns: ColumnDef<AIUsageRow, unknown>[] = [
  { accessorKey: "provider", header: "Provider" },
  { accessorKey: "model", header: "Model" },
  { accessorKey: "calls", header: "Calls", cell: ({ row }) => row.original.calls.toLocaleString() },
  {
    accessorKey: "successRatePct",
    header: "Success rate",
    cell: ({ row }) => {
      const pct = row.original.successRatePct;
      if (pct === null) return <span className="text-muted-foreground">n/a</span>;
      // Amber/red only below a real reliability concern — a single stray timeout in a busy month
      // shouldn't paint an otherwise-solid provider as troubled.
      const tone = pct >= 95 ? "text-success" : pct >= 80 ? "text-warning" : "text-destructive";
      return (
        <span className={tone} title={`${row.original.successCount} succeeded, ${row.original.failureCount} failed`}>
          {pct}%
        </span>
      );
    }
  },
  { accessorKey: "inputTokens", header: "Input tokens", cell: ({ row }) => row.original.inputTokens.toLocaleString() },
  { accessorKey: "outputTokens", header: "Output tokens", cell: ({ row }) => row.original.outputTokens.toLocaleString() },
  { accessorKey: "totalTokens", header: "Total tokens", cell: ({ row }) => row.original.totalTokens.toLocaleString() },
  {
    accessorKey: "avgLatencyMs",
    header: "Avg latency",
    cell: ({ row }) =>
      row.original.avgLatencyMs === null ? (
        <span className="text-muted-foreground">not measured</span>
      ) : (
        <span title={`measured on ${row.original.latencyMeasuredCalls} of ${row.original.calls} calls`}>
          {row.original.avgLatencyMs.toLocaleString()} ms
        </span>
      )
  },
  { accessorKey: "costUsd", header: "Cost", cell: ({ row }) => `$${row.original.costUsd.toFixed(2)}` },
  { accessorKey: "costSharePct", header: "% of total", cell: ({ row }) => `${row.original.costSharePct}%` }
];

interface ToggleRow {
  key: keyof NotificationPreferences;
  label: string;
  description: string;
  icon: ReactNode;
  /** Section heading this row sits under in the matrix. */
  group: "Timesheets" | "Tickets" | "Changes" | "Digests" | "Identity" | "Workspace";
}

/**
 * EVERY gateable email in the app, in one table. `notificationPreferenceKeys` is the contract:
 * a key that exists there but has no row here is a category the backend silently enforces and
 * no admin can find — which is exactly what had happened to the six `emailTicket*` rows below.
 * The `emailChannelCoverage` assertion under this list keeps that from recurring.
 */
const emailRows = [
  { group: "Timesheets", key: "emailTimesheetSubmitted", label: "Submission confirmation", description: "Email the submitter when a timesheet enters the approval queue.", icon: <Check className="h-4 w-4 text-info" /> },
  { group: "Timesheets", key: "emailTimesheetApproved", label: "Timesheet approved", description: "Email the employee when their entry is approved.", icon: <Check className="h-4 w-4 text-success" /> },
  { group: "Timesheets", key: "emailTimesheetRejected", label: "Timesheet rejected", description: "Email the employee with the reviewer's reason and a fix link.", icon: <X className="h-4 w-4 text-destructive" /> },
  { group: "Timesheets", key: "emailSlaBreach", label: "Approval SLA breached", description: "Email the manager who missed the window before we escalate.", icon: <Hourglass className="h-4 w-4 text-warning" /> },
  { group: "Timesheets", key: "emailEscalation", label: "Approval escalations", description: "Email the manager-of-manager (or admin) when an SLA is missed.", icon: <ShieldX className="h-4 w-4 text-destructive" /> },
  { group: "Timesheets", key: "emailDailyReminder", label: "Daily reminder (4 PM)", description: "Nudge employees who haven't logged today's time.", icon: <Clock className="h-4 w-4 text-primary" /> },
  { group: "Timesheets", key: "emailDailyEscalation", label: "Next-morning escalation (9 AM)", description: "Email both the employee and their manager when yesterday's log was missed.", icon: <Timer className="h-4 w-4 text-destructive" /> },
  { group: "Timesheets", key: "emailDeadlineReminder", label: "Monthly deadline reminder", description: "Email employees a few days before the monthly cutoff.", icon: <CalendarClock className="h-4 w-4 text-warning" /> },
  { group: "Digests", key: "emailWeeklyDigest", label: "Weekly digest", description: "AI-authored Monday-morning recap of your ticket and timesheet activity. Requires the AI weekly digest toggle in the AI tab.", icon: <BellRing className="h-4 w-4 text-info" /> },
  { group: "Digests", key: "emailPracticeUpdate", label: "Weekly AI/ML practice update", description: "The consolidated leadership update — products, POCs, bugs, security, training, metrics, risks and decisions required. Sent on demand from Practice Update, and optionally every Monday. Recipients are set there by a super admin.", icon: <BellRing className="h-4 w-4 text-primary" /> },
  { group: "Digests", key: "emailSecurityWeeklyDigest", label: "Weekly security digest", description: "AI-authored Monday-morning (08:30) org-wide security recap for every admin — open findings, risk score, tickets past SLA. Requires the AI weekly security digest toggle in the AI tab.", icon: <ShieldAlert className="h-4 w-4 text-destructive" /> },
  { group: "Digests", key: "emailBugPatternDigest", label: "Monthly bug-pattern digest", description: "AI-authored \"what kept breaking\" recap on the 1st of every month — recurring CI failures and security-finding hotspots. Requires the AI monthly bug-pattern digest toggle in the AI tab.", icon: <BellRing className="h-4 w-4 text-info" /> },
  { group: "Tickets", key: "emailTicketStaleNudge", label: "Stale-ticket nudge", description: "AI-suggested next action when the SLA sweep flags a ticket as stale. Requires the AI stale-ticket nudge toggle in the AI tab.", icon: <Hourglass className="h-4 w-4 text-warning" /> },
  { group: "Workspace", key: "emailMaintenanceScheduled", label: "Maintenance warning", description: "\"Save your work\" email when a super admin sends the maintenance-window notice from the Maintenance tab. The in-app notification always fires — this only gates the email copy.", icon: <Wrench className="h-4 w-4 text-warning" /> },
  { group: "Workspace", key: "emailAiAutonomyApplied", label: "Assistant acted on its own", description: "Tells the person a change was made for them when a capability set to Apply or Act freely in the AI tab applies its own change set. On by default — those levels move your job from approving a change to vetoing it, and a veto nobody is told about is not a veto.", icon: <Bot className="h-4 w-4 text-primary" /> },
  { group: "Workspace", key: "emailWorkflowApproval", label: "A workflow is waiting for a decision", description: "Sent to the person a workflow's approval step names, when a run stops at that step. On by default: a gate blocks everything after it, sometimes for days, and an approval request nobody sees is a workflow that looks broken rather than blocked.", icon: <Workflow className="h-4 w-4 text-primary" /> },
  { group: "Workspace", key: "emailGoalDigest", label: "Weekly goal digest", description: "Monday morning, to a goal's OWNER only: which of their goals are off track and which periods close this week. Off by default, like every other digest — and it stays quiet in a week where nothing needs a look.", icon: <Target className="h-4 w-4 text-primary" /> },
  { group: "Tickets", key: "emailTicketNeedsReview", label: "Email-sourced ticket needs review", description: "Alert project admins/managers when an inbound email is classified with low confidence.", icon: <Sparkles className="h-4 w-4 text-warning" /> },
  // Face (identity) verification lifecycle — none of these ever carry a captured image or a
  // score; they link into the app, where authorization is checked.
  { group: "Identity", key: "emailFaceEnrollmentRequired", label: "Face enrollment required", description: "Tell someone the identity policy now covers them — before a blocked submission does.", icon: <ScanFace className="h-4 w-4 text-primary" /> },
  { group: "Identity", key: "emailFaceEnrollmentReminder", label: "Face enrollment reminder", description: "Daily follow-up (at most one per 3 days) while a covered person hasn't enrolled.", icon: <ScanFace className="h-4 w-4 text-warning" /> },
  { group: "Identity", key: "emailFaceVerificationFlagged", label: "Identity check flagged", description: "Alert the person's manager and admins when repeated failed checks flag an attempt for review.", icon: <ShieldAlert className="h-4 w-4 text-destructive" /> },
  { group: "Identity", key: "emailFaceReviewOverdue", label: "Identity review overdue", description: "Nudge admins when flagged attempts sit unreviewed for 48+ hours.", icon: <Hourglass className="h-4 w-4 text-warning" /> },
  { group: "Identity", key: "emailFaceDataDeleted", label: "Face data deleted", description: "Confirm to the person when their biometric data is deleted (self-service or by an admin).", icon: <ShieldCheck className="h-4 w-4 text-success" /> },
  { group: "Identity", key: "emailFaceEntitlementLost", label: "Face verification plan change", description: "Tell admins when the plan stops including face verification and the purge grace window starts.", icon: <ShieldX className="h-4 w-4 text-destructive" /> },
  { group: "Digests", key: "emailIdentityWeeklyDigest", label: "Weekly identity digest", description: "Monday-morning recap of identity checks, failures, and pending reviews for every admin. Stats only — no AI.", icon: <BellRing className="h-4 w-4 text-info" /> },
  // Ticket lifecycle. These six were enforced by dispatchNotification from the day they shipped
  // but had no row here, so the only way to change them was a direct DB write.
  { group: "Tickets", key: "emailTicketAssigned", label: "Ticket assigned", description: "Email the assignee when a ticket is assigned to them.", icon: <Inbox className="h-4 w-4 text-primary" /> },
  { group: "Tickets", key: "emailTicketStatusChanged", label: "Ticket status changed", description: "Email the reporter and assignee when a ticket moves between statuses.", icon: <RefreshCw className="h-4 w-4 text-info" /> },
  { group: "Tickets", key: "emailTicketCommented", label: "Ticket commented", description: "Email the ticket's participants when someone adds a comment.", icon: <Pencil className="h-4 w-4 text-info" /> },
  { group: "Tickets", key: "emailTicketSlaBreach", label: "Ticket SLA breached", description: "Email the assignee when a ticket passes its priority's SLA window.", icon: <Hourglass className="h-4 w-4 text-warning" /> },
  { group: "Tickets", key: "emailTicketEscalation", label: "Ticket escalation", description: "Email the assignee's manager when a breached ticket escalates.", icon: <ShieldX className="h-4 w-4 text-destructive" /> },
  { group: "Tickets", key: "emailTicketClosedDigest", label: "Ticket-closed security digest", description: "Security/test-status recap to whoever closed a ticket, their manager, and this org's admins. Needs a connected scan source to be meaningful.", icon: <ShieldCheck className="h-4 w-4 text-success" /> }
,
  /* --- Change management. Every one of these except the digest is the direct consequence of an
     action somebody took, which is why they ship enabled — see the schema comments. Muting one
     suppresses only the EMAIL leg; the in-app bell always fires, because an approval that goes
     quiet because somebody tidied their mail settings is a governance hole. --- */
  { group: "Changes", key: "emailChangeSubmitted", label: "Change submitted", description: "Tell the requester and implementer that a change has gone forward for assessment or approval.", icon: <FileStack className="h-4 w-4 text-info" /> },
  { group: "Changes", key: "emailChangeApprovalRequested", label: "Approval needed", description: "Email an approver the moment their step in a change's chain opens. The one that blocks everything after it.", icon: <ShieldCheck className="h-4 w-4 text-warning" /> },
  { group: "Changes", key: "emailChangeApproved", label: "Change approved", description: "The board said yes — sent to the requester, the implementer and anyone watching.", icon: <ShieldCheck className="h-4 w-4 text-success" /> },
  { group: "Changes", key: "emailChangeRejected", label: "Change rejected", description: "The board said no, carrying the rejecting approver's comment.", icon: <ShieldX className="h-4 w-4 text-destructive" /> },
  { group: "Changes", key: "emailChangeScheduled", label: "Change scheduled", description: "An approved change has been given an implementation window.", icon: <CalendarClock className="h-4 w-4 text-info" /> },
  { group: "Changes", key: "emailChangeWindowReminder", label: "Window reminder", description: "The implementation window opens shortly — sent a day out and again an hour out.", icon: <Hourglass className="h-4 w-4 text-warning" /> },
  { group: "Changes", key: "emailChangeImplementationStarted", label: "Implementation started", description: "Work on an approved change has begun. Off by default: the people who need this are already watching the change.", icon: <Hourglass className="h-4 w-4 text-muted-foreground" /> },
  { group: "Changes", key: "emailChangeCompleted", label: "Change completed", description: "A change finished implementing, with the outcome that was recorded.", icon: <ShieldCheck className="h-4 w-4 text-success" /> },
  { group: "Changes", key: "emailChangeFailed", label: "Change failed or rolled back", description: "Sent to this org's admins as well as the parties — a failed change is everyone's problem.", icon: <ShieldX className="h-4 w-4 text-destructive" /> },
  { group: "Changes", key: "emailChangePirDue", label: "Review due", description: "A change is waiting on its post-implementation review before it can close.", icon: <FileStack className="h-4 w-4 text-warning" /> },
  { group: "Changes", key: "emailChangeFreezeConflict", label: "Freeze conflict", description: "A change's window collides with a freeze period. Reported, never silently blocked.", icon: <ShieldX className="h-4 w-4 text-warning" /> },
  { group: "Changes", key: "emailChangeOverdueApproval", label: "Approval overdue", description: "An approval has sat undecided past the workspace's approval SLA — nudges the approver, then their manager.", icon: <Hourglass className="h-4 w-4 text-destructive" /> },
  { group: "Changes", key: "emailChangeWeeklyDigest", label: "Weekly change digest", description: "Monday morning to change managers: next week's calendar and last week's outcomes. Off by default, like every digest here.", icon: <CalendarClock className="h-4 w-4 text-muted-foreground" /> }
] as const satisfies readonly ToggleRow[];

/**
 * Compile-time proof that every gateable email category has a row above. If a new key is added
 * to `notificationPreferenceKeys` without a matching `emailRows` entry, this errors — the whole
 * point being that the backend already enforces such a key, so a missing row is an invisible
 * setting rather than a cosmetic gap. Deliberately a type-level check, not a runtime one: the
 * failure has to surface in CI, not in a super admin's browser.
 */
type UncoveredEmailKey = Exclude<keyof NotificationPreferences, (typeof emailRows)[number]["key"]>;
const _emailChannelCoverage: UncoveredEmailKey extends never ? true : never = true;
void _emailChannelCoverage;

const EMAIL_GROUP_ORDER: ReadonlyArray<ToggleRow["group"]> = ["Timesheets", "Tickets", "Changes", "Digests", "Identity", "Workspace"];

/**
 * Transactional mail that deliberately has NO toggle and no role column. These go to one specific
 * person as the direct result of an action they or an admin just took, and are listed purely so
 * "which emails does this app send?" has a single complete answer on this screen.
 *
 * Not gateable on purpose: a role filter over a password reset is an account-lockout waiting to
 * happen, and `dispatchTransactional()` has no recipient User row to read a role from anyway.
 */
const ALWAYS_SENT_ROWS: ReadonlyArray<{ label: string; description: string }> = [
  { label: "welcome", description: "Sent once, the first time an account is created." },
  { label: "reset", description: "Password-reset link with a 30-minute TTL." },
  { label: "Email-intake confirmation", description: "Auto-reply to an external sender whose email created a ticket." }
];

/**
 * Column order for the Email channels matrix: least-privileged first, so the two columns an
 * admin most often wants to clear (Manager, Super Admin — the roles that approve time rather
 * than log it) sit next to each other on the right. Deliberately NOT `roles` from @timesheet/
 * shared, which is ordered by descending privilege for permission checks.
 */
const MATRIX_ROLES: ReadonlyArray<{ role: RoleName; label: string; short: string }> = [
  { role: "EMPLOYEE", label: "Employee", short: "Emp" },
  { role: "TEAM_LEAD", label: "Team Leader", short: "TL" },
  { role: "MANAGER", label: "Manager", short: "Mgr" },
  { role: "ADMIN", label: "Admin", short: "Adm" },
  { role: "SUPER_ADMIN", label: "Super Admin", short: "SA" }
];

const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);

function formatHour(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12.toString().padStart(2, "0")}:00 ${suffix}  (${hour.toString().padStart(2, "0")}:00)`;
}

export function WorkspaceSettingsPage() {
  const user = useAuthStore((s) => s.user);
  // Always true in practice — the route is RequireRole-gated, so a non-super-admin never renders
  // this component. Kept as belt-and-braces (and to keep the `readOnly` plumbing meaningful) so
  // that if the route gate is ever loosened, every control stays disabled rather than silently
  // becoming editable. See this file's header comment.
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  /* Controlled rather than `defaultValue` so one panel can send an admin to another — the
     Integrations tab points at Single sign-on now that SCIM lives there, and a pointer nobody can
     follow is just an apology. */
  const [tab, setTab] = useState("reminders");

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="h-5 w-5" />
        </div>
        {/* min-w-0 so the description wraps instead of setting a floor on the row's width; the
            icon gets `shrink-0` so the wrap doesn't squash it into an ellipse. */}
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight">Workspace settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isSuperAdmin
              ? "Tune workspace-wide reminders, notification channels, and BCC behavior. Changes apply to everyone."
              : "Read-only view. Only the super admin can change these settings."}
          </p>
        </div>
      </div>

      {/* `grid-cols-[minmax(0,1fr)]` is load-bearing, not tidying — and `min-w-0` alone is NOT
          enough here, which is the subtle part. A grid ITEM defaults to `min-width: auto`, so the
          column track sizes itself to the widest panel's min-content no matter how narrow the
          container is allowed to get. Any one tab with a wide element therefore stretched the
          whole page past the viewport, and `overflow-x: clip` on html/body hid the damage rather
          than scrolling it — which is how the Face verification tab rendered 512px wide inside a
          390px phone while the page-level overflow test stayed green. An explicit `minmax(0,1fr)`
          track lets the column shrink below min-content, making each panel responsible for its
          own overflow instead of exporting it to the page. */}
      <Tabs value={tab} onValueChange={setTab} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
        <TabsList data-tour="settings-tabs" className="w-full justify-start sm:w-auto">
          {/* First: it is the one tab about what the product LOOKS like rather than what it does,
              and it is the first thing a new workspace personalises. */}
          <TabsTrigger value="branding">Branding</TabsTrigger>
          <TabsTrigger value="reminders">Reminders & schedule</TabsTrigger>
          <TabsTrigger value="emails">Email channels</TabsTrigger>
          <TabsTrigger value="mail-server">Mail server</TabsTrigger>
          <TabsTrigger value="ticketing">Ticketing</TabsTrigger>
          {/* Sits next to Ticketing on purpose: planning extends the ticket, it isn't a separate
              product, and an admin looking for "where do I turn on the Gantt" looks near the
              thing it plans. */}
          <TabsTrigger value="planning">Planning</TabsTrigger>
          <TabsTrigger value="changes">Change management</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="email-intake">Email intake</TabsTrigger>
          <TabsTrigger value="chat-integrations">Chat integrations</TabsTrigger>
          <TabsTrigger value="security-devops">Security & DevOps</TabsTrigger>
          <TabsTrigger value="face-verification">Face verification</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="public-api">Public API</TabsTrigger>
          {/* Next to Public API on purpose: both hand an outside system a bearer token against
              this workspace. The difference an admin must not miss is that this one's caller is a
              language model, which is why its own tab leads with that. */}
          <TabsTrigger value="mcp">MCP server</TabsTrigger>
          <TabsTrigger value="sso">Single sign-on</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="storage">Storage & logs</TabsTrigger>
          <TabsTrigger value="bcc">BCC & forms</TabsTrigger>
        </TabsList>

        {/* No readOnly prop: the card's own mutations are SUPER_ADMIN-gated on the server, and a
            non-admin simply never reaches this route (see App.tsx's RequireRole). */}
        <TabsContent value="branding">
          <BrandingSettingsCard />
        </TabsContent>

        <TabsContent value="reminders">
          <ReminderScheduleCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="emails">
          <EmailChannelsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="mail-server">
          <MailServerSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="ticketing">
          <TicketingSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="changes">
          <ChangeManagementSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="planning">
          <PlanningSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="ai">
          <AISettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="email-intake">
          <EmailIntakeSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="chat-integrations">
          <ChatIntegrationsSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="face-verification">
          <FaceVerificationSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="security-devops">
          <SecurityDevOpsSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="integrations">
          <IntegrationsSettingsCard readOnly={!isSuperAdmin} onGoToSso={() => setTab("sso")} />
        </TabsContent>

        <TabsContent value="billing">
          <BillingSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="public-api">
          <PublicApiSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="mcp">
          <McpServerSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="sso">
          <SsoSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        <TabsContent value="maintenance">
          <MaintenanceSettingsCard readOnly={!isSuperAdmin} />
        </TabsContent>

        {/* No readOnly prop: this tab is diagnostics only — the paths are env-managed and there
            is nothing on it to write. See StorageAndLogsCard's header for why. */}
        <TabsContent value="storage">
          <StorageAndLogsCard />
        </TabsContent>

        <TabsContent value="bcc">
          <BccAndFormsCard readOnly={!isSuperAdmin} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function useSettings() {
  return useQuery({ queryKey: ["settings", "notifications"], queryFn: settingsApi.getNotifications });
}

function useUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<GlobalSettings>) => settingsApi.updateNotifications(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ["settings", "notifications"] });
      const previous = queryClient.getQueryData<GlobalSettings>(["settings", "notifications"]);
      if (previous) queryClient.setQueryData(["settings", "notifications"], { ...previous, ...payload });
      return { previous };
    },
    onError: (err: any, _p, context) => {
      if (context?.previous) queryClient.setQueryData(["settings", "notifications"], context.previous);
      toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "notifications"] });
    }
  });
}

function ReminderScheduleCard({ readOnly }: { readOnly: boolean }) {
  const settings = useSettings();
  const update = useUpdate();
  const [draftDaily, setDraftDaily] = useState<number | null>(null);
  const [draftEscalation, setDraftEscalation] = useState<number | null>(null);

  useEffect(() => {
    if (settings.data) {
      setDraftDaily(settings.data.dailyReminderHour);
      setDraftEscalation(settings.data.escalationReminderHour);
    }
  }, [settings.data]);

  const dailyChanged = draftDaily !== null && settings.data && draftDaily !== settings.data.dailyReminderHour;
  const escalationChanged = draftEscalation !== null && settings.data && draftEscalation !== settings.data.escalationReminderHour;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlarmClock className="h-4 w-4 text-primary" />
          Daily reminder schedule
        </CardTitle>
        <CardDescription>
          When TimeSphere should nudge employees about today's timesheet, and when to escalate yesterday's missed logs.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {settings.data?.serverTimezone && (
          <div className="flex items-start gap-3 rounded-lg border border-info/40 bg-info/10 p-3 text-sm">
            <AlarmClock className="mt-0.5 h-4 w-4 shrink-0 text-info" />
            <div className="flex-1">
              <p className="font-semibold">
                Reminder hours fire in <span className="text-info">{settings.data.serverTimezone}</span>{" "}
                <span className="text-xs font-normal text-muted-foreground">({settings.data.serverUtcOffset})</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Set in the API's <code className="rounded bg-background/60 px-1">TZ</code> env var. Restart the API after changing it.
              </p>
            </div>
          </div>
        )}
        {settings.isLoading && (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        )}
        {!settings.isLoading && settings.data && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="daily-hour" className="flex items-center justify-between">
                  <span>Daily reminder time</span>
                  <span className="text-xs font-normal text-muted-foreground">Mon–Fri only</span>
                </Label>
                <div className="flex gap-2">
                  <Select
                    value={String(draftDaily ?? settings.data.dailyReminderHour)}
                    onValueChange={(value) => setDraftDaily(parseInt(value, 10))}
                    disabled={readOnly}
                  >
                    <SelectTrigger id="daily-hour"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {HOURS_24.map((h) => (
                        <SelectItem key={h} value={String(h)}>{formatHour(h)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {dailyChanged && (
                    <Button
                      size="sm"
                      disabled={readOnly || update.isPending}
                      onClick={() => draftDaily !== null && update.mutate({ dailyReminderHour: draftDaily })}
                    >
                      <Save className="h-4 w-4" />Save
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Nudges every active employee who hasn't logged time for today.
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="esc-hour" className="flex items-center justify-between">
                  <span>Next-day escalation time</span>
                  <span className="text-xs font-normal text-muted-foreground">Mon–Fri only</span>
                </Label>
                <div className="flex gap-2">
                  <Select
                    value={String(draftEscalation ?? settings.data.escalationReminderHour)}
                    onValueChange={(value) => setDraftEscalation(parseInt(value, 10))}
                    disabled={readOnly}
                  >
                    <SelectTrigger id="esc-hour"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {HOURS_24.map((h) => (
                        <SelectItem key={h} value={String(h)}>{formatHour(h)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {escalationChanged && (
                    <Button
                      size="sm"
                      disabled={readOnly || update.isPending}
                      onClick={() => draftEscalation !== null && update.mutate({ escalationReminderHour: draftEscalation })}
                    >
                      <Save className="h-4 w-4" />Save
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  If yesterday's log is still missing, both employee and manager get a heads-up at this hour.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
              <div className="mt-1 grid h-8 w-8 place-items-center rounded-md bg-muted">
                <CalendarClock className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <Label htmlFor="weekdays-only" className={readOnly ? "" : "cursor-pointer"}>Weekdays only</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Skip Saturdays and Sundays. Recommended for office-based teams; turn off for 24/7 operations.
                </p>
              </div>
              <Switch
                id="weekdays-only"
                checked={settings.data.remindOnWeekdaysOnly}
                disabled={readOnly}
                onCheckedChange={(checked) => update.mutate({ remindOnWeekdaysOnly: checked })}
              />
            </div>

            <Alert variant="info">
              <AlarmClock />
              <AlertTitle>How the escalation chain works</AlertTitle>
              <AlertDescription>
                At <strong>{formatHour(settings.data.dailyReminderHour).split("  ")[0]}</strong> {settings.data.serverTimezone ? `${settings.data.serverTimezone}` : "local"} each weekday, anyone without a log entry today gets a reminder.
                If they still haven't logged by <strong>{formatHour(settings.data.escalationReminderHour).split("  ")[0]}</strong> the next business day, they receive a "this was escalated" follow-up and their manager is notified.
              </AlertDescription>
            </Alert>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Email channels — a category × role matrix.
 *
 * Two independent gates per cell, and the distinction matters when reading this:
 *  - the row's `Switch` is the category master (`GlobalNotificationSettings.emailDailyReminder`
 *    and friends). Off = nobody gets that email, whatever the ticks say.
 *  - each role `Checkbox` is the per-role audience (`emailRoleMutes`). Unticked = that role is
 *    muted for that category. Stored inverted (we persist the MUTES, not the ticks) so that a
 *    workspace which never opens this screen — and every category added after it shipped — keeps
 *    defaulting to "everyone", with no backfill.
 *
 * Both gate the EMAIL leg only; the in-app bell notification always fires. That's the property
 * that makes muting MANAGER/SUPER_ADMIN safe: an approver still SEES an escalation in the app,
 * they just stop getting a copy per employee per day in their inbox.
 */
function EmailChannelsCard({ readOnly }: { readOnly: boolean }) {
  const settings = useSettings();
  const update = useUpdate();

  const allOff = settings.data ? notificationPreferenceKeys.every((key) => !settings.data?.[key]) : false;
  const mutes: EmailRoleMutes = (settings.data?.emailRoleMutes as EmailRoleMutes | null) ?? {};

  /** Persist the whole map — see settings.controller.ts, which replaces rather than merges. */
  const saveMutes = (next: EmailRoleMutes) =>
    update.mutate({ emailRoleMutes: next } as Partial<GlobalSettings>);

  const toggleCell = (key: keyof NotificationPreferences, role: RoleName, receives: boolean) => {
    const current = mutes[key] ?? [];
    const next = receives ? current.filter((r) => r !== role) : Array.from(new Set([...current, role]));
    saveMutes({ ...mutes, [key]: next });
  };

  /** Column header acts as select-all/none for that role across every category. */
  const toggleColumn = (role: RoleName, receivesAll: boolean) => {
    const next: EmailRoleMutes = { ...mutes };
    for (const row of emailRows) {
      const current = next[row.key] ?? [];
      next[row.key] = receivesAll ? current.filter((r) => r !== role) : Array.from(new Set([...current, role]));
    }
    saveMutes(next);
  };

  const columnFullyOn = (role: RoleName) => emailRows.every((row) => !isEmailRoleMuted(mutes, row.key, role));

  // Collapsed sections are held as a set of what's CLOSED, so a group added later opens by
  // default rather than being invisible until someone thinks to look for it.
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<ToggleRow["group"]>>(new Set());
  const toggleGroup = (group: ToggleRow["group"]) =>
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (!next.delete(group)) next.add(group);
      return next;
    });

  /** How many cells in a group are muted — the one fact worth surfacing on a collapsed header,
   *  since a closed section that is silently muting mail is exactly what this screen exists to
   *  prevent. `0` renders nothing rather than a "0 muted" badge nobody needs to read. */
  const mutedCountIn = (group: ToggleRow["group"]) =>
    emailRows
      .filter((row) => row.group === group)
      .reduce((total, row) => total + MATRIX_ROLES.filter((c) => isEmailRoleMuted(mutes, row.key, c.role)).length, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-primary" />
          Email channels
        </CardTitle>
        <CardDescription>
          Which roles receive which emails. The switch turns a category off for everyone; the ticks choose the audience
          within it. In-app alerts always fire — this screen only mutes outbound email.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {allOff && !settings.isLoading && (
          <Alert variant="warning">
            <ShieldAlert />
            <AlertTitle>All email channels are off</AlertTitle>
            <AlertDescription>No outbound email will be sent. Users will still see in-app alerts in the bell menu.</AlertDescription>
          </Alert>
        )}

        {settings.isLoading && (
          <div className="grid gap-3 rounded-lg border border-border p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={`s-${i}`} className="flex items-center gap-4">
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-40" />
              </div>
            ))}
          </div>
        )}

        {!settings.isLoading && (
          // Horizontal scroll is contained HERE rather than on the page: seven columns cannot fit
          // a phone, and letting the page scroll sideways breaks every other card on the tab.
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th
                    scope="col"
                    className="sticky left-0 z-10 bg-muted/40 px-4 py-2 text-left align-bottom font-semibold backdrop-blur"
                  >
                    Email template
                  </th>
                  <th scope="col" className="w-16 px-2 py-2 text-center align-bottom text-xs font-semibold">
                    On
                  </th>
                  <th
                    scope="colgroup"
                    colSpan={MATRIX_ROLES.length}
                    className="border-l border-border px-2 pt-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Roles that receive it
                  </th>
                </tr>
                <tr className="border-b border-border bg-muted/20">
                  <th scope="col" className="sticky left-0 z-10 bg-muted/20 px-4 py-2" />
                  <th scope="col" className="px-2 py-2" />
                  {MATRIX_ROLES.map((column, index) => {
                    const fullyOn = columnFullyOn(column.role);
                    return (
                      <th
                        key={column.role}
                        scope="col"
                        className={`w-24 px-2 py-2 text-center text-xs font-semibold ${index === 0 ? "border-l border-border" : ""}`}
                      >
                        <button
                          type="button"
                          disabled={readOnly}
                          onClick={() => toggleColumn(column.role, !fullyOn)}
                          title={`${fullyOn ? "Mute" : "Unmute"} every category for ${column.label}`}
                          className="focus-ring rounded px-1 py-0.5 leading-tight transition hover:text-primary disabled:cursor-not-allowed disabled:hover:text-inherit"
                        >
                          <span className="hidden sm:inline">{column.label}</span>
                          <span className="sm:hidden">{column.short}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {EMAIL_GROUP_ORDER.flatMap((group) => {
                  const rowsInGroup = emailRows.filter((row) => row.group === group);
                  if (rowsInGroup.length === 0) return [];
                  const collapsed = collapsedGroups.has(group);
                  const mutedInGroup = mutedCountIn(group);
                  return [
                    <tr key={`group-${group}`} className="bg-muted/40">
                      {/* Not sticky, unlike the data rows' first cell: this cell already spans the
                          full table width, so pinning it left would only risk it ghosting over the
                          columns scrolling beneath a translucent background.

                          Collapsing hides rows inside ONE table rather than giving each group its
                          own — separate tables would size their columns independently, and a
                          matrix whose role columns stop lining up between sections is unreadable. */}
                      <th scope="colgroup" colSpan={2 + MATRIX_ROLES.length} className="p-0">
                        <button
                          type="button"
                          onClick={() => toggleGroup(group)}
                          aria-expanded={!collapsed}
                          className="focus-ring flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
                        >
                          <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
                          <span>{group}</span>
                          <span className="font-normal normal-case text-muted-foreground/70">
                            {rowsInGroup.length} {rowsInGroup.length === 1 ? "email" : "emails"}
                          </span>
                          {mutedInGroup > 0 && (
                            <Badge variant="muted" className="ml-auto font-normal normal-case">
                              {mutedInGroup} muted
                            </Badge>
                          )}
                        </button>
                      </th>
                    </tr>,
                    ...(collapsed ? [] : rowsInGroup.map((row) => {
                  const enabled = Boolean(settings.data?.[row.key]);
                  const inputId = `gns-${row.key}`;
                  const isUpdatingThis =
                    update.isPending && update.variables && Object.prototype.hasOwnProperty.call(update.variables, row.key);
                  // No zebra striping: the frozen first column has to be OPAQUE to occlude the
                  // cells sliding under it, which rules out the usual translucent `bg-muted/10`
                  // stripe — an opaque stripe that matched would have to be repeated here by
                  // index anyway, since a `even:` variant on the cell keys off its position among
                  // siblings (always 1st), not the row's. `divide-y` carries row separation.
                  return (
                    <tr key={row.key} className="align-top">
                      <th scope="row" className="sticky left-0 z-10 max-w-sm bg-background px-4 py-3 text-left font-normal">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted">{row.icon}</div>
                          <div className="min-w-0">
                            <Label htmlFor={inputId} className={readOnly ? "" : "cursor-pointer"}>
                              {row.label}
                            </Label>
                            <p className="mt-0.5 text-xs font-normal text-muted-foreground">{row.description}</p>
                          </div>
                        </div>
                      </th>
                      <td className="px-2 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {isUpdatingThis && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                          <Switch
                            id={inputId}
                            checked={enabled}
                            disabled={readOnly}
                            onCheckedChange={(value) => update.mutate({ [row.key]: value } as Partial<GlobalSettings>)}
                            aria-label={`${row.label} — email on or off for everyone`}
                          />
                        </div>
                      </td>
                      {MATRIX_ROLES.map((column, index) => {
                        const receives = !isEmailRoleMuted(mutes, row.key, column.role);
                        return (
                          <td
                            key={column.role}
                            className={`px-2 py-3 text-center ${index === 0 ? "border-l border-border" : ""}`}
                          >
                            <Checkbox
                              className="mx-auto"
                              // Greyed, not hidden, when the master switch is off: the audience is
                              // still meaningful config, it just isn't reachable until the category
                              // is on — and hiding it would read as "this row has no roles".
                              disabled={readOnly || !enabled}
                              checked={receives}
                              onCheckedChange={(value) => toggleCell(row.key, column.role, value === true)}
                              aria-label={`${column.label} receives ${row.label}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                    }))
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}

        {!settings.isLoading && (
          <div className="rounded-lg border border-dashed border-border p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Always sent</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Direct replies to an action someone just took. These have no toggle and no audience — they go to one
              specific person, and a role filter over a password reset would lock people out of the app.
            </p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-3">
              {ALWAYS_SENT_ROWS.map((row) => (
                <li key={row.label} className="flex items-start gap-2">
                  <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{row.label}</p>
                    <p className="text-xs text-muted-foreground">{row.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Tip: click a role name to mute or unmute that whole column. Managers and super admins normally approve time
          rather than log it, so muting them on the two reminder rows removes the bulk of their inbox traffic without
          touching escalations they still need.
        </p>
      </CardContent>
    </Card>
  );
}

function BccAndFormsCard({ readOnly }: { readOnly: boolean }) {
  const settings = useSettings();
  const update = useUpdate();
  const [formConfig, setFormConfig] = useState({
    maxDailyHours: "12",
    approval: "Manager approval",
    mandatory: "Project, activity, date, time, task"
  });

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MailCheck className="h-4 w-4 text-primary" />
            BCC behavior
          </CardTitle>
          <CardDescription>
            Optionally BCC every active super admin on outbound transactional email. Useful for compliance & training visibility.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
            <div className="mt-1 grid h-8 w-8 place-items-center rounded-md bg-muted">
              <ShieldCheck className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <Label htmlFor="bcc-admin" className={readOnly ? "" : "cursor-pointer"}>
                BCC super admin on all outbound emails
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                When enabled, every welcome / reset / submission / approval / SLA / reminder email also delivers a silent copy to each
                active super admin. The recipient never sees the BCC list.
              </p>
            </div>
            {settings.isLoading ? (
              <Skeleton className="h-6 w-11 rounded-full" />
            ) : (
              <Switch
                id="bcc-admin"
                checked={Boolean(settings.data?.bccSuperAdminOnAllEmails)}
                disabled={readOnly}
                onCheckedChange={(checked) => update.mutate({ bccSuperAdminOnAllEmails: checked })}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Timesheet validation</CardTitle>
          <CardDescription>Applies to every new timesheet across the workspace.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Max daily hours</Label>
              <Input value={formConfig.maxDailyHours} onChange={(e) => setFormConfig({ ...formConfig, maxDailyHours: e.target.value })} disabled={readOnly} />
            </div>
            <div className="grid gap-1.5">
              <Label>Approval workflow</Label>
              <Input value={formConfig.approval} onChange={(e) => setFormConfig({ ...formConfig, approval: e.target.value })} disabled={readOnly} />
            </div>
            <div className="grid gap-1.5">
              <Label>Mandatory fields</Label>
              <Input value={formConfig.mandatory} onChange={(e) => setFormConfig({ ...formConfig, mandatory: e.target.value })} disabled={readOnly} />
            </div>
          </div>
          <Button
            disabled={readOnly}
            className="self-start"
            onClick={() => toast.success("Configuration saved", { description: "Persisted locally for this demo build." })}
          >
            <Save />Save configuration
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function TicketingSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "ticketing"], queryFn: settingsApi.getTicketing });
  const [sla, setSla] = useState<Pick<GlobalTicketSettings, "slaLowHours" | "slaMediumHours" | "slaHighHours" | "slaCriticalHours"> | null>(null);

  useEffect(() => {
    if (settings.data) {
      setSla({
        slaLowHours: settings.data.slaLowHours,
        slaMediumHours: settings.data.slaMediumHours,
        slaHighHours: settings.data.slaHighHours,
        slaCriticalHours: settings.data.slaCriticalHours
      });
    }
  }, [settings.data]);

  const update = useMutation({
    mutationFn: (payload: Partial<GlobalTicketSettings>) => settingsApi.updateTicketing(payload),
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["settings", "ticketing"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const types = useQuery({ queryKey: ["ticket-types", "all"], queryFn: () => ticketTypeApi.list(true) });
  const [newType, setNewType] = useState({ name: "", color: "#3B82F6" });
  const createType = useMutation({
    mutationFn: () => ticketTypeApi.create(newType),
    onSuccess: () => {
      toast.success("Type added");
      setNewType({ name: "", color: "#3B82F6" });
      queryClient.invalidateQueries({ queryKey: ["ticket-types"] });
    },
    onError: (err: any) => toast.error("Could not add type", { description: err?.response?.data?.message ?? "Try again." })
  });
  const toggleType = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => ticketTypeApi.update(id, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ticket-types"] }),
    onError: (err: any) => toast.error("Could not update type", { description: err?.response?.data?.message ?? "Try again." })
  });

  const labels = useQuery({ queryKey: ["labels"], queryFn: labelApi.list });
  const [newLabel, setNewLabel] = useState({ name: "", color: "#8B5CF6" });
  const createLabel = useMutation({
    mutationFn: () => labelApi.create(newLabel),
    onSuccess: () => {
      toast.success("Label added");
      setNewLabel({ name: "", color: "#8B5CF6" });
      queryClient.invalidateQueries({ queryKey: ["labels"] });
    },
    onError: (err: any) => toast.error("Could not add label", { description: err?.response?.data?.message ?? "Try again." })
  });
  const removeLabel = useMutation({
    mutationFn: (id: string) => labelApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["labels"] }),
    onError: (err: any) => toast.error("Could not remove label", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Timer className="h-4 w-4 text-primary" />
            Ticket SLA hours
          </CardTitle>
          <CardDescription>
            How many hours a ticket has to be resolved before it's flagged overdue and escalated, by priority.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {(settings.isLoading || !sla) ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <div className="grid gap-1.5">
                  <Label>Low</Label>
                  <Input type="number" min={1} value={sla.slaLowHours} disabled={readOnly} onChange={(e) => setSla({ ...sla, slaLowHours: Number(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Medium</Label>
                  <Input type="number" min={1} value={sla.slaMediumHours} disabled={readOnly} onChange={(e) => setSla({ ...sla, slaMediumHours: Number(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label>High</Label>
                  <Input type="number" min={1} value={sla.slaHighHours} disabled={readOnly} onChange={(e) => setSla({ ...sla, slaHighHours: Number(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Critical</Label>
                  <Input type="number" min={1} value={sla.slaCriticalHours} disabled={readOnly} onChange={(e) => setSla({ ...sla, slaCriticalHours: Number(e.target.value) })} />
                </div>
              </div>
              {!readOnly && (
                <Button size="sm" className="justify-self-start" disabled={update.isPending} onClick={() => sla && update.mutate(sla)}>
                  <Save className="h-4 w-4" />Save SLA hours
                </Button>
              )}
              <Separator />
              <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex-1">
                  <Label>Cost analytics</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Requires hourly rates on user profiles. Off by default.</p>
                </div>
                <Switch checked={settings.data?.enableCostAnalytics ?? false} disabled={readOnly} onCheckedChange={(v) => update.mutate({ enableCostAnalytics: v })} />
              </div>
              <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex-1">
                  <Label>Team leaderboard</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Resolved-ticket rankings on the Insights page. Off by default.</p>
                </div>
                <Switch checked={settings.data?.enableLeaderboard ?? false} disabled={readOnly} onCheckedChange={(v) => update.mutate({ enableLeaderboard: v })} />
              </div>
              <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex-1">
                  <Label>Block resolve on failing CI</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    A ticket can't move to Resolved while its latest ingested test run (Security & DevOps webhook) is
                    failing. Off by default — has no effect until your CI actually posts test runs.
                  </p>
                </div>
                <Switch
                  checked={settings.data?.blockResolveOnFailingTests ?? false}
                  disabled={readOnly}
                  onCheckedChange={(v) => update.mutate({ blockResolveOnFailingTests: v })}
                />
              </div>

              <Separator />
              <div className="grid gap-1.5">
                <Label className="text-sm font-semibold">Malware scanning on upload</Label>
                <p className="text-xs text-muted-foreground">
                  Every file is checked before it is stored — attachments, avatars, workspace logos, imported
                  requirements documents, and the attachments that arrive by email. Nothing is written anywhere
                  reachable until it comes back clean.
                </p>
              </div>
              <VirusScanToggle
                enabled={settings.data?.virusScanEnabled ?? false}
                readOnly={readOnly}
                onToggle={(v) => update.mutate({ virusScanEnabled: v })}
              />

              <Separator />
              <div className="grid gap-1.5">
                <Label className="text-sm font-semibold">Verified work attestations</Label>
                <p className="text-xs text-muted-foreground">
                  A client-facing record that approved hours map to real tickets, done by identity-verified people and approved by a
                  named manager — priced at the rate frozen when each entry was approved. Issued from the Reports page.
                </p>
              </div>
              <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex-1">
                  <Label>Enable attestations</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Off by default. Set a project's rate and client name under Projects → Billing so amounts appear on the artifact.
                  </p>
                </div>
                <Switch
                  checked={settings.data?.enableAttestations ?? false}
                  disabled={readOnly}
                  onCheckedChange={(v) => update.mutate({ enableAttestations: v })}
                />
              </div>
              <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex-1">
                  <Label>Allow public share links</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Lets a super admin mint an expiring, revocable public URL so a client can verify an attestation without an
                    account. Deliberately separate from the toggle above — publishing to an unauthenticated URL is a different
                    decision from producing an internal artifact. Off by default.
                  </p>
                </div>
                <Switch
                  checked={settings.data?.enableAttestationSharing ?? false}
                  disabled={readOnly || !(settings.data?.enableAttestations ?? false)}
                  onCheckedChange={(v) => update.mutate({ enableAttestationSharing: v })}
                />
              </div>
              <div className="grid gap-1.5 sm:max-w-xs">
                <Label htmlFor="attestation-currency">Default currency</Label>
                <Input
                  id="attestation-currency"
                  value={settings.data?.defaultCurrency ?? "USD"}
                  maxLength={3}
                  disabled={readOnly}
                  onChange={(e) => update.mutate({ defaultCurrency: e.target.value.toUpperCase() })}
                />
                <p className="text-xs text-muted-foreground">
                  ISO-4217 code, used when a project sets no currency of its own. An attestation refuses to mix currencies in one
                  period rather than silently summing them.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ticket types</CardTitle>
          <CardDescription>Bug/Task/Improvement are seeded defaults — add your own or retire ones you don't use.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!readOnly && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <Label className="text-xs">Name</Label>
                <Input className="w-48" value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} placeholder="e.g. Support Request" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Color</Label>
                <Input type="color" className="h-9 w-14 p-1" value={newType.color} onChange={(e) => setNewType({ ...newType, color: e.target.value })} />
              </div>
              <Button size="sm" disabled={!newType.name.trim() || createType.isPending} onClick={() => createType.mutate()}>
                <Plus className="h-4 w-4" />Add type
              </Button>
            </div>
          )}
          <div className="divide-y divide-border rounded-lg border border-border">
            {(types.data ?? []).map((t) => (
              <div key={t.id} className="flex items-center gap-3 p-3">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: t.color ?? "#94A3B8" }} />
                <span className="flex-1 text-sm font-medium">{t.name}</span>
                <Badge variant={t.isActive ? "success" : "muted"}>{t.isActive ? "Active" : "Inactive"}</Badge>
                {!readOnly && <Switch checked={t.isActive} onCheckedChange={(v) => toggleType.mutate({ id: t.id, isActive: v })} />}
              </div>
            ))}
            {(types.data ?? []).length === 0 && <p className="p-3 text-sm text-muted-foreground">No ticket types yet.</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Labels</CardTitle>
          <CardDescription>Cross-cutting tags for tickets (e.g. "regression", "customer-reported").</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!readOnly && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <Label className="text-xs">Name</Label>
                <Input className="w-48" value={newLabel.name} onChange={(e) => setNewLabel({ ...newLabel, name: e.target.value })} placeholder="e.g. regression" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Color</Label>
                <Input type="color" className="h-9 w-14 p-1" value={newLabel.color} onChange={(e) => setNewLabel({ ...newLabel, color: e.target.value })} />
              </div>
              <Button size="sm" disabled={!newLabel.name.trim() || createLabel.isPending} onClick={() => createLabel.mutate()}>
                <Plus className="h-4 w-4" />Add label
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {(labels.data ?? []).map((l) => (
              <span key={l.id} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color ?? "#94A3B8" }} />
                {l.name}
                {!readOnly && (
                  <button type="button" onClick={() => removeLabel.mutate(l.id)} className="ml-1 text-muted-foreground hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
            {(labels.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">No labels yet.</p>}
          </div>
        </CardContent>
      </Card>

      <TicketRulesCard readOnly={readOnly} />
    </div>
  );
}

function TicketRulesCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ["settings", "ticket-rules"], queryFn: settingsApi.listTicketRules });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const users = useQuery({ queryKey: ["users"], queryFn: userApi.list });
  const labels = useQuery({ queryKey: ["labels"], queryFn: labelApi.list });

  const emptyDraft: TicketRuleInput = {
    name: "",
    conditionProjectId: null,
    conditionPriority: null,
    conditionSource: null,
    actionAssigneeId: null,
    actionLabelId: null,
    actionNotifyUserId: null
  };
  const [draft, setDraft] = useState<TicketRuleInput>(emptyDraft);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["settings", "ticket-rules"] });

  const create = useMutation({
    mutationFn: () => settingsApi.createTicketRule({ ...draft, order: rules.data?.length ?? 0 }),
    onSuccess: () => {
      toast.success("Rule added");
      setDraft(emptyDraft);
      invalidate();
    },
    onError: (err: any) => toast.error("Could not add rule", { description: err?.response?.data?.message ?? "Try again." })
  });
  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => settingsApi.updateTicketRule(id, { isActive }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not update rule", { description: "Try again." })
  });
  const remove = useMutation({
    mutationFn: (id: string) => settingsApi.deleteTicketRule(id),
    onSuccess: () => {
      toast.success("Rule deleted");
      invalidate();
    },
    onError: () => toast.error("Could not delete rule", { description: "Try again." })
  });

  const hasAnyAction = Boolean(draft.actionAssigneeId || draft.actionLabelId || draft.actionNotifyUserId);
  const hasAnyCondition = Boolean(draft.conditionProjectId || draft.conditionPriority || draft.conditionSource || draft.conditionSenderDomain);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-4 w-4 text-primary" />
          Automation rules
        </CardTitle>
        <CardDescription>
          If/then automation on manually-created tickets — the first rule (in order below) whose every condition matches gets its
          actions applied. Only runs when the creator didn't already pick an assignee themselves; a rule is a fallback default, not
          an override. Email/chat intake keep using their own existing routing rules.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {rules.isLoading && <Skeleton className="h-24 w-full" />}

        {!rules.isLoading && (
          <div className="grid gap-2">
            {(rules.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">No automation rules yet.</p>}
            {(rules.data ?? []).map((rule, index) => (
              <div key={rule.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground">#{index + 1}</span>
                    <p className="text-sm font-medium">{rule.name}</p>
                    {!rule.isActive && <Badge variant="muted">Inactive</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    If{" "}
                    {[
                      rule.conditionProject && `project = ${rule.conditionProject.name}`,
                      rule.conditionPriority && `priority = ${rule.conditionPriority}`,
                      rule.conditionSource && `source = ${rule.conditionSource}`,
                      rule.conditionSenderDomain && `sender domain = ${rule.conditionSenderDomain}`
                    ]
                      .filter(Boolean)
                      .join(" AND ") || "any ticket"}
                    {" → "}
                    {[
                      rule.actionAssignee && `assign to ${rule.actionAssignee.name}`,
                      rule.actionLabel && `label "${rule.actionLabel.name}"`,
                      rule.actionNotifyUser && `notify ${rule.actionNotifyUser.name}`
                    ]
                      .filter(Boolean)
                      .join(", ") || "no action"}
                  </p>
                </div>
                {!readOnly && (
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={rule.isActive}
                      onCheckedChange={(value) => toggleActive.mutate({ id: rule.id, isActive: value })}
                      disabled={toggleActive.isPending}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => remove.mutate(rule.id)}
                      disabled={remove.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!readOnly && (
          <>
            <Separator />
            <div className="grid gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">New rule</p>
              <div className="grid gap-1.5">
                <Label className="text-xs">Name</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Route payments bugs to Priya" />
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="grid gap-1.5">
                  <Label className="text-xs">If project</Label>
                  <Select value={draft.conditionProjectId ?? "__any__"} onValueChange={(v) => setDraft({ ...draft, conditionProjectId: v === "__any__" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__any__">Any</SelectItem>
                      {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">If priority</Label>
                  <Select value={draft.conditionPriority ?? "__any__"} onValueChange={(v) => setDraft({ ...draft, conditionPriority: v === "__any__" ? null : (v as TicketRuleInput["conditionPriority"]) })}>
                    <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__any__">Any</SelectItem>
                      {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">If source</Label>
                  <Select value={draft.conditionSource ?? "__any__"} onValueChange={(v) => setDraft({ ...draft, conditionSource: v === "__any__" ? null : (v as TicketRuleInput["conditionSource"]) })}>
                    <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__any__">Any</SelectItem>
                      {["MANUAL", "EMAIL", "API", "CHAT"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">If sender domain</Label>
                  <Input
                    value={draft.conditionSenderDomain ?? ""}
                    onChange={(e) => setDraft({ ...draft, conditionSenderDomain: e.target.value || null })}
                    placeholder="e.g. acme.com"
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Then assign to</Label>
                  <Select value={draft.actionAssigneeId ?? "__none__"} onValueChange={(v) => setDraft({ ...draft, actionAssigneeId: v === "__none__" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="No change" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No change</SelectItem>
                      {(users.data ?? []).map((u: any) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Then label</Label>
                  <Select value={draft.actionLabelId ?? "__none__"} onValueChange={(v) => setDraft({ ...draft, actionLabelId: v === "__none__" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="No label" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No label</SelectItem>
                      {(labels.data ?? []).map((l: any) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Then notify</Label>
                  <Select value={draft.actionNotifyUserId ?? "__none__"} onValueChange={(v) => setDraft({ ...draft, actionNotifyUserId: v === "__none__" ? null : v })}>
                    <SelectTrigger><SelectValue placeholder="No one" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No one</SelectItem>
                      {(users.data ?? []).map((u: any) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Button
                  size="sm"
                  disabled={!draft.name.trim() || !hasAnyAction || create.isPending}
                  onClick={() => create.mutate()}
                >
                  <Plus className="h-4 w-4" />Add rule
                </Button>
                {!hasAnyCondition && draft.name.trim() && (
                  <span className="ml-2 text-xs text-muted-foreground">No conditions set — this rule matches every ticket.</span>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A single Excel-export button for the AI usage table — one format, not the 3-way CSV/XLSX/PDF
 *  menu Change Management's register export has, since only Excel was asked for here. Downloads
 *  via an authenticated blob GET (settingsApi.downloadAiUsageExcel), never a bare `<a href>` —
 *  this app keeps its access token in memory, so a plain link would 401. Same dance as Changes.tsx's
 *  ExportMenu: createObjectURL, a programmatic click, then revokeObjectURL. */
function AiUsageExportButton({ range, feature }: { range: DateRangeValue; feature: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const { blob } = await settingsApi.downloadAiUsageExcel({ from: range.from, to: range.to, feature: feature || undefined });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `ai-usage-${range.from}-to-${range.to}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error("Could not export", { description: err?.response?.data?.message ?? "Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={run}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      Export .xlsx
    </Button>
  );
}

function AISettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "ai"], queryFn: settingsApi.getAI });

  // Defaults to the current calendar month — same window the card always showed before it could
  // be changed at all. `allowAllTime={false}` on the picker below keeps the range bounded: a spend
  // report over "all time" isn't a period anyone can act on.
  const [usageRange, setUsageRange] = useState<DateRangeValue>(() => {
    const now = new Date();
    return { from: localIso(new Date(now.getFullYear(), now.getMonth(), 1)), to: localIso(now) };
  });
  const [usageFeature, setUsageFeature] = useState<string>("");

  const usage = useQuery({
    queryKey: ["settings", "ai", "usage", usageRange.from, usageRange.to, usageFeature],
    queryFn: () => settingsApi.getAIUsageSummary({ from: usageRange.from, to: usageRange.to, feature: usageFeature || undefined }),
    enabled: Boolean(settings.data?.aiEnabled && usageRange.from && usageRange.to)
  });
  const usageTrend = useQuery({
    queryKey: ["settings", "ai", "usage-trend", usageRange.from, usageRange.to],
    queryFn: () => settingsApi.getAIUsageTrend({ from: usageRange.from, to: usageRange.to }),
    enabled: Boolean(settings.data?.aiEnabled && usageRange.from && usageRange.to)
  });

  const update = useMutation({
    mutationFn: (payload: Partial<GlobalAISettings> & { apiKey?: string }) => settingsApi.updateAI(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ["settings", "ai"] });
      const previous = queryClient.getQueryData<GlobalAISettings>(["settings", "ai"]);
      // apiKey is write-only and not part of the cached settings shape — don't spread it into
      // the optimistic cache update, or GlobalAISettings would gain a field it never actually has.
      // eslint-disable-next-line sonarjs/no-unused-vars -- rest-sibling omit pattern
      const { apiKey: _apiKey, ...optimistic } = payload;
      if (previous) queryClient.setQueryData(["settings", "ai"], { ...previous, ...optimistic });
      return { previous };
    },
    onError: (err: any, _payload, context) => {
      if (context?.previous) queryClient.setQueryData(["settings", "ai"], context.previous);
      toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "ai"] })
  });

  const [budgetDraft, setBudgetDraft] = useState("");
  useEffect(() => {
    if (settings.data) setBudgetDraft(settings.data.monthlyBudgetUsd != null ? String(settings.data.monthlyBudgetUsd) : "");
  }, [settings.data?.monthlyBudgetUsd]);

  const toggles: Array<{ key: keyof GlobalAISettings; label: string; description: string }> = [
    // ONLY the settings that are NOT a capability. Every per-capability switch moved into
    // AIAutonomyCard, where it sits beside that capability's autonomy level — the two answer
    // different questions about the same thing, and listing them separately made this tab look
    // like it held two copies of everything.
    //
    // What is left is data retention, which is genuinely a different subject: it governs what is
    // KEPT about an AI call, not what the call is allowed to do.
    { key: "autoTriageAutoApply", label: "Auto-apply triage suggestions (legacy)", description: "Pre-fills the suggestion instead of showing an accept/dismiss chip. This predates the autonomy ladder and means the same thing as setting Ticket triage to “Apply, reversible” above — leaving it on holds triage at that level. Prefer the capability setting; this stays so workspaces that already use it keep working." },
    { key: "aiCaptureEnabled", label: "Record AI quality metrics", description: "Logs one row per AI call — which feature, which model, whether the response parsed, and how long it took. No prompt text, no user content, just a hash. Without this there is no way to answer \"is our AI actually any good?\" — cost is the only AI signal the system otherwise keeps." },
    { key: "aiCaptureContentEnabled", label: "Also store prompts and responses", description: "Additionally keeps the prompt text, the model's answer, and the inputs it was given. This retains real user content (ticket descriptions, timesheet notes, PR diffs), so it's a deliberate privacy decision — but it's required before you can build a test set from real failures or compare one prompt against another. Face-verification prompts are never stored regardless of this setting." },
  ];

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            AI features
          </CardTitle>
          <CardDescription>
            Every AI feature stays off until you enable it here — nothing calls out to Anthropic otherwise.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings.isLoading && <Skeleton className="h-40 w-full" />}
          {!settings.isLoading && settings.data && (
            <>
              {!settings.data.apiKeyConfigured && (
                <Alert variant="warning">
                  <ShieldAlert />
                  <AlertTitle>No API key configured</AlertTitle>
                  <AlertDescription>
                    Set <code className="rounded bg-background/60 px-1">ANTHROPIC_API_KEY</code> in{" "}
                    <code className="rounded bg-background/60 px-1">apps/api/.env</code>, or add a provider below —
                    toggles will save either way, but nothing will actually run until a key is available.
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex items-start gap-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
                <div className="flex-1">
                  <Label>Enable AI features</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Master switch for everything below.</p>
                </div>
                <Switch checked={settings.data.aiEnabled} disabled={readOnly} onCheckedChange={(v) => update.mutate({ aiEnabled: v })} />
              </div>

              <div className="divide-y divide-border rounded-lg border border-border">
                {toggles.map((t) => (
                  <div key={t.key} className="flex items-start gap-4 p-4">
                    <div className="min-w-0 flex-1">
                      <Label className={readOnly ? "" : "cursor-pointer"}>{t.label}</Label>
                      <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
                    </div>
                    <Switch
                      checked={Boolean(settings.data?.[t.key])}
                      disabled={readOnly || !settings.data?.aiEnabled}
                      onCheckedChange={(v) => update.mutate({ [t.key]: v } as Partial<GlobalAISettings>)}
                    />
                  </div>
                ))}
              </div>

              <AIProviderListCard readOnly={readOnly} />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Confidence threshold</Label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.data.confidenceThreshold}
                    disabled={readOnly}
                    onChange={(e) => update.mutate({ confidenceThreshold: Number(e.target.value) })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Below this, AI-classified tickets are flagged "needs review" instead of auto-assigned.
                  </p>
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>Monthly budget (USD, optional)</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="No cap"
                    value={budgetDraft}
                    disabled={readOnly}
                    onChange={(e) => setBudgetDraft(e.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={readOnly}
                    onClick={() => update.mutate({ monthlyBudgetUsd: budgetDraft ? Number(budgetDraft) : null })}
                  >
                    <Save className="h-4 w-4" />Save
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  AI features pause gracefully once this month's estimated spend hits the cap.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {settings.data?.aiEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI usage</CardTitle>
            <CardDescription>
              Estimated cost and token consumption{usage.data ? ` from ${usage.data.from} to ${usage.data.to}` : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {usage.isLoading && <Skeleton className="h-20 w-full" />}
            {!usage.isLoading && usage.data && (
              <>
                <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Estimated spend</p>
                    <p className="mt-1 text-2xl font-black">${usage.data.totalCostUsd.toFixed(2)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">AI calls</p>
                    <p className="mt-1 text-2xl font-black">{usage.data.totalCalls}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Success rate</p>
                    <p className="mt-1 text-2xl font-black">
                      {usage.data.overallSuccessRatePct === null ? (
                        <span className="text-base font-normal text-muted-foreground">n/a</span>
                      ) : (
                        `${usage.data.overallSuccessRatePct}%`
                      )}
                    </p>
                    {usage.data.totalFailures > 0 && (
                      <p className="text-xs text-muted-foreground">{usage.data.totalFailures} failed attempt{usage.data.totalFailures === 1 ? "" : "s"}</p>
                    )}
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Input tokens</p>
                    <p className="mt-1 text-2xl font-black">{usage.data.totalInputTokens.toLocaleString()}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Output tokens</p>
                    <p className="mt-1 text-2xl font-black">{usage.data.totalOutputTokens.toLocaleString()}</p>
                  </div>
                </div>

                {/* The agent-driven share. Shown as "X of the total", never as its own total, because
                    it is a subset — presenting it as a separate figure would invite adding the two. */}
                <div className="rounded-lg border border-border bg-muted/20 p-4">
                  <p className="text-xs uppercase text-muted-foreground">Driven by AI teammates</p>
                  {usage.data.agentDriven.calls === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      None this month — every call above was made by a person using an AI feature directly.
                    </p>
                  ) : (
                    <p className="mt-1 text-sm">
                      <span className="text-2xl font-black">${usage.data.agentDriven.costUsd.toFixed(2)}</span>{" "}
                      <span className="text-muted-foreground">
                        of the ${usage.data.totalCostUsd.toFixed(2)} above, across {usage.data.agentDriven.calls} call
                        {usage.data.agentDriven.calls === 1 ? "" : "s"} and{" "}
                        {(usage.data.agentDriven.inputTokens + usage.data.agentDriven.outputTokens).toLocaleString()} tokens —
                        see <a className="underline" href="/app/agents">Agents</a> for which teammate.
                      </span>
                    </p>
                  )}
                </div>

                {/* Per-workflow spend. Read from the agent runs each flow queued rather than from the
                    usage log, which records what was asked of a model and not who composed the
                    question — said on its face, because it is a view from a different table and the
                    two will not add up to the penny. */}
                {usage.data.byFlow.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/20 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Spent by workflows</p>
                    <ul className="mt-2 space-y-1">
                      {usage.data.byFlow.map((flow) => (
                        <li key={flow.flowId} className="flex flex-wrap items-baseline gap-2 text-sm">
                          <span aria-hidden>{flow.emoji}</span>
                          <span className="font-medium">{flow.name}</span>
                          <span className="tabular-nums">${flow.costUsd.toFixed(2)}</span>
                          <span className="text-xs text-muted-foreground">
                            across {flow.runs} run{flow.runs === 1 ? "" : "s"}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Part of the teammate figure above, attributed through the runs each workflow queued — see{" "}
                      <a className="underline" href="/app/studio">
                        Workflows
                      </a>{" "}
                      for what they did.
                    </p>
                  </div>
                )}

                {usageTrend.data && usageTrend.data.providerNames.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Spend trend, by provider</p>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={usageTrend.data.weeks} margin={{ left: -20, right: 8 }}>
                          <CartesianGrid {...GRID_STYLE} vertical={false} />
                          <XAxis dataKey="weekStart" tickFormatter={formatWeek} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
                          <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => `$${v}`} />
                          <RTooltip {...TOOLTIP_STYLE} formatter={(v: number, name) => [`$${Number(v).toFixed(2)}`, name]} labelFormatter={formatWeek} />
                          {usageTrend.data.providerNames.map((provider, index) => (
                            <Bar key={provider} dataKey={provider} stackId="cost" fill={MODEL_COLORS[index % MODEL_COLORS.length]} radius={index === usageTrend.data.providerNames.length - 1 ? [4, 4, 0, 0] : undefined} />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider &amp; model breakdown</p>
                  </div>
                  <DataTable
                    columns={usageColumns}
                    data={usage.data.rows}
                    isLoading={usage.isLoading}
                    searchPlaceholder="Search provider or model..."
                    emptyMessage="No AI calls in this range."
                    toolbar={
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={usageFeature || "__all"} onValueChange={(v) => setUsageFeature(v === "__all" ? "" : v)}>
                          <SelectTrigger className="w-[180px]"><SelectValue placeholder="All features" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__all">All features</SelectItem>
                            {usage.data.features.map((f) => (
                              <SelectItem key={f.feature} value={f.feature}>
                                {f.feature} ({f.calls})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <DateRangePicker value={usageRange} onChange={setUsageRange} allowAllTime={false} className="w-auto" />
                        <AiUsageExportButton range={usageRange} feature={usageFeature} />
                      </div>
                    }
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Sits directly under the monthly total it explains: that card answers "what did we spend",
          this one answers "what is spending it". */}
      {settings.data?.aiEnabled && <AiFeatureUsagePanel />}

      {/* Placed above the quality/prompt/dataset cards because it answers the question people
          arrive at this tab asking once AI is on: not "how well is it doing" but "what is it
          allowed to do without me". */}
      <AIAutonomyCard
        readOnly={readOnly}
        aiEnabled={Boolean(settings.data?.aiEnabled)}
        settings={settings.data}
        onToggleFeature={(key, value) => update.mutate({ [key]: value } as never)}
      />

      {/* Directly under the ladder on purpose: you set how much authority a capability holds up
          there, and watch it actually used down here. Only when AI is on — with the master switch
          off nothing can be queued, and an empty panel would just raise questions. */}
      {settings.data?.aiEnabled && !readOnly && <AgentRunsCard />}

      <AIQualityCard enabled={Boolean(settings.data?.aiEnabled)} captureOn={Boolean(settings.data?.aiCaptureEnabled)} />

      <AIPromptsCard readOnly={readOnly} />

      <AIDatasetsCard readOnly={readOnly} contentCaptureOn={Boolean(settings.data?.aiCaptureContentEnabled)} />

      <AIEvalsCard />
    </div>
  );
}

/** Formats a 0–1 rate as a percentage, or an em dash when there's honestly nothing to report. */
function pct(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * AI QUALITY — deliberately separate from the spend card above, because cost and correctness are
 * different questions and this product could previously only answer the first one.
 *
 * The ordering here is the point: parse-failure rate leads because it's objective and covers every
 * structured call, and every human-derived number is shown next to its coverage so nobody reads
 * "80% positive" from eight ratings as if it meant something.
 */
function AIQualityCard({ enabled, captureOn }: { enabled: boolean; captureOn: boolean }) {
  const quality = useQuery({
    queryKey: ["settings", "ai", "quality"],
    queryFn: () => settingsApi.getAIQualitySummary(30),
    enabled: enabled && captureOn
  });

  if (!enabled) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          AI quality
        </CardTitle>
        <CardDescription>
          How well the AI is actually performing, as opposed to what it costs. Last 30 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!captureOn && (
          <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            Turn on <strong>Record AI quality metrics</strong> above to start measuring this. Until then the only thing recorded
            about your AI is what it costs.
          </p>
        )}

        {captureOn && quality.isLoading && <Skeleton className="h-32 w-full" />}

        {captureOn && quality.data && (
          <>
            {quality.data.totalInteractions === 0 && (
              <p className="text-sm text-muted-foreground">No AI calls recorded yet in this window.</p>
            )}

            {quality.data.totalInteractions > 0 && (
              <>
                <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3">
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Unusable responses</p>
                    <p className="mt-1 text-2xl font-black">{pct(quality.data.overallParseFailureRate)}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">Failed to match the expected format</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">AI calls</p>
                    <p className="mt-1 text-2xl font-black">{quality.data.totalInteractions}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Legacy ticket ratings</p>
                    <p className="mt-1 text-2xl font-black">
                      {quality.data.legacyTicketFeedback.up}/{quality.data.legacyTicketFeedback.up + quality.data.legacyTicketFeedback.down}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">Older per-ticket thumbs, counted separately</p>
                  </div>
                </div>

                {/*
                  What people did with AI-authored change sets. This is a better signal than the
                  thumbs beside it and worth showing next to them: a rating only happens when
                  somebody chooses to leave one, whereas every reviewed proposal produces a decision
                  on every row as a by-product of ordinary work.

                  Undone is shown apart from rejected on purpose. Rejecting is "I read this and
                  disagreed"; undoing is "I let it happen and then took it back", which is worse and
                  should not be hidden inside the same number.
                */}
                {quality.data.proposalDecisions.length > 0 && (
                  <div className="rounded-lg border border-border p-4">
                    <p className="text-xs uppercase text-muted-foreground">What people did with AI suggestions</p>
                    <p className="mb-3 mt-0.5 text-[11px] text-muted-foreground">
                      Per change row, not per AI call — so these are not comparable with the numbers above. Refused means the
                      row was left alone because somebody had already changed it, which is the safeguard working rather than a
                      bad suggestion.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {quality.data.proposalDecisions.map((d) => (
                        <div key={d.kind} className="rounded-md border border-border bg-muted/20 p-3">
                          <p className="text-xs font-medium">{d.kind.replaceAll("_", " ").toLowerCase()}</p>
                          <p className="mt-1 text-sm">
                            <span className="font-semibold text-success">{d.accepted}</span> kept ·{" "}
                            <span className="font-semibold">{d.rejected}</span> rejected ·{" "}
                            <span className="font-semibold text-warning-foreground">{d.undone}</span> undone
                            {d.refused > 0 && <span className="text-muted-foreground"> · {d.refused} refused</span>}
                          </p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {d.acceptRate === null
                              ? "Too few decisions to read a rate into yet"
                              : `${Math.round(d.acceptRate * 100)}% of decided rows were kept`}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* The honesty note. Without it, the thumbs column below invites exactly the wrong
                    conclusion. */}
                <p className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  <strong>Unusable-response rate is the number to trust.</strong> It's measured automatically on every structured
                  call. Thumbs ratings only come from people who chose to leave one — check the coverage column before reading
                  anything into them, and note that a bad result is far likelier to get rated than a good one.
                </p>

                <div className="grid gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">By feature — worst first</p>
                  {/* Stacked cards below sm, table above — the same fallback DataTable uses. */}
                  <div className="grid gap-1.5 sm:hidden">
                    {quality.data.features.map((f) => (
                      <div key={f.feature} className="grid gap-1 rounded-lg border border-border bg-card p-3 text-sm shadow-sm">
                        <span className="font-medium">{f.feature}</span>
                        <span className="text-xs text-muted-foreground">
                          {f.interactions} calls · unusable {pct(f.parseFailureRate)} · rated {f.rated} ({pct(f.coverage)} coverage)
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="hidden overflow-x-auto rounded-lg border border-border sm:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                          <th className="p-2.5 font-semibold">Feature</th>
                          <th className="p-2.5 font-semibold">Calls</th>
                          <th className="p-2.5 font-semibold">Unusable</th>
                          <th className="p-2.5 font-semibold">Rated (coverage)</th>
                          <th className="p-2.5 font-semibold">Thumbs up</th>
                          <th className="p-2.5 font-semibold">Avg latency</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {quality.data.features.map((f) => (
                          <tr key={f.feature}>
                            <td className="p-2.5 font-medium">{f.feature}</td>
                            <td className="p-2.5 text-muted-foreground">{f.interactions}</td>
                            <td className="p-2.5">
                              {f.parseFailureRate == null ? (
                                <span className="text-muted-foreground">n/a</span>
                              ) : (
                                <span className={f.parseFailureRate > 0.05 ? "font-semibold text-destructive" : "text-success"}>
                                  {pct(f.parseFailureRate)}
                                </span>
                              )}
                            </td>
                            <td className="p-2.5 text-muted-foreground">
                              {f.rated} ({pct(f.coverage)})
                            </td>
                            <td className="p-2.5 text-muted-foreground">
                              {/* Suppressed below 10 ratings rather than shown as a confident-looking
                                  percentage derived from a handful of clicks. */}
                              {f.thumbsUpRate == null ? <span title="Too few ratings to be meaningful">—</span> : pct(f.thumbsUpRate)}
                            </td>
                            <td className="p-2.5 text-muted-foreground">{f.avgLatencyMs != null ? `${f.avgLatencyMs}ms` : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface ConnectionDraft {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  pollIntervalMinutes: number;
  fallbackProjectId: string;
}

function EmailIntakeSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "email-intake"], queryFn: emailIntakeApi.getSettings });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const users = useQuery({ queryKey: ["users"], queryFn: userApi.list });
  const routingRules = useQuery({ queryKey: ["email-intake", "routing-rules"], queryFn: emailIntakeApi.routingRules.list });
  const assigneeRules = useQuery({ queryKey: ["email-intake", "assignee-rules"], queryFn: emailIntakeApi.assigneeRules.list });

  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  useEffect(() => {
    if (settings.data) {
      setDraft({
        imapHost: settings.data.imapHost ?? "",
        imapPort: settings.data.imapPort,
        imapSecure: settings.data.imapSecure,
        imapUser: settings.data.imapUser ?? "",
        imapPassword: "",
        pollIntervalMinutes: settings.data.pollIntervalMinutes,
        fallbackProjectId: settings.data.fallbackProjectId ?? ""
      });
    }
  }, [settings.data]);

  const update = useMutation({
    mutationFn: () =>
      emailIntakeApi.updateSettings({
        imapHost: draft!.imapHost || null,
        imapPort: draft!.imapPort,
        imapSecure: draft!.imapSecure,
        imapUser: draft!.imapUser || null,
        imapPassword: draft!.imapPassword || undefined,
        pollIntervalMinutes: draft!.pollIntervalMinutes,
        fallbackProjectId: draft!.fallbackProjectId || null
      }),
    onSuccess: () => {
      toast.success("Saved");
      setDraft((d) => (d ? { ...d, imapPassword: "" } : d));
      queryClient.invalidateQueries({ queryKey: ["settings", "email-intake"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const testConnection = useMutation({
    mutationFn: () =>
      emailIntakeApi.testConnection(
        draft
          ? {
              host: draft.imapHost || undefined,
              port: draft.imapPort,
              secure: draft.imapSecure,
              user: draft.imapUser || undefined,
              password: draft.imapPassword || undefined
            }
          : undefined
      ),
    onSuccess: (res) => {
      if (res.ok) toast.success("Connection succeeded");
      else toast.error("Connection failed", { description: res.error });
    },
    onError: (err: any) => toast.error("Could not test connection", { description: err?.response?.data?.message ?? "Try again." })
  });

  const [newRule, setNewRule] = useState({ matchType: "TO_ADDRESS" as EmailMatchType, matchValue: "", projectId: "", defaultModuleId: "" });
  const createRule = useMutation({
    mutationFn: () =>
      emailIntakeApi.routingRules.create({
        matchType: newRule.matchType,
        matchValue: newRule.matchValue,
        projectId: newRule.projectId,
        defaultModuleId: newRule.defaultModuleId || undefined
      }),
    onSuccess: () => {
      toast.success("Routing rule added");
      setNewRule({ matchType: "TO_ADDRESS", matchValue: "", projectId: "", defaultModuleId: "" });
      queryClient.invalidateQueries({ queryKey: ["email-intake", "routing-rules"] });
    },
    onError: (err: any) => toast.error("Could not add rule", { description: err?.response?.data?.message ?? "Try again." })
  });
  const toggleRule = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => emailIntakeApi.routingRules.update(id, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["email-intake", "routing-rules"] }),
    onError: (err: any) => toast.error("Could not update rule", { description: err?.response?.data?.message ?? "Try again." })
  });
  const removeRule = useMutation({
    mutationFn: (id: string) => emailIntakeApi.routingRules.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["email-intake", "routing-rules"] }),
    onError: (err: any) => toast.error("Could not remove rule", { description: err?.response?.data?.message ?? "Try again." })
  });

  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ matchType: "TO_ADDRESS" as EmailMatchType, matchValue: "", projectId: "", defaultModuleId: "" });
  function startEditRule(rule: { id: string; matchType: EmailMatchType; matchValue: string; projectId: string; defaultModuleId: string | null }) {
    setEditingRuleId(rule.id);
    setEditDraft({ matchType: rule.matchType, matchValue: rule.matchValue, projectId: rule.projectId, defaultModuleId: rule.defaultModuleId ?? "" });
  }
  const saveEditRule = useMutation({
    mutationFn: () =>
      emailIntakeApi.routingRules.update(editingRuleId as string, {
        matchType: editDraft.matchType,
        matchValue: editDraft.matchValue,
        projectId: editDraft.projectId,
        defaultModuleId: editDraft.defaultModuleId || null
      }),
    onSuccess: () => {
      toast.success("Routing rule updated");
      setEditingRuleId(null);
      queryClient.invalidateQueries({ queryKey: ["email-intake", "routing-rules"] });
    },
    onError: (err: any) => toast.error("Could not update rule", { description: err?.response?.data?.message ?? "Try again." })
  });

  const [newAssignee, setNewAssignee] = useState({ projectId: "", moduleId: "", defaultAssigneeId: "" });
  const selectedProjectForAssignee = (projects.data ?? []).find((p: any) => p.id === newAssignee.projectId);
  const saveAssigneeRule = useMutation({
    mutationFn: () => emailIntakeApi.assigneeRules.save({ moduleId: newAssignee.moduleId, defaultAssigneeId: newAssignee.defaultAssigneeId }),
    onSuccess: () => {
      toast.success("Assignee rule saved");
      setNewAssignee({ projectId: "", moduleId: "", defaultAssigneeId: "" });
      queryClient.invalidateQueries({ queryKey: ["email-intake", "assignee-rules"] });
    },
    onError: (err: any) => toast.error("Could not save rule", { description: err?.response?.data?.message ?? "Try again." })
  });
  const removeAssigneeRule = useMutation({
    mutationFn: (id: string) => emailIntakeApi.assigneeRules.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["email-intake", "assignee-rules"] }),
    onError: (err: any) => toast.error("Could not remove rule", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {/* The IMAP mark, which is the inbound half of the pair whose outbound half sits on
                the Mail server tab — see connector-marks.tsx. */}
            <ImapMark className="h-4 w-4 text-primary" />
            Mailbox connection
          </CardTitle>
          <CardDescription>
            IMAP mailbox polled for inbound bug-report emails. Master switch is the "Email-to-ticket intake" toggle on the AI tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings.isLoading || !draft ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              {settings.data?.lastPollError && (
                <Alert variant="destructive">
                  <ShieldAlert />
                  <AlertTitle>Last poll failed</AlertTitle>
                  <AlertDescription>{settings.data.lastPollError}</AlertDescription>
                </Alert>
              )}
              {settings.data?.lastPolledAt && !settings.data.lastPollError && (
                <p className="text-xs text-muted-foreground">Last polled {new Date(settings.data.lastPolledAt).toLocaleString()}</p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>IMAP host</Label>
                  <Input value={draft.imapHost} disabled={readOnly} onChange={(e) => setDraft({ ...draft, imapHost: e.target.value })} placeholder="imap.gmail.com" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Port</Label>
                  <Input type="number" value={draft.imapPort} disabled={readOnly} onChange={(e) => setDraft({ ...draft, imapPort: Number(e.target.value) })} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Username</Label>
                  <Input value={draft.imapUser} disabled={readOnly} onChange={(e) => setDraft({ ...draft, imapUser: e.target.value })} placeholder="bugs@yourcompany.com" />
                </div>
                <div className="grid gap-1.5">
                  <Label>
                    Password / app password{" "}
                    {settings.data?.imapPasswordSet && <span className="font-normal text-muted-foreground">(saved — leave blank to keep)</span>}
                  </Label>
                  <Input
                    type="password"
                    value={draft.imapPassword}
                    disabled={readOnly}
                    onChange={(e) => setDraft({ ...draft, imapPassword: e.target.value })}
                    placeholder={settings.data?.imapPasswordSet ? "••••••••" : ""}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Poll interval (minutes)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={draft.pollIntervalMinutes}
                    disabled={readOnly}
                    onChange={(e) => setDraft({ ...draft, pollIntervalMinutes: Number(e.target.value) })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>
                    Fallback project <span className="text-muted-foreground">(no routing rule match)</span>
                  </Label>
                  <Select
                    value={draft.fallbackProjectId || "none"}
                    onValueChange={(v) => setDraft({ ...draft, fallbackProjectId: v === "none" ? "" : v })}
                    disabled={readOnly}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None — drop unmatched mail</SelectItem>
                      {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex-1">
                  <Label>Use TLS (secure)</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Almost always on for port 993.</p>
                </div>
                <Switch checked={draft.imapSecure} disabled={readOnly} onCheckedChange={(v) => setDraft({ ...draft, imapSecure: v })} />
              </div>
              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={update.isPending} onClick={() => update.mutate()}>
                    <Save className="h-4 w-4" />Save
                  </Button>
                  <Button size="sm" variant="outline" disabled={testConnection.isPending} onClick={() => testConnection.mutate()}>
                    <PlugZap className="h-4 w-4" />Test connection
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Routing rules</CardTitle>
          <CardDescription>First active match (in creation order) wins. No match falls back to the project above.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!readOnly && (
            <div className="grid gap-2 sm:grid-cols-5 sm:items-end">
              <div className="grid gap-1.5">
                <Label className="text-xs">Match on</Label>
                <Select value={newRule.matchType} onValueChange={(v) => setNewRule({ ...newRule, matchType: v as EmailMatchType })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {emailMatchTypes.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Value</Label>
                <Input
                  value={newRule.matchValue}
                  onChange={(e) => setNewRule({ ...newRule, matchValue: e.target.value })}
                  placeholder={newRule.matchType === "SUBJECT_PREFIX" ? "[BUG]" : newRule.matchType === "TO_PLUS_TAG" ? "bugs" : "bugs@yourcompany.com"}
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Project</Label>
                <Select value={newRule.projectId} onValueChange={(v) => setNewRule({ ...newRule, projectId: v, defaultModuleId: "" })}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">
                  Default module <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={newRule.defaultModuleId}
                  onValueChange={(v) => setNewRule({ ...newRule, defaultModuleId: v })}
                  disabled={!newRule.projectId}
                >
                  <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                  <SelectContent>
                    {(projects.data ?? [])
                      .find((p: any) => p.id === newRule.projectId)
                      ?.modules?.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" disabled={!newRule.matchValue.trim() || !newRule.projectId || createRule.isPending} onClick={() => createRule.mutate()}>
                <Plus className="h-4 w-4" />Add rule
              </Button>
            </div>
          )}
          <div className="divide-y divide-border rounded-lg border border-border">
            {(routingRules.data ?? []).map((rule) =>
              editingRuleId === rule.id ? (
                <div key={rule.id} className="grid gap-2 p-3 sm:grid-cols-5 sm:items-end">
                  <Select value={editDraft.matchType} onValueChange={(v) => setEditDraft({ ...editDraft, matchType: v as EmailMatchType })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {emailMatchTypes.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input value={editDraft.matchValue} onChange={(e) => setEditDraft({ ...editDraft, matchValue: e.target.value })} />
                  <Select value={editDraft.projectId} onValueChange={(v) => setEditDraft({ ...editDraft, projectId: v, defaultModuleId: "" })}>
                    <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={editDraft.defaultModuleId} onValueChange={(v) => setEditDraft({ ...editDraft, defaultModuleId: v })}>
                    <SelectTrigger><SelectValue placeholder="Any module" /></SelectTrigger>
                    <SelectContent>
                      {(projects.data ?? [])
                        .find((p: any) => p.id === editDraft.projectId)
                        ?.modules?.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={!editDraft.matchValue.trim() || !editDraft.projectId || saveEditRule.isPending} onClick={() => saveEditRule.mutate()}>
                      <Check className="h-4 w-4" />Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingRuleId(null)}>
                      <X className="h-4 w-4" />Cancel
                    </Button>
                  </div>
                </div>
              ) : (
              <div key={rule.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <Badge variant="muted">{rule.matchType.replace(/_/g, " ")}</Badge>
                <span className="font-mono text-xs">{rule.matchValue}</span>
                <span className="flex-1 text-muted-foreground">
                  &rarr; {rule.project.name}
                  {rule.defaultModule ? ` / ${rule.defaultModule.name}` : ""}
                </span>
                {!readOnly && (
                  <>
                    <Switch checked={rule.isActive} onCheckedChange={(v) => toggleRule.mutate({ id: rule.id, isActive: v })} />
                    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => startEditRule(rule)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => removeRule.mutate(rule.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
              )
            )}
            {(routingRules.data ?? []).length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No routing rules yet — inbound mail lands in the fallback project.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Module auto-assignment</CardTitle>
          <CardDescription>
            Once a module is resolved for an email-sourced ticket, assign it to this person automatically — only when it isn't flagged "needs review".
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!readOnly && (
            <div className="grid gap-2 sm:grid-cols-4 sm:items-end">
              <div className="grid gap-1.5">
                <Label className="text-xs">Project</Label>
                <Select value={newAssignee.projectId} onValueChange={(v) => setNewAssignee({ projectId: v, moduleId: "", defaultAssigneeId: "" })}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Module</Label>
                <Select
                  value={newAssignee.moduleId}
                  onValueChange={(v) => setNewAssignee({ ...newAssignee, moduleId: v })}
                  disabled={!newAssignee.projectId}
                >
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {selectedProjectForAssignee?.modules?.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Assignee</Label>
                <Select value={newAssignee.defaultAssigneeId} onValueChange={(v) => setNewAssignee({ ...newAssignee, defaultAssigneeId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {(users.data ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                disabled={!newAssignee.moduleId || !newAssignee.defaultAssigneeId || saveAssigneeRule.isPending}
                onClick={() => saveAssigneeRule.mutate()}
              >
                <Plus className="h-4 w-4" />Save rule
              </Button>
            </div>
          )}
          <div className="divide-y divide-border rounded-lg border border-border">
            {(assigneeRules.data ?? []).map((rule) => (
              <div key={rule.id} className="flex items-center gap-3 p-3 text-sm">
                <span className="flex-1">{rule.module.name}</span>
                <span className="text-muted-foreground">&rarr; {rule.defaultAssignee.name}</span>
                {!readOnly && (
                  <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => removeAssigneeRule.mutate(rule.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            {(assigneeRules.data ?? []).length === 0 && <p className="p-3 text-sm text-muted-foreground">No auto-assignment rules yet.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The malware-scanning switch, with its own connectivity check beside it.
 *
 * THE TEST BUTTON IS NOT A CONVENIENCE. This setting fails CLOSED: with it on and no clamd
 * reachable, every upload in the workspace is refused. Finding that out from a colleague's failed
 * attachment is the wrong order, so the check sits next to the switch that causes it — and the
 * copy says what happens when the scanner is down, before somebody flips it and discovers.
 */
function VirusScanToggle({
  enabled,
  readOnly,
  onToggle
}: {
  enabled: boolean;
  readOnly: boolean;
  onToggle: (value: boolean) => void;
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string; version?: string } | null>(null);
  const test = useMutation({
    mutationFn: () => settingsApi.testVirusScanner(),
    onSuccess: setResult,
    onError: () => setResult({ ok: false, message: "The check itself couldn't run. Try again." })
  });

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <Label>Scan uploads for malware</Label>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Off by default, because it needs a ClamAV daemon this deployment can reach. With it on, a file that
            cannot be scanned is <strong>refused rather than stored</strong> — so check the connection below before
            switching it on, or uploads will start failing.
          </p>
        </div>
        <Switch checked={enabled} disabled={readOnly} onCheckedChange={onToggle} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={readOnly || test.isPending} onClick={() => test.mutate()}>
          <ShieldCheck className="h-3.5 w-3.5" />
          {test.isPending ? "Checking…" : "Test scanner connection"}
        </Button>
        {result && (
          <span className={`text-xs ${result.ok ? "text-success" : "text-destructive"}`}>
            {result.message}
            {result.version ? ` (${result.version})` : ""}
          </span>
        )}
      </div>

      {/* Said plainly, because "we scan uploads" is routinely over-read. */}
      <p className="text-xs leading-5 text-muted-foreground">
        A signature scanner catches known malware. It does not make an HTML file safe — that is handled separately by
        the extension allow-list and by serving every download as an attachment rather than as a page.
      </p>
    </div>
  );
}

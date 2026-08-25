import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  activityTypes,
  permissions,
  ticketStatuses,
  ticketStatusTransitions,
  DEFAULT_STATUS_CATEGORY,
  type TicketStatus
} from "@timesheet/shared";
import { EMAIL_INTAKE_SYSTEM_EMAIL } from "../src/services/email-intake.service.js";
import { CHAT_INTAKE_SYSTEM_EMAIL } from "../src/services/chat-intake.service.js";
import { SECURITY_INGESTION_SYSTEM_EMAIL } from "../src/services/security-report.service.js";
import { GIT_INTEGRATION_SYSTEM_EMAIL } from "../src/services/git-provider.service.js";
import { AGENT_SYSTEM_EMAIL } from "../src/services/principal.service.js";
import { hashPassword } from "../src/utils/security.js";
import { SEED_TEMPLATES } from "./email-templates-seed.js";

const TEMPLATE_VARIABLES: Record<string, string[]> = {
  welcome: ["name", "appUrl"],
  reset: ["resetUrl", "appUrl"],
  "timesheet.submitted": ["name", "hours", "date", "project", "managerName", "appUrl"],
  "timesheet.approved": ["name", "hours", "date", "reviewer", "project", "appUrl"],
  "timesheet.rejected": ["name", "date", "project", "reviewer", "reason", "appUrl"],
  "sla.breach": ["managerName", "employeeName", "date", "project", "deadline", "hoursOverdue", "appUrl"],
  escalation: ["targetName", "employeeName", "managerName", "date", "project", "appUrl"],
  "deadline.reminder": ["name", "daysLeft", "deadlineDay", "appUrl"],
  "reminder.daily": ["name", "date", "deadlineHour", "appUrl"],
  "reminder.escalation.employee": ["name", "missedDate", "managerName", "appUrl"],
  "reminder.escalation.manager": ["managerName", "employeeName", "missedDate", "employeeEmail", "appUrl"],
  "ticket.assigned": ["assigneeName", "ticketKey", "title", "priority", "assignedBy", "appUrl"],
  "ticket.status_changed": ["ticketKey", "title", "from", "to", "changedBy", "appUrl"],
  "ticket.commented": ["ticketKey", "title", "author", "appUrl"],
  "ticket.sla_breach": ["assigneeName", "ticketKey", "title", "priority", "hoursOverdue", "appUrl"],
  "ticket.escalation": ["targetName", "ticketKey", "title", "assigneeName", "appUrl"],
  "change.submitted": [
    "changeKey", "projectName", "title", "changeType", "riskLevel", "riskScore",
    "activityWindow", "description", "requestedBy", "receivedBy", "peopleInvolved", "appUrl"
  ],
  "change.decided": [
    "changeKey", "projectName", "title", "changeType", "riskLevel", "riskScore",
    "activityWindow", "description", "requestedBy", "receivedBy", "peopleInvolved",
    "decision", "decidedBy", "comments", "appUrl"
  ]
};

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  welcome: "Sent the first time an account is created.",
  reset: "Password reset link with a 30-minute TTL.",
  "timesheet.submitted": "Confirmation to the employee when a timesheet enters the approval queue.",
  "timesheet.approved": "Sent when a manager approves a timesheet.",
  "timesheet.rejected": "Sent when a manager rejects a timesheet — includes the reason.",
  "sla.breach": "Sent to the manager who missed an approval window before we escalate.",
  escalation: "Sent to the manager-of-manager (or admin) when an SLA is missed.",
  "deadline.reminder": "Reminder to log time before the monthly cutoff.",
  "reminder.daily": "Daily 4 PM nudge to log today's timesheet (weekdays only).",
  "reminder.escalation.employee": "Next-morning escalation reminder to the employee for a missed log day.",
  "reminder.escalation.manager": "Next-morning notification to the manager when a report missed yesterday's log.",
  "ticket.assigned": "Sent to the assignee when a ticket is assigned to them.",
  "ticket.status_changed": "Sent to the reporter, assignee, and watchers when a ticket's status changes.",
  "ticket.commented": "Sent to the reporter, assignee, and watchers when someone comments on a ticket.",
  "ticket.sla_breach": "Sent to the assignee when a ticket misses its resolution SLA.",
  "ticket.escalation": "Sent to the escalation target when a ticket's SLA breach is escalated.",
  "change.submitted": "Sent the moment a change is submitted - to its approver, the requester, and everyone tagged on it.",
  "change.decided": "Sent when a change is approved or rejected, carrying who decided and their comments."
};

export interface SeedTenantOptions {
  /** All three default to the original hardcoded dev/demo values — passing none reproduces
   *  today's exact seed exactly, for `npm run seed` and any already-provisioned tenant. */
  adminEmail?: string;
  adminName?: string;
  adminPassword?: string;
  /** Demo manager/employee users + the sample "HICS Operations Platform" project. Defaults to
   *  true (unchanged local-dev behavior). Phase B8's real-org provisioning flow
   *  (services/provisioning.service.ts) passes false — a paying customer's brand-new database
   *  should get exactly the structural data every tenant needs plus the one real admin account
   *  it asked for, never fake sample people and a fake sample project. */
  includeDemoData?: boolean;
}

/**
 * The system "Default" workflow — V5's six statuses and `ticketStatusTransitions` expressed as
 * rows so custom workflows can exist alongside them.
 *
 * WHY IT IS DERIVED FROM @timesheet/shared RATHER THAN WRITTEN OUT: `ticketStatusTransitions` is
 * what the API validates against and what the status picker renders from. If this seed restated
 * the graph by hand, the two could drift, and the visible symptom would be a board offering a
 * move the server then rejects. Deriving it means the default workflow is the shared map, by
 * construction.
 *
 * The ids are DETERMINISTIC (`wfs-open`, not a uuid) and match the ones the phase-1 migration
 * inserts, so a fresh install and an upgraded install end up with byte-identical rows — which is
 * what lets tests, fixtures and later migrations refer to them by id at all.
 */
const WORKFLOW_ID = "wf-default";
const statusRowId = (s: TicketStatus) => `wfs-${s.toLowerCase().replace(/_/g, "-")}`;
const STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened"
};

export async function seedDefaultWorkflow(client: PrismaClient) {
  await client.workflow.upsert({
    where: { id: WORKFLOW_ID },
    update: {},
    create: {
      id: WORKFLOW_ID,
      name: "Default",
      description:
        "The built-in ticket workflow. Reproduces the six statuses and transitions this app has always enforced.",
      isDefault: true,
      isActive: true,
      isSystem: true
    }
  });

  for (const [index, status] of ticketStatuses.entries()) {
    await client.workflowStatus.upsert({
      where: { id: statusRowId(status) },
      update: {},
      create: {
        id: statusRowId(status),
        workflowId: WORKFLOW_ID,
        name: STATUS_LABEL[status],
        category: DEFAULT_STATUS_CATEGORY[status],
        legacyStatus: status,
        order: index,
        // OPEN is where a new ticket lands (Ticket.status defaults to OPEN), and CLOSED is the
        // only status nothing legally leaves except via REOPENED — read straight off the map
        // rather than asserted, so a change there flows here.
        isInitial: status === "OPEN",
        isFinal: ticketStatusTransitions[status].length === 0
      }
    });
  }

  for (const [from, targets] of Object.entries(ticketStatusTransitions) as [TicketStatus, TicketStatus[]][]) {
    for (const to of targets) {
      await client.workflowTransition.upsert({
        where: {
          workflowId_fromStatusId_toStatusId: {
            workflowId: WORKFLOW_ID,
            fromStatusId: statusRowId(from),
            toStatusId: statusRowId(to)
          }
        },
        update: {},
        create: {
          workflowId: WORKFLOW_ID,
          fromStatusId: statusRowId(from),
          toStatusId: statusRowId(to)
        }
      });
    }
  }
}

/**
 * Seeds one tenant database's baseline data: roles/permissions, activity types, default ticket
 * types, the email-intake system account, and every "global" settings singleton at its safe
 * default — always. One admin user (real details if provided, otherwise the original demo
 * "Avery Stone" account) is always created too; the demo manager/employee users and sample
 * project are gated behind `includeDemoData` (see SeedTenantOptions). Takes an arbitrary
 * `PrismaClient` (rather than a fixed module-level instance) so it can seed EITHER the local
 * dev database (see `main()` below) OR a brand-new tenant database at org-provisioning time
 * (Phase B8) — the exact same seed logic either way, since "the whole DB is this org's" holds
 * equally in both cases under the database-per-tenant model.
 */
/**
 * How long ago the seeded accounts finished onboarding.
 *
 * NOT `new Date()`, and the difference is load-bearing. Two separate first-run experiences key off
 * this timestamp, and they disagree about what "now" should mean:
 *
 *   - `onboarding.service.ts` only cares that it is SET — any value dismisses the blocking gate.
 *   - `ProductTour.shouldAutoStartTour` opens the walkthrough when it is set AND less than 24 hours
 *     old, which is the right rule for a person who genuinely just signed up.
 *
 * Stamping "now" therefore swapped one full-screen overlay for another: the gate closed and the
 * tour opened itself over the whole app instead. Seeded demo accounts are not people who signed up
 * a moment ago — they are an established workspace — so they are dated well outside that window.
 * Both overlays stay shut, and `product-tour.spec.ts`'s "does NOT open itself for an established
 * account" describes what the seed actually produces.
 */
const ONBOARDED_AT = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

export async function seedTenant(client: PrismaClient, options: SeedTenantOptions = {}) {
  const {
    adminEmail = "superadmin@timesheet.local",
    adminName = "Avery Stone",
    adminPassword = "Admin@12345",
    includeDemoData = true
  } = options;

  const permissionRows = await Promise.all(
    Object.values(permissions).map((key) =>
      client.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
    )
  );

  const grants: Record<string, string[]> = {
    SUPER_ADMIN: Object.values(permissions),
    ADMIN: Object.values(permissions),
    // NOTE: this map is mirrored by idempotent SQL in
    // prisma/migrations/*_v6_phase1_planning_foundation/migration.sql, because this seed is a
    // ONE-TIME bootstrap that never runs on upgrade — a permission added here alone would reach
    // fresh installs and never reach existing ones. Change both together.
    MANAGER: [
      permissions.TIMESHEETS_WRITE,
      permissions.TIMESHEETS_APPROVE,
      permissions.REPORTS_VIEW,
      permissions.TICKETS_VIEW,
      permissions.TICKETS_WRITE,
      permissions.TICKETS_ASSIGN,
      permissions.PLAN_WRITE,
      permissions.APPROVALS_MANAGE,
      // V8 phase 1: managers own the alignment surface — a manager who cannot write the goals
      // their team is measured against has nothing to manage. Mirrored in
      // migrations/20260817150000_v8_phase1_goals/migration.sql for existing installs.
      permissions.GOALS_MANAGE
    ],
    TEAM_LEAD: [
      permissions.TIMESHEETS_WRITE,
      permissions.TIMESHEETS_APPROVE,
      permissions.REPORTS_VIEW,
      permissions.TICKETS_VIEW,
      permissions.TICKETS_WRITE,
      permissions.TICKETS_ASSIGN,
      permissions.PLAN_WRITE,
      permissions.APPROVALS_MANAGE,
      // V8 phase 1: managers own the alignment surface — a manager who cannot write the goals
      // their team is measured against has nothing to manage. Mirrored in
      // migrations/20260817150000_v8_phase1_goals/migration.sql for existing installs.
      permissions.GOALS_MANAGE
    ],
    EMPLOYEE: [permissions.TIMESHEETS_WRITE, permissions.TICKETS_VIEW, permissions.TICKETS_WRITE]
  };

  // V8 phase 11: change management. Kept out of the literal above so the addition reads as one
  // decision rather than five edited lines. Mirrored by idempotent SQL in
  // migrations/20260819160000_change_management/migration.sql — this seed is a ONE-TIME bootstrap
  // and never runs on upgrade, so a key added here alone reaches fresh installs and no others.
  //
  // Raising a change is open to everyone who can raise a ticket; APPROVING one starts at TEAM_LEAD,
  // because the whole point of the module is that somebody accountable signs off. Reading needs no
  // key at all — a change about to take a service down is not a secret from the people who use it.
  grants.EMPLOYEE.push(permissions.CHANGES_WRITE);
  grants.MANAGER.push(permissions.CHANGES_WRITE, permissions.CHANGES_APPROVE);
  grants.TEAM_LEAD.push(permissions.CHANGES_WRITE, permissions.CHANGES_APPROVE);

  for (const [name, rolePermissions] of Object.entries(grants)) {
    const role = await client.role.upsert({
      where: { name: name as any },
      update: {},
      create: { name: name as any, description: name.replace("_", " ") }
    });
    await client.rolePermission.deleteMany({ where: { roleId: role.id } });
    await client.rolePermission.createMany({
      data: permissionRows
        .filter((p) => rolePermissions.includes(p.key))
        .map((p) => ({ roleId: role.id, permissionId: p.id }))
    });
  }

  for (const name of activityTypes) {
    await client.activityType.upsert({ where: { name }, update: {}, create: { name } });
  }

  const ticketTypeDefaults = [
    { name: "BUG", color: "#DC2626" },
    { name: "TASK", color: "#3B82F6" },
    { name: "IMPROVEMENT", color: "#8B5CF6" }
  ];
  for (const t of ticketTypeDefaults) {
    await client.ticketType.upsert({ where: { name: t.name }, update: {}, create: t });
  }

  const adminRole = await client.role.findUniqueOrThrow({ where: { name: "SUPER_ADMIN" } });
  const managerRole = await client.role.findUniqueOrThrow({ where: { name: "MANAGER" } });
  const employeeRole = await client.role.findUniqueOrThrow({ where: { name: "EMPLOYEE" } });
  const passwordHash = await hashPassword(adminPassword);

  const admin = await client.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      name: adminName,
      email: adminEmail,
      passwordHash,
      roleId: adminRole.id,
      status: "ACTIVE",
      bio: "Workspace administrator — owns billing, compliance, and platform configuration.",
      timezone: "America/New_York",
      /**
       * REQUIRED FOR THE SEEDED WORKSPACE TO BE USABLE, not decoration. `onboarding.service.ts`
       * blocks a user behind a full-screen gate until BOTH `phoneNumber` and `timezone` are set;
       * the seed set the timezone and not the phone, so every seeded account — including the demo
       * super-admin the README tells you to sign in as — met a blocking overlay on first load.
       *
       * It stayed invisible for a long time because the gate is self-closing: it writes
       * `onboardingCompletedAt` the moment the fields are filled, so any developer who dismissed it
       * once never saw it again, while every FRESH database still had it. What finally caught it was
       * CI's e2e suite reaching the browser for the first time and failing ~92 clicks against the
       * overlay's `fixed inset-0` backdrop.
       *
       * 555-01xx (NANP) and the 98765 43210 example are the reserved fictional ranges, so nothing
       * here can dial a real person.
       */
      phoneNumber: "+12125550100",
      onboardingCompletedAt: ONBOARDED_AT,
      emailVerifiedAt: new Date()
    }
  });

  if (includeDemoData) {
    const manager = await client.user.upsert({
      where: { email: "manager@timesheet.local" },
      update: { managerId: admin.id },
      create: {
        name: "Mira Kapoor",
        email: "manager@timesheet.local",
        passwordHash,
        roleId: managerRole.id,
        status: "ACTIVE",
        managerId: admin.id,
        bio: "Engineering manager. Reviews approvals daily and runs weekly utilization syncs.",
        timezone: "Asia/Kolkata",
        // See the admin above: without a phone number the onboarding gate blocks this account.
        phoneNumber: "+919876543211",
        onboardingCompletedAt: ONBOARDED_AT,
        emailVerifiedAt: new Date()
      }
    });

    const employee = await client.user.upsert({
      where: { email: "employee@timesheet.local" },
      update: { managerId: manager.id },
      create: {
        name: "Dev Patel",
        email: "employee@timesheet.local",
        passwordHash,
        roleId: employeeRole.id,
        status: "ACTIVE",
        managerId: manager.id,
        bio: "Full-stack engineer working on the operations platform.",
        timezone: "Asia/Kolkata",
        // See the admin above: without a phone number the onboarding gate blocks this account.
        phoneNumber: "+919876543210",
        onboardingCompletedAt: ONBOARDED_AT,
        emailVerifiedAt: new Date()
      }
    });

    const project = await client.project.upsert({
      where: { code: "HICS-OPS" },
      update: {},
      create: {
        code: "HICS-OPS",
        name: "HICS Operations Platform",
        description: "Internal operations and productivity suite",
        slaApprovalHours: 48,
        submissionDeadlineDayOfMonth: 5
      }
    });
    const core = await client.projectModule.upsert({
      where: { projectId_name: { projectId: project.id, name: "Timesheets" } },
      update: {},
      create: { projectId: project.id, name: "Timesheets" }
    });
    await client.projectSubmodule.upsert({
      where: { moduleId_name: { moduleId: core.id, name: "Daily Entry" } },
      update: {},
      create: { moduleId: core.id, name: "Daily Entry" }
    });
    await client.projectSubmodule.upsert({
      where: { moduleId_name: { moduleId: core.id, name: "Approvals" } },
      update: {},
      create: { moduleId: core.id, name: "Approvals" }
    });

    // Assign all three seeded users to the demo project so the new
    // visibility-by-assignment behaviour works out of the box.
    for (const user of [admin, manager, employee]) {
      await client.userProjectAssignment.upsert({
        where: { userId_projectId: { userId: user.id, projectId: project.id } },
        update: {},
        create: { userId: user.id, projectId: project.id }
      });
    }

    /**
     * WORK ITEMS, because a demo workspace with a project and no work in it is not a demo.
     *
     * Until this existed, `npm run seed` produced a workspace whose Tickets page, Timesheet
     * history, Reports and budget panels were all empty — the first thing anyone following the
     * README saw. The e2e suite noticed before any human did: it had never run against a freshly
     * seeded database, and when CI finally reached it, specs asking questions like "do the report
     * numbers move when I filter" and "does the budget panel refuse a forecast it cannot support"
     * failed because there was nothing to filter and nothing to forecast from.
     *
     * DETERMINISTIC IDS AND `upsert`, so re-seeding an existing workspace is a no-op rather than a
     * second pile of fake work. `npm run setup` runs the seed, and people run it more than once.
     *
     * Dates are relative to the seed run, not fixed: a report filtered to "this month" has to find
     * something whenever the workspace was created, and a hardcoded 2026 date stops being this
     * month almost immediately.
     */
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    /** Midnight local, matching how the app stores a work DATE rather than an instant. */
    const workDay = (daysAgo: number) => {
      const d = day(daysAgo);
      d.setHours(0, 0, 0, 0);
      return d;
    };

    const demoTickets = [
      { n: 1, title: "Approval reminders fire an hour early for IST managers", status: "OPEN", priority: "HIGH", reporter: manager, assignee: employee },
      { n: 2, title: "Timesheet export drops the notes column in Excel", status: "IN_PROGRESS", priority: "MEDIUM", reporter: employee, assignee: employee },
      { n: 3, title: "Add a monthly utilisation view to Reports", status: "IN_REVIEW", priority: "LOW", reporter: manager, assignee: employee },
      { n: 4, title: "Project budget shows a forecast with two weeks of data", status: "RESOLVED", priority: "MEDIUM", reporter: admin, assignee: manager },
      { n: 5, title: "Sign-in page overflows on a 320px phone", status: "CLOSED", priority: "LOW", reporter: employee, assignee: employee },
      { n: 6, title: "SLA escalation email names the wrong approver", status: "OPEN", priority: "CRITICAL", reporter: manager, assignee: manager }
    ] as const;

    for (const t of demoTickets) {
      await client.ticket.upsert({
        where: { key: `HICS-OPS-${t.n}` },
        update: {},
        create: {
          key: `HICS-OPS-${t.n}`,
          projectId: project.id,
          moduleId: core.id,
          title: t.title,
          description: `<p>${t.title}. Seeded sample ticket — safe to close or delete.</p>`,
          status: t.status,
          priority: t.priority,
          reporterId: t.reporter.id,
          assigneeId: t.assignee.id,
          createdAt: day(20 - t.n),
          resolvedAt: t.status === "RESOLVED" || t.status === "CLOSED" ? day(3) : null,
          closedAt: t.status === "CLOSED" ? day(2) : null
        }
      });
    }

    /**
     * ADVANCE THE PROJECT'S TICKET COUNTER PAST WHAT WAS JUST SEEDED.
     *
     * Keys are issued from `Project.ticketSeq` (see `issueTicketKey`), which increments per create.
     * Inserting HICS-OPS-1..6 directly leaves that counter at 0, so the very first ticket anyone
     * creates is handed HICS-OPS-1 — a key that already exists — and the create dies on the unique
     * index. The symptom is a "create a ticket" test failing on a workspace that has tickets, which
     * reads like anything except a seed problem.
     *
     * Raised, never lowered: on a workspace where people have since created their own tickets the
     * counter is already past this, and forcing it back down would reintroduce exactly the
     * collision this line exists to prevent.
     */
    const seededProject = await client.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { ticketSeq: true }
    });
    if (seededProject.ticketSeq < demoTickets.length) {
      await client.project.update({ where: { id: project.id }, data: { ticketSeq: demoTickets.length } });
    }

    /**
     * A spread of statuses on purpose. APPROVED gives Reports and the budget panel something to
     * add up, SUBMITTED gives the approvals queue a row to act on, and DRAFT gives the employee's
     * own history something editable — the three states the specs each need one of, and the three
     * a person actually has on any ordinary week.
     */
    const demoEntries = [
      { daysAgo: 9, activity: "Development", task: "Wire the approval reminder to the project's own deadline day", start: "09:30", end: "13:00", hours: 3.5, status: "APPROVED", reviewer: manager },
      { daysAgo: 8, activity: "Development", task: "Excel export: keep the notes column and widen it to fit", start: "10:00", end: "16:30", hours: 6.5, status: "APPROVED", reviewer: manager },
      { daysAgo: 7, activity: "Code Review", task: "Review the utilisation view PR and leave notes on the query", start: "14:00", end: "16:00", hours: 2, status: "APPROVED", reviewer: manager },
      { daysAgo: 4, activity: "Bug Fixing", task: "Reproduce the 320px sign-in overflow and fix the grid gap", start: "09:00", end: "12:15", hours: 3.25, status: "SUBMITTED", reviewer: null },
      { daysAgo: 3, activity: "Testing", task: "Cross-browser pass on the reports filters", start: "11:00", end: "15:00", hours: 4, status: "SUBMITTED", reviewer: null },
      { daysAgo: 1, activity: "Documentation", task: "Write up the escalation matrix for the runbook", start: "09:45", end: "11:45", hours: 2, status: "DRAFT", reviewer: null }
    ] as const;

    /**
     * Seeded entry ids are REAL uuids, not readable sentinels like `seed-entry-1`.
     *
     * `Timesheet.id` is `@default(uuid())`, so every entry a person creates is a uuid — and the
     * routes that act on one (`PUT /timesheets/:id`, the correction endpoint, the per-entry export)
     * validate `:id` with `z.string().uuid()`. A readable sentinel therefore seeds demo rows the
     * API itself refuses to touch: opening one from history deep-links to `?entry=seed-entry-6`,
     * editing it returns `422 Validation failed — id: Invalid uuid`, and the single-entry export
     * names the file after a truncated sentinel. Demo data you cannot click on is worse than none,
     * because the failure looks like a broken feature rather than a broken fixture.
     *
     * Still deterministic, so the upsert stays idempotent and the specs can address a known row:
     * a fixed prefix plus the index, shaped as a valid v4 uuid (version nibble `4`, variant `8`).
     */
    const seedEntryId = (n: number) => `5eed0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

    // Workspaces seeded before that change carry the old sentinel rows. Left in place they would
    // sit alongside the uuid ones as permanent un-editable duplicates, so they are retired here —
    // scoped to the `seed-entry-` prefix, which only this seed has ever produced.
    await client.timesheet.deleteMany({ where: { id: { startsWith: "seed-entry-" } } });

    for (const [index, e] of demoEntries.entries()) {
      const id = seedEntryId(index + 1);
      await client.timesheet.upsert({
        where: { id },
        update: {},
        create: {
          id,
          userId: employee.id,
          projectId: project.id,
          moduleId: core.id,
          activityType: e.activity,
          taskDescription: e.task,
          workDate: workDay(e.daysAgo),
          startTime: e.start,
          endTime: e.end,
          totalHours: e.hours,
          status: e.status,
          submittedAt: e.status === "DRAFT" ? null : day(e.daysAgo),
          reviewedAt: e.status === "APPROVED" ? day(e.daysAgo - 1) : null,
          reviewedById: e.reviewer ? e.reviewer.id : null,
          createdAt: day(e.daysAgo)
        }
      });
    }
  }

  // System account that satisfies Ticket.reporterId's required FK for email-sourced tickets.
  // Unusable random password each seed run — nobody is meant to log in as this account; the
  // real sender's identity lives in Ticket.externalReporterEmail/Name.
  await client.user.upsert({
    where: { email: EMAIL_INTAKE_SYSTEM_EMAIL },
    update: {},
    create: {
      name: "Email Intake",
      email: EMAIL_INTAKE_SYSTEM_EMAIL,
      passwordHash: await hashPassword(randomUUID()),
      roleId: employeeRole.id,
      status: "ACTIVE",
      bio: "System account — reporter of record for tickets auto-created from inbound email.",
      emailVerifiedAt: new Date()
    }
  });

  // Same role for chat-sourced tickets (Slack/Teams/Google Chat/Telegram) — see
  // chat-intake.service.ts's header comment.
  await client.user.upsert({
    where: { email: CHAT_INTAKE_SYSTEM_EMAIL },
    update: {},
    create: {
      name: "Chat Intake",
      email: CHAT_INTAKE_SYSTEM_EMAIL,
      passwordHash: await hashPassword(randomUUID()),
      roleId: employeeRole.id,
      status: "ACTIVE",
      bio: "System account — reporter of record for tickets auto-created from chat platforms.",
      emailVerifiedAt: new Date()
    }
  });

  // Same role for tickets auto-created from a CRITICAL/HIGH security finding — see
  // security-report.service.ts's header comment.
  await client.user.upsert({
    where: { email: SECURITY_INGESTION_SYSTEM_EMAIL },
    update: {},
    create: {
      name: "Security Ingestion",
      email: SECURITY_INGESTION_SYSTEM_EMAIL,
      passwordHash: await hashPassword(randomUUID()),
      roleId: employeeRole.id,
      status: "ACTIVE",
      bio: "System account — reporter of record for tickets auto-created from an ingested CRITICAL/HIGH security finding.",
      emailVerifiedAt: new Date()
    }
  });

  // Author of record for TicketBranch auto-sync + AI PR-review summary comments posted by
  // controllers/git-webhook.controller.ts — see git-provider.service.ts's header comment.
  await client.user.upsert({
    where: { email: GIT_INTEGRATION_SYSTEM_EMAIL },
    update: {},
    create: {
      name: "GitHub Integration",
      email: GIT_INTEGRATION_SYSTEM_EMAIL,
      passwordHash: await hashPassword(randomUUID()),
      roleId: employeeRole.id,
      status: "ACTIVE",
      bio: "System account — author of record for branch/PR sync and AI PR-review summaries from the connected GitHub account.",
      emailVerifiedAt: new Date()
    }
  });

  // Author of record for rows created by an AI agent run.
  //
  // ALSO created by migration `20260808180000_audit_actor_provenance`, and that is not a
  // duplication to tidy away — the two cover different databases. Migrations run BEFORE this seed,
  // so on a brand-new workspace the Role table is still empty when that migration runs and its
  // guarded INSERT correctly does nothing; this upsert is what covers the fresh install. The
  // migration covers the opposite case, an already-seeded workspace being upgraded, which this
  // file never runs against again. Both are idempotent, so whichever gets there first wins and the
  // other is a no-op.
  await client.user.upsert({
    where: { email: AGENT_SYSTEM_EMAIL },
    update: {},
    create: {
      name: "AI Agent",
      email: AGENT_SYSTEM_EMAIL,
      passwordHash: await hashPassword(randomUUID()),
      roleId: employeeRole.id,
      // INACTIVE on purpose, unlike the four above. This account is a foreign-key target and never
      // a principal, and `principal.service.ts#loadRequestUser` refuses any account that is not
      // ACTIVE — so this makes "the agent account can never be loaded as an acting identity" a
      // property of the data rather than a rule someone has to remember. A foreign key only needs
      // the row to exist, so it works as `reporterId`/`authorId` exactly the same.
      status: "INACTIVE",
      bio: "System account — author of record for rows created by an AI agent run. Never a principal: every agent run acts as the named person who is accountable for it, and is refused exactly what they are refused.",
      emailVerifiedAt: new Date()
    }
  });

  // Global notification settings singleton.
  await client.globalNotificationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" }
  });

  // Ticket SLA hours + AI feature toggles singletons. AI stays off (aiEnabled: false)
  // until an admin explicitly opts in from Workspace Settings.
  await client.globalTicketSettings.upsert({
    where: { id: "global" },
    update: {},
    create: {
      id: "global",
      slaLowHours: Number(process.env.TICKET_SLA_LOW_HOURS ?? 168),
      slaMediumHours: Number(process.env.TICKET_SLA_MEDIUM_HOURS ?? 72),
      slaHighHours: Number(process.env.TICKET_SLA_HIGH_HOURS ?? 24),
      slaCriticalHours: Number(process.env.TICKET_SLA_CRITICAL_HOURS ?? 4)
    }
  });
  await client.globalAISettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" }
  });

  // Planning-layer singleton + the system workflow (V6). Both are also created by
  // *_v6_phase1_planning_foundation/migration.sql for databases that already existed — this
  // block is the fresh-install half of the same fact, and the two must stay in step.
  await client.globalPlanningSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" }
  });
  await seedDefaultWorkflow(client);

  // Pre-fill every email template with a polished cross-client design. Admins
  // can later open Email Templates and tweak / send-test / revert any of them.
  for (const [key, template] of Object.entries(SEED_TEMPLATES)) {
    await client.emailTemplate.upsert({
      where: { key },
      update: {
        subject: template.subject,
        bodyHtml: template.bodyHtml,
        variables: TEMPLATE_VARIABLES[key] ?? [],
        description: TEMPLATE_DESCRIPTIONS[key] ?? null,
        enabled: true
      },
      create: {
        key,
        subject: template.subject,
        bodyHtml: template.bodyHtml,
        variables: TEMPLATE_VARIABLES[key] ?? [],
        description: TEMPLATE_DESCRIPTIONS[key] ?? null,
        enabled: true
      }
    });
  }
}

// Local dev entry point — seeds whatever DATABASE_URL currently points at, exactly as before
// this function was made reusable for tenant provisioning. Guarded so that OTHER scripts can
// `import { seedTenant } from "./seed.js"` (e.g. to seed a brand-new tenant database at
// org-provisioning time) without ALSO triggering this side effect just by importing it.
const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/").replace(/^\//, "")}`;
if (isEntryPoint) {
  const prisma = new PrismaClient();
  seedTenant(prisma).finally(() => prisma.$disconnect());
}

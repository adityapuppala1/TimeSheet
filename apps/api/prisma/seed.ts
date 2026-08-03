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
  "ticket.escalation": ["targetName", "ticketKey", "title", "assigneeName", "appUrl"]
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
  "ticket.escalation": "Sent to the escalation target when a ticket's SLA breach is escalated."
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
      permissions.APPROVALS_MANAGE
    ],
    TEAM_LEAD: [
      permissions.TIMESHEETS_WRITE,
      permissions.TIMESHEETS_APPROVE,
      permissions.REPORTS_VIEW,
      permissions.TICKETS_VIEW,
      permissions.TICKETS_WRITE,
      permissions.TICKETS_ASSIGN,
      permissions.PLAN_WRITE,
      permissions.APPROVALS_MANAGE
    ],
    EMPLOYEE: [permissions.TIMESHEETS_WRITE, permissions.TICKETS_VIEW, permissions.TICKETS_WRITE]
  };

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

import { PrismaClient } from "@prisma/client";
import { activityTypes, permissions } from "@timesheet/shared";
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
  "reminder.escalation.manager": ["managerName", "employeeName", "missedDate", "employeeEmail", "appUrl"]
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
  "reminder.escalation.manager": "Next-morning notification to the manager when a report missed yesterday's log."
};

const prisma = new PrismaClient();

async function main() {
  const permissionRows = await Promise.all(
    Object.values(permissions).map((key) =>
      prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
    )
  );

  const grants: Record<string, string[]> = {
    SUPER_ADMIN: Object.values(permissions),
    ADMIN: Object.values(permissions),
    MANAGER: [permissions.TIMESHEETS_WRITE, permissions.TIMESHEETS_APPROVE, permissions.REPORTS_VIEW],
    TEAM_LEAD: [permissions.TIMESHEETS_WRITE, permissions.TIMESHEETS_APPROVE, permissions.REPORTS_VIEW],
    EMPLOYEE: [permissions.TIMESHEETS_WRITE]
  };

  for (const [name, rolePermissions] of Object.entries(grants)) {
    const role = await prisma.role.upsert({
      where: { name: name as any },
      update: {},
      create: { name: name as any, description: name.replace("_", " ") }
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissionRows
        .filter((p) => rolePermissions.includes(p.key))
        .map((p) => ({ roleId: role.id, permissionId: p.id }))
    });
  }

  for (const name of activityTypes) {
    await prisma.activityType.upsert({ where: { name }, update: {}, create: { name } });
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: "SUPER_ADMIN" } });
  const managerRole = await prisma.role.findUniqueOrThrow({ where: { name: "MANAGER" } });
  const employeeRole = await prisma.role.findUniqueOrThrow({ where: { name: "EMPLOYEE" } });
  const passwordHash = await hashPassword("Admin@12345");

  const admin = await prisma.user.upsert({
    where: { email: "superadmin@timesheet.local" },
    update: {},
    create: {
      name: "Avery Stone",
      email: "superadmin@timesheet.local",
      passwordHash,
      roleId: adminRole.id,
      status: "ACTIVE",
      bio: "Workspace administrator — owns billing, compliance, and platform configuration.",
      timezone: "America/New_York",
      emailVerifiedAt: new Date()
    }
  });

  const manager = await prisma.user.upsert({
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

  const employee = await prisma.user.upsert({
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

  const project = await prisma.project.upsert({
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
  const core = await prisma.projectModule.upsert({
    where: { projectId_name: { projectId: project.id, name: "Timesheets" } },
    update: {},
    create: { projectId: project.id, name: "Timesheets" }
  });
  await prisma.projectSubmodule.upsert({
    where: { moduleId_name: { moduleId: core.id, name: "Daily Entry" } },
    update: {},
    create: { moduleId: core.id, name: "Daily Entry" }
  });
  await prisma.projectSubmodule.upsert({
    where: { moduleId_name: { moduleId: core.id, name: "Approvals" } },
    update: {},
    create: { moduleId: core.id, name: "Approvals" }
  });

  // Assign all three seeded users to the demo project so the new
  // visibility-by-assignment behaviour works out of the box.
  for (const user of [admin, manager, employee]) {
    await prisma.userProjectAssignment.upsert({
      where: { userId_projectId: { userId: user.id, projectId: project.id } },
      update: {},
      create: { userId: user.id, projectId: project.id }
    });
  }

  // Global notification settings singleton.
  await prisma.globalNotificationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" }
  });

  // Pre-fill every email template with a polished cross-client design. Admins
  // can later open Email Templates and tweak / send-test / revert any of them.
  for (const [key, template] of Object.entries(SEED_TEMPLATES)) {
    await prisma.emailTemplate.upsert({
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

main().finally(() => prisma.$disconnect());

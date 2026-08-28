/**
 * WHAT: one maintenance window, applied across every workspace on the deployment — armed, cleared,
 * and reported on from the platform-admin console.
 *
 * IT REUSES THE TENANT MECHANISM RATHER THAN ADDING A SECOND ONE. Each workspace already has a
 * `MaintenanceSettings` row, `middleware/auth.ts` already answers `503 { code: "MAINTENANCE" }` for
 * everyone below SUPER_ADMIN while a window is live, the SPA already redirects that code to
 * `/maintenance`, the heartbeat already turns an open tab into a redirect within seconds, and
 * `notifyUsersOfMaintenance` already writes the in-app notification and email. So a platform-wide
 * window is not a new gate — it is the SAME row written into N tenant databases inside
 * `withOrgTenant`.
 *
 * WHY THAT IS THE RIGHT CALL AND NOT A SHORTCUT. A second, control-plane gate would have to be
 * consulted on every authenticated request in every tenant, which means either a cross-database
 * read on the hot path or a second cache with its own staleness. Worse, the two could disagree —
 * and "the platform says we are in maintenance, the workspace says we are not" is a state nobody
 * can debug. One mechanism, one source of truth per workspace, one page that already exists.
 *
 * WHAT THE CONTROL PLANE DOES KEEP is a record of the BROADCAST: who armed it, when, over which
 * workspaces, with what message, and how each one fared. That is the thing a tenant row genuinely
 * cannot answer — "did this reach all forty of them?" — and it is what makes clearing the window
 * later a single, reliable action rather than forty separate ones somebody has to remember.
 *
 * PARTIAL FAILURE IS REPORTED, NEVER SWALLOWED. One workspace with an unreachable database must not
 * stop the other thirty-nine from entering maintenance; each result is recorded per workspace and
 * the console shows exactly which ones did not take.
 */
import { randomUUID } from "node:crypto";
import { controlPrisma } from "../config/control-prisma.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { AppError } from "../middleware/error.js";
import {
  getMaintenanceSettings,
  notifyUsersOfMaintenance,
  updateMaintenanceSettings,
  type MaintenanceSettingsShape
} from "./maintenance.service.js";
import { platformAudit } from "./platform-audit.service.js";
import { sendPlatformTemplate } from "./platform-mail.service.js";
import { workspaceUrlForSlug } from "./workspace-directory.service.js";

/** The workspaces a platform-wide window can reach: ones that resolve and can be signed into. */
const TARGETABLE = ["ACTIVE", "GRACE"] as const;

export interface WorkspaceMaintenanceState {
  organizationId: string;
  name: string;
  slug: string;
  status: string;
  /** Null when the workspace's database could not be read — stated, never guessed at. */
  settings: (MaintenanceSettingsShape & { phase: string }) | null;
  error: string | null;
}

export interface BroadcastOutcome {
  organizationId: string;
  slug: string;
  ok: boolean;
  /** How many people were notified in that workspace, when notification was asked for. */
  notified: number;
  /** Whether the workspace's own super admins were emailed by the platform. */
  emailed: boolean;
  error: string | null;
}

/**
 * The current window in every workspace, read one tenant at a time.
 *
 * DELIBERATELY NOT CACHED. This is an operator staring at a screen during a change window; a
 * ten-second-stale answer to "is everyone in maintenance yet?" is worse than a slow one.
 */
export async function getFleetMaintenance(): Promise<WorkspaceMaintenanceState[]> {
  const orgs = await controlPrisma.organization.findMany({
    where: { status: { in: [...TARGETABLE] } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, slug: true, status: true, database: { select: { id: true } } }
  });

  return Promise.all(
    orgs.map(async (org) => {
      if (!org.database) {
        return { organizationId: org.id, name: org.name, slug: org.slug, status: org.status, settings: null, error: "No database registered for this workspace." };
      }
      try {
        const settings = await withOrgTenant(org.slug, async () => {
          const row = await getMaintenanceSettings();
          const { phaseOf } = await import("./maintenance.service.js");
          return { ...row, phase: phaseOf(row) };
        });
        return { organizationId: org.id, name: org.name, slug: org.slug, status: org.status, settings, error: null };
      } catch (error) {
        return { organizationId: org.id, name: org.name, slug: org.slug, status: org.status, settings: null, error: (error as Error).message.slice(0, 200) };
      }
    })
  );
}

export interface BroadcastInput {
  /** Empty means every targetable workspace — the console makes that choice explicit. */
  organizationIds: string[];
  enabled: boolean;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  message: string | null;
  /** Write the in-app notification to everyone currently online in each workspace. */
  notifyUsers: boolean;
  /** Email each workspace's super admins from the PLATFORM relay. */
  emailSuperAdmins: boolean;
  actorLabel: string;
  /** What the workspace's read-only notice names as the owner of the window. */
  managedByLabel?: string | null;
}

/**
 * Arm (or clear) the window across the chosen workspaces.
 *
 * THE EMAIL COMES FROM THE PLATFORM, NOT THE WORKSPACE. A window that is about to take a workspace
 * offline may be taking its outbound mail with it, and a notice that cannot leave is not a notice.
 * `sendPlatformTemplate` uses the deployment's own relay for exactly this reason.
 */
export async function broadcastMaintenance(input: BroadcastInput): Promise<{ broadcastId: string; outcomes: BroadcastOutcome[] }> {
  if (input.enabled) {
    if (!input.scheduledStartAt || !input.scheduledEndAt) throw new AppError(422, "Pick when the window starts and ends — every workspace's notice quotes it.");
    if (input.scheduledEndAt <= input.scheduledStartAt) throw new AppError(422, "The window must end after it starts.");
  }

  const orgs = await controlPrisma.organization.findMany({
    where: {
      status: { in: [...TARGETABLE] },
      ...(input.organizationIds.length ? { id: { in: input.organizationIds } } : {})
    },
    select: { id: true, name: true, slug: true, ownerEmail: true, database: { select: { id: true } } }
  });
  if (orgs.length === 0) throw new AppError(404, "No reachable workspaces matched.");

  // The id is minted BEFORE the first tenant write, not taken from the record afterwards, so the
  // same reference is stamped into every workspace's row and onto the broadcast. One incident, one
  // reference — a customer quoting it and an operator searching for it land in the same place.
  const reference = randomUUID();

  const outcomes: BroadcastOutcome[] = [];

  for (const org of orgs) {
    if (!org.database) {
      outcomes.push({ organizationId: org.id, slug: org.slug, ok: false, notified: 0, emailed: false, error: "No database registered." });
      continue;
    }
    try {
      const notified = await withOrgTenant(org.slug, async () => {
        // `updateMaintenanceSettings` carries the window validation the tenant UI relies on, so a
        // broadcast cannot write a shape a workspace admin would have been refused.
        await updateMaintenanceSettings({
          enabled: input.enabled,
          scheduledStartAt: input.scheduledStartAt,
          scheduledEndAt: input.scheduledEndAt,
          message: input.message,
          // The actor is a platform admin with no user row in this tenant. `updatedById` is a
          // free-text column, so the label goes in rather than a fabricated user id.
          userId: input.actorLabel,
          // `source: "platform"` is what makes the window READ-ONLY inside the workspace. Without
          // it a single tenant could switch off a deployment-wide window and take a live database
          // into the migration it was there to protect.
          source: "platform",
          managedByLabel: input.managedByLabel ?? "Platform operations",
          managedReference: reference
        });
        if (!input.enabled || !input.notifyUsers) return 0;
        const result = await notifyUsersOfMaintenance();
        return result.notified;
      });

      let emailed = false;
      if (input.emailSuperAdmins) {
        const recipients = await superAdminRecipients(org.slug, org.ownerEmail);
        if (recipients.length) {
          const result = await sendPlatformTemplate(input.enabled ? "maintenance.scheduled" : "maintenance.cleared", {
            to: recipients.join(","),
            organizationId: org.id,
            vars: {
              workspace: org.name,
              slug: org.slug,
              workspaceUrl: workspaceUrlForSlug(org.slug),
              startsAt: input.scheduledStartAt ? input.scheduledStartAt.toUTCString() : "",
              endsAt: input.scheduledEndAt ? input.scheduledEndAt.toUTCString() : "",
              note: input.message ?? ""
            },
            metadata: { by: input.actorLabel }
          });
          emailed = result.ok;
        }
      }

      outcomes.push({ organizationId: org.id, slug: org.slug, ok: true, notified, emailed, error: null });
    } catch (error) {
      // RULE: one workspace's failure never stops the rest of the fleet.
      outcomes.push({ organizationId: org.id, slug: org.slug, ok: false, notified: 0, emailed: false, error: (error as Error).message.slice(0, 300) });
    }
  }

  const record = await controlPrisma.platformMaintenanceBroadcast.create({
    data: {
      id: reference,
      enabled: input.enabled,
      scheduledStartAt: input.scheduledStartAt,
      scheduledEndAt: input.scheduledEndAt,
      message: input.message,
      actorLabel: input.actorLabel,
      targetCount: orgs.length,
      appliedCount: outcomes.filter((o) => o.ok).length,
      failedCount: outcomes.filter((o) => !o.ok).length,
      notifiedCount: outcomes.reduce((sum, o) => sum + o.notified, 0),
      emailedCount: outcomes.filter((o) => o.emailed).length,
      outcomes: JSON.parse(JSON.stringify(outcomes))
    }
  });

  await platformAudit("PLATFORM_ADMIN", input.actorLabel, input.enabled ? "maintenance.broadcast_armed" : "maintenance.broadcast_cleared", "PlatformMaintenanceBroadcast", record.id, {
    targets: orgs.length,
    applied: record.appliedCount,
    failed: record.failedCount
  });

  return { broadcastId: record.id, outcomes };
}

/** Who to email in a workspace: its live super admins, falling back to the recorded owner. */
async function superAdminRecipients(slug: string, ownerEmail: string | null): Promise<string[]> {
  try {
    const admins = await withOrgTenant(slug, async () => {
      const { prisma } = await import("../config/prisma.js");
      return prisma.user.findMany({
        where: { status: "ACTIVE", deletedAt: null, isAgent: false, role: { name: "SUPER_ADMIN" } },
        select: { email: true }
      });
    });
    const emails = admins.map((a) => a.email).filter(Boolean);
    if (emails.length) return emails;
  } catch {
    // A workspace whose database is unreachable is exactly the one whose owner most needs telling.
  }
  return ownerEmail ? [ownerEmail] : [];
}

export async function listBroadcasts(limit = 20) {
  return controlPrisma.platformMaintenanceBroadcast.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

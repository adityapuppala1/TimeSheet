/**
 * WHAT: the part of fleet monitoring that leaves the room.
 *
 * WHY IT EXISTS. `platform-tenant-health.service.ts#deriveAlerts` has computed real, severity-tiered
 * alerts across the whole fleet since 4.0.0 — connections at 90%, an auto-increment key 94%
 * consumed, a service DOWN, a workspace whose schema is behind the code that is running. Every one
 * of them existed only for as long as somebody had the Monitoring page open. A monitoring system
 * nobody is looking at is a log file with charts, and the failure it is meant to catch happens at
 * 03:00 on a Sunday when nobody is looking at anything.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ANTI-NOISE RULE — the single most important thing in this file.
 *
 * A digest that arrives every morning saying the same three things is a digest people filter into a
 * folder, and the morning it says a fourth thing they do not read that one either. Alert fatigue is
 * not a soft problem: it is the mechanism by which a working alert system stops working, and it is
 * caused by exactly one thing — reporting STATE on a timer instead of reporting CHANGE.
 *
 * So this reports change:
 *   • APPEARED  — a condition with no open record, or one nobody has actually been told about yet.
 *   • ESCALATED — an open condition whose severity is now higher than the severity we reported.
 *   • CLEARED   — an open condition that is gone, and only if somebody was told it was there.
 * A standing condition that is exactly as it was six hours ago updates its row and sends NOTHING.
 * When no bucket has anything in it above the configured floor, no message is sent at all.
 *
 * TWO CONSEQUENCES THAT ARE EASY TO GET WRONG, both handled here:
 *
 *  1. WHAT WE SAW IS NOT WHAT WE SAID. `PlatformAlertState.severity` is the last sweep's reading;
 *     `reportedSeverity`/`lastReportedAt` are what a human was actually told, and they are written
 *     ONLY when a channel accepted the message. A mail relay that was down therefore leaves the
 *     alert looking new on the next run rather than being silently swallowed forever, and the
 *     six-hourly schedule becomes the retry without a delivery queue existing.
 *
 *  2. THE FIRST RUN IS LOUD, ON PURPOSE. There is no backfill for the state table and there could
 *     not be one — it records what somebody was told, and nobody has been told anything. So the
 *     first digest on any deployment reports everything currently wrong, once, and is quiet from
 *     then on. Seeding it "already reported" would open with silence about real problems.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE WEBHOOK IS THE SAME EVENT, ADDRESSED DIFFERENTLY. It reuses `webhook-dispatch.service.ts`'s
 * thinking rather than its code — the tenant dispatcher writes `WebhookDelivery` rows against the
 * TENANT Prisma client and cannot be called from the control plane at all — but the shape is
 * deliberately identical: the SSRF gate re-checked on every attempt rather than trusted from when
 * the URL was saved, the same `X-TimeSphere-Signature: sha256=<hex>` HMAC over the raw body, the
 * same short timeout, and an OUTCOME returned rather than an exception thrown. What it does NOT
 * copy is the retry table, and that is a decision rather than an omission: this event is recomputed
 * from scratch every six hours and, by the rule above, is not marked reported until it lands — so
 * the schedule already IS the retry, and a second delivery queue would be machinery for nothing.
 *
 * NOT CONFIGURED IS A FIRST-CLASS STATE. No webhook URL means the digest skips that channel in
 * silence and the console says "Not configured" — never a failure, never a retry, never a log line
 * per run about a thing nobody asked for.
 *
 * WHAT LEAVES THE BUILDING: workspace names, slugs, severities, alert titles and the thresholds
 * they crossed. Aggregate operational facts, the same line every cross-tenant surface in this
 * console holds — never a ticket, a person, or anything from inside a customer's database.
 */
import crypto from "node:crypto";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";
import { assertPublicEgressTarget } from "../utils/egress.js";
import { platformAudit } from "./platform-audit.service.js";
import { sendPlatformTemplate } from "./platform-mail.service.js";
import { getFleetHealth, type HealthAlertSeverity } from "./platform-tenant-health.service.js";
import { getFleetSchemaDrift, TENANT_MIGRATE_COMMAND } from "./tenant-schema-check.service.js";

/* ------------------------------------------------------------------------------------------ */
/* Severity                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;

/** Rank, so "higher than" is a comparison rather than a chain of string equality. Bigger is worse. */
const SEVERITY_RANK: Record<HealthAlertSeverity, number> = { info: 1, warning: 2, critical: 3 };

/** An unrecognised severity ranks 0 — below the lowest floor, so it can never trigger a message.
 *  Fail closed: a value this build does not understand must not page anybody. */
export const severityRank = (value: string | null | undefined): number => SEVERITY_RANK[value as HealthAlertSeverity] ?? 0;

/* ------------------------------------------------------------------------------------------ */
/* What the fleet currently says                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface FleetAlert {
  organizationId: string;
  slug: string;
  name: string;
  key: string;
  severity: HealthAlertSeverity;
  title: string;
  detail: string;
  area: string;
}

export interface FleetAlertSweep {
  generatedAt: string;
  alerts: FleetAlert[];
  totals: { critical: number; warning: number; info: number; workspaces: number };
  /** Workspaces the sweep could not read at all. Reported separately from alerts because an
   *  unreachable database produces NO alerts, which looks identical to a healthy one. */
  unreachable: Array<{ organizationId: string; slug: string; name: string; error: string }>;
}

/**
 * Every alert across the fleet, right now.
 *
 * SCHEMA DRIFT IS FOLDED IN HERE rather than living on its own page only. A workspace behind on
 * migrations is not a background nicety: it is the state in which a worker logs "table … does not
 * exist" once a minute and the customer's features are quietly missing. It belongs in the same
 * stream as "the database is full", and expressing it as an ordinary per-workspace alert means it
 * inherits the whole delivery and anti-noise mechanism for free instead of needing a second one.
 */
export async function sweepFleetAlerts(): Promise<FleetAlertSweep> {
  const fleet = await getFleetHealth();
  const drift = await getFleetSchemaDrift();

  const alerts: FleetAlert[] = [];
  for (const row of fleet.rows) {
    for (const alert of row.alerts) {
      alerts.push({
        organizationId: row.organizationId,
        slug: row.slug,
        name: row.name,
        key: alert.key,
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
        area: alert.area
      });
    }
  }

  for (const row of drift.rows.filter((entry) => entry.behind)) {
    alerts.push({
      organizationId: row.organizationId,
      slug: row.slug,
      name: row.name,
      key: "schema.drift",
      // CRITICAL, and it earns it: every feature whose tables landed in the missed migration is
      // broken for this workspace and nothing in the product says so to its users.
      severity: "critical",
      title: "Database schema is behind the running code",
      detail: `On ${row.schemaVersion ?? "no recorded version"}; this build expects ${drift.latest}. Fix from a terminal: ${TENANT_MIGRATE_COMMAND}`,
      area: "database"
    });
  }

  // Sorted worst-first here rather than at each reader, so the email, the webhook payload and the
  // console page cannot present the same sweep in three different orders.
  alerts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));

  return {
    generatedAt: new Date().toISOString(),
    alerts,
    totals: {
      critical: alerts.filter((alert) => alert.severity === "critical").length,
      warning: alerts.filter((alert) => alert.severity === "warning").length,
      info: alerts.filter((alert) => alert.severity === "info").length,
      workspaces: new Set(alerts.map((alert) => alert.organizationId)).size
    },
    unreachable: fleet.rows
      .filter((row) => !row.reachable)
      .map((row) => ({ organizationId: row.organizationId, slug: row.slug, name: row.name, error: row.error ?? "Unreachable." }))
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The diff — the anti-noise rule, as a pure function                                          */
/* ------------------------------------------------------------------------------------------ */

/** The subset of a `PlatformAlertState` row the diff needs. Narrowed so the rule can be tested
 *  against plain objects rather than against Prisma's row type. */
export interface StoredAlertState {
  organizationId: string;
  alertKey: string;
  severity: string;
  title: string;
  detail: string;
  resolvedAt: Date | null;
  lastReportedAt: Date | null;
  reportedSeverity: string | null;
  firstSeenAt: Date;
}

export interface AlertDiff {
  appeared: FleetAlert[];
  escalated: Array<FleetAlert & { previousSeverity: string }>;
  cleared: StoredAlertState[];
  /** Still true, still exactly as reported. Counted for the console; never mailed. */
  unchanged: FleetAlert[];
}

const identity = (organizationId: string, key: string) => `${organizationId}::${key}`;

/**
 * What has CHANGED since somebody was last told.
 *
 * PURE, and deliberately so: this rule is the whole difference between an alert system and a
 * mailing list, and a rule that can only be exercised through a database and an SMTP server is a
 * rule nobody re-checks after touching it.
 *
 * The comparison is against what was REPORTED, not against what was last seen. That is what makes
 * a failed delivery self-healing — see the header's point (1). An open row nobody has been told
 * about is `appeared`, however many sweeps have already recorded it.
 */
export function diffAlerts(stored: StoredAlertState[], current: FleetAlert[]): AlertDiff {
  const open = new Map(stored.filter((row) => row.resolvedAt === null).map((row) => [identity(row.organizationId, row.alertKey), row]));
  const live = new Set(current.map((alert) => identity(alert.organizationId, alert.key)));

  const appeared: FleetAlert[] = [];
  const escalated: Array<FleetAlert & { previousSeverity: string }> = [];
  const unchanged: FleetAlert[] = [];

  for (const alert of current) {
    const previous = open.get(identity(alert.organizationId, alert.key));
    if (!previous || previous.lastReportedAt === null) {
      appeared.push(alert);
      continue;
    }
    if (severityRank(alert.severity) > severityRank(previous.reportedSeverity)) {
      escalated.push({ ...alert, previousSeverity: previous.reportedSeverity ?? "unknown" });
      continue;
    }
    // Includes a DE-escalation — warning down to info — which is deliberately not a message. It is
    // an improvement in something already reported, and mailing it would double the traffic of
    // every flapping metric for no decision anybody makes differently.
    unchanged.push(alert);
  }

  const cleared = stored.filter(
    // "Was open, is gone, and we actually said so." The last clause is what stops a recovery notice
    // for a condition nobody ever heard about.
    (row) => row.resolvedAt === null && row.lastReportedAt !== null && !live.has(identity(row.organizationId, row.alertKey))
  );

  return { appeared, escalated, cleared, unchanged };
}

/** Everything in the diff that clears the floor. Below it, a change is recorded and not sent. */
export function reportable(diff: AlertDiff, minSeverity: string): AlertDiff {
  const floor = severityRank(minSeverity);
  return {
    appeared: diff.appeared.filter((alert) => severityRank(alert.severity) >= floor),
    escalated: diff.escalated.filter((alert) => severityRank(alert.severity) >= floor),
    // A clear is judged on the severity it HAD: an operator told about a critical is owed the
    // sentence that says it is over, whatever the floor happens to be set to now.
    cleared: diff.cleared.filter((row) => severityRank(row.reportedSeverity ?? row.severity) >= floor),
    unchanged: diff.unchanged
  };
}

/** Whether the filtered diff is worth anybody's inbox. One expression, so "did we send" and "why
 *  did we send" can never diverge. */
export const worthSending = (diff: AlertDiff): boolean => diff.appeared.length + diff.escalated.length + diff.cleared.length > 0;

/* ------------------------------------------------------------------------------------------ */
/* Settings                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface AlertSettings {
  digestEnabled: boolean;
  minSeverity: string;
  recipients: string[];
  webhookUrl: string | null;
  webhookSecretSet: boolean;
  lastRunAt: Date | null;
  lastSentAt: Date | null;
  lastWebhookAt: Date | null;
  lastWebhookStatus: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The shipped defaults, used when no row has ever been written. Not seeded by the migration on
 *  purpose: a row would put an `updatedBy` of nobody against settings no operator has looked at. */
const DEFAULTS: AlertSettings = {
  digestEnabled: true,
  minSeverity: "warning",
  recipients: [],
  webhookUrl: null,
  webhookSecretSet: false,
  lastRunAt: null,
  lastSentAt: null,
  lastWebhookAt: null,
  lastWebhookStatus: null,
  updatedAt: null,
  updatedBy: null
};

export async function getAlertSettings(): Promise<AlertSettings> {
  const row = await controlPrisma.platformAlertSettings.findUnique({ where: { id: "global" } }).catch(() => null);
  if (!row) return { ...DEFAULTS };
  return {
    digestEnabled: row.digestEnabled,
    minSeverity: row.minSeverity,
    recipients: Array.isArray(row.recipients) ? (row.recipients as string[]) : [],
    webhookUrl: row.webhookUrl,
    // The secret itself is NEVER returned, the same contract as the mail password and the AI key.
    webhookSecretSet: Boolean(row.encryptedWebhookSecret),
    lastRunAt: row.lastRunAt,
    lastSentAt: row.lastSentAt,
    lastWebhookAt: row.lastWebhookAt,
    lastWebhookStatus: row.lastWebhookStatus,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy
  };
}

export async function updateAlertSettings(input: {
  digestEnabled: boolean;
  minSeverity: string;
  recipients: string[];
  webhookUrl: string | null;
  /** Omitted keeps the stored secret; "" clears it. Same three-state contract as every other
   *  secret field in this console, so an operator editing a URL does not lose their signature. */
  webhookSecret?: string;
  actorLabel: string;
  reason?: string;
}): Promise<AlertSettings> {
  if (!ALERT_SEVERITIES.includes(input.minSeverity as (typeof ALERT_SEVERITIES)[number])) {
    throw new AppError(422, `"${input.minSeverity}" is not a severity. Choose one of ${ALERT_SEVERITIES.join(", ")}.`);
  }
  if (input.webhookUrl) {
    // Checked HERE as well as on every delivery, so a typo is refused at the moment it is typed
    // rather than silently failing four hours later inside a worker.
    await assertPublicEgressTarget(input.webhookUrl, "This alert webhook URL");
  }

  const before = await getAlertSettings();
  const secretPatch =
    input.webhookSecret === undefined
      ? {}
      : { encryptedWebhookSecret: input.webhookSecret ? encryptSecret(input.webhookSecret) : null };

  const data = {
    digestEnabled: input.digestEnabled,
    minSeverity: input.minSeverity,
    recipients: input.recipients,
    webhookUrl: input.webhookUrl,
    updatedBy: input.actorLabel,
    ...secretPatch
  };
  await controlPrisma.platformAlertSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });

  await platformAudit(
    "PLATFORM_ADMIN",
    input.actorLabel,
    "platform_alerts.settings_updated",
    "PlatformAlertSettings",
    "global",
    { webhookConfigured: Boolean(input.webhookUrl), recipients: input.recipients.length },
    {
      reason: input.reason,
      before: { digestEnabled: before.digestEnabled, minSeverity: before.minSeverity, recipients: before.recipients, webhookUrl: before.webhookUrl },
      after: { digestEnabled: input.digestEnabled, minSeverity: input.minSeverity, recipients: input.recipients, webhookUrl: input.webhookUrl }
    }
  );

  return getAlertSettings();
}

/**
 * Who the digest goes to.
 *
 * The explicit list wins; an empty one falls back to every ACTIVE platform admin. The fallback is
 * the important half — a deployment that never opens this screen still gets its alerts, and a
 * recipient list that is a static copy of the operator roster is a list that keeps mailing somebody
 * who left three months ago.
 */
export async function resolveAlertRecipients(settings: AlertSettings): Promise<string[]> {
  if (settings.recipients.length) return settings.recipients;
  const admins = await controlPrisma.platformAdminUser.findMany({ where: { status: "ACTIVE" }, select: { email: true } });
  return admins.map((admin) => admin.email);
}

/* ------------------------------------------------------------------------------------------ */
/* The webhook                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const WEBHOOK_TIMEOUT_MS = 5000;

export interface WebhookOutcome {
  /** "not_configured" | "delivered" | "http_<status>" | "failed" | "blocked". */
  status: string;
  ok: boolean;
  error?: string;
}

/**
 * One POST at the operator's endpoint.
 *
 * Every deliberate choice here is copied from `webhook-dispatch.service.ts#attemptWebhookDelivery`
 * and is copied for its reasons, not for symmetry:
 *   • the SSRF gate runs on EVERY attempt, not only when the URL was saved — a target that was
 *     public when it was typed and now resolves inside the network is re-checked;
 *   • an OUTCOME comes back instead of a throw, because the caller is a worker where a rejection is
 *     an unhandled promise and because "blocked, and here is why" has to reach the console;
 *   • the timeout is short and explicit — a hung receiver must not hold a worker open.
 *
 * Unsigned when no secret is set. Slack and Teams incoming webhooks verify nothing and reject
 * nothing, so demanding a secret would make the common case impossible for no gain; the header is
 * added the moment one exists.
 */
export async function deliverAlertWebhook(payload: Record<string, unknown>): Promise<WebhookOutcome> {
  const row = await controlPrisma.platformAlertSettings.findUnique({ where: { id: "global" } }).catch(() => null);
  if (!row?.webhookUrl) return { status: "not_configured", ok: false };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-TimeSphere-Event": "platform.alert_digest" };
  if (row.encryptedWebhookSecret) {
    try {
      headers["X-TimeSphere-Signature"] = `sha256=${crypto.createHmac("sha256", decryptSecret(row.encryptedWebhookSecret)).update(body).digest("hex")}`;
    } catch {
      // Undecryptable (ENCRYPTION_KEY rotated). Send unsigned rather than not at all: an alert that
      // arrives without a signature is recoverable; one that never arrives is the outage.
    }
  }

  let outcome: WebhookOutcome;
  try {
    await assertPublicEgressTarget(row.webhookUrl, "This alert webhook URL");
  } catch (error) {
    outcome = { status: "blocked", ok: false, error: (error as Error).message.slice(0, 300) };
    await recordWebhookOutcome(outcome);
    return outcome;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(row.webhookUrl, { method: "POST", headers, body, signal: controller.signal });
    outcome = response.ok ? { status: "delivered", ok: true } : { status: `http_${response.status}`, ok: false };
  } catch (error) {
    outcome = { status: "failed", ok: false, error: (error as Error).message.slice(0, 300) };
  } finally {
    clearTimeout(timeout);
  }

  await recordWebhookOutcome(outcome);
  return outcome;
}

/** The last attempt, on the settings row, so the console can show whether the endpoint is actually
 *  working without an operator having to trigger one to find out. */
async function recordWebhookOutcome(outcome: WebhookOutcome): Promise<void> {
  await controlPrisma.platformAlertSettings
    .update({ where: { id: "global" }, data: { lastWebhookAt: new Date(), lastWebhookStatus: outcome.error ? `${outcome.status}: ${outcome.error}`.slice(0, 64) : outcome.status } })
    .catch(() => undefined);
}

/* ------------------------------------------------------------------------------------------ */
/* The digest                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface DigestResult {
  /** False whenever nothing was worth saying — which is the healthy, common answer. */
  sent: boolean;
  reason: string;
  appeared: number;
  escalated: number;
  cleared: number;
  unchanged: number;
  recipients: number;
  mailed: number;
  webhook: WebhookOutcome | null;
  /** True when the caller asked for a preview: nothing is sent and no state is written. */
  dryRun: boolean;
}

const line = (alert: FleetAlert) => `${alert.name} (${alert.slug}) — ${alert.title}. ${alert.detail}`;

/** The email body's three lists, as plain text lines. Built here rather than in the template so the
 *  webhook payload and the email describe the same run in the same words. */
function summarise(diff: AlertDiff): { newLines: string; escalatedLines: string; clearedLines: string } {
  return {
    newLines: diff.appeared.map((alert) => `[${alert.severity.toUpperCase()}] ${line(alert)}`).join("\n") || "None.",
    escalatedLines: diff.escalated.map((alert) => `[${alert.previousSeverity.toUpperCase()} → ${alert.severity.toUpperCase()}] ${line(alert)}`).join("\n") || "None.",
    clearedLines: diff.cleared.map((row) => `${row.title} — ${row.detail}`).join("\n") || "None."
  };
}

/**
 * Why a pass sent nothing. Two DIFFERENT sentences, deliberately: "nothing has changed" and "the
 * fleet is quiet" describe very different states, and an operator reading the console needs to know
 * which one they are in before deciding whether the alerting is working.
 */
function quietReason(standing: number): string {
  if (standing === 0) return "The fleet is quiet.";
  return `Nothing has changed — ${standing} standing alert${standing === 1 ? "" : "s"} already reported.`;
}

/**
 * One message per recipient, and one recipient's failure never costs the others theirs — the same
 * isolation rule every fleet-wide loop in this console follows. Returns how many actually landed,
 * which is what decides whether these alerts are marked reported.
 */
async function mailDigest(recipients: string[], sweep: FleetAlertSweep, filtered: AlertDiff, consoleUrl: string): Promise<number> {
  const { newLines, escalatedLines, clearedLines } = summarise(filtered);
  let mailed = 0;
  for (const to of recipients) {
    const result = await sendPlatformTemplate("platform.alert_digest", {
      to,
      vars: {
        criticalCount: sweep.totals.critical,
        warningCount: sweep.totals.warning,
        newCount: filtered.appeared.length,
        escalatedCount: filtered.escalated.length,
        clearedCount: filtered.cleared.length,
        newAlerts: newLines,
        escalatedAlerts: escalatedLines,
        clearedAlerts: clearedLines,
        consoleUrl
      },
      metadata: { appeared: filtered.appeared.length, escalated: filtered.escalated.length, cleared: filtered.cleared.length }
    }).catch((error: Error) => ({ ok: false, status: "FAILED" as const, emailLogId: null, errorMessage: error.message, subject: "" }));
    if (result.ok) mailed += 1;
  }
  return mailed;
}

/**
 * One digest pass: sweep, diff, send if and only if something changed, then record what was said.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE. The state rows are written AFTER delivery is attempted, and
 * `lastReportedAt`/`reportedSeverity` move only when a channel accepted the message. Writing them
 * first would mean an SMTP outage silently consumes an alert: the row would say "told them", the
 * next sweep would call it unchanged, and nobody would ever hear about it. See the header.
 *
 * `dryRun` stops before both the sending and the recording, which is what makes the console's
 * "Preview" button safe to press repeatedly — it answers "what WOULD go out" without spending the
 * one chance to say it.
 */
export async function runAlertDigest(options: { dryRun?: boolean; actorLabel?: string } = {}): Promise<DigestResult> {
  const dryRun = options.dryRun ?? false;
  const settings = await getAlertSettings();
  const sweep = await sweepFleetAlerts();

  const stored = await controlPrisma.platformAlertState.findMany({ where: { resolvedAt: null } });
  const diff = diffAlerts(stored as unknown as StoredAlertState[], sweep.alerts);
  const filtered = reportable(diff, settings.minSeverity);

  const base = {
    appeared: filtered.appeared.length,
    escalated: filtered.escalated.length,
    cleared: filtered.cleared.length,
    unchanged: diff.unchanged.length,
    dryRun
  };

  if (!dryRun) {
    await controlPrisma.platformAlertSettings
      .upsert({ where: { id: "global" }, create: { id: "global", lastRunAt: new Date() }, update: { lastRunAt: new Date() } })
      .catch(() => undefined);
  }

  if (!settings.digestEnabled) {
    // Still swept, still diffed, still RECORDED — only the sending is off, and that distinction is
    // what makes switching it back on sane. Conditions that came and went while it was off resolve
    // silently, because nobody was ever told about them; what is still wrong at the moment it is
    // re-enabled is still unreported, and is therefore reported once. The alternative — not
    // recording at all — would open with a backlog of things that had already fixed themselves.
    if (!dryRun) await recordState(sweep.alerts, diff, new Set());
    return { ...base, sent: false, reason: "The operator digest is switched off.", recipients: 0, mailed: 0, webhook: null };
  }

  if (!worthSending(filtered)) {
    if (!dryRun) await recordState(sweep.alerts, diff, new Set());
    return { ...base, sent: false, reason: quietReason(diff.unchanged.length), recipients: 0, mailed: 0, webhook: null };
  }

  const recipients = await resolveAlertRecipients(settings);
  if (dryRun) {
    return { ...base, sent: false, reason: "Preview only — nothing was sent and nothing was recorded.", recipients: recipients.length, mailed: 0, webhook: null };
  }

  const consoleUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/platform-admin/alerts`;
  const mailed = await mailDigest(recipients, sweep, filtered, consoleUrl);

  const webhook = await deliverAlertWebhook({
    event: "platform.alert_digest",
    deliveredAt: new Date().toISOString(),
    totals: sweep.totals,
    consoleUrl,
    appeared: filtered.appeared,
    escalated: filtered.escalated,
    cleared: filtered.cleared.map((row) => ({ organizationId: row.organizationId, key: row.alertKey, title: row.title, severity: row.severity }))
  });

  const delivered = mailed > 0 || webhook.ok;
  // ONLY what actually went out is marked reported. Everything else stays looking new, so the next
  // scheduled run is the retry. See the header's point (1).
  const reportedKeys = new Set(delivered ? [...filtered.appeared, ...filtered.escalated].map((alert) => identity(alert.organizationId, alert.key)) : []);
  await recordState(sweep.alerts, diff, reportedKeys, delivered ? filtered.cleared : []);

  if (delivered) {
    await controlPrisma.platformAlertSettings.update({ where: { id: "global" }, data: { lastSentAt: new Date() } }).catch(() => undefined);
    await platformAudit("SYSTEM", options.actorLabel ?? "alert-digest", "platform_alerts.digest_sent", "PlatformAlertSettings", "global", {
      appeared: filtered.appeared.length,
      escalated: filtered.escalated.length,
      cleared: filtered.cleared.length,
      mailed,
      webhook: webhook.status
    });
  }

  return {
    ...base,
    sent: delivered,
    reason: delivered
      ? `Reported ${filtered.appeared.length} new, ${filtered.escalated.length} escalated and ${filtered.cleared.length} cleared.`
      : `Nothing could be delivered (${mailed} emails, webhook ${webhook.status}) — these alerts stay unreported so the next run tries again.`,
    recipients: recipients.length,
    mailed,
    webhook
  };
}

/**
 * Write down what the sweep saw, and — separately — what was actually said.
 *
 * The two are separate parameters rather than one, because that separation IS the self-healing
 * property: `lastSeenAt` moves for every live alert on every run, while `lastReportedAt` moves only
 * for the keys in `reportedKeys`.
 */
async function recordState(current: FleetAlert[], diff: AlertDiff, reportedKeys: Set<string>, clearedNow: StoredAlertState[] = []): Promise<void> {
  const now = new Date();

  for (const alert of current) {
    const reported = reportedKeys.has(identity(alert.organizationId, alert.key));
    try {
      await controlPrisma.platformAlertState.upsert({
        where: { organizationId_alertKey: { organizationId: alert.organizationId, alertKey: alert.key } },
        create: {
          organizationId: alert.organizationId,
          alertKey: alert.key,
          severity: alert.severity,
          title: alert.title.slice(0, 255),
          detail: alert.detail,
          area: alert.area,
          firstSeenAt: now,
          lastSeenAt: now,
          ...(reported ? { lastReportedAt: now, reportedSeverity: alert.severity } : {})
        },
        update: {
          severity: alert.severity,
          title: alert.title.slice(0, 255),
          detail: alert.detail,
          area: alert.area,
          lastSeenAt: now,
          // A condition that had resolved and is back re-opens the SAME row rather than making a
          // second one, so the timeline reads as one thing coming and going — and `firstSeenAt`
          // deliberately keeps the original date, which is what "when did this start" means.
          resolvedAt: null,
          ...(reported ? { lastReportedAt: now, reportedSeverity: alert.severity } : {})
        }
      });
    } catch (error) {
      // One row's failure must not cost the rest of the sweep its record — the same isolation rule
      // the fleet loops follow. Recording is best-effort; the alert itself has already been sent.
      console.warn(`[platform-alerts] could not record ${alert.slug}/${alert.key}: ${(error as Error).message}`);
    }
  }

  // Resolve only what was actually announced as resolved. A condition that cleared while the relay
  // was down stays open, so its recovery notice is still owed on the next successful run.
  for (const row of clearedNow) {
    await controlPrisma.platformAlertState
      .updateMany({ where: { organizationId: row.organizationId, alertKey: row.alertKey, resolvedAt: null }, data: { resolvedAt: now } })
      .catch(() => undefined);
  }

  // Everything else that has gone quiet but was never reported: resolve it silently. It never
  // reached anybody, so there is nothing to announce and leaving it open would make it look new
  // forever the next time it flickers back.
  const unannounced = diff.cleared.length ? new Set(diff.cleared.map((row) => identity(row.organizationId, row.alertKey))) : new Set<string>();
  const liveKeys = new Set(current.map((alert) => identity(alert.organizationId, alert.key)));
  const stale = await controlPrisma.platformAlertState.findMany({ where: { resolvedAt: null, lastReportedAt: null } }).catch(() => []);
  for (const row of stale) {
    const id = identity(row.organizationId, row.alertKey);
    if (liveKeys.has(id) || unannounced.has(id)) continue;
    await controlPrisma.platformAlertState.update({ where: { id: row.id }, data: { resolvedAt: now } }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The console's read                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** Everything the Alerts page shows, in one read — the live sweep, the delivery configuration, and
 *  the open state rows that say how long each condition has been standing. One endpoint rather than
 *  four because the page's whole claim is that these agree with each other. */
export async function getAlertsOverview(): Promise<{
  sweep: FleetAlertSweep;
  settings: AlertSettings;
  open: Array<{ organizationId: string; alertKey: string; severity: string; firstSeenAt: Date; lastReportedAt: Date | null }>;
}> {
  const [sweep, settings, open] = await Promise.all([
    sweepFleetAlerts(),
    getAlertSettings(),
    controlPrisma.platformAlertState.findMany({
      where: { resolvedAt: null },
      select: { organizationId: true, alertKey: true, severity: true, firstSeenAt: true, lastReportedAt: true }
    })
  ]);
  return { sweep, settings, open };
}

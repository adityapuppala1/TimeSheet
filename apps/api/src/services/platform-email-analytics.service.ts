/**
 * WHAT: delivery analytics for PLATFORM email — the same questions the workspace-side
 * `email-analytics.service.ts` answers about a tenant's own mail, asked of `PlatformEmailLog`:
 * how much went out, how much failed, per template, per recipient DOMAIN, per TENANT, over time,
 * and why the failures failed.
 *
 * WHY IT IS A SEPARATE MODULE AND NOT A PARAMETER ON THE TENANT ONE. The two read different tables
 * in different databases through different clients: the tenant service reads `EmailLog` via the
 * tenant-scoped Prisma proxy and cannot run without a tenant context, and this one reads
 * `PlatformEmailLog` in the control plane, which has no tenant at all. They also count different
 * things — a tenant log has a QUEUED state and a retry queue behind it; the platform sender has
 * neither (it sends inline and records the attempt), so `SKIPPED` is its third state instead. One
 * function with a mode flag would be two functions sharing a name.
 *
 * WHAT IS DELIBERATELY THE SAME, because an operator who has read one screen should be able to read
 * the other: the window echo (`from`/`to` are what was MEASURED, not what was asked for), the
 * success rate that excludes not-yet-judged mail, the normalised failure reason, and the rule that
 * a domain bucket is derived in exactly one place so a malformed address cannot land in two.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { PLATFORM_TEMPLATES } from "./platform-mail-templates.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlatformCounts {
  sent: number;
  failed: number;
  skipped: number;
  test: number;
}

export interface PlatformRateRow extends PlatformCounts {
  /** sent / (sent + failed). Skipped is excluded — a message with no relay to try was never judged
   *  by a mail server, and counting it as a failure would blame the recipient for our own
   *  configuration. Null until something settles. */
  successRate: number | null;
}

export interface PlatformDomainRow extends PlatformRateRow {
  domain: string;
  topFailures: Array<{ reason: string; count: number }>;
  lastSentAt: string | null;
}

export interface PlatformTemplateRow extends PlatformRateRow {
  key: string;
  group: string;
  lastSentAt: string | null;
}

export interface PlatformTenantRow extends PlatformRateRow {
  organizationId: string | null;
  name: string;
  slug: string | null;
  status: string | null;
  /** Which retention stages this workspace has actually been sent, newest first. */
  markers: string[];
  lastSentAt: string | null;
}

export interface PlatformEmailAnalytics {
  from: string;
  to: string;
  windowDays: number;
  totals: PlatformRateRow;
  perDay: Array<{ day: string; sent: number; failed: number; skipped: number }>;
  perTemplate: PlatformTemplateRow[];
  perDomain: PlatformDomainRow[];
  perTenant: PlatformTenantRow[];
  failureReasons: Array<{ reason: string; count: number; lastAt: string }>;
  /** True when more distinct domains existed than are listed individually. */
  domainsTruncated: boolean;
}

const DOMAIN_LIMIT = 25;
const TENANT_LIMIT = 50;

const rateOf = (sent: number, failed: number): number | null => (sent + failed > 0 ? sent / (sent + failed) : null);

/** One rule for turning a recipient address into a domain bucket. */
function domainOf(to: string | null | undefined): string {
  const raw = String(to ?? "").trim();
  const domain = raw.includes("@") ? raw.split("@").pop()!.toLowerCase() : raw.toLowerCase();
  if (!domain) return "(no recipient)";
  return domain.includes(".") ? domain : "(invalid address)";
}

/**
 * Collapse an SMTP error to the shape of the problem, so twelve bounces from one cause group into
 * one line. Addresses, message ids, queue ids and the numeric parts of enhanced status codes are
 * the parts that differ per message and carry no diagnostic weight in aggregate.
 */
export function normalisePlatformFailure(raw: string | null | undefined): string {
  if (!raw) return "Unknown error";
  return (
    raw
      .replace(/<[^>]*@[^>]*>/g, "<address>")
      .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "<address>")
      .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "Unknown error"
  );
}

interface Bucket extends PlatformCounts {
  lastSentAt: Date | null;
}
const emptyBucket = (): Bucket => ({ sent: 0, failed: 0, skipped: 0, test: 0, lastSentAt: null });

function tally(bucket: Bucket, status: string, isTest: boolean, at: Date): void {
  if (isTest) {
    bucket.test += 1;
    return;
  }
  if (status === "SENT") {
    bucket.sent += 1;
    if (!bucket.lastSentAt || at > bucket.lastSentAt) bucket.lastSentAt = at;
  } else if (status === "FAILED") bucket.failed += 1;
  else bucket.skipped += 1;
}

const withRate = (b: Bucket) => ({ sent: b.sent, failed: b.failed, skipped: b.skipped, test: b.test, successRate: rateOf(b.sent, b.failed), lastSentAt: b.lastSentAt?.toISOString() ?? null });

/**
 * `fromIso`/`toIso` are inclusive calendar dates; omitted bounds default to the last 90 days.
 * Everything is computed from one read of the window — the row count here is platform-scale
 * (thousands, not millions), and one pass keeps every figure on this screen consistent with every
 * other, which grouped queries per card do not guarantee.
 */
export async function getPlatformEmailAnalytics(fromIso?: string, toIso?: string): Promise<PlatformEmailAnalytics> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const since = fromIso ? new Date(`${fromIso}T00:00:00`) : new Date(todayStart.getTime() - 89 * DAY_MS);
  const untilExclusive = toIso ? new Date(new Date(`${toIso}T00:00:00`).getTime() + DAY_MS) : new Date(todayStart.getTime() + DAY_MS);
  const windowDays = Math.max(1, Math.round((untilExclusive.getTime() - since.getTime()) / DAY_MS));

  const rows = await controlPrisma.platformEmailLog.findMany({
    where: { createdAt: { gte: since, lt: untilExclusive } },
    select: {
      templateKey: true,
      status: true,
      isTest: true,
      createdAt: true,
      errorMessage: true,
      to: true,
      organizationId: true,
      organization: { select: { name: true, slug: true, status: true } },
      dayMarker: true
    },
    orderBy: { createdAt: "desc" }
  });

  const totals = emptyBucket();
  const perTemplate = new Map<string, Bucket>();
  const perDomain = new Map<string, Bucket>();
  const perTenant = new Map<string, Bucket & { name: string; slug: string | null; status: string | null; markers: Set<string> }>();
  const perDay = new Map<string, { day: string; sent: number; failed: number; skipped: number }>();
  const domainFailures = new Map<string, Map<string, number>>();
  const failures = new Map<string, { count: number; lastAt: Date }>();

  for (const r of rows) {
    tally(totals, r.status, r.isTest, r.createdAt);

    const t = perTemplate.get(r.templateKey) ?? emptyBucket();
    tally(t, r.status, r.isTest, r.createdAt);
    perTemplate.set(r.templateKey, t);

    // Test sends are excluded from the domain, tenant and per-day series on purpose: an operator
    // mailing themselves six times to check a template would otherwise dominate the chart and drag
    // their own domain's success rate around.
    if (r.isTest) continue;

    const domain = domainOf(r.to);
    const d = perDomain.get(domain) ?? emptyBucket();
    tally(d, r.status, false, r.createdAt);
    perDomain.set(domain, d);

    const key = r.organizationId ?? "(no workspace)";
    const tenant =
      perTenant.get(key) ??
      Object.assign(emptyBucket(), {
        name: r.organization?.name ?? "Not tied to a workspace",
        slug: r.organization?.slug ?? null,
        status: r.organization?.status ?? null,
        markers: new Set<string>()
      });
    tally(tenant, r.status, false, r.createdAt);
    if (r.dayMarker) tenant.markers.add(r.dayMarker);
    perTenant.set(key, tenant);

    const day = r.createdAt.toISOString().slice(0, 10);
    const bucket = perDay.get(day) ?? { day, sent: 0, failed: 0, skipped: 0 };
    if (r.status === "SENT") bucket.sent += 1;
    else if (r.status === "FAILED") bucket.failed += 1;
    else bucket.skipped += 1;
    perDay.set(day, bucket);

    if (r.status === "FAILED") {
      const reason = normalisePlatformFailure(r.errorMessage);
      const seen = failures.get(reason);
      if (seen) {
        seen.count += 1;
        if (r.createdAt > seen.lastAt) seen.lastAt = r.createdAt;
      } else failures.set(reason, { count: 1, lastAt: r.createdAt });

      const perDomainFailure = domainFailures.get(domain) ?? new Map<string, number>();
      perDomainFailure.set(reason, (perDomainFailure.get(reason) ?? 0) + 1);
      domainFailures.set(domain, perDomainFailure);
    }
  }

  // Zero-filled, so the x-axis is time rather than "days on which mail happened".
  const days: PlatformEmailAnalytics["perDay"] = [];
  for (let t = since.getTime(); t < untilExclusive.getTime(); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    days.push(perDay.get(day) ?? { day, sent: 0, failed: 0, skipped: 0 });
  }

  const groupOf = new Map(PLATFORM_TEMPLATES.map((t) => [t.key, t.group as string]));
  const templates: PlatformTemplateRow[] = PLATFORM_TEMPLATES.map((def) => ({ key: def.key, group: def.group, ...withRate(perTemplate.get(def.key) ?? emptyBucket()) }));
  // Anything logged under a key the registry no longer knows about — a renamed template, or a raw
  // send. Shown rather than dropped: silently missing volume is how an analytics screen lies.
  for (const [key, bucket] of perTemplate) {
    if (!groupOf.has(key)) templates.push({ key, group: "Unregistered", ...withRate(bucket) });
  }

  const domains = [...perDomain.entries()]
    .map(([domain, bucket]) => ({
      domain,
      ...withRate(bucket),
      topFailures: [...(domainFailures.get(domain) ?? new Map())]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
    }))
    .sort((a, b) => b.sent + b.failed - (a.sent + a.failed));

  const tenants = [...perTenant.entries()]
    .map(([id, bucket]) => ({
      organizationId: id === "(no workspace)" ? null : id,
      name: bucket.name,
      slug: bucket.slug,
      status: bucket.status,
      markers: [...bucket.markers],
      ...withRate(bucket)
    }))
    .sort((a, b) => b.sent + b.failed - (a.sent + a.failed))
    .slice(0, TENANT_LIMIT);

  return {
    from: since.toISOString(),
    to: new Date(untilExclusive.getTime() - 1).toISOString(),
    windowDays,
    totals: { sent: totals.sent, failed: totals.failed, skipped: totals.skipped, test: totals.test, successRate: rateOf(totals.sent, totals.failed) },
    perDay: days,
    perTemplate: templates.sort((a, b) => b.sent + b.failed - (a.sent + a.failed)),
    perDomain: domains.slice(0, DOMAIN_LIMIT),
    perTenant: tenants,
    failureReasons: [...failures.entries()]
      .map(([reason, v]) => ({ reason, count: v.count, lastAt: v.lastAt.toISOString() }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    domainsTruncated: domains.length > DOMAIN_LIMIT
  };
}

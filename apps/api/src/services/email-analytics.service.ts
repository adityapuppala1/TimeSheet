/**
 * WHAT: aggregate read models over `EmailLog` for the admin Email templates screen — per-template
 * send counts with a today-vs-yesterday trend, daily/weekly/monthly volume, the success-vs-failure
 * split, and a grouped failure breakdown (reason -> affected recipients).
 * WHY this needs its own file: `EmailLog.template` is NOT a template key. `dispatchNotification`
 * writes the notification CATEGORY into that column while `dispatchTransactional` writes the
 * templateKey, so turning a log row back into one of the editor's template cards is a
 * reconciliation, not a join — see `LOG_ALIASES` and `resolveLogTemplate`. Anything that fails to
 * reconcile is reported in an explicit "unmapped" list; dropping it would make the per-template
 * numbers add up to less than the workspace total with no indication of where the rest went.
 * HOW: everything a client needs is aggregated in SQL / in this file. Raw `EmailLog` rows never
 * leave the server through these functions — the per-template "Recent sends" list in
 * `email-templates.controller.ts` is a separate, deliberately capped view.
 * WHO calls this: `controllers/email-templates.controller.ts`.
 */
import { prisma } from "../config/prisma.js";
import { TEMPLATE_KEYS } from "./template-store.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_SUFFIX = ".test";

/** Failure rows inspected per request. Grouping+normalisation happens in JS (SQL cannot strip
 *  volatile ids out of an SMTP string), so the window has to be bounded; `totalFailures` is a
 *  separate COUNT so the UI can say when it is looking at a sample rather than everything. */
const FAILURE_SAMPLE_CAP = 5_000;
/** Recipients returned per reason. A single misconfigured From-address can fail for the whole
 *  workspace; an admin debugging it needs a few dozen examples, not thousands. */
const RECIPIENTS_PER_REASON_CAP = 50;

/**
 * `EmailLog.template` values that do not equal the template-card key they belong to.
 *
 * Every other notification category happens to be spelled exactly like its template key, so the
 * identity case is handled by `TEMPLATE_KEYS` membership rather than being listed here.
 */
const LOG_ALIASES: Record<string, string[]> = {
  // face.service.ts sends the reminder under its own category but renders the *_required
  // template — one card, two categories feeding it.
  "face.enrollment_reminder": ["face.enrollment_required"],
  // One category, two templates: the escalation run mails the employee AND (conditionally) their
  // manager under the same `reminder.escalation` category, so a log row on its own cannot say
  // which of the two templates produced it. Attributed to both cards and flagged `shared`, so the
  // UI can label the number instead of quietly showing each card the pair's combined total.
  "reminder.escalation": ["reminder.escalation.employee", "reminder.escalation.manager"]
};

export interface ResolvedLogTemplate {
  /** Template-card keys this log row belongs to. Empty when nothing maps — an unmapped row. */
  cards: string[];
  /** Written by the editor's test / bulk-test paths as `<key>.test`, not a real transactional send. */
  isTest: boolean;
}

/** Reverse the category-vs-templateKey ambiguity described in this file's header. */
export function resolveLogTemplate(logTemplate: string): ResolvedLogTemplate {
  const isTest = logTemplate.endsWith(TEST_SUFFIX);
  const base = isTest ? logTemplate.slice(0, -TEST_SUFFIX.length) : logTemplate;
  const aliased = LOG_ALIASES[base];
  if (aliased) return { cards: aliased, isTest };
  if (TEMPLATE_KEYS.includes(base)) return { cards: [base], isTest };
  return { cards: [], isTest };
}

interface Counts {
  total: number;
  sent: number;
  failed: number;
  queued: number;
  /** Subset of `total` produced by the editor's test sends. */
  test: number;
  today: number;
  yesterday: number;
}

export interface TemplateVolumeRow extends Counts {
  key: string;
  /** `EmailLog.template` values that feed this row — what an admin would grep the log for. */
  sources: string[];
  /** True when at least one source also feeds another card, i.e. the number is a shared total
   *  that must not be summed across rows. */
  shared: boolean;
  sharedWith: string[];
}

export interface UnmappedVolumeRow extends Omit<Counts, "test"> {
  template: string;
}

export interface VolumeBucket {
  /** ISO date of the bucket start (day / Monday / 1st of month). Formatted by the client. */
  bucket: string;
  sent: number;
  failed: number;
  queued: number;
  total: number;
}

export interface EmailAnalytics {
  generatedAt: string;
  /** Raw workspace totals — computed independently of the per-template reconciliation so they
   *  stay correct even where a category maps to two cards or to none. */
  totals: { total: number; sent: number; failed: number; queued: number; test: number; unmapped: number };
  today: Omit<VolumeBucket, "bucket">;
  yesterday: Omit<VolumeBucket, "bucket">;
  perTemplate: TemplateVolumeRow[];
  unmapped: UnmappedVolumeRow[];
  daily: VolumeBucket[];
  weekly: VolumeBucket[];
  monthly: VolumeBucket[];
}

function emptyCounts(): Counts {
  return { total: 0, sent: 0, failed: 0, queued: 0, test: 0, today: 0, yesterday: 0 };
}

function startOfLocalDay(date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday-start weeks, matching the weekly buckets the rest of the reporting surface uses. */
function startOfLocalWeek(date: Date): Date {
  const d = startOfLocalDay(date);
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  return d;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addStatus(target: { sent: number; failed: number; queued: number; total: number }, status: string, n: number) {
  target.total += n;
  if (status === "SENT") target.sent += n;
  else if (status === "FAILED") target.failed += n;
  // Anything that is neither delivered nor refused is still in flight. Treated as a bucket rather
  // than matched on QUEUED specifically so a future EmailStatus member is never silently lost.
  else target.queued += n;
}

export async function getEmailAnalytics(): Promise<EmailAnalytics> {
  const todayStart = startOfLocalDay();
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);
  // 12 whole months of daily rows is at most ~365 * 3 status combinations — one query that the
  // daily, weekly AND monthly series are all folded out of, instead of three scans.
  const seriesSince = new Date(todayStart.getFullYear(), todayStart.getMonth() - 11, 1);

  const [allTime, todayGroups, yesterdayGroups, daily] = await Promise.all([
    prisma.emailLog.groupBy({ by: ["template", "status"], _count: { _all: true } }),
    prisma.emailLog.groupBy({ by: ["template", "status"], where: { createdAt: { gte: todayStart } }, _count: { _all: true } }),
    prisma.emailLog.groupBy({
      by: ["template", "status"],
      where: { createdAt: { gte: yesterdayStart, lt: todayStart } },
      _count: { _all: true }
    }),
    // Prisma's groupBy cannot bucket a DateTime. DATE() resolves in the session time zone, which
    // config/prisma.ts pins, so a "day" here is the same day the rest of the app reports.
    prisma.$queryRaw<Array<{ day: Date | string; status: string; n: bigint | number }>>`
      SELECT DATE(createdAt) AS day, status, COUNT(*) AS n
      FROM EmailLog
      WHERE createdAt >= ${seriesSince}
      GROUP BY day, status
    `
  ]);

  const byCard = new Map<string, Counts>(TEMPLATE_KEYS.map((key) => [key, emptyCounts()]));
  const byUnmapped = new Map<string, Counts>();
  const totals = { total: 0, sent: 0, failed: 0, queued: 0, test: 0, unmapped: 0 };
  const sourcesByCard = new Map<string, Set<string>>(TEMPLATE_KEYS.map((key) => [key, new Set<string>()]));
  const sharedWithByCard = new Map<string, Set<string>>(TEMPLATE_KEYS.map((key) => [key, new Set<string>()]));

  const windowCounts = new Map<string, Map<string, number>>([
    ["today", new Map(todayGroups.map((g) => [`${g.template}|${g.status}`, g._count._all]))],
    ["yesterday", new Map(yesterdayGroups.map((g) => [`${g.template}|${g.status}`, g._count._all]))]
  ]);

  for (const group of allTime) {
    const n = group._count._all;
    const { cards, isTest } = resolveLogTemplate(group.template);
    const todayN = windowCounts.get("today")!.get(`${group.template}|${group.status}`) ?? 0;
    const yesterdayN = windowCounts.get("yesterday")!.get(`${group.template}|${group.status}`) ?? 0;

    addStatus(totals, group.status, n);
    if (isTest) totals.test += n;

    if (cards.length === 0) {
      totals.unmapped += n;
      const bucket = byUnmapped.get(group.template) ?? emptyCounts();
      addStatus(bucket, group.status, n);
      bucket.today += todayN;
      bucket.yesterday += yesterdayN;
      byUnmapped.set(group.template, bucket);
      continue;
    }

    for (const card of cards) {
      const bucket = byCard.get(card)!;
      addStatus(bucket, group.status, n);
      if (isTest) bucket.test += n;
      bucket.today += todayN;
      bucket.yesterday += yesterdayN;
      sourcesByCard.get(card)!.add(group.template);
      for (const sibling of cards) if (sibling !== card) sharedWithByCard.get(card)!.add(sibling);
    }
  }

  // Card order follows TEMPLATE_KEYS so the analytics table reads in the same order as the grid.
  const perTemplate: TemplateVolumeRow[] = TEMPLATE_KEYS.map((key) => ({
    key,
    sources: Array.from(sourcesByCard.get(key)!).sort(),
    shared: sharedWithByCard.get(key)!.size > 0,
    sharedWith: Array.from(sharedWithByCard.get(key)!).sort(),
    ...byCard.get(key)!
  }));

  const unmapped: UnmappedVolumeRow[] = Array.from(byUnmapped.entries())
    .map(([template, counts]) => ({
      template,
      total: counts.total,
      sent: counts.sent,
      failed: counts.failed,
      queued: counts.queued,
      today: counts.today,
      yesterday: counts.yesterday
    }))
    .sort((a, b) => b.total - a.total);

  return {
    generatedAt: new Date().toISOString(),
    totals,
    ...buildSeries(daily, todayStart),
    perTemplate,
    unmapped
  };
}

function emptyBucket(bucket: string): VolumeBucket {
  return { bucket, sent: 0, failed: 0, queued: 0, total: 0 };
}

/** Fold the one daily aggregate into zero-filled daily (30d), weekly (12w) and monthly (12m)
 *  series. Zero-filling matters: a missing bucket renders as a gap the eye reads as "no data"
 *  rather than "nothing was sent". */
function buildSeries(
  rows: Array<{ day: Date | string; status: string; n: bigint | number }>,
  todayStart: Date
): { today: Omit<VolumeBucket, "bucket">; yesterday: Omit<VolumeBucket, "bucket">; daily: VolumeBucket[]; weekly: VolumeBucket[]; monthly: VolumeBucket[] } {
  const dayMap = new Map<string, VolumeBucket>();
  const weekMap = new Map<string, VolumeBucket>();
  const monthMap = new Map<string, VolumeBucket>();

  for (const row of rows) {
    // mysql2 hands DATE back as a Date; the string form is kept for driver configurations that
    // return it as one, rather than trusting a shape that isn't guaranteed.
    const day = row.day instanceof Date ? row.day : new Date(`${String(row.day)}T00:00:00`);
    const n = Number(row.n);
    const dayKey = isoDate(day);
    const weekKey = isoDate(startOfLocalWeek(day));
    const monthKey = isoDate(new Date(day.getFullYear(), day.getMonth(), 1));

    for (const [map, key] of [[dayMap, dayKey], [weekMap, weekKey], [monthMap, monthKey]] as const) {
      const bucket = map.get(key) ?? emptyBucket(key);
      addStatus(bucket, row.status, n);
      map.set(key, bucket);
    }
  }

  const daily = Array.from({ length: 30 }, (_, i) => {
    const key = isoDate(new Date(todayStart.getTime() - (29 - i) * DAY_MS));
    return dayMap.get(key) ?? emptyBucket(key);
  });
  const weekStart = startOfLocalWeek(todayStart);
  const weekly = Array.from({ length: 12 }, (_, i) => {
    const key = isoDate(new Date(weekStart.getTime() - (11 - i) * 7 * DAY_MS));
    return weekMap.get(key) ?? emptyBucket(key);
  });
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const key = isoDate(new Date(todayStart.getFullYear(), todayStart.getMonth() - (11 - i), 1));
    return monthMap.get(key) ?? emptyBucket(key);
  });

  const strip = ({ sent, failed, queued, total }: VolumeBucket) => ({ sent, failed, queued, total });
  return {
    today: strip(dayMap.get(isoDate(todayStart)) ?? emptyBucket("")),
    yesterday: strip(dayMap.get(isoDate(new Date(todayStart.getTime() - DAY_MS))) ?? emptyBucket("")),
    daily,
    weekly,
    monthly
  };
}

/* ============================== Failure breakdown ============================== */

/**
 * Collapse the volatile parts of an SMTP rejection so two attempts that failed for the SAME
 * reason group together. Queue ids, message ids, IPs and the rejected address all change on
 * every attempt; without this, "550 mailbox unavailable" for 400 recipients reads as 400
 * distinct one-off failures and the actual pattern is invisible. Numeric SMTP codes (`550`,
 * `5.7.1`) are deliberately left intact — they are the signal, not the noise.
 */
export function normalizeErrorMessage(raw: string): string {
  return raw
    .replace(/<[^<>\s]+@[^<>\s]+>/g, "<message-id>")
    // Bounded rather than open `+` quantifiers: RFC 5321 caps a local part at 64 characters and
    // each domain label at 63, so nothing real is lost, and the bound is what keeps a long run of
    // word characters containing no "@" from being rescanned from every position (~180ms on 20k).
    .replace(/[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g, "<address>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g, "<timestamp>")
    // Opaque tokens: 8+ chars mixing letters and digits (SMTP queue ids, hex digests, boundary
    // markers). The lookaheads keep plain words ("authentication") and plain numbers (status
    // codes, port numbers) out of it.
    .replace(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}\b/g, "<id>")
    // Compound ids: Gmail rejections end in a session token like `a1b2c3d4e5-f6g7h8i9j0.7`,
    // whose HALVES the rule above catches but whose joiner and ordinal survive — so the same
    // "421 Temporary System Problem" grouped into one bucket per `.N` suffix and the pattern
    // (dozens of throttled sends, one cause) read as six unrelated errors. Real SMTP status
    // codes ("4.3.0") never contain an `<id>`, so they are untouched.
    .replace(/<id>(?:\s*-\s*<id>)*(?:\.\d+)?/g, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Stable, short id for a normalised reason so the client has a React key and a drill-in handle
 *  that survives a refetch (FNV-1a — this is a cache key, never a security boundary). */
function reasonId(normalized: string): string {
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export interface FailureRecipient {
  to: string;
  count: number;
  lastAt: string;
  /** The raw, un-normalised SMTP text for this recipient's most recent failure. */
  lastMessage: string;
}

export interface FailureReason {
  id: string;
  /** Normalised, groupable form — volatile ids replaced with `<placeholder>` markers. */
  reason: string;
  /** One verbatim message from the group, so the real SMTP text stays viewable. */
  sample: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  templates: Array<{ template: string; count: number }>;
  recipients: FailureRecipient[];
  /** True when `recipients` was capped — the list is a sample, not the whole set. */
  recipientsTruncated: boolean;
  /** Recipient domains across the WHOLE group (not just the capped recipient sample) — what the
   *  AI diagnosis is given instead of addresses, and what tells an admin "this is a gmail.com
   *  problem" at a glance. Top 10 by count. */
  domains: Array<{ domain: string; count: number }>;
}

export interface EmailFailureBreakdown {
  windowDays: number;
  since: string;
  totalFailures: number;
  /** How many of `totalFailures` were actually inspected (see FAILURE_SAMPLE_CAP). */
  sampledFailures: number;
  reasons: FailureReason[];
}

export async function getEmailFailureBreakdown(windowDays: number): Promise<EmailFailureBreakdown> {
  const since = new Date(startOfLocalDay().getTime() - (windowDays - 1) * DAY_MS);

  const [totalFailures, rows] = await Promise.all([
    prisma.emailLog.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
    prisma.emailLog.findMany({
      where: { status: "FAILED", createdAt: { gte: since } },
      // Only the four columns the breakdown needs — no subject, no metadata, no body-adjacent data.
      select: { to: true, template: true, errorMessage: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: FAILURE_SAMPLE_CAP
    })
  ]);

  interface Group {
    reason: string;
    sample: string;
    count: number;
    firstSeen: Date;
    lastSeen: Date;
    templates: Map<string, number>;
    recipients: Map<string, { count: number; lastAt: Date; lastMessage: string }>;
    domains: Map<string, number>;
  }
  const groups = new Map<string, Group>();

  for (const row of rows) {
    // A FAILED row with no errorMessage is a real state (the "no SMTP host" path writes one, but
    // an interrupted update may not) — bucketed explicitly instead of being skipped.
    const raw = row.errorMessage?.trim() || "No error message recorded";
    const reason = normalizeErrorMessage(raw);
    const group = groups.get(reason) ?? {
      reason,
      sample: raw,
      count: 0,
      firstSeen: row.createdAt,
      lastSeen: row.createdAt,
      templates: new Map<string, number>(),
      recipients: new Map<string, { count: number; lastAt: Date; lastMessage: string }>(),
      domains: new Map<string, number>()
    };
    group.count += 1;
    if (row.createdAt < group.firstSeen) group.firstSeen = row.createdAt;
    if (row.createdAt > group.lastSeen) group.lastSeen = row.createdAt;
    group.templates.set(row.template, (group.templates.get(row.template) ?? 0) + 1);
    const domain = row.to.includes("@") ? row.to.split("@").pop()!.toLowerCase() : "(invalid address)";
    group.domains.set(domain, (group.domains.get(domain) ?? 0) + 1);

    const recipient = group.recipients.get(row.to);
    if (!recipient) {
      group.recipients.set(row.to, { count: 1, lastAt: row.createdAt, lastMessage: raw });
    } else {
      recipient.count += 1;
      if (row.createdAt > recipient.lastAt) {
        recipient.lastAt = row.createdAt;
        recipient.lastMessage = raw;
      }
    }
    groups.set(reason, group);
  }

  const reasons: FailureReason[] = Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .map((group) => ({
      id: reasonId(group.reason),
      reason: group.reason,
      sample: group.sample,
      count: group.count,
      firstSeen: group.firstSeen.toISOString(),
      lastSeen: group.lastSeen.toISOString(),
      templates: Array.from(group.templates.entries())
        .map(([template, count]) => ({ template, count }))
        .sort((a, b) => b.count - a.count),
      recipients: Array.from(group.recipients.entries())
        .map(([to, r]) => ({ to, count: r.count, lastAt: r.lastAt.toISOString(), lastMessage: r.lastMessage }))
        .sort((a, b) => b.count - a.count || (a.to < b.to ? -1 : 1))
        .slice(0, RECIPIENTS_PER_REASON_CAP),
      recipientsTruncated: group.recipients.size > RECIPIENTS_PER_REASON_CAP,
      domains: Array.from(group.domains.entries())
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : 1))
        .slice(0, 10)
    }));

  return {
    windowDays,
    since: since.toISOString(),
    totalFailures,
    sampledFailures: rows.length,
    reasons
  };
}

/* ============================== Delivery by domain ============================== */

/** Domains listed individually; the tail beyond this is aggregated into one "(other)" row so a
 *  workspace mailing 400 distinct domains still gets a readable table AND honest totals. */
const DOMAIN_ROWS_CAP = 20;
/** Zero-filled chart buckets are capped so an "entire year" range cannot mint 4000 DOM nodes;
 *  past the cap the series simply contains only the days that had traffic. */
const DAILY_FILL_CAP = 400;

export interface EmailDomainRow {
  domain: string;
  total: number;
  sent: number;
  failed: number;
  queued: number;
  /** sent / (sent + failed). Queued is excluded — in-flight mail hasn't been judged yet, and
   *  counting it either way would swing the rate on every worker tick. Null until something
   *  settles. */
  successRate: number | null;
  /** This domain's top failure reasons in the window (normalised form, top 3) — what turns "12
   *  failed at gmail.com" into "gmail.com is throttling us" without leaving the table. */
  topFailures: Array<{ reason: string; count: number }>;
  /** Oldest still-in-flight send to this domain. In-flight mail normally settles within one
   *  worker tick, so an old timestamp here means STUCK, not busy. */
  oldestQueuedAt: string | null;
}

export interface EmailDomainStats {
  /** Echo of the resolved window (ISO datetimes) so the client renders what was measured, not
   *  what it asked for. */
  from: string;
  to: string;
  totals: EmailDomainRow;
  domains: EmailDomainRow[];
  /** True when more distinct domains existed than are listed individually. */
  truncated: boolean;
  daily: VolumeBucket[];
}

function rateOf(sent: number, failed: number): number | null {
  return sent + failed > 0 ? sent / (sent + failed) : null;
}

/** One rule for turning a recipient address into a domain bucket, shared by every aggregation in
 *  this section so a malformed address can never land in different buckets per query. */
function domainOf(to: string | null | undefined): string {
  const raw = String(to ?? "");
  const domain = raw.includes("@") ? raw.split("@").pop()!.toLowerCase() : raw.toLowerCase();
  return domain.includes(".") ? domain : "(invalid address)";
}

/**
 * Per-recipient-domain delivery split over a date range — which domains fail, which are still in
 * flight, and each one's success rate. `from`/`to` are ISO dates (inclusive); omitted bounds
 * default to the last 30 days ending today.
 */
export async function getEmailDomainStats(fromIso?: string, toIso?: string): Promise<EmailDomainStats> {
  const todayStart = startOfLocalDay();
  const since = fromIso ? new Date(`${fromIso}T00:00:00`) : new Date(todayStart.getTime() - 29 * DAY_MS);
  const untilExclusive = toIso ? new Date(new Date(`${toIso}T00:00:00`).getTime() + DAY_MS) : new Date(todayStart.getTime() + DAY_MS);

  const [byDomain, dailyRows, failedRows, queuedAges] = await Promise.all([
    // `to` needs backticks — it is a MySQL reserved word as well as this table's recipient column.
    prisma.$queryRaw<Array<{ domain: string | null; status: string; n: bigint | number }>>`
      SELECT LOWER(SUBSTRING_INDEX(\`to\`, '@', -1)) AS domain, status, COUNT(*) AS n
      FROM EmailLog
      WHERE createdAt >= ${since} AND createdAt < ${untilExclusive}
      GROUP BY domain, status
    `,
    prisma.$queryRaw<Array<{ day: Date | string; status: string; n: bigint | number }>>`
      SELECT DATE(createdAt) AS day, status, COUNT(*) AS n
      FROM EmailLog
      WHERE createdAt >= ${since} AND createdAt < ${untilExclusive}
      GROUP BY day, status
    `,
    // Same normalise-in-JS reasoning (and the same sample cap) as getEmailFailureBreakdown: SQL
    // cannot strip volatile ids out of an SMTP string, so grouping happens here.
    prisma.emailLog.findMany({
      where: { status: "FAILED", createdAt: { gte: since, lt: untilExclusive } },
      select: { to: true, errorMessage: true },
      orderBy: { createdAt: "desc" },
      take: FAILURE_SAMPLE_CAP
    }),
    // "Not settled" mirrors addStatus's queued bucket: anything neither delivered nor refused.
    prisma.$queryRaw<Array<{ domain: string | null; oldest: Date | string }>>`
      SELECT LOWER(SUBSTRING_INDEX(\`to\`, '@', -1)) AS domain, MIN(createdAt) AS oldest
      FROM EmailLog
      WHERE status NOT IN ('SENT', 'FAILED') AND createdAt >= ${since} AND createdAt < ${untilExclusive}
      GROUP BY domain
    `
  ]);

  const failuresByDomain = new Map<string, Map<string, number>>();
  for (const row of failedRows) {
    const key = domainOf(row.to);
    const reason = normalizeErrorMessage(row.errorMessage?.trim() || "No error message recorded");
    const reasons = failuresByDomain.get(key) ?? new Map<string, number>();
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    failuresByDomain.set(key, reasons);
  }
  const topFailuresFor = (domain: string) =>
    Array.from((failuresByDomain.get(domain) ?? new Map<string, number>()).entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

  const oldestQueuedByDomain = new Map<string, string>();
  for (const row of queuedAges) {
    const key = row.domain && row.domain.includes(".") ? row.domain : "(invalid address)";
    const oldest = row.oldest instanceof Date ? row.oldest : new Date(`${String(row.oldest)}Z`.replace(" ", "T"));
    if (!Number.isNaN(oldest.getTime())) oldestQueuedByDomain.set(key, oldest.toISOString());
  }

  const perDomain = new Map<string, { sent: number; failed: number; queued: number; total: number }>();
  const totalsAcc = { sent: 0, failed: 0, queued: 0, total: 0 };
  for (const row of byDomain) {
    // An address with no "@" makes SUBSTRING_INDEX return the whole string; bucket those (and
    // NULLs) explicitly rather than letting garbage pose as a domain.
    const key = row.domain && row.domain.includes(".") ? row.domain : "(invalid address)";
    const bucket = perDomain.get(key) ?? { sent: 0, failed: 0, queued: 0, total: 0 };
    addStatus(bucket, row.status, Number(row.n));
    addStatus(totalsAcc, row.status, Number(row.n));
    perDomain.set(key, bucket);
  }

  const ranked = Array.from(perDomain.entries())
    .map(([domain, counts]) => ({
      domain,
      ...counts,
      successRate: rateOf(counts.sent, counts.failed),
      topFailures: topFailuresFor(domain),
      oldestQueuedAt: counts.queued > 0 ? oldestQueuedByDomain.get(domain) ?? null : null
    }))
    .sort((a, b) => b.total - a.total || (a.domain < b.domain ? -1 : 1));

  const listed = ranked.slice(0, DOMAIN_ROWS_CAP);
  const tail = ranked.slice(DOMAIN_ROWS_CAP);
  if (tail.length > 0) {
    const other = tail.reduce(
      (acc, row) => ({
        sent: acc.sent + row.sent,
        failed: acc.failed + row.failed,
        queued: acc.queued + row.queued,
        total: acc.total + row.total
      }),
      { sent: 0, failed: 0, queued: 0, total: 0 }
    );
    listed.push({
      domain: `(${tail.length} other domains)`,
      ...other,
      successRate: rateOf(other.sent, other.failed),
      topFailures: [],
      oldestQueuedAt: null
    });
  }

  // Zero-filled daily series across the window (bounded — see DAILY_FILL_CAP).
  const dayMap = new Map<string, VolumeBucket>();
  for (const row of dailyRows) {
    const day = row.day instanceof Date ? row.day : new Date(`${String(row.day)}T00:00:00`);
    const key = isoDate(day);
    const bucket = dayMap.get(key) ?? emptyBucket(key);
    addStatus(bucket, row.status, Number(row.n));
    dayMap.set(key, bucket);
  }
  const spanDays = Math.round((untilExclusive.getTime() - since.getTime()) / DAY_MS);
  const daily: VolumeBucket[] =
    spanDays <= DAILY_FILL_CAP
      ? Array.from({ length: Math.max(spanDays, 1) }, (_, i) => {
          const key = isoDate(new Date(since.getTime() + i * DAY_MS));
          return dayMap.get(key) ?? emptyBucket(key);
        })
      : Array.from(dayMap.values()).sort((a, b) => (a.bucket < b.bucket ? -1 : 1));

  return {
    from: since.toISOString(),
    to: new Date(untilExclusive.getTime() - 1).toISOString(),
    totals: {
      domain: "all",
      ...totalsAcc,
      successRate: rateOf(totalsAcc.sent, totalsAcc.failed),
      topFailures: [],
      oldestQueuedAt: null
    },
    domains: listed,
    truncated: tail.length > 0,
    daily
  };
}

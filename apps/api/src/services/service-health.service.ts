/**
 * WHAT: feature-level health monitoring and the recorded downtime history behind the status page.
 *
 * HOW THIS DIFFERS FROM system-health.service.ts, which already exists: that one answers "is this
 * BOX healthy" — CPU, memory, disk, event-loop lag, and whether the databases answer a ping. This
 * one answers "does this FEATURE work", which is a different question with a different audience.
 * A server with 12% CPU and both databases responding is perfectly healthy right up until the
 * moment nobody can submit a timesheet, and the person asking "why couldn't I submit yesterday"
 * is not helped by a CPU graph.
 *
 * WHAT A PROBE IS ALLOWED TO BE. Each probe exercises the dependency the feature actually needs —
 * a bounded query against the tables it reads, the mail transport's own verification state, the
 * AI provider's configuration. Deliberately NOT an HTTP self-call: the API calling itself proves
 * the process can reach itself, needs a credential to get past auth, and turns every health check
 * into a request that can itself fail for reasons unrelated to the feature. And deliberately NOT
 * a write — a monitor that creates rows every five minutes to prove writes work has become a
 * source of the load it is measuring.
 *
 * THREE STATES, NOT TWO. "Slow but answering" and "not answering" call for different reactions,
 * and collapsing them means either crying wolf over a slow query or staying silent while the
 * product becomes unusable. Every probe carries its own DEGRADED threshold because the honest
 * bar differs: a ticket list has to feel instant, a report is allowed to take a moment.
 *
 * INCIDENTS ARE RECORDED, NOT DERIVED ON READ. They have to outlive the samples that produced
 * them — samples get pruned, and "we were down for 40 minutes on the 3rd" must survive that,
 * because it is exactly the record somebody returns to months later. Deriving them at read time
 * would also let a pruning job silently rewrite history.
 *
 * WHO CALLS THIS: workers/service-health.worker.ts (every 5 minutes, per org) and
 * controllers/maintenance.controller.ts (the status page).
 */
import { prisma } from "../config/prisma.js";
import { controlPrisma } from "../config/control-prisma.js";
import { getTransportStatus } from "./mail.service.js";

export type ServiceStatusValue = "OPERATIONAL" | "DEGRADED" | "DOWN";

export interface ServiceDefinition {
  key: string;
  label: string;
  /** One line the reader can act on, shown under the name. */
  description: string;
  /** Above this many milliseconds the service is DEGRADED rather than OPERATIONAL. */
  degradedMs: number;
  probe: () => Promise<{ ok: boolean; detail?: string }>;
}

/** Anything slower than this is treated as a failure rather than waited on — a probe that hangs
 *  for thirty seconds turns the monitor itself into an outage. */
const PROBE_TIMEOUT_MS = 5_000;

async function withTimeout<T>(work: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * The monitored surface.
 *
 * Ordered as a reader scans it: the things everything else depends on first, then the features
 * people use, then the optional integrations. A status page sorted alphabetically makes the
 * reader do the dependency reasoning themselves — if the database is down, the six red rows
 * underneath it are noise, and they should read as consequences rather than six problems.
 */
export const SERVICES: ServiceDefinition[] = [
  {
    key: "api",
    label: "API",
    description: "The application server itself",
    degradedMs: 200,
    probe: async () => ({ ok: true, detail: `up ${Math.floor(process.uptime() / 60)} min` })
  },
  {
    key: "database",
    label: "Database",
    description: "This workspace's own database",
    degradedMs: 400,
    probe: async () => {
      await withTimeout(prisma.$queryRaw`SELECT 1`);
      return { ok: true };
    }
  },
  {
    key: "control-plane",
    label: "Control plane",
    description: "Org, plan and licence lookups",
    degradedMs: 500,
    probe: async () => {
      await withTimeout(controlPrisma.$queryRaw`SELECT 1`);
      return { ok: true };
    }
  },
  {
    key: "auth",
    label: "Sign-in & sessions",
    description: "Signing in and staying signed in",
    degradedMs: 500,
    probe: async () => {
      await withTimeout(prisma.session.count({ where: { revokedAt: null } }));
      return { ok: true };
    }
  },
  {
    key: "timesheets",
    label: "Timesheets",
    description: "Logging, submitting and approving time",
    degradedMs: 800,
    probe: async () => {
      await withTimeout(prisma.timesheet.count());
      return { ok: true };
    }
  },
  {
    key: "tickets",
    label: "Tickets",
    description: "Creating and progressing work items",
    degradedMs: 800,
    probe: async () => {
      await withTimeout(prisma.ticket.count());
      return { ok: true };
    }
  },
  {
    key: "reports",
    label: "Reports",
    description: "Aggregates and exports",
    // Allowed to be slower than a list: a report that takes a moment is doing its job, and
    // flagging it at the same bar as a ticket list would mean permanent amber.
    degradedMs: 2_000,
    probe: async () => {
      await withTimeout(prisma.timesheet.aggregate({ _sum: { totalHours: true } }));
      return { ok: true };
    }
  },
  {
    key: "attachments",
    label: "Files & attachments",
    description: "Uploading and downloading files",
    degradedMs: 800,
    probe: async () => {
      await withTimeout(prisma.ticketAttachment.count());
      return { ok: true };
    }
  },
  {
    key: "email",
    label: "Email delivery",
    description: "Notifications, welcome mail and scheduled reports",
    degradedMs: 1_500,
    probe: async () => {
      const status = await withTimeout(Promise.resolve(getTransportStatus()));
      // "Not configured" is a CHOICE, not a fault. Reporting an unconfigured optional integration
      // as an outage would leave a permanent red row that trains people to ignore the page — the
      // single most common way a status page stops being read.
      if (!status?.configured) return { ok: true, detail: "not configured" };
      if (status.verified === false) return { ok: false, detail: status.verifyError ?? "SMTP verification failed" };
      return { ok: true, detail: `${status.host}:${status.port}` };
    }
  },
  {
    key: "ai",
    label: "AI features",
    description: "Triage, summaries and the planning copilot",
    degradedMs: 1_000,
    probe: async () => {
      const settings = await withTimeout(prisma.globalAISettings.findUnique({ where: { id: "global" } }));
      if (!settings?.aiEnabled) return { ok: true, detail: "switched off" };
      const hasKey = Boolean(settings.apiKey);
      return hasKey ? { ok: true } : { ok: false, detail: "enabled but no API key is configured" };
    }
  },
  {
    key: "face",
    label: "Face verification",
    description: "Identity checks on protected actions",
    degradedMs: 1_000,
    probe: async () => {
      const settings = await withTimeout(prisma.globalFaceVerificationSettings.findUnique({ where: { id: "global" } }));
      if (!settings?.enabled) return { ok: true, detail: "switched off" };
      const enrolled = await withTimeout(prisma.faceEnrollment.count());
      return { ok: true, detail: `${enrolled} enrolled` };
    }
  },
  {
    key: "planning",
    label: "Planning",
    description: "Timeline, portfolios and resourcing",
    degradedMs: 1_000,
    probe: async () => {
      const settings = await withTimeout(prisma.globalPlanningSettings.findUnique({ where: { id: "global" } }));
      if (!settings?.enablePlanning) return { ok: true, detail: "switched off" };
      await withTimeout(prisma.ticket.count({ where: { startDate: { not: null } } }));
      return { ok: true };
    }
  },
  {
    key: "integrations",
    label: "Integrations",
    description: "Webhooks, git and inbound intake",
    degradedMs: 1_000,
    probe: async () => {
      await withTimeout(prisma.outboundWebhook.count());
      return { ok: true };
    }
  }
];

export interface ProbeResult {
  service: string;
  status: ServiceStatusValue;
  latencyMs: number;
  detail: string | null;
}

/** Runs one probe and classifies the outcome. Never throws — a monitor that fails is not a monitor. */
export async function probeService(definition: ServiceDefinition): Promise<ProbeResult> {
  const startedAt = performance.now();
  try {
    const result = await definition.probe();
    const latencyMs = Math.round(performance.now() - startedAt);
    if (!result.ok) {
      return { service: definition.key, status: "DOWN", latencyMs, detail: result.detail ?? "check failed" };
    }
    return {
      service: definition.key,
      status: latencyMs > definition.degradedMs ? "DEGRADED" : "OPERATIONAL",
      latencyMs,
      detail: latencyMs > definition.degradedMs ? `slow: ${latencyMs}ms` : (result.detail ?? null)
    };
  } catch (err) {
    return {
      service: definition.key,
      status: "DOWN",
      latencyMs: Math.round(performance.now() - startedAt),
      detail: (err as Error)?.message?.slice(0, 480) ?? "check threw"
    };
  }
}

/** How long raw samples are kept. Beyond this the daily rollup is what anyone reads, and at one
 *  sample per service per five minutes the raw stream is ~100k rows a year per tenant. */
export const SAMPLE_RETENTION_DAYS = 45;

/**
 * Probe everything, record the samples, and open or close incidents accordingly.
 *
 * The incident logic is deliberately simple and stateful rather than clever: an ongoing incident
 * for a service either continues (and takes the worst status seen so far) or is closed by the
 * first operational sample. No flap suppression — a service that alternates up and down every
 * five minutes has a real problem, and smoothing it away would hide exactly the pattern worth
 * seeing. `sampleCount` records how many consecutive failing probes an incident spanned, so a
 * one-sample blip is distinguishable from a sustained outage on read.
 */
export async function runHealthChecks(): Promise<ProbeResult[]> {
  const results = await Promise.all(SERVICES.map(probeService));

  await prisma.serviceHealthSample.createMany({
    data: results.map((r) => ({
      service: r.service,
      status: r.status,
      latencyMs: r.latencyMs,
      detail: r.detail?.slice(0, 480) ?? null
    }))
  });

  const open = await prisma.serviceIncident.findMany({ where: { endedAt: null } });
  const openByService = new Map(open.map((i) => [i.service, i]));

  for (const result of results) {
    const existing = openByService.get(result.service);
    if (result.status === "OPERATIONAL") {
      if (existing) {
        await prisma.serviceIncident.update({ where: { id: existing.id }, data: { endedAt: new Date() } });
      }
      continue;
    }
    if (existing) {
      await prisma.serviceIncident.update({
        where: { id: existing.id },
        data: {
          // DOWN outranks DEGRADED: an incident that dipped fully down should not read as a
          // slowdown once it recovers to merely slow.
          status: existing.status === "DOWN" ? "DOWN" : result.status,
          sampleCount: { increment: 1 },
          detail: result.detail ?? existing.detail
        }
      });
    } else {
      await prisma.serviceIncident.create({
        data: { service: result.service, status: result.status, detail: result.detail }
      });
    }
  }

  const cutoff = new Date(Date.now() - SAMPLE_RETENTION_DAYS * 86_400_000);
  await prisma.serviceHealthSample.deleteMany({ where: { checkedAt: { lt: cutoff } } });

  return results;
}

export interface StatusDay {
  date: string;
  /** Null when nothing was sampled that day — a gap is not an outage, and colouring it green
   *  would be a claim the data does not support. */
  status: ServiceStatusValue | null;
  samples: number;
  downSamples: number;
  degradedSamples: number;
  uptimePct: number | null;
}

export interface StatusPageService {
  key: string;
  label: string;
  description: string;
  current: ServiceStatusValue | null;
  currentDetail: string | null;
  lastCheckedAt: string | null;
  avgLatencyMs: number | null;
  uptimePct: number | null;
  days: StatusDay[];
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * The status page: current state per service, a day-by-day strip, and the incident log.
 *
 * A DAY IS COLOURED BY ITS WORST SAMPLE, not its average. Averaging is how a two-hour outage
 * disappears into a 96%-green day, and the whole reason somebody opens this page is to find the
 * bad hour. The uptime percentage alongside carries the magnitude, so the two together say both
 * "something happened" and "how much".
 */
export async function getStatusPage(days: number) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));

  const [samples, incidents] = await Promise.all([
    prisma.serviceHealthSample.findMany({
      where: { checkedAt: { gte: from } },
      select: { service: true, status: true, latencyMs: true, detail: true, checkedAt: true },
      orderBy: { checkedAt: "asc" }
    }),
    prisma.serviceIncident.findMany({
      where: { OR: [{ endedAt: null }, { startedAt: { gte: from } }] },
      orderBy: { startedAt: "desc" },
      take: 100
    })
  ]);

  const byService = new Map<string, typeof samples>();
  for (const sample of samples) {
    const list = byService.get(sample.service) ?? [];
    list.push(sample);
    byService.set(sample.service, list);
  }

  const services: StatusPageService[] = SERVICES.map((definition) => {
    const mine = byService.get(definition.key) ?? [];
    const latest = mine[mine.length - 1];

    const perDay = new Map<string, { total: number; down: number; degraded: number }>();
    for (const sample of mine) {
      const key = dayKey(sample.checkedAt);
      const bucket = perDay.get(key) ?? { total: 0, down: 0, degraded: 0 };
      bucket.total += 1;
      if (sample.status === "DOWN") bucket.down += 1;
      if (sample.status === "DEGRADED") bucket.degraded += 1;
      perDay.set(key, bucket);
    }

    const dayList: StatusDay[] = [];
    for (let i = 0; i < days; i += 1) {
      const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      const key = dayKey(date);
      const bucket = perDay.get(key);
      if (!bucket) {
        dayList.push({ date: key, status: null, samples: 0, downSamples: 0, degradedSamples: 0, uptimePct: null });
        continue;
      }
      dayList.push({
        date: key,
        status: bucket.down > 0 ? "DOWN" : bucket.degraded > 0 ? "DEGRADED" : "OPERATIONAL",
        samples: bucket.total,
        downSamples: bucket.down,
        degradedSamples: bucket.degraded,
        uptimePct: Number((((bucket.total - bucket.down) / bucket.total) * 100).toFixed(2))
      });
    }

    const measured = dayList.filter((d) => d.samples > 0);
    const totalSamples = measured.reduce((s, d) => s + d.samples, 0);
    const totalDown = measured.reduce((s, d) => s + d.downSamples, 0);
    const latencies = mine.map((s) => s.latencyMs).filter((v): v is number => typeof v === "number");

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      current: latest?.status ?? null,
      currentDetail: latest?.detail ?? null,
      lastCheckedAt: latest?.checkedAt.toISOString() ?? null,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      uptimePct: totalSamples === 0 ? null : Number((((totalSamples - totalDown) / totalSamples) * 100).toFixed(3)),
      days: dayList
    };
  });

  const labels = new Map(SERVICES.map((s) => [s.key, s.label]));
  const anyDown = services.some((s) => s.current === "DOWN");
  const anyDegraded = services.some((s) => s.current === "DEGRADED");
  const anyMeasured = services.some((s) => s.current !== null);

  return {
    from: dayKey(from),
    to: dayKey(now),
    days,
    // The headline. Null when nothing has been sampled yet — a page that says "All systems
    // operational" before it has ever run a check is stating something it does not know.
    overall: !anyMeasured ? null : anyDown ? "DOWN" : anyDegraded ? "DEGRADED" : "OPERATIONAL",
    services,
    incidents: incidents.map((incident) => ({
      id: incident.id,
      service: incident.service,
      serviceLabel: labels.get(incident.service) ?? incident.service,
      status: incident.status,
      startedAt: incident.startedAt.toISOString(),
      endedAt: incident.endedAt?.toISOString() ?? null,
      detail: incident.detail,
      sampleCount: incident.sampleCount,
      durationMinutes: Math.max(
        1,
        Math.round(((incident.endedAt ?? new Date()).getTime() - incident.startedAt.getTime()) / 60_000)
      )
    }))
  };
}

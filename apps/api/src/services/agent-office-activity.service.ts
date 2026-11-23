/**
 * WHAT: the Agents Office's activity feed — the last 24 hours of real agent runs, shaped so the 3D
 * office can replay them: who ran what, against which project, the queue each agent has waiting, and
 * which runs FED which (hand-offs).
 *
 * THE HAND-OFF RULE (nothing in the schema links one run to another, so this is derived and
 * deliberately conservative). Run B is linked FROM run A when all of these hold:
 *   1. A and B belong to different agents;
 *   2. A finished as COMPLETED or PARTIAL (work that produced something);
 *   3. they share a target — the same automation flow (`flowId`, kind "flow", the strongest signal
 *      that A's output was B's input) or, failing that, the same project (`scopeProjectId`, kind
 *      "project");
 *   4. B was created at or after A finished, and within HANDOFF_WINDOW_MS of it.
 * Each B gets at most ONE upstream link: the most recent A that qualifies, preferring a flow link.
 * A link is a claim that "B picked up where A left off", never that B read A's output verbatim.
 *
 * VISIBILITY: a run whose project the viewer cannot see (ticketProjectScope) keeps its timing — the
 * office still shows that agent was busy — but loses its project id, title and summary line, and is
 * never used for a hand-off, so a link cannot reveal that two agents touched a hidden project.
 * Tenant scoping is the request's tenant Prisma client, the same as every roster read.
 *
 * WHO CALLS THIS: controllers/agent.controller.ts `GET /agents/office-activity`.
 */
import { prisma } from "../config/prisma.js";

export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HANDOFF_WINDOW_MS = 30 * 60 * 1000;
/** Hard caps on the response: a busy workspace must not turn a decoration into a megabyte poll. */
export const MAX_RUNS = 400;
export const MAX_LINKS = 150;
const SUMMARY_MAX = 90;

export interface ViewerScope {
  unrestricted: boolean;
  projectIds: readonly string[];
}

export interface OfficeRunEvent {
  runId: string;
  agentId: string;
  capability: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The run's target, or null when it has none or the viewer may not see it. */
  entity: { type: "project"; id: string; title: string } | null;
  /** One short, sanitised line from the run's goal or error — null when absent or hidden. */
  summary: string | null;
}

export interface OfficeHandoff {
  fromRunId: string;
  toRunId: string;
  fromAgentId: string;
  toAgentId: string;
  kind: "flow" | "project";
  /** When the hand-off happened: B's creation time. */
  at: string;
  title: string | null;
}

export interface OfficeActivity {
  since: string;
  until: string;
  events: OfficeRunEvent[];
  /** QUEUED runs per agent right now. */
  queues: Record<string, number>;
  handoffs: OfficeHandoff[];
  /** True when MAX_RUNS cut the window short (oldest dropped). */
  truncated: boolean;
}

/** Strip control characters and markup-ish noise, collapse whitespace, keep the first line, truncate. */
export function summaryLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const clean = firstLine
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  return clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : clean;
}

/** The fields link derivation needs; `projectId` must already be null for hidden projects. */
export interface LinkableRun {
  id: string;
  agentId: string;
  status: string;
  flowId: string | null;
  projectId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

const PRODUCED = new Set(["COMPLETED", "PARTIAL"]);

function linkKind(a: LinkableRun, b: LinkableRun): "flow" | "project" | null {
  if (a.flowId && a.flowId === b.flowId) return "flow";
  if (a.projectId && a.projectId === b.projectId) return "project";
  return null;
}

function upstreamFor(b: LinkableRun, produced: readonly LinkableRun[]): { a: LinkableRun; kind: "flow" | "project" } | null {
  let best: { a: LinkableRun; kind: "flow" | "project" } | null = null;
  for (const a of produced) {
    if (a.agentId === b.agentId || a.finishedAt === null) continue;
    const gap = b.createdAt - a.finishedAt;
    if (gap < 0 || gap > HANDOFF_WINDOW_MS) continue;
    const kind = linkKind(a, b);
    if (!kind) continue;
    const better = !best || (kind === "flow" && best.kind === "project") || (kind === best.kind && a.finishedAt > (best.a.finishedAt ?? 0));
    if (better) best = { a, kind };
  }
  return best;
}

/** The hand-off rule from the header, as a pure function over already-redacted runs. */
export function deriveHandoffs(runs: readonly LinkableRun[], titleOf: (projectId: string) => string | null = () => null): OfficeHandoff[] {
  const produced = runs.filter((r) => PRODUCED.has(r.status) && r.finishedAt !== null);
  const links: OfficeHandoff[] = [];
  for (const b of [...runs].sort((x, y) => x.createdAt - y.createdAt)) {
    const up = upstreamFor(b, produced);
    if (!up) continue;
    links.push({
      fromRunId: up.a.id,
      toRunId: b.id,
      fromAgentId: up.a.agentId,
      toAgentId: b.agentId,
      kind: up.kind,
      at: new Date(b.createdAt).toISOString(),
      title: b.projectId ? titleOf(b.projectId) : null
    });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface RunRow {
  id: string;
  capability: string;
  status: string;
  flowId: string | null;
  scopeProjectId: string | null;
  goal: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** One run as the viewer may see it, plus its redacted form for link derivation. */
function shapeRun(r: RunRow, agentId: string, visible: (id: string | null) => boolean, titles: ReadonlyMap<string, string>): { event: OfficeRunEvent; link: LinkableRun } {
  // A project with no row (deleted) is treated as hidden: nothing to title it with.
  const shown = visible(r.scopeProjectId) && r.scopeProjectId !== null && titles.has(r.scopeProjectId);
  const projectId = shown ? r.scopeProjectId : null;
  // Unscoped runs (no project) are workspace-level and their summary is shown; a hidden project's is not.
  const summary = r.scopeProjectId === null || shown ? summaryLine(r.goal ?? r.error) : null;
  // A hidden project's run carries no target at all for linking, not even its flow.
  const hidden = r.scopeProjectId !== null && !shown;
  return {
    event: {
      runId: r.id,
      agentId,
      capability: r.capability,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      entity: projectId ? { type: "project", id: projectId, title: titles.get(projectId) ?? "" } : null,
      summary
    },
    link: {
      id: r.id,
      agentId,
      status: r.status,
      flowId: hidden ? null : r.flowId,
      projectId,
      createdAt: r.createdAt.getTime(),
      finishedAt: r.finishedAt ? r.finishedAt.getTime() : null
    }
  };
}

export async function getOfficeActivity(sinceInput: Date, scope: ViewerScope, now = new Date()): Promise<OfficeActivity> {
  const floor = new Date(now.getTime() - ACTIVITY_WINDOW_MS);
  const since = sinceInput.getTime() < floor.getTime() || sinceInput.getTime() > now.getTime() ? floor : sinceInput;

  const profiles = await prisma.agentProfile.findMany({
    where: { deletedAt: null },
    select: { id: true, identityUserId: true }
  });
  const agentOf = new Map(profiles.map((p) => [p.identityUserId, p.id]));
  const identityIds = [...agentOf.keys()];
  if (identityIds.length === 0)
    return {
      since: since.toISOString(),
      until: now.toISOString(),
      events: [],
      queues: {},
      handoffs: [],
      truncated: false
    };

  const [rows, queued] = await Promise.all([
    prisma.agentRun.findMany({
      where: {
        onBehalfOfId: { in: identityIds },
        OR: [{ createdAt: { gte: since } }, { status: { in: ["QUEUED", "RUNNING"] } }]
      },
      orderBy: { createdAt: "desc" },
      take: MAX_RUNS + 1,
      select: {
        id: true,
        onBehalfOfId: true,
        capability: true,
        status: true,
        flowId: true,
        scopeProjectId: true,
        goal: true,
        error: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true
      }
    }),
    prisma.agentRun.groupBy({
      by: ["onBehalfOfId"],
      where: { onBehalfOfId: { in: identityIds }, status: "QUEUED" },
      _count: { _all: true }
    })
  ]);
  const truncated = rows.length > MAX_RUNS;
  const runs = rows.slice(0, MAX_RUNS);

  const visible = (projectId: string | null): projectId is string => projectId !== null && (scope.unrestricted || scope.projectIds.includes(projectId));
  const projectIds = [...new Set(runs.map((r) => r.scopeProjectId).filter(visible))];
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, code: true, name: true }
      })
    : [];
  const titles = new Map(projects.map((p) => [p.id, `${p.code} · ${p.name}`]));

  const events: OfficeRunEvent[] = [];
  const linkable: LinkableRun[] = [];
  for (const r of runs) {
    const agentId = agentOf.get(r.onBehalfOfId);
    if (!agentId) continue;
    const shaped = shapeRun(r, agentId, visible, titles);
    events.push(shaped.event);
    linkable.push(shaped.link);
  }

  const queues: Record<string, number> = {};
  for (const g of queued) {
    const agentId = agentOf.get(g.onBehalfOfId);
    if (agentId) queues[agentId] = g._count._all;
  }

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    events: events.reverse(),
    queues,
    handoffs: deriveHandoffs(linkable, (id) => titles.get(id) ?? null),
    truncated
  };
}

/**
 * WHAT: the pure half of the office's REAL activity — given the last 24h of runs from
 * `GET /agents/office-activity` and a moment in time, what the office should show at that moment:
 * who is working, which hand-offs are in flight, whether agents are meeting over a shared item, how
 * deep each agent's queue is, and which idle colleagues walk over to help. The live view is this at
 * `now`; the replay timeline is this at the scrubbed time. No three.js, no DOM — unit-tested.
 *
 * WHAT IS REAL HERE: everything derived from the events — work, hand-offs (the server's conservative
 * rule: same flow, or same project within 30 min), meetings (≥2 agents with runs overlapping in time
 * on the same project), queue depth. WHAT IS NOT: a helper walking to an overloaded room is a
 * VISUAL cue only (no work is reassigned), so it is labelled "visual only" wherever it shows.
 *
 * WHO CALLS THIS: AgentOffice.tsx (and through it scene/office-engine.ts `setActivity`).
 */
import type { OfficeActivity, OfficeRunEvent } from "../../services/api";
import type { FeedLine } from "./office-model";

/** A queue at or above this many waiting runs draws idle colleagues over (visual only). */
export const HELP_THRESHOLD = 3;
/** Most helpers sent to any one queue. */
const MAX_HELPERS_PER_QUEUE = 2;
/** Longest line a speech bubble carries. */
const LINE_MAX = 34;

export interface HandoffView {
  key: string;
  fromAgentId: string;
  toAgentId: string;
  /** The real item title, or null when the viewer may not see it. */
  title: string | null;
}

export interface MeetingView {
  key: string;
  title: string;
  agentIds: string[];
  /** A short real line per agent from its run's summary; null → the office uses a stock phrase. */
  lines: Record<string, string | null>;
}

export interface HelperView {
  helperId: string;
  /** Whose queue it walks over to. */
  agentId: string;
}

export interface OfficeView {
  /** Agents with a run in progress at this moment. */
  working: ReadonlySet<string>;
  handoffs: HandoffView[];
  meeting: MeetingView | null;
  queues: Record<string, number>;
  helpers: HelperView[];
}

export const EMPTY_VIEW: OfficeView = {
  working: new Set(),
  handoffs: [],
  meeting: null,
  queues: {},
  helpers: []
};

const PENDING = new Set(["QUEUED", "RUNNING"]);
const ms = (iso: string | null): number | null => (iso ? Date.parse(iso) : null);

/** When a run began doing work (startedAt, else createdAt for a run past QUEUED). */
const startOf = (e: OfficeRunEvent): number => ms(e.startedAt) ?? Date.parse(e.createdAt);

/** When it stopped — a still-pending run is open-ended. */
function endOf(e: OfficeRunEvent): number {
  const finished = ms(e.finishedAt);
  if (finished !== null) return finished;
  return PENDING.has(e.status) ? Infinity : startOf(e);
}

/** Running (not merely queued) at time t. A QUEUED run with no start never runs in the window. */
export function isRunningAt(e: OfficeRunEvent, t: number): boolean {
  if (e.status === "QUEUED" && !e.startedAt) return false;
  return startOf(e) <= t && t < endOf(e);
}

/** Waiting in a queue at time t: created, not yet started (or finished without starting). */
export function isQueuedAt(e: OfficeRunEvent, t: number): boolean {
  const created = Date.parse(e.createdAt);
  if (created > t) return false;
  const left = ms(e.startedAt) ?? ms(e.finishedAt);
  return left === null ? e.status === "QUEUED" : t < left;
}

/** Shorten a real line for a speech bubble. */
export function bubbleLine(text: string | null): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > LINE_MAX ? `${clean.slice(0, LINE_MAX - 1).trimEnd()}…` : clean;
}

/** The largest group (≥2 agents) whose runs overlap at t on the same project. One meeting room → one meeting. */
export function meetingAt(events: readonly OfficeRunEvent[], t: number): MeetingView | null {
  const groups = new Map<string, { title: string; runs: Map<string, OfficeRunEvent> }>();
  for (const e of events) {
    if (!e.entity || !isRunningAt(e, t)) continue;
    const g = groups.get(e.entity.id) ?? {
      title: e.entity.title,
      runs: new Map<string, OfficeRunEvent>()
    };
    if (!g.runs.has(e.agentId)) g.runs.set(e.agentId, e);
    groups.set(e.entity.id, g);
  }
  let best: {
    key: string;
    title: string;
    runs: Map<string, OfficeRunEvent>;
  } | null = null;
  for (const [key, g] of groups) {
    if (g.runs.size < 2) continue;
    if (!best || g.runs.size > best.runs.size || (g.runs.size === best.runs.size && key < best.key)) best = { key, ...g };
  }
  if (!best) return null;
  const agentIds = [...best.runs.keys()].sort((a, b) => a.localeCompare(b));
  const lines: Record<string, string | null> = {};
  for (const id of agentIds) lines[id] = bubbleLine(best.runs.get(id)?.summary ?? null);
  return { key: `meet-${best.key}`, title: best.title, agentIds, lines };
}

/** Queue depth per agent at t, from the events (the replay); live mode uses the server's counts instead. */
export function queuesAt(events: readonly OfficeRunEvent[], t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) if (isQueuedAt(e, t)) out[e.agentId] = (out[e.agentId] ?? 0) + 1;
  return out;
}

/**
 * Idle agents sent to help overloaded queues — deepest queue first, one helper per waiting run above
 * the threshold (at most two each), never the queue's owner, never the same helper twice. Deterministic:
 * idle agents are taken in id order so a poll does not reshuffle who walks where.
 */
export function assignHelpers(queues: Readonly<Record<string, number>>, idleIds: readonly string[], threshold = HELP_THRESHOLD): HelperView[] {
  const pool = [...idleIds].sort((a, b) => a.localeCompare(b));
  const loaded = Object.entries(queues)
    .filter(([, depth]) => depth >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out: HelperView[] = [];
  for (const [agentId, depth] of loaded) {
    const want = Math.min(MAX_HELPERS_PER_QUEUE, depth - threshold + 1);
    for (let i = 0; i < want; i += 1) {
      const at = pool.findIndex((id) => id !== agentId);
      if (at < 0) break;
      out.push({ helperId: pool[at], agentId });
      pool.splice(at, 1);
    }
  }
  return out;
}

export interface ViewOptions {
  /** Live mode trusts the server's current queue counts; replay recomputes them from the events. */
  live: boolean;
  /** How long after it happens a hand-off still shows (ms of office time). */
  handoffWindowMs: number;
  /** On-duty agents with nothing of their own running — candidates for helping. */
  idleIds: readonly string[];
}

/** The office at time t. */
export function viewAt(activity: OfficeActivity | null, t: number, opts: ViewOptions): OfficeView {
  if (!activity) return EMPTY_VIEW;
  const working = new Set(activity.events.filter((e) => isRunningAt(e, t)).map((e) => e.agentId));
  const handoffs = activity.handoffs
    .filter((h) => {
      const at = Date.parse(h.at);
      return at <= t && t - at <= opts.handoffWindowMs;
    })
    .map((h) => ({
      key: `${h.fromRunId}>${h.toRunId}`,
      fromAgentId: h.fromAgentId,
      toAgentId: h.toAgentId,
      title: h.title
    }));
  const queues = opts.live ? { ...activity.queues } : queuesAt(activity.events, t);
  const idle = opts.idleIds.filter((id) => !working.has(id));
  return {
    working,
    handoffs,
    meeting: meetingAt(activity.events, t),
    queues,
    helpers: assignHelpers(queues, idle)
  };
}

/** Plain-words lines for the screen-reader list and the still (reduced-motion / no-WebGL) office. */
export function describeView(view: OfficeView, nameOf: (id: string) => string): string[] {
  const out: string[] = [];
  for (const h of view.handoffs) out.push(`${nameOf(h.fromAgentId)} handed ${h.title ?? "an item"} to ${nameOf(h.toAgentId)}`);
  if (view.meeting) out.push(`Meeting on ${view.meeting.title}: ${view.meeting.agentIds.map(nameOf).join(", ")}`);
  for (const [id, depth] of Object.entries(view.queues)) if (depth > 0) out.push(`${nameOf(id)} has ${depth} queued`);
  for (const h of view.helpers) out.push(`${nameOf(h.helperId)} is helping ${nameOf(h.agentId)} (visual only)`);
  return out;
}

/** The replay's bounds: the last 24h up to `now`. */
export function replayBounds(activity: OfficeActivity | null, now: number): { from: number; to: number } {
  const from = activity ? Date.parse(activity.since) : now - 24 * 3600_000;
  return { from: Math.min(from, now), to: now };
}

const VERB_AT: Readonly<Record<string, string>> = {
  COMPLETED: "finished",
  PARTIAL: "partly finished",
  FAILED: "failed",
  ABORTED: "aborted",
  BLOCKED: "was blocked on"
};

/** One run as of time t: what it was doing then, and when that last changed. */
function feedEntry(e: OfficeRunEvent, t: number): { verb: string; at: number } | null {
  const created = Date.parse(e.createdAt);
  if (created > t) return null;
  const finished = ms(e.finishedAt);
  if (finished !== null && finished <= t) return { verb: VERB_AT[e.status] ?? e.status.toLowerCase(), at: finished };
  const started = ms(e.startedAt);
  if (started !== null && started <= t) return { verb: "is running", at: started };
  return { verb: "queued", at: created };
}

/** The replay's feed: the real runs as they stood at time t, latest change first. */
export function feedAt(activity: OfficeActivity | null, t: number, nameOf: (id: string) => string, limit = 5): FeedLine[] {
  if (!activity) return [];
  const lines: FeedLine[] = [];
  for (const e of activity.events) {
    const entry = feedEntry(e, t);
    if (!entry) continue;
    const what = e.entity ? ` on ${e.entity.title}` : "";
    lines.push({
      key: `replay-${e.runId}`,
      agentId: e.agentId,
      agentName: nameOf(e.agentId),
      text: `${entry.verb} ${e.capability.replaceAll("_", " ")}${what}`,
      at: entry.at,
      kind: "run"
    });
  }
  return lines.sort((a, b) => b.at - a.at).slice(0, limit);
}

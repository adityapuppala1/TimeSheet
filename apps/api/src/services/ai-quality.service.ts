/**
 * WHAT: per-feature AI quality metrics, computed from captured `AIInteraction` rows.
 *
 * WHY the headline metric is PARSE FAILURE RATE and not thumbs-up rate:
 *
 * Thumbs-up rate looks like the obvious quality number and is, in this product, close to
 * meaningless on its own. Feedback can only be given from one screen (the AI Activity Log), only
 * on triage-touched tickets, and only by someone who bothers. So the rated population is a tiny,
 * self-selected slice — and people are far likelier to click thumbs-down on a bad result than
 * thumbs-up on a good one. A "72% positive" headline computed from 11 ratings out of 4,000 calls
 * is not a quality measurement, it's noise with a percent sign.
 *
 * Parse failure rate has none of those problems: every structured call either produced valid JSON
 * matching its schema or it didn't, that verdict is recorded automatically, and it covers 100% of
 * calls. It is a genuine floor on quality — a response that won't parse definitely failed.
 *
 * So this service reports COVERAGE alongside every human-derived number, and the UI is expected to
 * show coverage first. Being honest that you can't yet measure something is more useful than
 * confidently reporting a number that doesn't mean what it appears to.
 */
import { prisma } from "../config/prisma.js";

export interface FeatureQuality {
  feature: string;
  interactions: number;
  /** Structured calls only — free-text features have nothing to parse, so this is null for them. */
  parseFailureRate: number | null;
  parseableInteractions: number;
  /** Human ratings recorded against interactions of this feature. */
  rated: number;
  thumbsUp: number;
  thumbsDown: number;
  /** rated / interactions. Read this BEFORE trusting `thumbsUpRate`. */
  coverage: number;
  /** Null below MIN_RATINGS_FOR_RATE — a rate from 3 ratings is not a rate. */
  thumbsUpRate: number | null;
  avgLatencyMs: number | null;
}

export interface AIQualitySummary {
  captureEnabled: boolean;
  contentCaptureEnabled: boolean;
  windowDays: number;
  totalInteractions: number;
  /** Across all structured calls in the window — the honest headline. */
  overallParseFailureRate: number | null;
  features: FeatureQuality[];
  /** Pre-existing per-ticket thumbs data, reported SEPARATELY and never merged into the
   *  per-interaction numbers above — see the note in getAIQualitySummary. */
  legacyTicketFeedback: { up: number; down: number };
}

/** Below this many ratings a percentage is more misleading than no number at all. */
const MIN_RATINGS_FOR_RATE = 10;

export async function getAIQualitySummary(windowDays = 30): Promise<AIQualitySummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const settings = await prisma.globalAISettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  const [rows, legacyUp, legacyDown] = await Promise.all([
    prisma.aIInteraction.findMany({
      where: { createdAt: { gte: since } },
      select: { feature: true, parseOk: true, feedback: true, latencyMs: true }
    }),
    // The old `Ticket.aiFeedback` flag. Kept visible so historical signal isn't lost, but reported
    // as its own bucket: it's one flag per TICKET (a ticket may have been touched by several AI
    // features) whereas everything above is per CALL. Silently adding them together would produce
    // a number that means nothing.
    prisma.ticket.count({ where: { aiFeedback: "up", deletedAt: null } }),
    prisma.ticket.count({ where: { aiFeedback: "down", deletedAt: null } })
  ]);

  const byFeature = new Map<string, { total: number; parseable: number; parseFailures: number; up: number; down: number; latencies: number[] }>();

  for (const row of rows) {
    const bucket = byFeature.get(row.feature) ?? { total: 0, parseable: 0, parseFailures: 0, up: 0, down: 0, latencies: [] };
    bucket.total += 1;
    if (row.parseOk !== null) {
      bucket.parseable += 1;
      if (row.parseOk === false) bucket.parseFailures += 1;
    }
    if (row.feedback === "up") bucket.up += 1;
    if (row.feedback === "down") bucket.down += 1;
    if (typeof row.latencyMs === "number") bucket.latencies.push(row.latencyMs);
    byFeature.set(row.feature, bucket);
  }

  const features: FeatureQuality[] = [...byFeature.entries()]
    .map(([feature, b]) => {
      const rated = b.up + b.down;
      return {
        feature,
        interactions: b.total,
        parseFailureRate: b.parseable > 0 ? round(b.parseFailures / b.parseable) : null,
        parseableInteractions: b.parseable,
        rated,
        thumbsUp: b.up,
        thumbsDown: b.down,
        coverage: b.total > 0 ? round(rated / b.total) : 0,
        thumbsUpRate: rated >= MIN_RATINGS_FOR_RATE ? round(b.up / rated) : null,
        avgLatencyMs: b.latencies.length > 0 ? Math.round(b.latencies.reduce((a, c) => a + c, 0) / b.latencies.length) : null
      };
    })
    // Worst parse rate first — the point of this screen is to find what's broken, not to admire
    // what isn't.
    .sort((a, b) => (b.parseFailureRate ?? -1) - (a.parseFailureRate ?? -1) || b.interactions - a.interactions);

  const parseable = rows.filter((r) => r.parseOk !== null);
  const overallParseFailureRate = parseable.length > 0 ? round(parseable.filter((r) => r.parseOk === false).length / parseable.length) : null;

  return {
    captureEnabled: settings.aiCaptureEnabled,
    contentCaptureEnabled: settings.aiCaptureContentEnabled,
    windowDays,
    totalInteractions: rows.length,
    overallParseFailureRate,
    features,
    legacyTicketFeedback: { up: legacyUp, down: legacyDown }
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Attaches a rating to one specific interaction. Distinct from the pre-existing
 * `PATCH /tickets/:id/ai-feedback`, which sets a single flag on the TICKET — that endpoint and its
 * UI are left working exactly as they were.
 */
export async function setInteractionFeedback(params: {
  interactionId: string;
  feedback: "up" | "down" | null;
  userId: string;
  note?: string;
}): Promise<void> {
  await prisma.aIInteraction.update({
    where: { id: params.interactionId },
    data: {
      feedback: params.feedback,
      feedbackById: params.feedback ? params.userId : null,
      feedbackAt: params.feedback ? new Date() : null,
      feedbackNote: params.note ?? null
    }
  });
}

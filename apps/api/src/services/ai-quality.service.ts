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
  /**
   * What people did with AI-authored change sets. Reported in its OWN bucket for the same reason
   * the legacy ticket thumbs are: this counts change ROWS, not model calls, so adding it to the
   * numbers above would produce a figure that means nothing.
   *
   * WHY IT IS WORTH MORE THAN THUMBS: `ai-proposal.service.ts` has said since it was written that
   * per-row accept/reject is "a far richer signal than the thumbs-up/down on AIInteraction, and
   * produced as a by-product of people doing their normal work rather than as a favour to the
   * model" — and until now nothing read it. Thumbs are self-selected and rare; every applied
   * proposal produces a decision on every row whether anybody feels like rating it or not.
   *
   * UNDO IS THE STRONGEST SIGNAL HERE and is counted separately from a rejection: rejecting a row
   * is "I read this and disagreed"; undoing one is "I let it happen and then took it back", which
   * is a worse outcome and worth being able to see on its own.
   */
  proposalDecisions: ProposalDecisionStats[];
}

export interface ProposalDecisionStats {
  kind: string;
  /** Rows a person explicitly ticked. */
  accepted: number;
  /** Rows a person explicitly left unticked. */
  rejected: number;
  /** Rows that were applied and then put back. */
  undone: number;
  /** Rows refused at apply time — usually a stale before-state, which is the envelope working
   *  rather than the model being wrong. Kept apart from `rejected` so the two are never confused. */
  refused: number;
  /** Of the rows a person actually decided, the share they accepted. Null below the same
   *  threshold the thumbs rate uses, for the same reason. */
  acceptRate: number | null;
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
    legacyTicketFeedback: { up: legacyUp, down: legacyDown },
    proposalDecisions: await getProposalDecisionStats(since)
  };
}

/**
 * What happened to AI-authored change rows in the window, grouped by proposal kind.
 *
 * NOT gated on `aiCaptureEnabled`, unlike everything else on this screen. Capture is about
 * retaining prompt and output CONTENT; these are decisions people made about their own plan, they
 * already live in `AiProposalChange` as a normal part of the feature, and no new content is being
 * stored to report them.
 */
export async function getProposalDecisionStats(since: Date): Promise<ProposalDecisionStats[]> {
  const changes = await prisma.aiProposalChange.findMany({
    where: { createdAt: { gte: since } },
    select: { accepted: true, appliedAt: true, undoneAt: true, applyError: true, proposal: { select: { kind: true } } }
  });

  const byKind = new Map<string, ProposalDecisionStats>();
  for (const change of changes) {
    const kind = change.proposal?.kind ?? "UNKNOWN";
    const bucket = byKind.get(kind) ?? { kind, accepted: 0, rejected: 0, undone: 0, refused: 0, acceptRate: null };

    if (change.undoneAt) bucket.undone++;
    else if (change.applyError) bucket.refused++;
    else if (change.accepted === true) bucket.accepted++;
    else if (change.accepted === false) bucket.rejected++;
    // `accepted === null` is a row nobody has decided yet — deliberately counted nowhere. An
    // undecided row is not a rejection, and treating it as one would make every unreviewed
    // proposal look like a failure.

    byKind.set(kind, bucket);
  }

  return [...byKind.values()]
    .map((b) => {
      const decided = b.accepted + b.rejected + b.undone;
      return { ...b, acceptRate: decided >= MIN_RATINGS_FOR_RATE ? round(b.accepted / decided) : null };
    })
    .sort((a, b) => b.accepted + b.rejected + b.undone - (a.accepted + a.rejected + a.undone));
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

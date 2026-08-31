/**
 * WHAT: account health for one workspace — at risk, healthy, or an expansion candidate — WITH THE
 * REASON ATTACHED.
 *
 * WHY THERE IS NO BARE SCORE. A number on its own is a number nobody acts on, and a number nobody
 * acts on is a number nobody maintains: within two months it is stale, then it is wrong, then it is
 * quietly ignored, and the screen that carries it is dead weight. An operator who sees "62" cannot
 * do anything. An operator who sees "at risk — nobody has signed in for 41 days" can pick up the
 * phone. So the band and the score are OUTPUTS of the signals, never the other way round, and this
 * function's contract is that `signals` is never empty and `primarySignal` always names something
 * measured. When nothing at all has fired it says so explicitly, with the checks it ran — "steady"
 * is a finding, and it is a different finding from "we did not look".
 *
 * WHY IT IS PURE, AND WHY THAT IS THE WHOLE POINT. No database, no Prisma, no clock of its own —
 * every input arrives as a number. Scoring rules are exactly the kind of code that rots silently:
 * a threshold nudged to make one customer look better, an operator disagreeing with a band and
 * nobody able to say which rule produced it. A pure function is one a test can hold at arm's length
 * and interrogate rule by rule, which is what `platform-account-health.test.ts` does.
 *
 * NOTHING HERE READS TENANT CONTENT. Every input is a count, a rate or a number of days, taken from
 * `OrgUsageSnapshot` — which is itself aggregate-only. There is no path from this file to a ticket
 * title, a comment or a person, and there must never be one.
 *
 * WHERE THE OUTPUT GOES: the console's analytics screen, the Org 360 page, and — as facts, not as
 * conclusions — the platform AI advisor's fact sheet, so the advisor reasons about the same signals
 * an operator can see rather than about a second, private set of numbers.
 */
import { UNLIMITED_SEATS } from "@timesheet/shared";

/* ------------------------------------------------------------------------------------------ */
/* Shapes                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export type HealthBand = "AT_RISK" | "HEALTHY" | "EXPANSION";

/**
 * Which way a signal pushes.
 *
 * `risk` costs points. `expansion` costs NONE — a workspace pressing against its seat limit is not
 * unhealthy, it is a sales conversation, and letting it dock points would hide a happy customer
 * inside the at-risk list. `neutral` is the one that fires when nothing else did.
 */
export type SignalDirection = "risk" | "expansion" | "neutral";

export interface HealthSignal {
  /** Stable id, so a console can style or filter on it without matching prose. */
  id: string;
  direction: SignalDirection;
  /** Points this signal costs the score. Zero for expansion and neutral signals. */
  weight: number;
  /** Three or four words. What an operator scans down a column. */
  label: string;
  /** The measured fact, WITH ITS NUMBER IN IT. This is the sentence that makes the band actionable
   *  — never a restatement of the label. */
  detail: string;
}

export interface AccountHealth {
  band: HealthBand;
  /** 0–100, higher is healthier. Derived from the risk signals; never the primary artefact. */
  score: number;
  /** NEVER EMPTY. That invariant is the reason this module exists. */
  signals: HealthSignal[];
  /** The heaviest signal — what an operator should read first. */
  primarySignal: HealthSignal;
  /** One line naming the band AND its reason, ready to render. */
  headline: string;
}

export interface AccountHealthInput {
  status: string;
  reachable: boolean;
  seatsUsed: number;
  /** The effective ceiling. `UNLIMITED_SEATS` (or anything at/above it) means "no ceiling". */
  seatLimit: number;
  aiSpendUsd: number;
  /** 0 is a REAL cap here, not "unlimited" — Starter's ceiling is zero and that is what makes AI
   *  unavailable. A zero ceiling therefore produces no burn signal rather than a division. */
  aiBudgetCeilingUsd: number;
  /** Null when the workspace has never been signed into, or when it could not be read. */
  daysSinceLastActivity: number | null;
  /** Tickets created per day, recent half of the window vs the half before it. Both null when the
   *  snapshot history is too short to compare — which is the normal state on day one. */
  ticketsPerDayRecent: number | null;
  ticketsPerDayPrior: number | null;
  emailsSent: number;
  emailsFailed: number;
  backupFailures: number;
  /** Days until the trial ends; negative once it has. Null when there is no trial. */
  trialDaysRemaining: number | null;
  /** How many daily snapshots the trend figures came from. Fewer than `MIN_TREND_SNAPSHOTS` and no
   *  velocity signal is emitted at all — a confident trend off two points is a made-up trend. */
  snapshots: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Thresholds, in one block so an argument about a number happens in one place                 */
/* ------------------------------------------------------------------------------------------ */

/** At or above this share of the seat ceiling, a workspace is an expansion conversation. It is
 *  also the threshold the console's "seat overage" list uses — one constant, so the KPI tile and
 *  the list it links to cannot disagree about who is on it. */
export const SEAT_PRESSURE = 0.9;
/** Same idea for the AI budget: a workspace at 90% of its ceiling will hit it. */
const AI_BURN_PRESSURE = 0.9;
/** Quiet, then dormant. 14 days spans a holiday; 30 does not. */
const QUIET_DAYS = 14;
const DORMANT_DAYS = 30;
/** A mail failure rate worth a phone call, over a sample big enough to mean something. Three
 *  failures out of four sends is noise; twenty out of a hundred is a broken relay. */
const MAIL_FAILURE_RATE = 0.2;
const MAIL_MIN_SAMPLE = 10;
/** A halving or a doubling. Anything tighter is week-to-week noise dressed as a trend. */
const VELOCITY_DROP = 0.5;
const VELOCITY_RISE = 0.5;
/** Below this many daily snapshots there is no velocity comparison, only two numbers. */
export const MIN_TREND_SNAPSHOTS = 8;
/**
 * The two ways an account becomes AT_RISK, and they are deliberately different questions.
 *
 * `AT_RISK_SCORE` is the ACCUMULATION rule: two moderate problems at once — quiet plus slowing,
 * failing mail plus failing backups — is a workspace in trouble even though no single fact is
 * alarming. 80 rather than 60 because the weights below are calibrated so that one moderate signal
 * (15–25) leaves an account healthy-with-a-note and two do not.
 *
 * `MAJOR_RISK_WEIGHT` is the SEVERITY rule, and it exists because accumulation alone gets the
 * important case wrong: "nobody has signed in for 41 days" scores 60 on its own, which under a
 * pure threshold would read as Healthy. One fact can be enough, and pretending otherwise means
 * tuning weights until an arbitrary cutoff happens to land in the right place — which is how a
 * scoring rule stops being explainable.
 */
const AT_RISK_SCORE = 80;
const MAJOR_RISK_WEIGHT = 30;

const round1 = (value: number) => Math.round(value * 10) / 10;

/** True when a seat ceiling is a real ceiling. TEAM and ENTERPRISE both carry `UNLIMITED_SEATS`
 *  (1,000,000), so seat pressure is genuinely inapplicable to them — there is nothing to press
 *  against — and reporting 0.001% utilisation for them would be arithmetic, not information. */
export function hasSeatCeiling(seatLimit: number): boolean {
  return seatLimit > 0 && seatLimit < UNLIMITED_SEATS;
}

/* ------------------------------------------------------------------------------------------ */
/* The scorer                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Score one workspace.
 *
 * Reading order of the rules below is deliberate: lifecycle first (a suspended workspace's ticket
 * velocity is not the story), then engagement, then the two commercial pressures, then delivery.
 */
export function scoreAccountHealth(input: AccountHealthInput): AccountHealth {
  const signals: HealthSignal[] = [];
  const add = (signal: HealthSignal) => signals.push(signal);

  /* --- lifecycle ------------------------------------------------------------------------- */

  if (!input.reachable) {
    add({
      id: "unreachable",
      direction: "risk",
      weight: 30,
      label: "Workspace unreachable",
      detail: "The last sweep could not read this workspace's database, so every usage figure below is stale."
    });
  }

  if (input.status === "SUSPENDED" || input.status === "ARCHIVED") {
    add({
      id: "suspended",
      direction: "risk",
      weight: 45,
      label: `Workspace ${input.status.toLowerCase()}`,
      detail: `The workspace is ${input.status}. Nobody there can sign in, so nothing below is a usage signal.`
    });
  } else if (input.status === "GRACE") {
    add({
      id: "grace",
      direction: "risk",
      weight: 35,
      label: "In grace",
      detail: "The trial ended or a renewal failed and nobody has paid. Only a super admin can still sign in."
    });
  }

  if (input.trialDaysRemaining !== null) {
    if (input.trialDaysRemaining < 0) {
      add({
        id: "trial-lapsed",
        direction: "risk",
        weight: 25,
        label: "Trial lapsed",
        detail: `The trial ended ${Math.abs(Math.round(input.trialDaysRemaining))} days ago and no subscription followed it.`
      });
    } else if (input.trialDaysRemaining <= 7) {
      add({
        id: "trial-ending",
        direction: "risk",
        weight: 15,
        label: "Trial ending",
        detail: `The trial ends in ${Math.round(input.trialDaysRemaining)} days. After that the workspace goes to grace, not to a plan.`
      });
    }
  }

  /* --- engagement ------------------------------------------------------------------------ */

  if (input.daysSinceLastActivity === null) {
    add({
      id: "never-used",
      direction: "risk",
      weight: 35,
      label: "Never signed in",
      detail: "No sign-in has ever been recorded in this workspace. It was provisioned and then not adopted."
    });
  } else if (input.daysSinceLastActivity >= DORMANT_DAYS) {
    add({
      id: "dormant",
      direction: "risk",
      weight: 40,
      label: "Dormant",
      detail: `Nobody has signed in for ${Math.round(input.daysSinceLastActivity)} days.`
    });
  } else if (input.daysSinceLastActivity >= QUIET_DAYS) {
    add({
      id: "quiet",
      direction: "risk",
      weight: 20,
      label: "Gone quiet",
      detail: `The last sign-in was ${Math.round(input.daysSinceLastActivity)} days ago.`
    });
  }

  // Velocity needs BOTH halves of a long-enough window. On a short history there is no signal at
  // all, which is the correct answer — not a neutral one, and certainly not a confident one.
  if (input.snapshots >= MIN_TREND_SNAPSHOTS && input.ticketsPerDayRecent !== null && input.ticketsPerDayPrior !== null && input.ticketsPerDayPrior > 0) {
    const change = (input.ticketsPerDayRecent - input.ticketsPerDayPrior) / input.ticketsPerDayPrior;
    if (change <= -VELOCITY_DROP) {
      add({
        id: "velocity-down",
        direction: "risk",
        weight: 20,
        label: "Work slowing",
        detail: `Tickets raised per day fell from ${round1(input.ticketsPerDayPrior)} to ${round1(input.ticketsPerDayRecent)} across the window.`
      });
    } else if (change >= VELOCITY_RISE) {
      add({
        id: "velocity-up",
        direction: "expansion",
        weight: 0,
        label: "Work accelerating",
        detail: `Tickets raised per day rose from ${round1(input.ticketsPerDayPrior)} to ${round1(input.ticketsPerDayRecent)} across the window.`
      });
    }
  }

  /* --- commercial pressure --------------------------------------------------------------- */

  if (hasSeatCeiling(input.seatLimit)) {
    const utilisation = input.seatsUsed / input.seatLimit;
    if (utilisation >= 1) {
      add({
        id: "seats-full",
        direction: "expansion",
        weight: 0,
        label: "Seat limit reached",
        detail: `${input.seatsUsed} of ${input.seatLimit} seats are in use. They cannot add anybody else without moving tier.`
      });
    } else if (utilisation >= SEAT_PRESSURE) {
      add({
        id: "seats-tight",
        direction: "expansion",
        weight: 0,
        label: "Near the seat limit",
        detail: `${input.seatsUsed} of ${input.seatLimit} seats are in use — ${Math.round(utilisation * 100)}% of the ceiling.`
      });
    }
  }

  if (input.aiBudgetCeilingUsd > 0) {
    const burn = input.aiSpendUsd / input.aiBudgetCeilingUsd;
    if (burn >= 1) {
      add({
        id: "ai-budget-exhausted",
        direction: "expansion",
        weight: 0,
        label: "AI budget spent",
        detail: `$${round1(input.aiSpendUsd)} against a $${round1(input.aiBudgetCeilingUsd)} ceiling. Further AI calls are refused this month.`
      });
    } else if (burn >= AI_BURN_PRESSURE) {
      add({
        id: "ai-budget-tight",
        direction: "expansion",
        weight: 0,
        label: "AI budget nearly spent",
        detail: `$${round1(input.aiSpendUsd)} of a $${round1(input.aiBudgetCeilingUsd)} ceiling — ${Math.round(burn * 100)}%.`
      });
    }
  }

  /* --- delivery -------------------------------------------------------------------------- */

  const mailAttempts = input.emailsSent + input.emailsFailed;
  if (mailAttempts >= MAIL_MIN_SAMPLE && input.emailsFailed / mailAttempts >= MAIL_FAILURE_RATE) {
    add({
      id: "mail-failing",
      direction: "risk",
      weight: 25,
      label: "Mail failing",
      detail: `${input.emailsFailed} of ${mailAttempts} outbound messages failed this month. Every workspace brings its own SMTP, so this is theirs.`
    });
  }

  if (input.backupFailures > 0) {
    add({
      id: "backups-failing",
      direction: "risk",
      weight: 15,
      label: "Backups failing",
      detail: `${input.backupFailures} managed backup ${input.backupFailures === 1 ? "run has" : "runs have"} failed in the window.`
    });
  }

  /* --- the answer ------------------------------------------------------------------------ */

  // THE INVARIANT. A band with nothing behind it is exactly the useless number this module was
  // written to avoid, so when no rule fired we say what we checked. "Nothing is wrong" is a real
  // finding; "we produced a number" is not.
  if (signals.length === 0) {
    add({
      id: "steady",
      direction: "neutral",
      weight: 0,
      label: "Steady",
      detail: `No signal fired: sign-ins are recent, seats and AI budget are inside their ceilings, mail is delivering and no backup has failed.${
        input.snapshots < MIN_TREND_SNAPSHOTS ? ` Ticket velocity was not assessed — only ${input.snapshots} daily snapshot${input.snapshots === 1 ? "" : "s"} so far.` : ""
      }`
    });
  }

  // Heaviest first, which is the order an operator reads in. `sort` is stable in every engine this
  // runs on, so equal weights keep the deliberate declaration order above.
  signals.sort((a, b) => b.weight - a.weight);

  const score = Math.max(0, Math.min(100, 100 - signals.reduce((total, signal) => total + signal.weight, 0)));
  const risks = signals.filter((signal) => signal.direction === "risk");
  const hasExpansion = signals.some((signal) => signal.direction === "expansion");
  // EXPANSION requires NO risk signal at all, not merely a passing score. A workspace pressing its
  // seat limit while its mail relay is broken is a support call before it is a sales call, and
  // putting it on the upsell list is how the upsell list stops being read.
  const band: HealthBand =
    score < AT_RISK_SCORE || risks.some((signal) => signal.weight >= MAJOR_RISK_WEIGHT)
      ? "AT_RISK"
      : hasExpansion && risks.length === 0
        ? "EXPANSION"
        : "HEALTHY";

  // The primary signal is the heaviest RISK when there is one; otherwise the first expansion
  // signal, because on a healthy account the sales reason is the interesting one. Never index 0
  // blindly: expansion signals weigh nothing, so a sorted list puts them beside "steady".
  const primarySignal =
    risks[0] ??
    signals.find((signal) => signal.direction === "expansion") ??
    signals[0];

  const bandWord = band === "AT_RISK" ? "At risk" : band === "EXPANSION" ? "Expansion candidate" : "Healthy";

  return { band, score, signals, primarySignal, headline: `${bandWord} — ${primarySignal.detail}` };
}

/* ------------------------------------------------------------------------------------------ */
/* Seat overage — the warmest revenue list in the product                                      */
/* ------------------------------------------------------------------------------------------ */

export interface SeatUsageRow {
  orgId: string;
  slug: string;
  name: string;
  planTier: string;
  status: string;
  seatsUsed: number;
  seatLimit: number;
}

export interface SeatOverageRow extends SeatUsageRow {
  /** Seats used ÷ ceiling. Above 1 when the workspace is over its limit, which is possible: the
   *  ceiling is enforced at the moment a user is CREATED, and a platform admin can lower it after. */
  utilisation: number;
  /** Seats left before the ceiling. Negative when they are already past it. */
  seatsRemaining: number;
}

/**
 * The workspaces at or above `threshold` of their seat ceiling, warmest first.
 *
 * `countActiveSeats()` and `getEffectiveSeatLimit()` have existed per workspace since Phase B7 and
 * nothing ever put the two together across the fleet — so "who is about to need a bigger plan", the
 * single warmest revenue list this product can produce, was answerable only by opening forty pages.
 * Once snapshots exist it is one query and this filter.
 *
 * UNLIMITED TIERS ARE EXCLUDED, not shown at 0%. TEAM and ENTERPRISE carry `UNLIMITED_SEATS`, so
 * there is no ceiling to approach and a row for them would be noise in the one list that must stay
 * short enough to act on. The console says so rather than leaving an operator to wonder.
 */
export function selectSeatOverage(rows: SeatUsageRow[], threshold = SEAT_PRESSURE): SeatOverageRow[] {
  return rows
    .filter((row) => hasSeatCeiling(row.seatLimit))
    .map((row) => ({ ...row, utilisation: row.seatsUsed / row.seatLimit, seatsRemaining: row.seatLimit - row.seatsUsed }))
    .filter((row) => row.utilisation >= threshold)
    .sort((a, b) => b.utilisation - a.utilisation);
}

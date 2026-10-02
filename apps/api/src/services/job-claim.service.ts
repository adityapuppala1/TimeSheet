/**
 * WHAT: "this scheduled job ran for this period" — the one mechanism that makes a cron tick run once
 * per DEPLOYMENT rather than once per API replica.
 *
 * WHY IT EXISTS. Every replica starts every worker in server.ts, and the Helm chart ships two replicas
 * with an autoscaler on top (deploy/helm/timesphere/values.yaml). Each worker's in-process `running`
 * flag stops a tick overlapping ITSELF, but says nothing about the pod next to it — so at 09:00 both
 * pods sent every trial warning, at :05 both sent every scheduled report, and every minute two
 * inbound-mail pollers read the same unseen messages and opened the same ticket twice. Setting
 * `replicaCount: 1` does not help: the HPA owns the count while autoscaling is on.
 *
 * HOW. Two rows in `PlatformJobClaim`, whose primary key is (job, periodKey):
 *  - THE PERIOD CLAIM, `(tick:<job>, <minute|hour|day key>)`. The first replica whose INSERT lands
 *    runs the tick; the rest stand down. The key is the tick's period at the cron's granularity
 *    (`tickPeriodKey`), so two pods whose clocks differ by a second still name the same tick.
 *  - THE LEASE, `(tick:<job>, "lease")`, held for the length of the run. It is the `running` flag
 *    lifted to the deployment: a tick that outlasts its period is not overlapped by another pod's
 *    next tick. Renewed every minute while the body runs, and taken over once it has gone
 *    `LEASE_STALE_MS` without a renewal — which is how a pod killed mid-run stops blocking the job.
 *
 * `tick:` NAMESPACES THE ROWS. signup-digest claims ("signup-digest", day) inside its own body; a
 * wrapper claiming the same key would refuse its own job.
 *
 * INSERT IGNORE, NOT INSERT-AND-CATCH-P2002. A losing replica is the normal case here — every minute,
 * for every minute job — and Prisma logs every failed query at `error` level, so catching P2002 would
 * print a stack of "Unique constraint failed" lines per pod per minute. `skipDuplicates` answers the
 * same question with a row count and no error. It also turns an over-long value into a silent
 * truncation, which is why the lengths are checked here first.
 *
 * Not a lock service. No lock is held across a crash for longer than the stale window, and nothing
 * here promises exactly-once execution of a body that dies halfway: a job must still tolerate a
 * partial run, as each of them already did.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { platformDayKey } from "../utils/platform-time.js";

/** The granularity of a cron, which is the granularity of the period a tick claims. */
export type TickGranularity = "minute" | "hour" | "day";

const JOB_MAX = 64;
const PERIOD_MAX = 32;
const LEASE_KEY = "lease";
/** How often a running tick renews its lease. */
const LEASE_RENEW_MS = 60_000;
/** A lease not renewed for this long belongs to a pod that died mid-run. Five renewals' worth: a
 *  stalled event loop is not mistaken for a dead pod, and a crashed one blocks its job for minutes,
 *  not hours. */
const LEASE_STALE_MS = 5 * 60_000;
/** How long a claim is kept. Long enough to answer "did Monday's 09:00 run happen?"; short enough that
 *  a table written every minute by every minute job stays a few tens of thousands of rows. */
export const JOB_CLAIM_KEEP_DAYS = 7;

function assertFits(job: string, periodKey: string): void {
  if (job.length > JOB_MAX || periodKey.length > PERIOD_MAX) {
    throw new Error(`Job claim key too long (job ≤ ${JOB_MAX}, period ≤ ${PERIOD_MAX}): "${job}" / "${periodKey}"`);
  }
}

async function insertIgnore(job: string, periodKey: string, claimedAt?: Date): Promise<boolean> {
  assertFits(job, periodKey);
  const { count } = await controlPrisma.platformJobClaim.createMany({ data: [{ job, periodKey, ...(claimedAt ? { claimedAt } : {}) }], skipDuplicates: true });
  return count === 1;
}

/**
 * Claims `periodKey` of `job` for this process. True for exactly one caller per (job, period) across
 * every replica; false for the rest. Any database error propagates — "I could not tell" must not read
 * as "somebody else has it".
 */
export async function claimJobPeriod(job: string, periodKey: string): Promise<boolean> {
  return insertIgnore(job, periodKey);
}

/**
 * The period a tick at `at` belongs to.
 *
 * A DAY is the platform's calendar day: "the 09:00 run" belongs to the date where the deployment is.
 * A MINUTE OR AN HOUR is named by the UTC instant. Named in local time, as they once were, the hour a
 * daylight-saving zone repeats each autumn produced the same keys twice, and every minute and hour
 * job — the mail queue, inbound mail, the SLA sweeps, backups, scheduled reports — stood down for the
 * second pass. A minute and an hour are the same length in every zone, so UTC loses nothing.
 *
 * The `Z` marks the format and keeps it from ever equalling a key written in the old local-time
 * format. That changed once, at deploy: claims made before it are simply pruned by age, and the most
 * the switch costs is one period run by an old pod and a new one during the rollout.
 */
export function tickPeriodKey(at: Date, granularity: TickGranularity): string {
  if (granularity === "day") return platformDayKey(at);
  const iso = at.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return granularity === "hour" ? `${iso.slice(0, 13)}Z` : `${iso.slice(0, 16)}Z`;
}

/** Takes the job's lease, or takes over one gone stale. Returns the stamp that identifies OUR lease,
 *  or null when another pod is still running the job. */
async function acquireLease(job: string): Promise<Date | null> {
  const stamp = new Date();
  if (await insertIgnore(job, LEASE_KEY, stamp)) return stamp;
  const { count } = await controlPrisma.platformJobClaim.deleteMany({
    where: { job, periodKey: LEASE_KEY, claimedAt: { lt: new Date(stamp.getTime() - LEASE_STALE_MS) } }
  });
  if (count === 0) return null;
  console.warn(`[job-claim] ${job}: took over a lease not renewed for ${LEASE_STALE_MS / 60_000} minutes — the pod holding it stopped mid-run.`);
  return (await insertIgnore(job, LEASE_KEY, stamp)) ? stamp : null;
}

/**
 * Runs `fn` for this tick if, and only if, this replica is the one that gets it.
 *
 * Call it INSIDE the worker's own `running` guard, never around it: a pod that is still busy must not
 * claim the tick and then skip it, when the idle pod beside it could have run it.
 *
 * Returns whether `fn` ran. An error from `fn` propagates to the worker's own catch, as before; the
 * lease is released either way. A claim table that cannot be reached skips the tick with a warning —
 * running it unguarded would be the duplicate this exists to prevent, and the next tick tries again.
 */
export async function runOncePerTick(job: string, granularity: TickGranularity, fn: () => Promise<unknown>, at: Date = new Date()): Promise<boolean> {
  const name = `tick:${job}`;
  let lease: Date | null;
  try {
    lease = await acquireLease(name);
  } catch (error) {
    console.warn(`[${job}] could not claim this tick, skipping it: ${(error as Error).message}`);
    return false;
  }
  if (!lease) return false;

  let current = lease;
  const renew = async () => {
    const next = new Date();
    try {
      const { count } = await controlPrisma.platformJobClaim.updateMany({ where: { job: name, periodKey: LEASE_KEY, claimedAt: current }, data: { claimedAt: next } });
      if (count === 1) current = next;
    } catch (error) {
      console.warn(`[${job}] could not renew its lease: ${(error as Error).message}`);
    }
  };
  const heartbeat = setInterval(() => void renew(), LEASE_RENEW_MS);
  heartbeat.unref();

  try {
    let claimed: boolean;
    try {
      claimed = await claimJobPeriod(name, tickPeriodKey(at, granularity));
    } catch (error) {
      console.warn(`[${job}] could not claim this tick, skipping it: ${(error as Error).message}`);
      return false;
    }
    if (!claimed) return false;
    await fn();
    return true;
  } finally {
    clearInterval(heartbeat);
    await controlPrisma.platformJobClaim
      .deleteMany({ where: { job: name, periodKey: LEASE_KEY, claimedAt: current } })
      .catch((error: Error) => console.warn(`[${job}] could not release its lease (it goes stale in ${LEASE_STALE_MS / 60_000} minutes): ${error.message}`));
  }
}

/** Deletes claims older than `keepDays`. A live lease is renewed every minute, so it is never old
 *  enough to be caught; a stale one from a dead pod is tidied up with the rest. */
export async function pruneJobClaims(now: Date = new Date(), keepDays: number = JOB_CLAIM_KEEP_DAYS): Promise<number> {
  const { count } = await controlPrisma.platformJobClaim.deleteMany({ where: { claimedAt: { lt: new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000) } } });
  return count;
}

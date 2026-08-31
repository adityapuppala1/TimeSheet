/**
 * WHAT: the daily pass that closes out claimed fixes nobody ever proved.
 *
 * WHY A WORKER AT ALL. Everything else in verified remediation is event-driven — a ticket closes,
 * a scan arrives — and both of those are things that HAPPEN. The case this worker exists for is the
 * case where nothing happens: a ticket was resolved, the findings were marked awaiting proof, and
 * no qualifying scan ever ran. There is no event for "still nothing", so somebody has to go and
 * look, and a claim that sits unresolved forever is exactly as useless as never having tracked it.
 *
 * WHY IT NUDGES AND NEVER REOPENS. This is the judgement the whole feature turns on, and it is
 * argued in full on `sweepUnverifiedFindings` in services/security-report.service.ts. The short
 * version: the overwhelmingly likely reason no scan arrived is that nobody wired that scanner into
 * CI for that branch, not that a developer lied about their fix. A system that reopens somebody's
 * ticket and tells their manager the fix failed, on the strength of a pipeline nobody configured,
 * is a system that is wrong in public — and people switch those off, taking the verification that
 * WOULD have caught a real regression with them.
 *
 * WHY DAILY AND NOT HOURLY: the window it enforces is measured in days (14 by default), so an
 * hourly pass would ask the same question twenty-four times to change an answer once. The guard
 * against re-nudging is the state transition itself — a finding moves out of AWAITING_PROOF the
 * first time this sees it expire, so it can never be swept twice.
 */
import cron from "node-cron";
import { sweepUnverifiedFindings } from "../services/security-report.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

export function startVerificationSweepWorker(): void {
  if (started) return;
  started = true;

  // 04:50, in the gap after the retention jobs (03:40, 04:10) and well clear of the 08:00–08:45
  // digest block. Nothing here is time-of-day sensitive; it is placed so that a slow night for one
  // job is not also a slow night for this one.
  cron.schedule("50 4 * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runForEveryOrg("verification-sweep", async () => {
        const marked = await sweepUnverifiedFindings();
        if (marked > 0) console.log(`[verification-sweep] ${marked} claimed fix(es) marked unverified`);
      });
    } catch (error) {
      console.warn(`[verification-sweep] tick failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}

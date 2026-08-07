/**
 * Waits until the API is actually answering through the same origin the suite talks to.
 *
 * WHY THIS EXISTS: `playwright.config.ts` sets `reuseExistingServer: true`, so the suite normally
 * runs against a developer's own `npm run dev` — which is `tsx watch`. Saving any file under
 * `apps/api/src` restarts that process, and for the second or two it is down the Vite proxy answers
 * every `/api/...` call with **502**. A run that overlaps one save loses a dozen unrelated specs to
 * "could not sign in as superadmin: 502", pointing at auth, at the database, at anything but the
 * editor window that caused it.
 *
 * This is a real readiness condition, not a sleep: it polls the liveness probe — which touches no
 * database and needs no session — and gives up on a budget, so an API that is genuinely down still
 * fails, just with an error that says so. `/api/health` rather than bare `/health` because the
 * proxy only forwards `/api` and `/uploads`; Vite would serve `/health` as the SPA's index.html and
 * report a dead backend as healthy (see app.ts's note on why both paths exist).
 */
import type { APIRequestContext, Page } from "@playwright/test";

/** Two restarts' worth of headroom. A cold `tsx watch` restart is ~1-3s on this codebase. */
const READY_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

export async function waitForApiReady(
  requester: APIRequestContext | Page["request"],
  timeoutMs = READY_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `catch` rather than a status check alone: while the process is down the proxy can also
    // refuse the connection outright, which throws instead of returning a response.
    const ok = await requester
      .get("/api/health", { timeout: 5_000 })
      .then((res) => res.ok())
      .catch(() => false);
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * WHAT: live backend reachability monitoring for the whole app.
 *
 * WHY escalating rather than blocking on the first failure: a single dropped request happens for
 * boring reasons — a laptop waking from sleep, a wifi handover, a redeploy rolling one pod. Hard-
 * blocking the UI on that would throw away whatever the user was typing for no reason. So the
 * first failure only warns, and the app is not taken away until the backend has genuinely failed
 * to answer several times in a row.
 *
 * WHY it listens to real traffic as well as its own poll: a user who clicks Save into a dead API
 * should learn immediately, not up to POLL_INTERVAL_MS later. `onBackendReachabilityChange`
 * (services/api.ts) reports network-level failures from every request the app makes.
 *
 * IMPORTANT: only *unreachable* counts — a 4xx/5xx means the server is up and answering, which is
 * an application error for the calling code to handle, not an outage. See
 * `isBackendUnreachableError`.
 */
import { useEffect, useRef, useState } from "react";
import { onBackendReachabilityChange, SERVER_ORIGIN } from "../services/api";

/** How often to probe while healthy. */
const POLL_INTERVAL_MS = 15_000;
/** Faster re-probe while down, so recovery is noticed quickly. */
const DOWN_POLL_INTERVAL_MS = 5_000;
/** Consecutive failures before the non-blocking warning appears. */
const WARN_AFTER_FAILURES = 1;
/** Consecutive failures before the app is blocked outright. */
const BLOCK_AFTER_FAILURES = 3;
/** Must be shorter than the poll interval, or probes would pile up on a hung backend. */
const PROBE_TIMEOUT_MS = 8_000;

export type BackendHealthLevel = "healthy" | "degraded" | "down";

export interface BackendHealth {
  level: BackendHealthLevel;
  consecutiveFailures: number;
  lastOkAt: Date | null;
  /** Lets the user force an immediate retry instead of waiting for the next tick. */
  checkNow: () => void;
}

export function useBackendHealth(): BackendHealth {
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [lastOkAt, setLastOkAt] = useState<Date | null>(null);
  // Read inside the interval callback without making it a dependency (which would tear down and
  // recreate the timer on every state change).
  const failuresRef = useRef(0);
  const [probeNonce, setProbeNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    function recordSuccess() {
      if (cancelled) return;
      failuresRef.current = 0;
      setConsecutiveFailures(0);
      setLastOkAt(new Date());
    }

    function recordFailure() {
      if (cancelled) return;
      failuresRef.current += 1;
      setConsecutiveFailures(failuresRef.current);
    }

    async function probe() {
      // Deliberately a bare `fetch` against SERVER_ORIGIN + /api/health rather than the app's
      // axios instance: no auth header, no interceptors, no refresh-retry. The probe must work
      // when the user is logged out and must never itself trigger a token refresh.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${SERVER_ORIGIN}/api/health`, { signal: controller.signal, cache: "no-store" });
        // A non-2xx from a reachable server still means the process is answering; treat only a
        // thrown/aborted request as unreachable.
        if (res.ok) recordSuccess();
        else recordFailure();
      } catch {
        recordFailure();
      } finally {
        clearTimeout(timer);
      }
    }

    void probe();
    const interval = setInterval(probe, failuresRef.current > 0 ? DOWN_POLL_INTERVAL_MS : POLL_INTERVAL_MS);

    // Real traffic is a stronger, faster signal than the poll.
    const unsubscribe = onBackendReachabilityChange((reachable) => {
      if (reachable) recordSuccess();
      else recordFailure();
    });

    // Coming back from a background tab or regaining a connection are both moments where the
    // truth may have changed while no polling was happening.
    const onFocus = () => void probe();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);

    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
    };
    // `probeNonce` lets checkNow() force a fresh cycle; `consecutiveFailures` re-arms the timer at
    // the faster cadence once we're down (and back to the slow one once recovered).
  }, [probeNonce, consecutiveFailures > 0]);

  const level: BackendHealthLevel =
    consecutiveFailures >= BLOCK_AFTER_FAILURES ? "down" : consecutiveFailures >= WARN_AFTER_FAILURES ? "degraded" : "healthy";

  return { level, consecutiveFailures, lastOkAt, checkNow: () => setProbeNonce((n) => n + 1) };
}

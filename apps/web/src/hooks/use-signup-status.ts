/**
 * WHAT: whether this deployment offers self-serve signup, for every page that links to it.
 *
 * WHY A HOOK. Four public pages offer "start a free trial" — the pricing cards, the contact page, the
 * reactivation page and the signup page itself — and since 2026-10-01 signup is closed unless an
 * operator opens it (and is always closed on a single-org install). One query, one cache key, so the
 * pages cannot disagree about whether the door exists.
 *
 * `open` is `undefined` until the answer arrives, and stays `undefined` if the request fails. Callers
 * decide what unknown means for them: the pricing card keeps its trial button (the signup page states
 * the truth either way), while a page that merely MENTIONS a trial only does so when it is known open.
 *
 * `rootDomain` is what a new workspace's address hangs off (`<slug>.<rootDomain>`), straight from the
 * server — the signup page shows it rather than guessing from its own host.
 */
import { SELF_SERVE_TRIAL_DAYS } from "@timesheet/shared";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "../services/api";

export function useSignupStatus(): { open: boolean | undefined; trialDays: number; rootDomain: string | null } {
  const query = useQuery({
    queryKey: ["signup-status"],
    queryFn: () => authApi.signupStatus(),
    // An operator flips this rarely; a visitor should not re-ask on every focus change.
    staleTime: 5 * 60 * 1000,
    retry: 1
  });
  return { open: query.data?.open, trialDays: query.data?.trialDays ?? SELF_SERVE_TRIAL_DAYS, rootDomain: query.data?.rootDomain ?? null };
}

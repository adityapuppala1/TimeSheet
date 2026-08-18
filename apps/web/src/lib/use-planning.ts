/**
 * WHAT: the one hook every surface uses to ask "is this planning feature actually available?"
 *
 * WHY IT EXISTS RATHER THAN EACH PAGE READING THE SETTINGS ITSELF: availability is a workspace
 * toggle AND a plan entitlement, and the API computes that AND server-side (see
 * `planning.service.ts#getEffectivePlanning`). Re-deriving it in the client would let the nav
 * offer a page the API then 403s. So this returns the server's `effective` object verbatim and
 * nothing recomputes it.
 *
 * WHY IT NEVER THROWS OR BLOCKS: the sidebar calls it on every page load, including for users
 * whose session is still bootstrapping. A failed or pending fetch reports everything OFF — which
 * hides some nav for a moment rather than flashing links that then disappear, and matches the
 * "inert until an admin opts in" default the whole planning layer follows.
 */
import { useQuery } from "@tanstack/react-query";
import { planningApi, type PlanningEffective } from "../services/api";

const ALL_OFF: PlanningEffective = {
  planning: false,
  timeline: false,
  resourceManagement: false,
  approvals: false,
  proofing: false,
  requestForms: false,
  customWorkflows: false,
  goals: false
};

export function usePlanningFeatures(): { features: PlanningEffective; isLoading: boolean } {
  const query = useQuery({
    queryKey: ["planning", "settings"],
    queryFn: planningApi.settings,
    // Longer than the app default: these are admin settings that change once in a while, and the
    // sidebar asking on every navigation would be a request per page view for a value that is
    // almost always identical.
    staleTime: 5 * 60_000,
    retry: false
  });
  return { features: query.data?.effective ?? ALL_OFF, isLoading: query.isLoading };
}

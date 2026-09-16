/**
 * WHAT: the contract between the sidebar's Project → Module tree and the Tickets page — the two
 * query-string keys a tree link writes and the page reads, in one place.
 *
 * WHY A MODULE, NOT `?projectId=`: the URL is a thing people paste to each other, and the Tickets
 * page already reads `?open=` for a ticket. Short human keys keep the two consistent.
 *
 * WHY THE TREE STOPS AT MODULE: `Ticket` carries `projectId` and an optional `moduleId`; it has NO
 * submodule column — only `Timesheet` does (schema.prisma). A submodule row in a tree that leads
 * to tickets would be a row that leads nowhere, so the third tier is deliberately absent rather
 * than shown greyed out. The V12 state file records this; it corrects an earlier assumption.
 */

export const PROJECT_PARAM = "project";
export const MODULE_PARAM = "module";

export interface ProjectSelection {
  projectId?: string;
  moduleId?: string;
}

/** The Tickets URL for a project, or for one module within it. */
export function ticketsHref(projectId: string, moduleId?: string): string {
  const params = new URLSearchParams();
  params.set(PROJECT_PARAM, projectId);
  if (moduleId) params.set(MODULE_PARAM, moduleId);
  return `/app/tickets?${params.toString()}`;
}

/**
 * What a URL is asking the Tickets page to filter on. A module without a project is ignored: the
 * module select only offers the chosen project's modules, so it could never be shown selected.
 */
export function readProjectSelection(search: string | URLSearchParams): ProjectSelection {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const projectId = params.get(PROJECT_PARAM) || undefined;
  const moduleId = projectId ? params.get(MODULE_PARAM) || undefined : undefined;
  return { projectId, moduleId };
}

/** Removes the two keys, leaving every other parameter (e.g. `?open=`) untouched. */
export function withoutProjectSelection(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(PROJECT_PARAM);
  next.delete(MODULE_PARAM);
  return next;
}

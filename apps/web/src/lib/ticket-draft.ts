/**
 * WHAT: the pre-filled draft behind "Add ticket" — from the active filters, and from the group the
 * button sits under.
 *
 * WHY: the source rule (V12 state file, 3.13 and 3.17): tasks created from a grouped or filtered
 * view have their fields set to match the group and filter, so what you create lands where you
 * are looking. Status is not creatable (every ticket opens as OPEN). A sprint group is keyed by
 * the sprint's NAME (that is what the heading shows), so it is resolved here against the
 * project's sprint list; an unknown name pre-fills nothing rather than guessing.
 */
import type { TicketFilters } from "../components/SavedViewsBar";
import { PRIORITY_VARIANT } from "./ticket-visuals";

export type TicketPriorityId = keyof typeof PRIORITY_VARIANT;

export type TicketDraftInitial = Partial<{ projectId: string; moduleId: string; type: string; priority: TicketPriorityId; sprintId: string }>;

export interface NamedRef {
  id: string;
  name: string;
}

/** Everything the active filters pin down. "all" pins nothing. */
export function draftFromFilters(filters: TicketFilters): TicketDraftInitial {
  const initial: TicketDraftInitial = {};
  if (filters.projectId !== "all") initial.projectId = filters.projectId;
  if (filters.moduleId !== "all") initial.moduleId = filters.moduleId;
  if (filters.type !== "all") initial.type = filters.type;
  if (filters.priority !== "all") initial.priority = filters.priority as TicketPriorityId;
  // A sprint is per project, so it is only meaningful with the project it was filtered under.
  if (filters.sprintId !== "all" && filters.projectId !== "all") initial.sprintId = filters.sprintId;
  return initial;
}

function applyProjectGroup(initial: TicketDraftInitial, value: unknown, filters: TicketFilters, projects: ReadonlyArray<NamedRef>): void {
  if (typeof value !== "string") return;
  const project = projects.find((p) => p.name === value);
  if (!project) return;
  initial.projectId = project.id;
  // A module and a sprint belong to the project they were filtered under; drop them on a switch.
  if (filters.projectId !== project.id) {
    delete initial.moduleId;
    delete initial.sprintId;
  }
}

function applySprintGroup(initial: TicketDraftInitial, value: unknown, sprints: ReadonlyArray<NamedRef>): void {
  const sprint = typeof value === "string" ? sprints.find((s) => s.name === value) : undefined;
  // The "no sprint" group (null key) and an unknown name pre-fill no sprint, even under a sprint filter.
  if (sprint) initial.sprintId = sprint.id;
  else delete initial.sprintId;
}

/** The filters' draft, then the group's own value on top. */
export function draftFor(
  axis: string | undefined,
  value: unknown,
  filters: TicketFilters,
  projects: ReadonlyArray<NamedRef>,
  sprints: ReadonlyArray<NamedRef> = []
): TicketDraftInitial {
  const initial = draftFromFilters(filters);
  if (axis === "priority" && typeof value === "string" && value in PRIORITY_VARIANT) initial.priority = value as TicketPriorityId;
  if (axis === "type" && typeof value === "string" && value) initial.type = value;
  if (axis === "project") applyProjectGroup(initial, value, filters, projects);
  if (axis === "sprint") applySprintGroup(initial, value, sprints);
  return initial;
}

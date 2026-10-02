import { describe, expect, it } from "vitest";
import { draftFor, draftFromFilters, pickableTicketTypes } from "../../src/lib/ticket-draft";
import type { TicketFilters } from "../../src/components/SavedViewsBar";

const base: TicketFilters = { projectId: "all", moduleId: "all", type: "all", priority: "all", status: "all", assigneeId: "all", labelId: "all", sprintId: "all", search: "" } as unknown as TicketFilters;
const projects = [{ id: "p1", name: "Alpha" }, { id: "p2", name: "Beta" }];
const sprints = [{ id: "s1", name: "Sprint 1" }, { id: "s2", name: "Sprint 2" }];

describe("draftFromFilters", () => {
  it("pins nothing when every filter is all", () => {
    expect(draftFromFilters(base)).toEqual({});
  });
  it("carries the sprint filter only together with its project", () => {
    expect(draftFromFilters({ ...base, projectId: "p1", sprintId: "s1" })).toEqual({ projectId: "p1", sprintId: "s1" });
    expect(draftFromFilters({ ...base, sprintId: "s1" })).toEqual({});
  });
});

describe("draftFor", () => {
  it("a sprint group resolves the heading's name to the sprint id", () => {
    expect(draftFor("sprint", "Sprint 2", { ...base, projectId: "p1" }, projects, sprints)).toEqual({ projectId: "p1", sprintId: "s2" });
  });
  it("the no-sprint group and an unknown name pre-fill no sprint, even under a sprint filter", () => {
    expect(draftFor("sprint", null, { ...base, projectId: "p1", sprintId: "s1" }, projects, sprints)).toEqual({ projectId: "p1" });
    expect(draftFor("sprint", "Gone", { ...base, projectId: "p1", sprintId: "s1" }, projects, sprints)).toEqual({ projectId: "p1" });
  });
  it("switching project via a project group drops a sprint that belonged to the filtered project", () => {
    expect(draftFor("project", "Beta", { ...base, projectId: "p1", sprintId: "s1", moduleId: "m1" }, projects, sprints)).toEqual({ projectId: "p2" });
    expect(draftFor("project", "Alpha", { ...base, projectId: "p1", sprintId: "s1" }, projects, sprints)).toEqual({ projectId: "p1", sprintId: "s1" });
  });
  it("priority and type groups still pre-fill as before", () => {
    expect(draftFor("priority", "HIGH", base, projects)).toEqual({ priority: "HIGH" });
    expect(draftFor("priority", "nope", base, projects)).toEqual({});
    expect(draftFor("type", "TASK", base, projects)).toEqual({ type: "TASK" });
  });
});

describe("the CHANGE type is not something a new ticket can be given", () => {
  // Changes are raised from the Changes page, which creates their ticket; the API refuses a plain
  // ticket of type CHANGE, so offering it here would only ever produce a refusal.
  it("is left out of the type picker", () => {
    const types = [{ id: "1", name: "BUG" }, { id: "2", name: "CHANGE" }, { id: "3", name: "TASK" }];
    expect(pickableTicketTypes(types).map((t) => t.name)).toEqual(["BUG", "TASK"]);
  });
  it("is not carried into a new ticket's draft from a CHANGE type filter or group", () => {
    expect(draftFromFilters({ ...base, type: "CHANGE" })).toEqual({});
    expect(draftFor("type", "CHANGE", base, projects)).toEqual({});
  });
});

/**
 * V12 7.3 — the workload board grouped by project, people inside. A project row totals hours,
 * tickets and points over its people but measures no capacity; a person inside a project counts
 * only that project's bookings and tickets against their whole capacity; someone booked on a
 * project they are not assigned to still appears on its row; empty projects are dropped.
 */
import { describe, expect, it } from "vitest";
import { groupWorkloadByProject, type Bucket } from "../../src/services/workload.service.js";

const W1: Bucket = { start: "2026-09-14", end: "2026-09-20", label: "09-14", workingDays: 5 };
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const person = (id: string, name: string) => ({ id, name, email: `${id}@x`, avatarUrl: null, weeklyCapacityHours: 40, plannedUtilizationPct: null });

describe("groupWorkloadByProject", () => {
  const projects = [
    { id: "p1", code: "ALPHA", name: "Alpha", color: null },
    { id: "p2", code: "BETA", name: "Beta", color: "rose" },
    { id: "p3", code: "GAMMA", name: "Gamma", color: null }
  ];
  const people = [person("ana", "Ana"), person("bo", "Bo")];
  const membership = [{ userId: "ana", projectId: "p1" }, { userId: "bo", projectId: "p1" }];
  const bookings = [
    { id: "b1", userId: "ana", projectId: "p1", ticketId: null, startDate: d("2026-09-14"), endDate: d("2026-09-18"), hoursPerDay: 4, isTimeOff: false, note: null },
    // Bo is booked on Beta without being assigned to it.
    { id: "b2", userId: "bo", projectId: "p2", ticketId: null, startDate: d("2026-09-14"), endDate: d("2026-09-14"), hoursPerDay: 8, isTimeOff: false, note: null }
  ];
  const tickets = [{ userId: "ana", projectId: "p1", startDate: d("2026-09-15"), endDate: d("2026-09-15"), dueAt: null, storyPoints: 3 }];
  const groups = groupWorkloadByProject({
    projects, membership, people, bookings, logged: [], tickets, buckets: [W1], workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40
  });

  it("makes a row per project with people, drops projects with nobody, sorts by name", () => {
    expect(groups.map((g) => g.project.code)).toEqual(["ALPHA", "BETA"]);
    expect(groups[0].rows.map((r) => r.person.id)).toEqual(["ana", "bo"]);
    expect(groups[1].rows.map((r) => r.person.id)).toEqual(["bo"]); // booked there, not assigned
  });

  it("a person inside a project counts only that project's hours and tickets against their whole capacity", () => {
    const anaOnAlpha = groups[0].rows.find((r) => r.person.id === "ana")!;
    expect(anaOnAlpha.totals.bookedHours).toBe(20); // 4h × 5 working days
    expect(anaOnAlpha.totals.allocationPct).toBe(50); // of 40h
    expect(anaOnAlpha.totals.ticketCount).toBe(1);
    const boOnAlpha = groups[0].rows.find((r) => r.person.id === "bo")!;
    expect(boOnAlpha.totals.bookedHours).toBe(0); // Bo's booking is on Beta
  });

  it("project totals sum their people's hours, tickets and points — and carry no capacity", () => {
    expect(groups[0].totals).toEqual({ bookedHours: 20, loggedHours: 0, ticketCount: 1, storyPoints: 3 });
    expect(groups[1].totals).toEqual({ bookedHours: 8, loggedHours: 0, ticketCount: 0, storyPoints: 0 });
    expect("capacityHours" in groups[0].totals).toBe(false);
  });
});

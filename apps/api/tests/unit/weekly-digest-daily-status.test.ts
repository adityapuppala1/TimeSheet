/**
 * The Daily logging status section of the Monday digest.
 *
 * Three rules are worth pinning, each of which fails in a way nobody would notice from the email:
 *
 * 1. WHO SEES WHOM. A manager must get THEIR TEAM, not the workspace. The digest's own scope is keyed
 *    on `reports:view`, which managers hold too — so the daily grid keys on `users:manage` instead,
 *    the rule the home page uses. A test that only checked "admins get everyone" would pass against
 *    the version that quietly handed every manager the whole company.
 * 2. WHAT RED MEANS. Red is a WORKING day with nothing logged. A day off is grey even when empty, and
 *    a day off with entries is green — the same definitions as the home page card.
 * 3. THE NAMES ARE ESCAPED. This is an email built from HTML strings with people's names in it.
 *
 * Pure functions only: the Prisma read is exercised by the integration tier, and a mock of it would
 * have passed against the broken scope rule.
 */
import { describe, expect, it } from "vitest";

import { permissions } from "@timesheet/shared";

import {
  buildDailyStatus,
  fillScopeFor,
  renderDailyStatus,
  weekDays,
  type DayFigure,
  type RosterPerson
} from "../../src/services/weekly-digest-daily-status.service.js";

// Monday 2 Nov – Sunday 8 Nov 2026, stored the way `workDate` is: UTC midnight.
const FROM = new Date(Date.UTC(2026, 10, 2));
const TO = new Date(Date.UTC(2026, 10, 9));
const MON_TO_FRI = [1, 2, 3, 4, 5];

const person = (id: string, name: string, managerId: string | null = null, managerName: string | null = null): RosterPerson => ({
  id,
  name,
  managerId,
  managerName
});

const figures = (entries: Record<string, Record<string, DayFigure>>) =>
  new Map(Object.entries(entries).map(([id, days]) => [id, new Map(Object.entries(days))]));

describe("fillScopeFor — whose daily status the email carries", () => {
  it("gives everyone to users:manage, even with nobody reporting to them", () => {
    expect(fillScopeFor([permissions.USERS_MANAGE], 0)).toBe("ALL");
    expect(fillScopeFor([permissions.USERS_MANAGE, permissions.REPORTS_VIEW], 4)).toBe("ALL");
  });

  it("gives a manager their team, not the workspace, even though they hold reports:view", () => {
    expect(fillScopeFor([permissions.REPORTS_VIEW], 3)).toBe("TEAM");
  });

  it("gives everyone else just themselves", () => {
    expect(fillScopeFor([], 0)).toBe("SELF");
    expect(fillScopeFor([permissions.REPORTS_VIEW], 0)).toBe("SELF");
  });
});

describe("weekDays", () => {
  it("lists Monday to Sunday and marks only the working week as due", () => {
    const days = weekDays(FROM, TO, MON_TO_FRI);
    expect(days.map((d) => d.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(days.map((d) => d.due)).toEqual([true, true, true, true, true, false, false]);
    expect(days[0].key).toBe("2026-11-02");
  });

  it("follows the workspace's own working week", () => {
    const sixDay = weekDays(FROM, TO, [1, 2, 3, 4, 5, 6]);
    expect(sixDay.filter((d) => d.due)).toHaveLength(6);
  });
});

describe("buildDailyStatus", () => {
  const days = weekDays(FROM, TO, MON_TO_FRI);

  it("counts filled days, working days, gaps and hours; a filled day off is green and never a gap", () => {
    const status = buildDailyStatus({
      days,
      roster: [person("a", "Asha")],
      figures: figures({
        a: {
          "2026-11-02": { entries: 2, hours: 8 },
          "2026-11-03": { entries: 1, hours: 7.5 },
          "2026-11-07": { entries: 1, hours: 3 } // a Saturday
        }
      })
    });
    const asha = status.people[0];
    expect(asha.cells.map((c) => c.state)).toEqual(["filled", "filled", "missing", "missing", "missing", "filled", "off"]);
    expect(asha.cells[0].entries).toBe(2);
    expect(asha.filledDays).toBe(3); // the Saturday counts — so this can pass dueDays
    expect(asha.dueDays).toBe(5);
    expect(asha.gapDays).toBe(3); // Wed, Thu, Fri — the Saturday is not a gap and Sunday is just off
    expect(asha.hours).toBeCloseTo(18.5);
  });

  it("shows someone who logged nothing at all as a row of red working days", () => {
    const status = buildDailyStatus({ days, roster: [person("b", "Bala")], figures: new Map() });
    expect(status.people[0].gapDays).toBe(5);
    expect(status.people[0].cells.filter((c) => c.state === "missing")).toHaveLength(5);
    expect(status.people[0].cells.filter((c) => c.state === "off")).toHaveLength(2);
  });

  it("puts the people with the most unfilled days first", () => {
    const status = buildDailyStatus({
      days,
      roster: [person("a", "Asha"), person("b", "Bala"), person("c", "Chitra")],
      figures: figures({
        a: Object.fromEntries(days.filter((d) => d.due).map((d) => [d.key, { entries: 1, hours: 8 }])),
        c: { "2026-11-02": { entries: 1, hours: 8 } }
      })
    });
    expect(status.people.map((p) => p.name)).toEqual(["Bala", "Chitra", "Asha"]);
  });

  it("rolls teams up by manager, most gaps first, with the unmanaged bucket last", () => {
    const status = buildDailyStatus({
      days,
      roster: [
        person("a", "Asha", "m1", "Meera"),
        person("b", "Bala", "m1", "Meera"),
        person("c", "Chitra", "m2", "Nikhil"),
        person("d", "Dev")
      ],
      figures: figures({ a: Object.fromEntries(days.filter((d) => d.due).map((d) => [d.key, { entries: 1, hours: 8 }])) })
    });
    expect(status.teams.map((t) => t.name)).toEqual(["Meera", "Nikhil", "No manager"]);
    const meera = status.teams[0];
    expect(meera.people).toBe(2);
    expect(meera.gapPeople).toBe(1); // Bala
    expect(meera.filledDays).toBe(5);
    expect(meera.dueDays).toBe(10);
  });
});

describe("renderDailyStatus", () => {
  const days = weekDays(FROM, TO, MON_TO_FRI);
  const render = (roster: RosterPerson[], scope: "SELF" | "TEAM" | "ALL", extra: { maxRows?: number; recipientId?: string } = {}) =>
    renderDailyStatus(buildDailyStatus({ days, roster, figures: new Map() }), {
      scope,
      weekLabel: "Nov 2 - Nov 8",
      recipientId: extra.recipientId ?? "a",
      maxRows: extra.maxRows
    });

  it("renders nothing when there is nobody to show", () => {
    expect(render([], "ALL")).toBe("");
  });

  it("escapes names, because the email is built from HTML strings", () => {
    const html = render([person("a", '<img src=x onerror="alert(1)">')], "SELF");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("states days, hours against plan and the percentage, with 8h for each working day", () => {
    const html = render([person("a", "Asha")], "SELF");
    expect(html).toContain("0/5"); // days filled out of working days
    expect(html).toContain("0.0h/40h"); // hours / plan
    expect(html).toContain("0%");
  });

  it("titles the section for who is reading it", () => {
    expect(render([person("a", "Asha")], "SELF")).toContain("Your daily logging");
    expect(render([person("a", "Asha")], "TEAM")).toContain("Your team&#39;s daily logging");
    expect(render([person("a", "Asha")], "ALL")).toContain("Daily logging across the workspace");
  });

  it("marks the recipient's own row in a team view", () => {
    expect(render([person("a", "Asha"), person("b", "Bala")], "TEAM", { recipientId: "a" })).toContain("(you)");
  });

  it("adds the by-team table only for the workspace view, and only with more than one team", () => {
    const roster = [person("a", "Asha", "m1", "Meera"), person("c", "Chitra", "m2", "Nikhil")];
    expect(render(roster, "ALL")).toContain("By team");
    expect(render(roster, "TEAM")).not.toContain("By team");
    expect(render([person("a", "Asha", "m1", "Meera")], "ALL")).not.toContain("By team");
  });

  it("caps the rows and says how many are not shown", () => {
    const roster = Array.from({ length: 6 }, (_, i) => person(`u${i}`, `Person ${i}`));
    const html = render(roster, "ALL", { maxRows: 4, recipientId: "u0" });
    expect(html).toContain("Showing the 4 people with the most unfilled days");
    expect(html).toContain("2 more");
    expect(html).not.toContain("Person 5");
  });
});

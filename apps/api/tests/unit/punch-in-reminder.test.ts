/**
 * V17 A4 — the punch-in reminder (workers/daily-reminder.worker.ts#runPunchInReminders), and the
 * regression guard that the 17:00 timesheet reminder and the next-morning escalation are unchanged.
 *
 * The clock is the RECIPIENT's (utils/recipient-time.ts). The day verdict is resolveDayStatus, so a
 * weekend, a holiday or a punch from any source (here: a biometric webhook) all stay silent.
 * Delivery gates (category toggle, role mutes, EmailLog) are dispatchNotification's and are covered
 * in punch-in-reminder-email-gates.test.ts against the real dispatcher.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

type Person = { id: string; name: string; email: string; timezone: string | null; holidayCalendarId: string | null; manager: { id: string; name: string; isAgent: boolean } | null; role?: string };

const MEERA = { id: "meera", name: "Meera", isAgent: false };
const PEOPLE: Person[] = [
  { id: "asha", name: "Asha Rao", email: "asha@acme.test", timezone: "Asia/Kolkata", holidayCalendarId: null, manager: MEERA },
  { id: "nate", name: "Nate Park", email: "nate@acme.test", timezone: "America/New_York", holidayCalendarId: null, manager: MEERA }
];

const h = vi.hoisted(() => ({
  sent: [] as any[],
  punched: new Map<string, string>(), // `${userId}|${dateKey}` -> source
  holidays: [] as string[],
  loggedTimesheet: false,
  attendance: {} as Record<string, unknown>,
  planAllows: true,
  queries: 0,
  userWheres: [] as any[],
  extraPeople: [] as Person[]
}));

vi.mock("../../src/config/prisma.js", () => {
  const counted = <T extends (...a: any[]) => any>(fn: T) =>
    vi.fn(async (...a: Parameters<T>) => {
      h.queries += 1;
      return fn(...a);
    });
  return {
    prisma: {
      user: {
        findMany: counted(({ where }: any = {}) => {
          h.userWheres.push(where);
          const roles: string[] | undefined = where?.role?.name?.in;
          return [...PEOPLE, ...h.extraPeople].filter((p) => !roles || roles.includes(p.role ?? "EMPLOYEE"));
        })
      },
      timesheet: { count: vi.fn(async () => (h.loggedTimesheet ? 1 : 0)) },
      notification: {
        count: vi.fn(async ({ where }: any) => h.sent.filter((n) => n.userId === where.userId && n.category === where.category).length),
        // Rows from this run's earlier ticks; "createdAt" is the start of the window asked about.
        findMany: counted(({ where }: any) =>
          h.sent.filter((n) => where.userId.in.includes(n.userId) && n.category === where.category).map((n) => ({ userId: n.userId, createdAt: n.createdAt ?? new Date(8.64e15) }))
        )
      },
      attendanceRecord: {
        findMany: counted(({ where }: any) => {
          const days = where.workDate.in.map((d: Date) => d.toISOString().slice(0, 10));
          return [...h.punched.keys()]
            .map((k) => k.split("|"))
            .filter(([u, d]) => where.userId.in.includes(u) && days.includes(d))
            .map(([u, d]) => ({ userId: u, workDate: new Date(`${d}T00:00:00Z`) }));
        })
      },
      holidayCalendar: { findFirst: counted(() => ({ id: "cal" })) },
      holiday: {
        findMany: counted(({ where }: any) =>
          h.holidays
            .filter((d) => d >= where.date.gte.toISOString().slice(0, 10) && d <= where.date.lte.toISOString().slice(0, 10))
            .map((d) => ({ calendarId: "cal", date: new Date(`${d}T00:00:00Z`), name: "Holiday" }))
        )
      }
    }
  };
});
vi.mock("../../src/services/notify.service.js", () => ({
  getGlobalNotificationSettings: vi.fn(async () => ({ dailyReminderHour: 17, escalationReminderHour: 9, remindOnWeekdaysOnly: true })),
  dispatchNotification: vi.fn(async (n: any) => {
    h.sent.push(n);
  })
}));
vi.mock("../../src/services/attendance-settings.service.js", () => ({ getAttendanceSettings: vi.fn(async () => h.attendance) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ isPlanningCapabilityAllowed: vi.fn(async () => h.planAllows) }));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: vi.fn(async () => ({ workingDays: [1, 2, 3, 4, 5] })) }));

const { runPunchInReminders, runDailyReminders, runEscalationReminders, runRemindersNow } = await import("../../src/workers/daily-reminder.worker.js");

const inTenant = <T>(fn: () => Promise<T>) => runInTenant({} as PrismaClient, fn);

// Wednesday 18 November 2026.
const IST_11 = new Date("2026-11-18T05:30:00.000Z"); // 11:00 IST, 00:30 New York
const NY_11 = new Date("2026-11-18T16:00:00.000Z"); // 11:00 New York (EST), 21:30 IST
const IST_10 = new Date("2026-11-18T04:30:00.000Z");
const IST_SAT_11 = new Date("2026-11-21T05:30:00.000Z");

beforeEach(() => {
  h.sent.length = 0;
  h.punched.clear();
  h.holidays = [];
  h.loggedTimesheet = false;
  h.planAllows = true;
  h.queries = 0;
  h.userWheres = [];
  h.extraPeople = [];
  h.attendance = { attendanceEnabled: true, punchInReminderEnabled: true, punchInMode: "OPTIONAL", punchInReminderHour: 11 };
});

const punchRecipients = () => h.sent.filter((n) => n.category === "reminder.punch_in").map((n) => n.userId);

describe("the punch-in reminder fires", () => {
  it("at the reminder hour in each recipient's own timezone", async () => {
    await inTenant(() => runPunchInReminders(IST_11));
    expect(punchRecipients()).toEqual(["asha"]);
    await inTenant(() => runPunchInReminders(NY_11));
    expect(punchRecipients()).toEqual(["asha", "nate"]);
  });

  it("with its own category, template and the recipient's date", async () => {
    await inTenant(() => runPunchInReminders(IST_11));
    expect(h.sent[0]).toMatchObject({
      userId: "asha",
      category: "reminder.punch_in",
      link: "/app",
      email: { templateKey: "reminder.punch_in", vars: { name: "Asha Rao", date: "2026-11-18" } }
    });
    expect(h.sent[0].email.fallback.html).toContain("punch");
  });

  it("follows a configured hour", async () => {
    h.attendance = { ...h.attendance, punchInReminderHour: 10 };
    await inTenant(() => runPunchInReminders(IST_11));
    expect(punchRecipients()).toEqual([]);
    await inTenant(() => runPunchInReminders(IST_10));
    expect(punchRecipients()).toEqual(["asha"]);
  });
});

describe("the punch-in reminder stays silent", () => {
  it.each<[string, () => void, Date]>([
    ["off the hour", () => {}, IST_10],
    ["on a weekend", () => {}, IST_SAT_11],
    ["on a holiday", () => (h.holidays = ["2026-11-18"]), IST_11],
    ["when a biometric webhook already punched them in", () => h.punched.set("asha|2026-11-18", "WEBHOOK"), IST_11],
    ["when punching in is OFF", () => (h.attendance = { ...h.attendance, punchInMode: "OFF" }), IST_11],
    ["when the reminder setting is off", () => (h.attendance = { ...h.attendance, punchInReminderEnabled: false }), IST_11],
    ["when attendance is off", () => (h.attendance = { ...h.attendance, attendanceEnabled: false }), IST_11],
    ["when the plan lacks attendance", () => (h.planAllows = false), IST_11]
  ])("%s", async (_label, arrange, at) => {
    arrange();
    const result = await inTenant(() => runPunchInReminders(at));
    expect(result.sent).toBe(0);
    expect(punchRecipients()).toEqual([]);
  });

  it("the second time in a day (Notification idempotency)", async () => {
    await inTenant(() => runPunchInReminders(IST_11));
    // The :30 safety tick, same local hour.
    await inTenant(() => runPunchInReminders(new Date(IST_11.getTime() + 29 * 60_000)));
    expect(punchRecipients()).toEqual(["asha"]);
  });
});

/* ------------------------------------------------------------------ *
 * Regression: the 17:00 reminder and 09:00 escalation are unchanged
 * ------------------------------------------------------------------ */

describe("the existing timesheet reminders are byte-for-byte what they were", () => {
  // 17:00 IST Wednesday.
  const IST_17 = new Date("2026-11-18T11:30:00.000Z");
  // 09:00 IST Thursday.
  const IST_THU_9 = new Date("2026-11-19T03:30:00.000Z");

  it("the 17:00 daily reminder payload", async () => {
    await inTenant(() => runDailyReminders(IST_17));
    expect(h.sent).toEqual([
      {
        userId: "asha",
        category: "reminder.daily",
        title: "Log today's timesheet",
        body: "We haven't seen a timesheet entry for 2026-11-18 yet. Two minutes now saves a tomorrow-morning escalation.",
        link: "/app/timesheet",
        email: {
          templateKey: "reminder.daily",
          vars: { name: "Asha Rao", date: "2026-11-18", deadlineHour: "18" },
          fallback: {
            subject: "Don't forget — log today's timesheet (2026-11-18)",
            html: "<p>Hi Asha Rao, we haven't seen a timesheet for 2026-11-18. Please log it before 18:00 to avoid an escalation tomorrow morning.</p>"
          }
        }
      }
    ]);
  });

  it("the 09:00 escalation payloads (employee + manager)", async () => {
    await inTenant(() => runEscalationReminders(IST_THU_9));
    expect(h.sent).toEqual([
      {
        userId: "asha",
        category: "reminder.escalation",
        title: "Yesterday's timesheet escalated to your manager",
        body: "You didn't log time for 2026-11-18. Catch up now and file today's entry before 5 PM.",
        link: "/app/timesheet",
        metadata: { missedDate: "2026-11-18" },
        email: {
          templateKey: "reminder.escalation.employee",
          vars: { name: "Asha Rao", missedDate: "2026-11-18", managerName: "Meera" },
          fallback: {
            subject: "Action required — 2026-11-18 timesheet escalated",
            html: "<p>Asha Rao, you missed 2026-11-18's timesheet. Log it and today's entry before 5 PM.</p>"
          }
        }
      },
      {
        userId: "meera",
        category: "reminder.escalation",
        title: "Asha Rao missed yesterday's timesheet",
        body: "Asha Rao (asha@acme.test) did not log a timesheet for 2026-11-18. They've been reminded directly.",
        link: "/app/team",
        metadata: { missedDate: "2026-11-18", employeeId: "asha" },
        email: {
          templateKey: "reminder.escalation.manager",
          vars: { managerName: "Meera", employeeName: "Asha Rao", employeeEmail: "asha@acme.test", missedDate: "2026-11-18" },
          fallback: {
            subject: "Asha Rao missed yesterday's timesheet",
            html: "<p>Hi Meera, Asha Rao did not log a timesheet for 2026-11-18. They've been reminded.</p>"
          }
        }
      }
    ]);
  });

  it("a full tick at 17:00 with attendance fully on sends only the timesheet reminder", async () => {
    await inTenant(() => runRemindersNow(IST_17));
    expect(h.sent.map((n) => `${n.userId}:${n.category}`)).toEqual(["asha:reminder.daily"]);
  });

  it("a full tick at 11:00 sends only the punch-in reminder, never a timesheet one", async () => {
    await inTenant(() => runRemindersNow(IST_11));
    expect(h.sent.map((n) => `${n.userId}:${n.category}`)).toEqual(["asha:reminder.punch_in"]);
  });

  it("a punch-in does not count as a logged timesheet, and a timesheet does not count as a punch", async () => {
    h.punched.set("asha|2026-11-18", "WEB");
    await inTenant(() => runDailyReminders(IST_17));
    expect(h.sent.map((n) => n.category)).toEqual(["reminder.daily"]);
    h.sent.length = 0;
    h.punched.clear();
    h.loggedTimesheet = true;
    await inTenant(() => runPunchInReminders(IST_11));
    expect(punchRecipients()).toEqual(["asha"]);
  });
});

/* ------------------------------------------------------------------ *
 * Who: every role, and a constant number of queries
 * ------------------------------------------------------------------ */

const ROLES = ["EMPLOYEE", "TEAM_LEAD", "MANAGER", "ADMIN", "SUPER_ADMIN"];
const personIn = (id: string, role: string, timezone = "Asia/Kolkata"): Person => ({ id, name: id, email: `${id}@acme.test`, timezone, holidayCalendarId: null, manager: null, role });

describe("the punch-in reminder reaches every role", () => {
  it("each active role gets it — the recipient query does not filter by role", async () => {
    h.extraPeople = ROLES.map((r) => personIn(`p-${r}`, r));
    await inTenant(() => runPunchInReminders(IST_11));
    expect(punchRecipients()).toEqual(["asha", ...ROLES.map((r) => `p-${r}`)]);
    expect(h.userWheres[0]).toMatchObject({ isAgent: false, deletedAt: null, status: "ACTIVE" });
    expect(h.userWheres[0].role).toBeUndefined();
  });

  it("the 17:00 timesheet population is still EMPLOYEE and TEAM_LEAD only", async () => {
    h.extraPeople = ROLES.map((r) => personIn(`p-${r}`, r));
    await inTenant(() => runDailyReminders(new Date("2026-11-18T11:30:00.000Z")));
    expect(h.userWheres[0].role).toEqual({ name: { in: ["EMPLOYEE", "TEAM_LEAD"] } });
    expect(h.sent.map((n) => n.userId)).toEqual(["asha", "p-EMPLOYEE", "p-TEAM_LEAD"]);
  });
});

describe("the punch-in reminder has no N+1", () => {
  it("makes the same number of queries for 3 people as for 60", async () => {
    h.extraPeople = [personIn("x0", "EMPLOYEE")];
    await inTenant(() => runPunchInReminders(IST_11));
    const few = h.queries;
    h.sent.length = 0;
    h.queries = 0;
    h.extraPeople = Array.from({ length: 58 }, (_, i) => personIn(`x${i}`, ROLES[i % ROLES.length], i % 2 ? "Asia/Kolkata" : "Asia/Calcutta"));
    await inTenant(() => runPunchInReminders(IST_11));
    expect(punchRecipients()).toHaveLength(59);
    expect(h.queries).toBe(few);
  });
});
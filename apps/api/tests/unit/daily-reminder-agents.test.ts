/**
 * The daily reminder and next-morning escalation (workers/daily-reminder.worker.ts) are for PEOPLE.
 *
 * An AI teammate is an ACTIVE EMPLOYEE user row (agent-identity.ts), so the worker's population —
 * active employees and team leads — included every agent identity. Each one was "reminded" at 4 PM
 * to log a timesheet it will never log, and the next morning its owner (the agent's `managerId`)
 * was emailed that it had missed one. The workforce card already excludes agents from this exact
 * population (admin-summary.service.ts#WORKFORCE_WHERE); the worker now does too, and an
 * escalation is never addressed to an agent identity as somebody's manager.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Person = {
  id: string;
  name: string;
  email: string;
  status: string;
  deletedAt: Date | null;
  isAgent: boolean;
  role: string;
  timezone: string | null;
  manager: { id: string; name: string; isAgent: boolean } | null;
};

const MEERA = { id: "meera", name: "Meera", isAgent: false };
const MAX = { id: "max", name: "Max (AI)", isAgent: true };

const PEOPLE: Person[] = [
  { id: "asha", name: "Asha", email: "asha@acme.test", status: "ACTIVE", deletedAt: null, isAgent: false, role: "EMPLOYEE", timezone: "Asia/Kolkata", manager: MEERA },
  // An AI teammate owned by Meera: an ACTIVE EMPLOYEE row that will never fill a timesheet.
  { id: "bot", name: "Triage bot", email: "bot@acme.test", status: "ACTIVE", deletedAt: null, isAgent: true, role: "EMPLOYEE", timezone: null, manager: MEERA },
  // A person whose manager field points at an agent identity.
  { id: "riya", name: "Riya", email: "riya@acme.test", status: "ACTIVE", deletedAt: null, isAgent: false, role: "EMPLOYEE", timezone: "Asia/Kolkata", manager: MAX }
];

const sent = vi.hoisted(() => [] as Array<{ userId: string; category: string }>);

function matches(p: Person, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "status") {
      if (p.status !== cond) return false;
    } else if (key === "deletedAt") {
      if (cond === null && p.deletedAt !== null) return false;
    } else if (key === "isAgent") {
      if (p.isAgent !== cond) return false;
    } else if (key === "role") {
      if (!cond.name.in.includes(p.role)) return false;
    } else {
      throw new Error(`the fake directory does not understand \`${key}\``);
    }
  }
  return true;
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async (args: any) => PEOPLE.filter((p) => matches(p, args.where))) },
    // Nobody has logged anything, and nobody has been told yet today.
    timesheet: { count: vi.fn(async () => 0) },
    notification: { count: vi.fn(async () => 0) }
  }
}));
vi.mock("../../src/services/notify.service.js", () => ({
  getGlobalNotificationSettings: vi.fn(async () => ({ dailyReminderHour: 16, escalationReminderHour: 9, remindOnWeekdaysOnly: false })),
  dispatchNotification: vi.fn(async (n: { userId: string; category: string }) => {
    sent.push({ userId: n.userId, category: n.category });
  })
}));

const { runDailyReminders, runEscalationReminders } = await import("../../src/workers/daily-reminder.worker.js");

beforeEach(() => {
  sent.length = 0;
});

describe("the daily reminder", () => {
  it("reminds people, never an AI agent identity", async () => {
    // Thursday 1 October 2026, 16:00 IST.
    await runDailyReminders(new Date("2026-10-01T10:30:00.000Z"));
    expect(sent.map((s) => s.userId).sort()).toEqual(["asha", "riya"]);
  });
});

describe("the next-morning escalation", () => {
  it("escalates people only, and never to an agent identity as their manager", async () => {
    // Friday 2 October 2026, 09:00 IST.
    const result = await runEscalationReminders(new Date("2026-10-02T03:30:00.000Z"));
    const recipients = sent.map((s) => s.userId);
    // Asha and Riya are told; Meera hears about Asha — not about her agent, which never logs time.
    expect(recipients.filter((id) => id !== "meera").sort()).toEqual(["asha", "riya"]);
    expect(recipients.filter((id) => id === "meera")).toHaveLength(1);
    expect(recipients).not.toContain("bot");
    expect(recipients).not.toContain("max");
    expect(result).toEqual({ employees: 2, managers: 1 });
  });
});

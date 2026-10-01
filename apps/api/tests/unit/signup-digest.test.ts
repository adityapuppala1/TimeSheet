/**
 * The operators' view of self-serve signup (signup Phase 1, decision 1: a daily summary).
 *
 * Pinned, because each is either noise people learn to filter or silence when something is broken:
 *  - the summary goes out only in DAILY mode, and only on a day with news — refusals alone are not;
 *  - it is sent ONCE per day however many replicas run the cron (the PlatformJobClaim row);
 *  - a dry run neither claims the day nor sends;
 *  - provisioning failing is NOT news for tomorrow: the second failure inside an hour mails the alert
 *    recipients at once, once per hour, in every mode except OFF.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Attempt = { stage: string; domain: string | null; organizationId: string | null; detail: string | null; createdAt: Date };
type Org = { id: string; name: string; slug: string; ownerEmail: string | null; createdVia: string; createdAt: Date; trialEndsAt: Date | null };

let notifyMode = "DAILY";
let attempts: Attempt[] = [];
let orgs: Org[] = [];
const claims = new Set<string>();

const inWindow = (at: Date, range?: { gte?: Date; lt?: Date }) => (!range?.gte || at >= range.gte) && (!range?.lt || at < range.lt);
const control = {
  organization: {
    findMany: vi.fn(async ({ where }: { where: { createdVia?: string; createdAt?: { gte: Date; lt: Date }; id?: { in: string[] } } }) =>
      orgs.filter(
        (o) => (!where.createdVia || o.createdVia === where.createdVia) && (!where.createdAt || inWindow(o.createdAt, where.createdAt)) && (!where.id || where.id.in.includes(o.id))
      )
    )
  },
  signupAttempt: {
    findMany: vi.fn(async ({ where }: { where: { stage?: { in: string[] } | string; createdAt?: { gte: Date; lt?: Date } } }) =>
      attempts.filter((a) => {
        const stageOk = !where.stage || (typeof where.stage === "string" ? a.stage === where.stage : where.stage.in.includes(a.stage));
        return stageOk && inWindow(a.createdAt, where.createdAt);
      })
    )
  },
  platformJobClaim: {
    create: vi.fn(async ({ data }: { data: { job: string; periodKey: string } }) => {
      // A real unique key: a microtask yield first, so two concurrent callers interleave the way two
      // replicas do, then exactly one insert wins.
      await Promise.resolve();
      const key = `${data.job}|${data.periodKey}`;
      if (claims.has(key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      claims.add(key);
      return data;
    })
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));
vi.mock("../../src/services/platform-signup.service.js", () => ({ getSignupSettings: vi.fn(async () => ({ notifyMode })) }));
const resolveAlertRecipients = vi.fn(async (): Promise<string[]> => ["ops@timesphere.test", "owner@timesphere.test"]);
vi.mock("../../src/services/platform-alerts.service.js", () => ({
  getAlertSettings: vi.fn(async () => ({})),
  resolveAlertRecipients
}));
const sendPlatformTemplate = vi.fn(async () => ({ ok: true, status: "SENT", subject: "s" }));
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformTemplate }));
const platformAudit = vi.fn(async () => undefined);
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit }));
// The platform's zone, as config/env.ts defaults it — the days and hours below are India's.
vi.mock("../../src/config/env.js", () => ({ env: { APP_BASE_URL: "https://timesphere.test", TZ: "Asia/Kolkata" } }));

const { alertIfProvisioningFailing, claimJobPeriod, runSignupDigest } = await import("../../src/services/signup-digest.service.js");

const now = new Date("2026-10-02T08:15:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const attempt = (stage: string, minutesAgo: number, extra: Partial<Attempt> = {}): Attempt => ({
  stage,
  domain: "northwind.co.uk",
  organizationId: null,
  detail: null,
  createdAt: ago(minutesAgo),
  ...extra
});
const sentKeys = () => sendPlatformTemplate.mock.calls.map(([key]) => key);
const varsOf = (call = 0) => (sendPlatformTemplate.mock.calls[call][1] as { vars: Record<string, string> }).vars;

beforeEach(() => {
  vi.clearAllMocks();
  notifyMode = "DAILY";
  attempts = [];
  orgs = [];
  claims.clear();
});

describe("claimJobPeriod", () => {
  it("is true once and false after, for the same job and period", async () => {
    expect(await claimJobPeriod("signup-digest", "2026-10-02")).toBe(true);
    expect(await claimJobPeriod("signup-digest", "2026-10-02")).toBe(false);
    expect(await claimJobPeriod("signup-digest", "2026-10-03")).toBe(true);
  });
});

describe("the daily summary", () => {
  const busyDay = () => {
    orgs = [
      { id: "o1", name: "Northwind Logistics", slug: "northwind", ownerEmail: "priya@northwind.co.uk", createdVia: "SELF_SERVE", createdAt: ago(120), trialEndsAt: new Date("2026-10-17T00:00:00Z") },
      { id: "o0", name: "Old Co", slug: "old", ownerEmail: "a@old.example", createdVia: "SELF_SERVE", createdAt: ago(60 * 30), trialEndsAt: null },
      { id: "oc", name: "Console Co", slug: "console", ownerEmail: "a@console.example", createdVia: "CONSOLE", createdAt: ago(30), trialEndsAt: null }
    ];
    attempts = [
      attempt("FAILED", 300, { domain: "globex.com", detail: "Access denied for user 'provisioner'" }),
      attempt("JOIN_REQUESTED", 200, { organizationId: "o1" }),
      attempt("JOIN_REQUESTED", 100, { organizationId: "o1" }),
      attempt("REFUSED", 50, { domain: "gmail.com" }),
      attempt("FAILED", 60 * 30, { domain: "yesterday.com", detail: "old" })
    ];
  };

  it("sends nothing unless the mode is DAILY", async () => {
    busyDay();
    for (const mode of ["EACH", "OFF"]) {
      notifyMode = mode;
      const result = await runSignupDigest(now);
      expect(result.sent).toBe(false);
      expect(result.reason).toMatch(mode);
    }
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
    expect(claims.size).toBe(0);
  });

  it("sends nothing on a day with nothing created, failed or requested — refusals alone are not news", async () => {
    attempts = [attempt("REFUSED", 10), attempt("REFUSED", 20)];
    const result = await runSignupDigest(now);
    expect(result).toMatchObject({ sent: false, counts: { created: 0, failed: 0, joinRequested: 0, refused: 2 } });
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
    expect(claims.size).toBe(0);
  });

  it("lists each created workspace with its domain and trial end, and each failure with its error — the last 24 hours only", async () => {
    busyDay();
    const result = await runSignupDigest(now);
    expect(result).toMatchObject({ sent: true, recipients: 2, counts: { created: 1, failed: 1, joinRequested: 2, refused: 1 } });
    expect(sentKeys()).toEqual(["platform.signup_digest", "platform.signup_digest"]);
    const vars = varsOf();
    expect(vars.createdList).toContain("Northwind Logistics (northwind) — northwind.co.uk — trial ends 2026-10-17");
    expect(vars.createdList).not.toContain("Old Co");
    expect(vars.createdList).not.toContain("Console Co");
    expect(vars.failedList).toContain("globex.com — Access denied for user 'provisioner'");
    expect(vars.failedList).not.toContain("yesterday.com");
    expect(vars.joinList).toContain("Northwind Logistics: 2");
    expect(platformAudit).toHaveBeenCalledWith("SYSTEM", "scheduler", "signup.digest_sent", "PlatformSignupSettings", "global", expect.objectContaining({ created: 1 }));
  });

  it("says None. for an empty section rather than leaving a blank box", async () => {
    attempts = [attempt("JOIN_REQUESTED", 10, { organizationId: "o1" })];
    orgs = [{ id: "o1", name: "Northwind", slug: "nw", ownerEmail: null, createdVia: "SELF_SERVE", createdAt: ago(60 * 40), trialEndsAt: null }];
    await runSignupDigest(now);
    expect(varsOf().createdList).toBe("None.");
    expect(varsOf().failedList).toBe("None.");
  });

  it("is sent ONCE per day even when two replicas run the cron at the same minute", async () => {
    busyDay();
    const [a, b] = await Promise.all([runSignupDigest(now), runSignupDigest(now)]);
    expect([a.sent, b.sent].sort()).toEqual([false, true]);
    expect(sendPlatformTemplate).toHaveBeenCalledTimes(2); // two recipients, once — not four
  });

  it("names the day as India sees it, not UTC — 19:00 UTC on the 1st is the summary for the 2nd", async () => {
    const lateEvening = new Date("2026-10-01T19:00:00Z");
    orgs = [
      {
        id: "o1",
        name: "Northwind Logistics",
        slug: "northwind",
        ownerEmail: "priya@northwind.co.uk",
        createdVia: "SELF_SERVE",
        createdAt: new Date("2026-10-01T18:00:00Z"),
        // 01:00 IST on the 17th — still the 16th in UTC.
        trialEndsAt: new Date("2026-10-16T19:30:00Z")
      }
    ];
    await runSignupDigest(lateEvening);
    expect(claims.has("signup-digest|2026-10-02")).toBe(true);
    expect(varsOf().day).toBe("2026-10-02");
    expect(varsOf().createdList).toContain("trial ends 2026-10-17");
  });

  it("a dry run claims nothing and sends nothing, but says what it would do", async () => {
    busyDay();
    const result = await runSignupDigest(now, { dryRun: true });
    expect(result).toMatchObject({ sent: false, recipients: 2, counts: { created: 1 } });
    expect(result.reason).toMatch(/dry run/i);
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
    expect(claims.size).toBe(0);
    // …and the real run afterwards is not blocked by it.
    expect((await runSignupDigest(now)).sent).toBe(true);
  });
});

describe("provisioning is failing", () => {
  it("one failure in the hour is not an outage — nothing is sent", async () => {
    attempts = [attempt("FAILED", 5)];
    expect(await alertIfProvisioningFailing(now)).toBe(false);
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
  });

  it("the SECOND failure within an hour sends one 'provisioning is failing' email, even in DAILY mode", async () => {
    attempts = [attempt("FAILED", 50, { domain: "a.com", detail: "ECONNREFUSED db-2:3306" }), attempt("FAILED", 1, { domain: "b.com", detail: "ECONNREFUSED db-2:3306" })];
    expect(await alertIfProvisioningFailing(now)).toBe(true);
    expect(sentKeys()).toEqual(["platform.signup_failing", "platform.signup_failing"]);
    expect(varsOf().failedCount).toBe("2");
    expect(varsOf().recentFailures).toContain("b.com — ECONNREFUSED db-2:3306");
  });

  it("claims India's clock hour, not UTC's", async () => {
    attempts = [attempt("FAILED", 20), attempt("FAILED", 10)];
    await alertIfProvisioningFailing(now); // 08:15 UTC = 13:45 IST
    expect(claims.has("signup-failing|2026-10-02T13")).toBe(true);
  });

  it("with nobody to tell, claims nothing — the hour stays free for when recipients are configured", async () => {
    attempts = [attempt("FAILED", 20), attempt("FAILED", 10)];
    resolveAlertRecipients.mockResolvedValueOnce([]);
    expect(await alertIfProvisioningFailing(now)).toBe(false);
    expect(claims.size).toBe(0);
    expect(await alertIfProvisioningFailing(now)).toBe(true);
  });

  it("a failure more than an hour ago does not count towards it", async () => {
    attempts = [attempt("FAILED", 61), attempt("FAILED", 1)];
    expect(await alertIfProvisioningFailing(now)).toBe(false);
  });

  it("a third failure in the same hour sends nothing more — one email per hour", async () => {
    attempts = [attempt("FAILED", 20), attempt("FAILED", 10)];
    expect(await alertIfProvisioningFailing(now)).toBe(true);
    attempts.push(attempt("FAILED", 0));
    expect(await alertIfProvisioningFailing(now)).toBe(false);
    expect(sendPlatformTemplate).toHaveBeenCalledTimes(2);
  });

  it("OFF silences the failing alert too", async () => {
    notifyMode = "OFF";
    attempts = [attempt("FAILED", 20), attempt("FAILED", 10)];
    expect(await alertIfProvisioningFailing(now)).toBe(false);
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
  });

  it("never throws — it runs inside a failure path that is already answering a person", async () => {
    attempts = [attempt("FAILED", 20), attempt("FAILED", 10)];
    control.platformJobClaim.create.mockRejectedValueOnce(new Error("control plane down"));
    await expect(alertIfProvisioningFailing(now)).resolves.toBe(false);
  });
});

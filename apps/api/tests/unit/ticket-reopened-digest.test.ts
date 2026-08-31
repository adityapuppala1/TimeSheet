/**
 * Who hears that a fix did not hold.
 *
 * The gap this exists to close: an auto-reopen used to send one line to the CURRENT ASSIGNEE and
 * nobody else. So the person who closed the ticket — the one who made the call that turned out to
 * be wrong — was never told, their manager was never told, and the three people who actually did
 * the work and logged time against it were never told. If the ticket had since been reassigned, the
 * only person notified was somebody with no memory of the fix at all.
 *
 * Every assertion below is about the recipient set, because that is the whole content of the fix.
 * The audience is assembled from three places that have nothing to do with each other — the audit
 * trail (who closed it), the ticket (who owns it now) and the timesheets (who worked on it) — and
 * dropping any one of them leaves a plausible-looking email that reaches the wrong people.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  [key: string]: unknown;
}

const users: Row[] = [];
const auditRows: Row[] = [];
const timesheets: Row[] = [];
const moduleRules: Row[] = [];

function matchWhere(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key] ?? null;
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("not" in c) return value !== (c.not ?? null);
      return false;
    }
    return value === (condition ?? null);
  });
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ingestionSettings: { findUnique: vi.fn(async () => ({ id: "global", verifyResolutionEnabled: true, autoReopenEnabled: true })) },
    // `buildTicketSecurityReport` runs for real so the digest's `riskVerdict` is the same string the
    // PDF and the ticket panel would show — the point of that shared builder.
    ticket: { findFirstOrThrow: vi.fn(async () => ({ id: "ticket-1", key: "HICS-OPS-1", title: "SQL injection in the login handler" })) },
    securityFinding: { findMany: vi.fn(async () => []) },
    testRun: { findFirst: vi.fn(async () => null) },
    auditLog: { findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => auditRows.filter((r) => matchWhere(r, where))) },
    timesheet: {
      findMany: vi.fn(async ({ where = {}, distinct }: { where?: Record<string, unknown>; distinct?: string[] } = {}) => {
        const hits = timesheets.filter((r) => matchWhere(r, where));
        if (!distinct) return hits;
        const seen = new Set<unknown>();
        return hits.filter((row) => {
          const key = distinct.map((field) => row[field]).join("|");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      })
    },
    moduleAssigneeRule: {
      findUnique: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => moduleRules.find((r) => matchWhere(r, where)) ?? null)
    },
    user: {
      findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => users.filter((r) => matchWhere(r, where))),
      findUnique: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => users.find((r) => matchWhere(r, where)) ?? null)
    },
    ticketComment: { create: vi.fn(async () => ({})) }
  }
}));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const dispatchNotification = vi.fn().mockResolvedValue(undefined);
const dispatchTransactional = vi.fn().mockResolvedValue({ ok: true });
let notificationSettings: Row = { emailTicketReopenedDigest: true, emailTicketClosedDigest: true };
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: (...a: unknown[]) => dispatchNotification(...a),
  dispatchTransactional: (...a: unknown[]) => dispatchTransactional(...a),
  getGlobalNotificationSettings: vi.fn(async () => notificationSettings),
  templates: new Proxy({}, { get: () => () => "<html>body</html>" })
}));
vi.mock("../../src/services/ai.service.js", () => ({ classifyCiFailure: vi.fn(), classifySecurityFinding: vi.fn() }));
vi.mock("../../src/services/git-provider.service.js", () => ({
  fetchGitHubCodeowners: vi.fn(),
  fetchGitHubLastCommitAuthor: vi.fn(),
  parseCodeownersOwners: vi.fn()
}));
vi.mock("../../src/services/ticket.service.js", () => ({
  computeTicketDueDate: vi.fn(() => new Date()),
  getGlobalTicketSettings: vi.fn().mockResolvedValue({}),
  issueTicketKey: vi.fn()
}));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (v: string) => v }));

const { sendTicketReopenedDigest } = await import("../../src/services/security-report.service.js");
const { TEMPLATE_VARIABLES, TEMPLATE_DESCRIPTIONS, TEMPLATE_DEFAULTS, sampleVariables } = await import(
  "../../src/services/template-store.service.js"
);
const { notificationPreferenceKeys } = await import("@timesheet/shared");

const TICKET = { id: "ticket-1", key: "HICS-OPS-1", title: "SQL injection in the login handler", assigneeId: "u-assignee", moduleId: "module-1" };
const RUN = { id: "run-1", tool: "semgrep", repository: "acme/api", branch: "main", commitSha: "4f2a91c0be31aa" };
const SURVIVOR = {
  severity: "CRITICAL",
  title: "SQL injection",
  tool: "semgrep",
  firstSeenAt: new Date(Date.now() - 23 * 24 * 60 * 60 * 1000),
  occurrences: 14
};

function send(overrides: Partial<Parameters<typeof sendTicketReopenedDigest>[0]> = {}) {
  return sendTicketReopenedDigest({
    ticket: TICKET,
    scanRun: RUN,
    survived: [SURVIVOR],
    verifiedFixed: [],
    didReopen: true,
    slaDueAt: new Date("2026-09-15T12:00:00Z"),
    ...overrides
  });
}

/** The addresses that actually went in the `to` header, which is a comma-joined string. */
function toAddresses(): string[] {
  return String(dispatchTransactional.mock.calls[0][0].to)
    .split(",")
    .map((address) => address.trim());
}

beforeEach(() => {
  users.length = 0;
  auditRows.length = 0;
  timesheets.length = 0;
  moduleRules.length = 0;
  notificationSettings = { emailTicketReopenedDigest: true, emailTicketClosedDigest: true };
  dispatchNotification.mockClear();
  dispatchTransactional.mockClear();

  users.push(
    { id: "u-closer", name: "Avery Stone", email: "avery@example.com", status: "ACTIVE", deletedAt: null },
    { id: "u-assignee", name: "Dev Patel", email: "dev@example.com", status: "ACTIVE", deletedAt: null },
    { id: "u-logger-a", name: "Priya Raman", email: "priya@example.com", status: "ACTIVE", deletedAt: null },
    { id: "u-logger-b", name: "Sam Ortiz", email: "sam@example.com", status: "ACTIVE", deletedAt: null },
    { id: "u-manager", name: "Jo Blake", email: "jo@example.com", status: "ACTIVE", deletedAt: null },
    { id: "u-module-owner", name: "Kim Lee", email: "kim@example.com", status: "ACTIVE", deletedAt: null }
  );
  // The closer is recovered from the audit trail — the ticket itself does not remember who closed it.
  // Newest first, and only a row whose `metadata.to` was RESOLVED/CLOSED counts.
  auditRows.push(
    { actorId: "u-someone-else", metadata: { from: "OPEN", to: "IN_PROGRESS" }, entity: "Ticket", entityId: "ticket-1", action: "ticket.status_changed" },
    { actorId: "u-closer", metadata: { from: "IN_PROGRESS", to: "RESOLVED" }, entity: "Ticket", entityId: "ticket-1", action: "ticket.status_changed" }
  );
  timesheets.push(
    { ticketId: "ticket-1", userId: "u-logger-a" },
    { ticketId: "ticket-1", userId: "u-logger-a" },
    { ticketId: "ticket-1", userId: "u-logger-b" }
  );
  moduleRules.push({ moduleId: "module-1", defaultAssigneeId: "u-module-owner" });
});

describe("the recipient set", () => {
  it("reaches the closer, the current assignee and everyone who logged time", async () => {
    await send();

    const to = toAddresses();
    // The person whose call turned out to be wrong. Recovered from the audit trail, because nothing
    // on the ticket records it.
    expect(to).toContain("avery@example.com");
    // Who owns it now — not necessarily the same person.
    expect(to).toContain("dev@example.com");
    // The people who actually did the work. Invisible to every other recipient query in this file,
    // and the ones most likely to know why the fix did not take.
    expect(to).toContain("priya@example.com");
    expect(to).toContain("sam@example.com");
  });

  it("counts somebody who logged forty entries once", async () => {
    await send();
    const to = toAddresses();
    expect(to.filter((address) => address === "priya@example.com")).toHaveLength(1);
  });

  it("cc's the closer's manager and the module owner", async () => {
    // `activeManagerOf` reads the closer's own row, so the manager hangs off it.
    users.find((u) => u.id === "u-closer")!.manager = { id: "u-manager", name: "Jo Blake", email: "jo@example.com", status: "ACTIVE", deletedAt: null };

    await send();

    const cc = dispatchTransactional.mock.calls[0][0].cc as string[];
    expect(cc).toContain("jo@example.com");
    // This schema has no `Module.ownerId`; the module's ModuleAssigneeRule default assignee IS the
    // module owner, and it is the same relation intake routing already treats as one.
    expect(cc).toContain("kim@example.com");
  });

  it("never puts a Cc address in the To header as well", async () => {
    moduleRules[0].defaultAssigneeId = "u-assignee";
    await send();
    const cc = dispatchTransactional.mock.calls[0][0].cc as string[];
    expect(cc).not.toContain("dev@example.com");
  });

  it("drops people who have left", async () => {
    users.find((u) => u.id === "u-logger-b")!.status = "INACTIVE";
    await send();
    // `dispatchTransactional` has no user row to check, unlike `dispatchNotification` — so the
    // filtering has to happen while the audience is assembled or it does not happen at all.
    expect(toAddresses()).not.toContain("sam@example.com");
  });

  it("still raises the in-app bell for every primary recipient", async () => {
    await send();
    const notified = dispatchNotification.mock.calls.map((call) => call[0].userId);
    expect(new Set(notified)).toEqual(new Set(["u-closer", "u-assignee", "u-logger-a", "u-logger-b"]));
    expect(dispatchNotification.mock.calls[0][0].category).toBe("ticket.reopened_digest");
  });

  it("sends nothing when the category is muted for this workspace", async () => {
    notificationSettings = { emailTicketReopenedDigest: false, emailTicketClosedDigest: true };
    await send();
    expect(dispatchTransactional).not.toHaveBeenCalled();
  });
});

describe("what the email says", () => {
  it("names the scan, the tool and the commit that triggered it", async () => {
    await send();
    const vars = dispatchTransactional.mock.calls[0][0].vars;
    expect(vars.scanSummary).toContain("semgrep");
    expect(vars.scanSummary).toContain("acme/api (main)");
    expect(vars.scanSummary).toContain("4f2a91c0be31");
  });

  it("carries how long each survivor has been open and how many scans reported it", async () => {
    await send();
    const survived = String(dispatchTransactional.mock.calls[0][0].vars.survivedText);
    expect(survived).toContain("23 days");
    expect(survived).toContain("14 scans");
  });

  it("lists what the same scan DID prove fixed, so the report is not just a complaint", async () => {
    await send({
      verifiedFixed: [{ severity: "HIGH", title: "Hardcoded AWS key", tool: "semgrep", firstSeenAt: new Date(), occurrences: 3 }]
    });
    expect(String(dispatchTransactional.mock.calls[0][0].vars.fixedText)).toContain("Hardcoded AWS key");
  });

  it("says the SLA clock restarted only when the ticket actually moved", async () => {
    await send({ didReopen: true });
    expect(String(dispatchTransactional.mock.calls[0][0].vars.slaText)).toMatch(/SLA clock has been restarted/);

    dispatchTransactional.mockClear();
    await send({ didReopen: false });
    // Telling a manager a clock restarted when it did not is the fastest way to make them stop
    // reading these.
    expect(String(dispatchTransactional.mock.calls[0][0].vars.slaText)).toMatch(/NOT reopened/);
  });

  it("is a template an administrator can find, read and edit", () => {
    // email-template-registry.test.ts already enforces this for every key it finds in src, which is
    // the general guard. This is the specific one: a new template that is dispatched but missing
    // from any of these four maps is an email nobody can change a word of, and the failure is
    // invisible from any single file.
    const key = "ticket.reopened_digest";
    expect(TEMPLATE_VARIABLES[key]).toContain("survivedText");
    expect(TEMPLATE_DESCRIPTIONS[key]).toBeTruthy();
    expect(TEMPLATE_DEFAULTS[key].html).toContain("<table");
    expect(sampleVariables(key).scanSummary).toBeTruthy();
    // And a toggle on the Workspace Settings notification screen, which renders from this list.
    expect(notificationPreferenceKeys).toContain("emailTicketReopenedDigest");
  });

  it("escapes scanner-supplied text before it reaches the DB-override template path", async () => {
    await send({
      survived: [{ ...SURVIVOR, title: '<img src=x onerror="alert(1)">' }]
    });
    const survived = String(dispatchTransactional.mock.calls[0][0].vars.survivedText);
    // `applyVars` substitutes into an administrator-edited template with no escaping of its own, and
    // a finding title arrives from an ingest webhook. Same split `renderFindingsHtml` documents.
    expect(survived).not.toContain("<img");
    expect(survived).toContain("&lt;img");
  });
});

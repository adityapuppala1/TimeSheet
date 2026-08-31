/**
 * Verified remediation, driven against an in-memory stand-in for the tables it writes.
 *
 * WHY THIS FILE IS NOT A SET OF MOCK-CALL ASSERTIONS. Every claim this feature makes is a claim
 * about what ends up in a row: is the finding FIXED, does it carry a `verifiedFixedAt`, did the
 * ticket move. A test that only checked which prisma methods were called could not tell a correct
 * verdict from an incorrect one that happened to call `updateMany`.
 *
 * The case that matters most is `a scan by a different tool`. Getting it wrong does not throw, does
 * not fail anything visibly, and quietly marks a workspace's whole backlog "verified fixed" the
 * first night somebody adds a second scanner to CI. It is the one control here whose absence is
 * invisible from the outside, so it gets its own describe block.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  [key: string]: unknown;
}

const findings: Row[] = [];
const scanRuns: Row[] = [];
const tickets: Row[] = [];
const comments: Row[] = [];
/** The security-ingestion system account that authors ticket comments, plus the one assignee these
 *  tests notify. `sendTicketReopenedDigest` filters its recipients through this table, so a person
 *  who is not here is a person the digest correctly refuses to email. */
const users: Row[] = [];
let ingestionSettings: Row | null = null;
let seq = 0;

/**
 * The slice of Prisma's `where` semantics this service actually uses. `null` means IS NULL rather
 * than "any value" — a stand-in that treated a null repository as a wildcard would let every test
 * here pass while the real query matched nothing.
 */
function matchWhere(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key] ?? null;
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("not" in c) return value !== (c.not ?? null);
      if ("lt" in c) return value instanceof Date && value.getTime() < (c.lt as Date).getTime();
      return false;
    }
    return value === (condition ?? null);
  });
}

function table(rows: Row[]) {
  return {
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => rows.filter((r) => matchWhere(r, where))),
    findFirst: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => rows.find((r) => matchWhere(r, where)) ?? null),
    findFirstOrThrow: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      const found = rows.find((r) => matchWhere(r, where));
      if (!found) throw new Error("not found");
      return found;
    }),
    findUnique: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => rows.find((r) => matchWhere(r, where)) ?? null),
    create: vi.fn(async ({ data }: { data: Row }) => {
      seq += 1;
      const row = { id: `row-${seq}`, ...data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const row = rows.find((r) => matchWhere(r, where))!;
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const hits = rows.filter((r) => matchWhere(r, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    }),
    count: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => rows.filter((r) => matchWhere(r, where)).length)
  };
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    get ingestionSettings() {
      return { findUnique: vi.fn(async () => ingestionSettings) };
    },
    securityFinding: table(findings),
    scanRun: table(scanRuns),
    ticket: table(tickets),
    ticketComment: table(comments),
    testRun: { findFirst: vi.fn(async () => null) },
    timesheet: { findMany: vi.fn(async () => []) },
    auditLog: { findMany: vi.fn(async () => []) },
    moduleAssigneeRule: { findUnique: vi.fn(async () => null) },
    user: table(users)
  }
}));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));

const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...args: unknown[]) => auditSpy(...args) }));

const dispatchNotification = vi.fn().mockResolvedValue(undefined);
const dispatchTransactional = vi.fn().mockResolvedValue({ ok: true });
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: (...a: unknown[]) => dispatchNotification(...a),
  dispatchTransactional: (...a: unknown[]) => dispatchTransactional(...a),
  getGlobalNotificationSettings: vi.fn().mockResolvedValue({ emailTicketClosedDigest: true, emailTicketReopenedDigest: true }),
  templates: new Proxy({}, { get: () => () => "<html>body</html>" })
}));
vi.mock("../../src/services/ai.service.js", () => ({
  classifyCiFailure: vi.fn(),
  classifySecurityFinding: vi.fn()
}));
vi.mock("../../src/services/git-provider.service.js", () => ({
  fetchGitHubCodeowners: vi.fn(),
  fetchGitHubLastCommitAuthor: vi.fn(),
  parseCodeownersOwners: vi.fn()
}));
vi.mock("../../src/services/ticket.service.js", () => ({
  computeTicketDueDate: vi.fn(() => new Date("2026-09-15T12:00:00Z")),
  getGlobalTicketSettings: vi.fn().mockResolvedValue({}),
  issueTicketKey: vi.fn()
}));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (v: string) => v }));

const { markFindingsAwaitingVerification, verifyFindingsAgainstScanRun, sweepUnverifiedFindings } = await import(
  "../../src/services/security-report.service.js"
);

/** Lets the detached digest send settle, so an assertion about it is not a race. */
const flushDetached = () => new Promise((resolve) => setTimeout(resolve, 0));

function addTicket(overrides: Row = {}): Row {
  const ticket = {
    id: "ticket-1",
    key: "HICS-OPS-1",
    title: "SQL injection in the login handler",
    status: "RESOLVED",
    priority: "HIGH",
    assigneeId: "user-assignee",
    moduleId: null,
    dueAt: new Date("2026-08-01T12:00:00Z"),
    deletedAt: null,
    ...overrides
  };
  tickets.push(ticket);
  return ticket;
}

function addFinding(overrides: Row = {}): Row {
  seq += 1;
  const finding = {
    id: `finding-${seq}`,
    ticketId: "ticket-1",
    tool: "semgrep",
    type: "SAST",
    severity: "CRITICAL",
    title: "SQL injection",
    status: "OPEN",
    fingerprint: "v1:aaa",
    repository: "acme/api",
    branch: "main",
    firstSeenAt: new Date("2026-08-01T00:00:00Z"),
    lastSeenAt: new Date("2026-08-20T00:00:00Z"),
    occurrences: 12,
    verificationState: null,
    awaitingVerificationSince: null,
    verifiedFixedAt: null,
    verifiedByScanRunId: null,
    verifiedByCommitSha: null,
    ...overrides
  };
  findings.push(finding);
  return finding;
}

function addScanRun(overrides: Row = {}): Row {
  seq += 1;
  const run = {
    id: `run-${seq}`,
    tool: "semgrep",
    type: "SAST",
    repository: "acme/api",
    branch: "main",
    commitSha: "4f2a91c0be31aa",
    ...overrides
  };
  scanRuns.push(run);
  return run;
}

beforeEach(() => {
  findings.length = 0;
  scanRuns.length = 0;
  tickets.length = 0;
  comments.length = 0;
  users.length = 0;
  users.push(
    { id: "system-user", name: "Security Ingestion", email: "security-ingestion@system.local", status: "ACTIVE", deletedAt: null },
    { id: "user-assignee", name: "Dev Patel", email: "dev@example.com", status: "ACTIVE", deletedAt: null }
  );
  seq = 0;
  ingestionSettings = { id: "global", verifyResolutionEnabled: true, verificationWindowDays: 14, autoReopenEnabled: true };
  auditSpy.mockClear();
  dispatchNotification.mockClear();
  dispatchTransactional.mockClear();
});

describe("the gate: resolving a ticket makes its findings a claim, not a conclusion", () => {
  it("marks every still-open finding as awaiting proof", async () => {
    addTicket();
    const finding = addFinding();

    const marked = await markFindingsAwaitingVerification({ id: "ticket-1", key: "HICS-OPS-1" }, "user-closer");

    expect(marked).toBe(1);
    // PENDING_VERIFICATION buckets as `pending`, which every report counts as UNRESOLVED. A claimed
    // fix must keep counting against the workspace until something confirms it.
    expect(finding.status).toBe("PENDING_VERIFICATION");
    expect(finding.verificationState).toBe("AWAITING_PROOF");
    expect(finding.awaitingVerificationSince).toBeInstanceOf(Date);
  });

  it("says on the ticket what proof it is waiting for, and which tool has to produce it", async () => {
    addTicket();
    addFinding();
    await markFindingsAwaitingVerification({ id: "ticket-1", key: "HICS-OPS-1" }, "user-closer");

    const body = String((comments[0] as { body: string }).body);
    expect(body).toContain("semgrep");
    expect(body).toContain("acme/api");
    // The claim a reader most needs to be able to check.
    expect(body).toMatch(/different scanner not reporting this finding proves nothing/i);
  });

  it("leaves findings that were already resolved alone", async () => {
    addTicket();
    const accepted = addFinding({ id: "finding-accepted", status: "ACCEPTED_RISK" });
    const marked = await markFindingsAwaitingVerification({ id: "ticket-1", key: "HICS-OPS-1" }, "user-closer");
    expect(marked).toBe(0);
    expect(accepted.status).toBe("ACCEPTED_RISK");
  });

  it("does not restart the clock when a resolved ticket is then closed", async () => {
    addTicket();
    const finding = addFinding();
    await markFindingsAwaitingVerification({ id: "ticket-1", key: "HICS-OPS-1" }, "user-closer");
    const firstStamp = finding.awaitingVerificationSince;

    const second = await markFindingsAwaitingVerification({ id: "ticket-1", key: "HICS-OPS-1" }, "user-closer");

    // The second transition finds nothing left in the open bucket. Without that, closing something
    // already resolved would quietly hand it another fortnight of grace.
    expect(second).toBe(0);
    expect(finding.awaitingVerificationSince).toBe(firstStamp);
  });

  it("does nothing at all when verified remediation is switched off", async () => {
    ingestionSettings = { id: "global", verifyResolutionEnabled: false, verificationWindowDays: 14, autoReopenEnabled: true };
    addTicket();
    const finding = addFinding();

    expect(await markFindingsAwaitingVerification({ id: "ticket-1", key: "HICS-OPS-1" }, "user-closer")).toBe(0);
    expect(finding.status).toBe("OPEN");
    expect(finding.verificationState).toBeNull();
  });
});

describe("the verdict: the next scan settles it", () => {
  it("marks the finding fixed and stamps the evidence when the scan no longer reports it", async () => {
    addTicket();
    const finding = addFinding({ status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF", awaitingVerificationSince: new Date() });
    const run = addScanRun();

    await verifyFindingsAgainstScanRun(String(run.id), []);

    expect(finding.status).toBe("FIXED");
    expect(finding.verificationState).toBe("VERIFIED_FIXED");
    expect(finding.verifiedFixedAt).toBeInstanceOf(Date);
    // Which run and which commit proved it — the evidence a security engineer will ask for.
    expect(finding.verifiedByScanRunId).toBe(run.id);
    expect(finding.verifiedByCommitSha).toBe("4f2a91c0be31aa");
    expect(finding.awaitingVerificationSince).toBeNull();
  });

  it("reopens the ticket when the same scan still reports the finding", async () => {
    const ticket = addTicket({ status: "RESOLVED" });
    const finding = addFinding({ status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF", awaitingVerificationSince: new Date() });
    const run = addScanRun();

    await verifyFindingsAgainstScanRun(String(run.id), ["v1:aaa"]);

    expect(finding.verificationState).toBe("REFUTED_BY_SCAN");
    // Back to OPEN, not left pending: a scanner reporting it again is a settled claim, not an
    // unsettled one.
    expect(finding.status).toBe("OPEN");
    expect(finding.verifiedFixedAt).toBeNull();
    expect(ticket.status).toBe("REOPENED");
    // And the SLA clock restarted, so the escalation sweep does not treat a just-reopened ticket as
    // permanently breached from its first minute.
    expect(ticket.dueAt).toEqual(new Date("2026-09-15T12:00:00Z"));
  });

  it("reports both halves when one scan proves one finding gone and another still there", async () => {
    addTicket();
    const survivor = addFinding({ fingerprint: "v1:aaa", status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const fixed = addFinding({ fingerprint: "v1:bbb", status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun();

    await verifyFindingsAgainstScanRun(String(run.id), ["v1:aaa"]);

    expect(survivor.verificationState).toBe("REFUTED_BY_SCAN");
    expect(fixed.verificationState).toBe("VERIFIED_FIXED");
    // One message carrying both lists — "two of the four you fixed came back" is the sentence that
    // makes the situation legible, and two emails saying half of it each do not.
    const body = String((comments.at(-1) as { body: string }).body);
    expect(body).toContain("A fix did not hold");
    expect(body).toMatch(/1 other finding/);
  });

  it("never touches a finding with no fingerprint, because absence cannot mean anything about it", async () => {
    addTicket();
    const unidentifiable = addFinding({ fingerprint: null, status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun();

    await verifyFindingsAgainstScanRun(String(run.id), []);

    expect(unidentifiable.verificationState).toBe("AWAITING_PROOF");
    expect(unidentifiable.status).toBe("PENDING_VERIFICATION");
  });

  it("does nothing at all when verified remediation is switched off", async () => {
    ingestionSettings = { id: "global", verifyResolutionEnabled: false, verificationWindowDays: 14, autoReopenEnabled: true };
    addTicket();
    const finding = addFinding({ status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun();

    await verifyFindingsAgainstScanRun(String(run.id), []);

    expect(finding.verificationState).toBe("AWAITING_PROOF");
    expect(finding.status).toBe("PENDING_VERIFICATION");
  });
});

describe("a scan by a DIFFERENT tool proves nothing", () => {
  it("does not mark a semgrep finding fixed because gitleaks did not report it", async () => {
    addTicket();
    const finding = addFinding({ tool: "semgrep", status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun({ tool: "gitleaks" });

    await verifyFindingsAgainstScanRun(String(run.id), []);

    // gitleaks was never looking for a semgrep rule. Treating its silence as evidence would mark a
    // workspace's entire backlog verified-fixed the first night somebody added a second scanner.
    expect(finding.verificationState).toBe("AWAITING_PROOF");
    expect(finding.status).toBe("PENDING_VERIFICATION");
    expect(finding.verifiedFixedAt).toBeNull();
  });

  it("does not reopen a semgrep finding because a gitleaks run happens to carry its fingerprint", async () => {
    const ticket = addTicket();
    const finding = addFinding({ tool: "semgrep", status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun({ tool: "gitleaks" });

    await verifyFindingsAgainstScanRun(String(run.id), ["v1:aaa"]);

    expect(finding.verificationState).toBe("AWAITING_PROOF");
    expect(ticket.status).toBe("RESOLVED");
  });

  it("still matches when the two spellings differ only in case, the way the fingerprint does", async () => {
    addTicket();
    const finding = addFinding({ tool: "Semgrep", status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun({ tool: "semgrep" });

    await verifyFindingsAgainstScanRun(String(run.id), []);

    expect(finding.verificationState).toBe("VERIFIED_FIXED");
  });

  it("does not let a run on another branch speak for this one", async () => {
    addTicket();
    const finding = addFinding({ branch: "main", status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun({ branch: "release/2.0" });

    await verifyFindingsAgainstScanRun(String(run.id), []);

    // The same code can be fixed on one branch and not the other — which is exactly why the dedup
    // index keys on branch too.
    expect(finding.verificationState).toBe("AWAITING_PROOF");
  });

  it("does not let one tool's SAST run speak for its own QUALITY findings", async () => {
    // A run is created per (tool, type, repository, branch), so ONE payload carrying two types
    // produces two runs, each holding only its own type's fingerprints. SonarQube makes that the
    // normal case: a single analysis reports VULNERABILITY (→ SAST) and CODE_SMELL (→ QUALITY)
    // together. Without the same-TYPE restriction, the SAST run's verdict looks at the QUALITY
    // finding, does not find its fingerprint in the SAST list, and declares it verified fixed —
    // while the very same request was reporting it.
    addTicket();
    const finding = addFinding({ tool: "sonarqube", type: "QUALITY", status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun({ tool: "sonarqube", type: "SAST" });

    await verifyFindingsAgainstScanRun(String(run.id), []);

    expect(finding.verificationState).toBe("AWAITING_PROOF");
    expect(finding.status).toBe("PENDING_VERIFICATION");
  });

  it("and a QUALITY run does settle a QUALITY finding, so the ladder still serves both disciplines", async () => {
    addTicket();
    const finding = addFinding({ tool: "sonarqube", type: "QUALITY", status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun({ tool: "sonarqube", type: "QUALITY" });

    await verifyFindingsAgainstScanRun(String(run.id), []);

    expect(finding.verificationState).toBe("VERIFIED_FIXED");
  });
});

describe("the ladder: verification on, auto-reopen off", () => {
  it("marks the finding and sends the digest, and leaves the ticket exactly where it was", async () => {
    ingestionSettings = { id: "global", verifyResolutionEnabled: true, verificationWindowDays: 14, autoReopenEnabled: false };
    const ticket = addTicket({ status: "CLOSED" });
    const finding = addFinding({ status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF" });
    const run = addScanRun();

    await verifyFindingsAgainstScanRun(String(run.id), ["v1:aaa"]);
    await flushDetached();

    // The whole point of two toggles: "tell me the fix did not hold, but do not move my tickets".
    expect(finding.verificationState).toBe("REFUTED_BY_SCAN");
    expect(ticket.status).toBe("CLOSED");
    expect(ticket.dueAt).toEqual(new Date("2026-08-01T12:00:00Z"));
    expect(dispatchTransactional).toHaveBeenCalledWith(expect.objectContaining({ templateKey: "ticket.reopened_digest" }));
    // And the email says so rather than claiming a clock restarted that did not.
    expect(String(dispatchTransactional.mock.calls[0][0].vars.slaText)).toMatch(/NOT reopened/);
  });
});

describe("the grace window: running out of time is not evidence", () => {
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  it("marks an expired claim unverified and nudges the assignee, without reopening anything", async () => {
    const ticket = addTicket({ status: "CLOSED" });
    const finding = addFinding({ status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF", awaitingVerificationSince: longAgo });

    expect(await sweepUnverifiedFindings()).toBe(1);

    expect(finding.verificationState).toBe("UNVERIFIED");
    // THE LINE THIS WHOLE FEATURE TURNS ON. Nobody proved the fix failed; a scan simply never ran.
    expect(ticket.status).toBe("CLOSED");
    // And the finding keeps counting — running out of patience does not make a vulnerability less
    // real, so the status stays in the `pending` bucket.
    expect(finding.status).toBe("PENDING_VERIFICATION");
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-assignee", category: "security.verification_unverified" })
    );
  });

  it("says in the comment that this is not an accusation", async () => {
    addTicket();
    addFinding({ status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF", awaitingVerificationSince: longAgo });
    await sweepUnverifiedFindings();

    const body = String((comments[0] as { body: string }).body);
    expect(body).toMatch(/not an accusation that the fix failed/i);
    expect(body).toMatch(/absence of proof is not proof of failure/i);
  });

  it("leaves a claim that is still inside its window alone", async () => {
    addTicket();
    const finding = addFinding({
      status: "PENDING_VERIFICATION",
      verificationState: "AWAITING_PROOF",
      awaitingVerificationSince: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    });

    expect(await sweepUnverifiedFindings()).toBe(0);
    expect(finding.verificationState).toBe("AWAITING_PROOF");
  });

  it("does nothing at all when verified remediation is switched off", async () => {
    ingestionSettings = { id: "global", verifyResolutionEnabled: false, verificationWindowDays: 14, autoReopenEnabled: true };
    addTicket();
    const finding = addFinding({ status: "PENDING_VERIFICATION", verificationState: "AWAITING_PROOF", awaitingVerificationSince: longAgo });

    expect(await sweepUnverifiedFindings()).toBe(0);
    expect(finding.verificationState).toBe("AWAITING_PROOF");
  });
});

/**
 * Parsing the configured From address, and the deliverability warnings derived from it.
 *
 * This got rewritten to kill a quadratic backtrack (~400ms on a 20k-character value), which means
 * the PARSING changed even though the intent did not — so the accepted and rejected forms are
 * pinned here rather than trusted. The old pattern scanned for an email-shaped substring anywhere
 * in the string; the new one locates the delimiter and validates the two halves, which is stricter
 * on garbage. That stricter answer is the better one for a config diagnostic: "no parseable
 * address, use 'Name <user@domain>'" is actionable, and silently picking an address out of a
 * malformed value hides the misconfiguration it exists to report.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1" }) }));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (v: string) => v }));

const { classifyFromAddress } = await import("../../src/services/mail.service.js");

const domainOf = (from: string, smtpUser = "") => classifyFromAddress(from, smtpUser).fromDomain;
const addressOf = (from: string, smtpUser = "") => classifyFromAddress(from, smtpUser).fromAddress;

describe("the forms a From header actually takes", () => {
  it("reads a bare address", () => {
    expect(addressOf("support@acme.io")).toBe("support@acme.io");
    expect(domainOf("support@acme.io")).toBe("acme.io");
  });

  it("reads a display name with the address in angle brackets", () => {
    expect(addressOf("Support <support@acme.io>")).toBe("support@acme.io");
    expect(domainOf("Support <support@acme.io>")).toBe("acme.io");
  });

  it("handles a quoted display name containing a comma, which is the case that breaks naive splits", () => {
    expect(addressOf('"Acme, Inc." <billing@acme.io>')).toBe("billing@acme.io");
  });

  it("keeps plus-addressing, dots and subdomains intact", () => {
    expect(addressOf("A B <a.b+timesheet@mail.acme.co.uk>")).toBe("a.b+timesheet@mail.acme.co.uk");
    expect(domainOf("A B <a.b+timesheet@mail.acme.co.uk>")).toBe("mail.acme.co.uk");
  });

  it("lower-cases the domain but not the local part, since only the domain is case-insensitive", () => {
    expect(domainOf("Support <Support@ACME.io>")).toBe("acme.io");
    expect(addressOf("Support <Support@ACME.io>")).toBe("Support@ACME.io");
  });
});

describe("values that are not an address", () => {
  const unparseable = (from: string) => {
    const result = classifyFromAddress(from, "");
    expect(result.fromDomain, from).toBeNull();
    expect(result.issues.join(" "), from).toMatch(/no parseable address/);
  };

  it("reports them as unparseable, with the format to use", () => {
    for (const from of ["", "Support Team", "@acme.io", "support@", "no-at-sign.example.com", "a b@acme.io"]) {
      unparseable(from);
    }
  });

  it("does not pick an address out of surrounding prose", () => {
    // The old pattern matched anywhere, so this yielded "support@acme.io" and the admin never
    // learned their MAIL_FROM was malformed. Refusing it surfaces the misconfiguration.
    unparseable("please contact support@acme.io for help");
  });
});

describe("the deliverability warnings this exists to produce", () => {
  it("flags a reserved TLD that real mail servers drop", () => {
    const { issues } = classifyFromAddress("TimeSphere <no-reply@timesheet.local>", "");
    expect(issues.join(" ")).toMatch(/reserved TLD/);
  });

  it("flags a From domain that does not match the SMTP account's domain", () => {
    const { issues } = classifyFromAddress("Support <support@acme.io>", "postmaster@sendgrid.net");
    expect(issues.join(" ")).toMatch(/does not match the SMTP account's domain/);
  });

  it("says nothing when the From address and SMTP account agree on a real domain", () => {
    expect(classifyFromAddress("Support <support@acme.io>", "support@acme.io").issues).toEqual([]);
  });
});

describe("cost", () => {
  it("stays linear on a long value, which is the whole reason it was rewritten", () => {
    // The previous unanchored pattern retried from every character of a string containing no "@",
    // each retry scanning forward. This is the input that took ~400ms.
    const started = Date.now();
    classifyFromAddress("ab".repeat(10_000), "");
    expect(Date.now() - started).toBeLessThan(50);
  });
});

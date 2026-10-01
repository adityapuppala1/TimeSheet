/**
 * Which company an email address belongs to — decision 9 in docs/SIGNUP_AND_DOMAINS_PLAN.md.
 *
 * One company domain holds one workspace, so this function is a customer's identity at signup. Two
 * answers for one company would let it open two workspaces; one answer for two companies would route
 * a stranger into somebody else's. Both failure directions are pinned below.
 */
import { describe, expect, it } from "vitest";
import { companyDomainOf } from "../../src/utils/company-domain.js";

describe("companyDomainOf", () => {
  it.each([
    ["priya@acme.com", "acme.com"],
    ["priya@eng.acme.com", "acme.com"],
    ["  Priya@Mail.ACME.co.uk ", "acme.co.uk"],
    ["dev@eng.acme.co.in", "acme.co.in"],
    ["x@team.example.github.io", "example.github.io"]
  ])("rolls %s up to its registrable domain %s", (email, expected) => {
    expect(companyDomainOf(email)).toBe(expected);
  });

  it("keeps two Microsoft 365 default domains apart — onmicrosoft.com is not on the Public Suffix List", () => {
    expect(companyDomainOf("a@contoso.onmicrosoft.com")).toBe("contoso.onmicrosoft.com");
    expect(companyDomainOf("b@fabrikam.onmicrosoft.com")).toBe("fabrikam.onmicrosoft.com");
    expect(companyDomainOf("c@eng.contoso.onmicrosoft.com")).toBe("contoso.onmicrosoft.com");
  });

  it.each(["a@co.uk", "a@localhost", "a@10.0.0.1", "a@acme", "not-an-email", "a@onmicrosoft.com", "@acme.com", "a@"])(
    "has no company domain for %s",
    (email) => {
      expect(companyDomainOf(email)).toBeNull();
    }
  );

  it("normalises an internationalised domain to ASCII so one company is one claim", () => {
    expect(companyDomainOf("a@bücher.de")).toBe("xn--bcher-kva.de");
    expect(companyDomainOf("a@xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
  });
});

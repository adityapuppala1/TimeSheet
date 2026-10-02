/**
 * The "needs review" and "closed digest" emails open the ticket they are about.
 *
 * Both are about ONE ticket, and both sent the reader somewhere else: the needs-review email to the
 * AI activity log, the closed digest to the whole Tickets list — in a workspace with seventeen hundred
 * tickets. Every other ticket email (and every bell notification) already links `?open=<id>`, the deep
 * link the Tickets page opens a single ticket from. Pinned on both copies of each email: the code
 * fallback and the seeded template a workspace actually sends from.
 */
import { describe, expect, it } from "vitest";

const { templates } = await import("../../src/services/mail-templates.js");
const { SEED_TEMPLATES } = await import("../../prisma/email-templates-seed.js");
const { TEMPLATE_VARIABLES, TEMPLATE_DEFAULTS, sampleVariables } = await import("../../src/services/template-store.service.js");

const DEEP_LINK = "/app/tickets?open=ticket-42";

describe("the code fallback links to the one ticket", () => {
  it("needs review", () => {
    const html = templates.ticketNeedsReview({ targetName: "Lena Lead", ticketKey: "WEB-7", title: "Invoice blank", senderEmail: "c@x.io", confidence: 0.4, ticketId: "ticket-42" });
    expect(html).toContain(DEEP_LINK);
    expect(html).not.toContain("/app/ai-activity");
  });

  it("closed digest", () => {
    const html = templates.ticketClosedDigest({
      ticketKey: "WEB-7",
      title: "Invoice blank",
      closedBy: "Ada",
      riskVerdict: "Clean",
      findingsText: "None",
      testStatus: "PASSED",
      ticketId: "ticket-42"
    });
    expect(html).toContain(DEEP_LINK);
  });
});

describe("the seeded template a workspace sends from links to the one ticket", () => {
  for (const key of ["ticket.needs_review", "ticket.closed_digest"] as const) {
    it(key, () => {
      const body = SEED_TEMPLATES[key].bodyHtml;
      expect(body).toContain("{{appUrl}}/app/tickets?open={{ticketId}}");
      expect(body).not.toContain('href="{{appUrl}}/app/ai-activity"');
      expect(body).not.toContain('href="{{appUrl}}/app/tickets"');
    });
  }
});

describe("the editor knows the new variable", () => {
  for (const key of ["ticket.needs_review", "ticket.closed_digest"] as const) {
    it(`${key} declares ticketId, ships it in its default body and has a sample for it`, () => {
      expect(TEMPLATE_VARIABLES[key]).toContain("ticketId");
      expect(TEMPLATE_DEFAULTS[key].html).toContain("{{ticketId}}");
      expect(sampleVariables(key).ticketId).toBeTruthy();
    });
  }
});

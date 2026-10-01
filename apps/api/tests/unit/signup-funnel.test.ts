/**
 * The signup funnel recorder (signup Phase 1). Every stage a signup reaches is a row, so the console
 * can draw the funnel and the daily summary can count it. Two properties matter more than the count:
 * the row never holds the person's address (an abandoned attempt is somebody who chose not to
 * become a customer), and recording can never break the signup it is recording.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { signupAttempt: { create } } }));

const { recordSignupStage } = await import("../../src/services/signup-funnel.service.js");

beforeEach(() => {
  create.mockClear();
  create.mockImplementation(async ({ data }) => data);
});

describe("recordSignupStage", () => {
  it("stores the company domain and a keyed hash — never the address", async () => {
    await recordSignupStage("VERIFIED", { email: "Priya@Eng.Northwind.co.uk" });
    const row = create.mock.calls[0][0].data;
    expect(row).toMatchObject({ stage: "VERIFIED", domain: "northwind.co.uk" });
    expect(row.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row).toLowerCase()).not.toContain("priya");
  });

  it("keeps a personal domain as its own domain rather than none — the funnel counts refusals by provider", async () => {
    await recordSignupStage("REFUSED", { email: "someone@rediffmail.com", detail: "personal" });
    expect(create.mock.calls[0][0].data).toMatchObject({ stage: "REFUSED", domain: "rediffmail.com", detail: "personal" });
  });

  it("links the workspace when the stage concerns one, and truncates a long detail", async () => {
    await recordSignupStage("FAILED", { email: "a@acme.com", organizationId: "org-1", detail: "x".repeat(900) });
    const row = create.mock.calls[0][0].data;
    expect(row.organizationId).toBe("org-1");
    expect(row.detail).toHaveLength(500);
  });

  it("never throws — a control-plane hiccup must not fail the signup it was recording", async () => {
    create.mockRejectedValueOnce(new Error("control plane down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(recordSignupStage("CODE_SENT", { email: "a@acme.com" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

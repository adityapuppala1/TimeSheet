/**
 * The link an approved joiner sets their first password with (signup Phase 1). It rides the existing
 * password-reset machinery — same table, same token format, same /reset-password page — with a longer life,
 * because "your request was approved" may sit in an inbox over a weekend where a reset link would not.
 */
import { describe, expect, it, vi } from "vitest";

const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
vi.mock("../../src/config/prisma.js", () => ({ prisma: { passwordResetToken: { create } } }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({ tenantBaseUrl: () => "https://acme.timesphere.test" }));

const { issueSetPasswordLink } = await import("../../src/services/set-password-link.service.js");

describe("issueSetPasswordLink", () => {
  it("stores only a hash, lives as long as asked, and points at the reset page in welcome mode", async () => {
    const before = Date.now();
    const url = await issueSetPasswordLink("user-1", 72 * 60 * 60 * 1000);
    const row = create.mock.calls[0][0].data as { userId: string; tokenHash: string; expiresAt: Date };
    const token = new URL(url).searchParams.get("token")!;
    expect(url.startsWith("https://acme.timesphere.test/reset-password?")).toBe(true);
    expect(new URL(url).searchParams.get("welcome")).toBe("1");
    expect(row.userId).toBe("user-1");
    // `<selector>.<verifier>` — the selector is stored to look the row up by, the verifier only
    // as a SHA-256 (reset-token.service.ts).
    const [selector, verifier] = token.split(".");
    expect((row as { selector?: string }).selector).toBe(selector);
    expect(row.tokenHash).not.toContain(verifier);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(72 * 60 * 60 * 1000 - 1000);
    expect(row.expiresAt.getTime() - before).toBeLessThanOrEqual(72 * 60 * 60 * 1000 + 5000);
  });
});

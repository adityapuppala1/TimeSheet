/**
 * Reset links (audit #3 and #15).
 *
 * THE DEFECT: `resetPassword` loaded up to 500 live tokens across EVERY user and bcrypt-compared the
 * submitted one against each — about 24 s of CPU for one wrong guess once 500 were live, and any
 * genuine link older than the newest 500 could never match at all, so flooding forgot-password
 * broke every real reset in the workspace.
 *
 * THE SHAPE NOW: a link is `<selector>.<verifier>`. The selector is an indexed column, so a guess
 * costs one lookup; the verifier is 48 random characters, so a fast hash (SHA-256) is the right
 * tool and it is compared in constant time. Links minted before this change (no `.`) keep working
 * until they expire, checked only among the legacy rows — a pool nothing adds to any more.
 *
 * And the low-severity half (#15): spending a link is one conditional UPDATE whose count is
 * checked, a successful reset or a password change voids every other outstanding link for that
 * person, and redeeming re-checks that the account is still ACTIVE.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({
  tenantBaseUrl: () => "https://acme.timesphere.test",
  rememberWorkspaceMembership: vi.fn()
}));
// Wrapped, not replaced: the real bcrypt still runs where a test needs a legacy row to match, and
// the spy is what lets "no bcrypt" be asserted rather than inferred from timing.
vi.mock("../../src/utils/security.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/utils/security.js")>();
  return { ...actual, verifyTokenHash: vi.fn(actual.verifyTokenHash) };
});

const { changePassword, requestPasswordReset, resetPassword } = await import("../../src/services/auth.service.js");
const { issueSetPasswordLink } = await import("../../src/services/set-password-link.service.js");
const { hashPassword, hashToken, verifyTokenHash } = await import("../../src/utils/security.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CURRENT = "the-current-one";
const NEXT = "a-genuinely-new-one";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let client: PrismaClient & Record<string, any>;
let storedHash: string;

beforeEach(async () => {
  vi.mocked(verifyTokenHash).mockClear();
  storedHash ??= await hashPassword(CURRENT);
  const user = { id: USER_ID, name: "Ada", email: "ada@example.com", passwordHash: storedHash, status: "ACTIVE", deletedAt: null };
  const c: Record<string, any> = {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      findUniqueOrThrow: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockResolvedValue(user)
    },
    passwordResetToken: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0)
    },
    session: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) }
  };
  // Both forms, like the house fake client: an array of already-started writes, or a callback
  // handed this same object so the assertions below see every write wherever it was issued.
  c.$transaction = vi.fn((arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(c) : Promise.all(arg as Promise<unknown>[])
  );
  client = c as PrismaClient & Record<string, any>;
});

const inTenant = <T>(fn: () => Promise<T>) => runInTenant(client, fn, "org-1");

/** A stored row for a link in the NEW format, as the issuer writes it. */
function newFormatRow(selector: string, verifier: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-new",
    userId: USER_ID,
    selector,
    tokenHash: sha256(verifier),
    usedAt: null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    createdAt: new Date(),
    ...overrides
  };
}

const SELECTOR = "AbCdEfGhIjKlMnOp";
const VERIFIER = "v".repeat(24) + "W".repeat(24);
const NEW_TOKEN = `${SELECTOR}.${VERIFIER}`;

describe("issuing a link", () => {
  it("forgot-password mints <selector>.<verifier> and stores the selector plus a SHA-256 of the verifier", async () => {
    const result = await inTenant(() => requestPasswordReset("ada@example.com"));
    const token = new URL(result!.resetUrl).searchParams.get("token")!;
    const [selector, verifier] = token.split(".");
    const row = client.passwordResetToken.create.mock.calls[0][0].data;

    expect(token).toMatch(/^[\w-]{16}\.[\w-]{48}$/);
    expect(row.selector).toBe(selector);
    expect(row.tokenHash).toBe(sha256(verifier));
    expect(row.tokenHash).not.toContain(verifier);
  });

  it("the welcome (set-password) link goes through the same path", async () => {
    const url = await inTenant(() => issueSetPasswordLink(USER_ID, 72 * 60 * 60 * 1000));
    const token = new URL(url).searchParams.get("token")!;
    const row = client.passwordResetToken.create.mock.calls[0][0].data;

    expect(token).toMatch(/^[\w-]{16}\.[\w-]{48}$/);
    expect(row.selector).toBe(token.split(".")[0]);
    expect(row.tokenHash).toBe(sha256(token.split(".")[1]));
  });
});

describe("redeeming a new-format link", () => {
  it("a bad token costs exactly one indexed lookup and no bcrypt at all", async () => {
    await expect(inTenant(() => resetPassword(NEW_TOKEN, NEXT))).rejects.toMatchObject({ statusCode: 422 });

    expect(client.passwordResetToken.findUnique).toHaveBeenCalledTimes(1);
    expect(client.passwordResetToken.findUnique.mock.calls[0][0]).toEqual({ where: { selector: SELECTOR } });
    expect(client.passwordResetToken.findMany).not.toHaveBeenCalled();
    expect(verifyTokenHash).not.toHaveBeenCalled();
  });

  it("the right selector with the wrong verifier is refused", async () => {
    client.passwordResetToken.findUnique.mockResolvedValue(newFormatRow(SELECTOR, "x".repeat(48)));
    await expect(inTenant(() => resetPassword(NEW_TOKEN, NEXT))).rejects.toMatchObject({ statusCode: 422 });
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("a genuine link redeems, with no bcrypt spent on the token", async () => {
    client.passwordResetToken.findUnique.mockResolvedValue(newFormatRow(SELECTOR, VERIFIER));
    await inTenant(() => resetPassword(NEW_TOKEN, NEXT));

    expect(verifyTokenHash).not.toHaveBeenCalled();
    expect(client.user.update).toHaveBeenCalledTimes(1);
    expect(client.user.update.mock.calls[0][0].data.passwordHash).not.toBe(storedHash);
  });

  it("an expired link is refused", async () => {
    client.passwordResetToken.findUnique.mockResolvedValue(newFormatRow(SELECTOR, VERIFIER, { expiresAt: new Date(Date.now() - 1000) }));
    await expect(inTenant(() => resetPassword(NEW_TOKEN, NEXT))).rejects.toMatchObject({ statusCode: 422 });
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("an already-used link is refused", async () => {
    client.passwordResetToken.findUnique.mockResolvedValue(newFormatRow(SELECTOR, VERIFIER, { usedAt: new Date() }));
    await expect(inTenant(() => resetPassword(NEW_TOKEN, NEXT))).rejects.toMatchObject({ statusCode: 422 });
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("a token in neither format is refused without touching the database", async () => {
    await expect(inTenant(() => resetPassword("not-a-token-at-all", NEXT))).rejects.toMatchObject({ statusCode: 422 });
    expect(client.passwordResetToken.findUnique).not.toHaveBeenCalled();
    expect(client.passwordResetToken.findMany).not.toHaveBeenCalled();
  });
});

describe("links minted before this change", () => {
  const LEGACY = "L".repeat(48);

  it("still redeem until they expire, searched only among legacy rows", async () => {
    client.passwordResetToken.findMany.mockResolvedValue([
      { id: "tok-old", userId: USER_ID, selector: null, tokenHash: await hashToken(LEGACY), usedAt: null, expiresAt: new Date(Date.now() + 60_000) }
    ]);
    await inTenant(() => resetPassword(LEGACY, NEXT));

    const where = client.passwordResetToken.findMany.mock.calls[0][0].where;
    // The pool new tokens never enter, so it drains to nothing within the longest TTL (72 h).
    expect(where).toMatchObject({ selector: null, usedAt: null, expiresAt: { gt: expect.any(Date) } });
    expect(client.passwordResetToken.findUnique).not.toHaveBeenCalled();
    expect(client.user.update).toHaveBeenCalledTimes(1);
  });

  it("an expired legacy link matches nothing", async () => {
    // The query is what refuses it — an expired row is never a candidate.
    await expect(inTenant(() => resetPassword(LEGACY, NEXT))).rejects.toMatchObject({ statusCode: 422 });
    expect(client.user.update).not.toHaveBeenCalled();
  });
});

describe("spending a link", () => {
  beforeEach(() => {
    client.passwordResetToken.findUnique.mockResolvedValue(newFormatRow(SELECTOR, VERIFIER));
  });

  it("is one conditional UPDATE, and a link a concurrent request already spent is refused", async () => {
    client.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(inTenant(() => resetPassword(NEW_TOKEN, NEXT))).rejects.toMatchObject({ statusCode: 422 });

    expect(client.passwordResetToken.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "tok-new", usedAt: null },
      data: { usedAt: expect.any(Date) }
    });
    expect(client.user.update).not.toHaveBeenCalled();
    expect(client.session.updateMany).not.toHaveBeenCalled();
  });

  it("a successful reset voids every other outstanding link for that person", async () => {
    await inTenant(() => resetPassword(NEW_TOKEN, NEXT));
    const voided = client.passwordResetToken.updateMany.mock.calls.map((call: any[]) => call[0]);
    expect(voided).toContainEqual({ where: { userId: USER_ID, usedAt: null }, data: { usedAt: expect.any(Date) } });
  });

  it("redeeming re-checks that the account is still ACTIVE", async () => {
    client.user.findUnique.mockResolvedValue({ id: USER_ID, email: "ada@example.com", passwordHash: storedHash, status: "INACTIVE", deletedAt: null });
    await expect(inTenant(() => resetPassword(NEW_TOKEN, NEXT))).rejects.toMatchObject({ statusCode: 422 });
    expect(client.user.update).not.toHaveBeenCalled();
    expect(client.passwordResetToken.updateMany).not.toHaveBeenCalled();
  });
});

describe("a self-service password change", () => {
  it("voids every outstanding reset link for that person", async () => {
    await inTenant(() => changePassword(USER_ID, CURRENT, NEXT));
    expect(client.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, usedAt: null },
      data: { usedAt: expect.any(Date) }
    });
  });
});

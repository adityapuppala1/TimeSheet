/**
 * Two tabs refreshing at the same moment must not sign the person out (security audit #17).
 *
 * THE SEQUENCE, as the auditor's probe drove it against the real `refresh()`:
 *   1. tab A presents S0 and rotates it: the row now holds S1, with S0 as the previous secret;
 *   2. tab B presents S0 inside the 30-second grace window — the same cookie, sent a moment later;
 *   3. the old code handed B a FRESH secret S2 and wrote it over S1. If the browser's cookie jar
 *      then ended on A's Set-Cookie (S1) — responses can land in either order, on different pods —
 *      the next refresh presented S1, matched neither the current nor the previous hash, and the
 *      whole session was revoked as a theft.
 *
 * THE FIX: a grace-window replay is given an ACCESS token only. No new secret is minted, nothing is
 * written, and the route sets no cookie — so whatever the jar holds (S1, from A) stays valid.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));

const { refresh } = await import("../../src/services/auth.service.js");
const { signRefreshToken, hashToken, opaqueToken } = await import("../../src/utils/security.js");

const USER = "33333333-3333-4333-8333-333333333333";
const SID = "44444444-4444-4444-8444-444444444444";

/** A session row that really rotates: `update` writes into it, `findUnique` reads it back. */
async function liveSession() {
  const s0 = opaqueToken();
  const row: Record<string, unknown> = {
    id: SID,
    userId: USER,
    refreshHash: await hashToken(s0),
    previousRefreshHash: null,
    refreshRotatedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 864e5)
  };
  const client = {
    session: {
      findUnique: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data))
    },
    user: { findUnique: vi.fn(async () => ({ status: "ACTIVE", deletedAt: null })) }
  } as unknown as PrismaClient & { session: { update: ReturnType<typeof vi.fn> } };
  return { s0, row, client };
}

const cookie = (secret: string) => `${signRefreshToken(USER, SID, 1, "org-1")}.${secret}`;
const secretOf = (refreshToken: string) => refreshToken.slice(refreshToken.lastIndexOf(".") + 1);

describe("a refresh replayed inside the grace window", () => {
  it("tab A rotates S0 -> S1, tab B replays S0: B gets an access token, and A's S1 keeps working", async () => {
    const { s0, row, client } = await liveSession();
    const inTenant = <T>(fn: () => Promise<T>) => runInTenant(client, fn, "org-1");

    const a = await inTenant(() => refresh(cookie(s0)));
    const s1 = secretOf(a.refreshToken!);
    const writesAfterA = client.session.update.mock.calls.length;

    const b = await inTenant(() => refresh(cookie(s0)));
    expect(b.accessToken).toEqual(expect.any(String));
    // No new secret for B, so there is nothing for its response to overwrite the jar with…
    expect(b.refreshToken).toBeNull();
    // …and nothing was written over S1.
    expect(client.session.update.mock.calls.length).toBe(writesAfterA);

    // The jar ends on A's Set-Cookie. That is now just the current secret.
    const next = await inTenant(() => refresh(cookie(s1)));
    expect(next.refreshToken).toEqual(expect.any(String));
    expect(row.revokedAt).toBeNull();
  });

  it("still treats a replay outside the window as theft and revokes the session", async () => {
    const { s0, row, client } = await liveSession();
    const inTenant = <T>(fn: () => Promise<T>) => runInTenant(client, fn, "org-1");
    await inTenant(() => refresh(cookie(s0)));
    row.refreshRotatedAt = new Date(Date.now() - 60_000);

    await expect(inTenant(() => refresh(cookie(s0)))).rejects.toMatchObject({ statusCode: 401 });
    expect(row.revokedAt).toBeInstanceOf(Date);
  });
});

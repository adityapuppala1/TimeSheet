import { vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

/**
 * A plain object of `vi.fn()` stubs covering only the tenant-DB model methods the AI/SCIM
 * controllers under test actually touch. Constructed fresh per test so mock state never leaks
 * between tests. Passed as the `client` in `tenantContext.run({ orgId, orgSlug, client }, fn)` —
 * the real `prisma` export (config/prisma.ts) is a Proxy that forwards through whatever client
 * is active in tenant context, so nothing in config/prisma.ts itself needs mocking.
 */
export function createFakeTenantClient(): PrismaClient {
  return {
    globalAISettings: { upsert: vi.fn() },
    aIUsageLog: { create: vi.fn(), aggregate: vi.fn() },
    scimSettings: { findUnique: vi.fn() },
    globalFaceVerificationSettings: { upsert: vi.fn(), update: vi.fn() },
    faceEnrollment: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    faceVerificationAttempt: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    faceEnrollmentTemplate: { findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    faceChallenge: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    notification: { create: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn()
    },
    role: { findUniqueOrThrow: vi.fn() }
  } as unknown as PrismaClient;
}

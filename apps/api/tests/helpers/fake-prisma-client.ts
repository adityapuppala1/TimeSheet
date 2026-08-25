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
    globalAISettings: { upsert: vi.fn(), findUnique: vi.fn() },
    // Defaults to no rows so callChat's getEnabledProviderConfigs() falls through to its
    // synthesized-default single config (GlobalAISettings' provider/model) — exactly like
    // production for a workspace that has never configured AIProviderConfig through the new UI.
    aIProviderConfig: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    },
    // Only ever called with an ARRAY of already-invoked operation promises in this codebase
    // (reorderProviderConfigs) — never the callback form — so resolving them is the whole stub.
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    aIUsageLog: { create: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    aIInteraction: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn()
    },
    aIDataset: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    aIDatasetItem: { create: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
    aIPromptTemplate: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    aIPromptVersion: { findFirst: vi.fn(), create: vi.fn() },
    aIEvalRun: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    aIEvalResult: { create: vi.fn(), findMany: vi.fn() },
    scimSettings: { findUnique: vi.fn() },
    globalFaceVerificationSettings: { upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
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
    faceEnrollmentTemplate: { findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn(), groupBy: vi.fn() },
    faceChallenge: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    notification: { create: vi.fn(), createMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    // Maintenance mode (services/maintenance.service.ts) + server health pings
    maintenanceSettings: { upsert: vi.fn() },
    session: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    $queryRaw: vi.fn(),
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn()
    },
    role: { findUniqueOrThrow: vi.fn() },
    // Billing / attestation (services/billing-rate.service.ts, attestation.service.ts)
    project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    ticket: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
    globalTicketSettings: { upsert: vi.fn(), findUnique: vi.fn() },
    timesheet: { findMany: vi.fn(), findFirst: vi.fn(), groupBy: vi.fn(), update: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    workAttestation: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
    attestationShareLink: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    // Feature-level health monitoring (services/service-health.service.ts). Every probe reads one
    // of these, so a missing entry surfaces as "cannot read properties of undefined" from inside
    // a probe rather than as a useful failure.
    ticketAttachment: { count: vi.fn() },
    outboundWebhook: { count: vi.fn() },
    globalPlanningSettings: { findUnique: vi.fn() },
    serviceHealthSample: { createMany: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    serviceIncident: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    aiCapabilityPolicy: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    agentRun: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    automationFlow: { findMany: vi.fn() },
    // V8 phase 3: the autonomy catalogue reports which agent owns each capability, so anything
    // touching it reads this table. Defaults to no claims — a suite that cares sets its own rows.
    agentProfile: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    agentRunStep: { create: vi.fn() },
    mcpToolInvocation: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    aiProposal: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn(), create: vi.fn() },
    // The spend ledger defaults to "a fresh month, well under budget" so every capability test
    // passes the gate without knowing it exists; the ledger's own tests override these.
    aiSpendMonth: {
      findUnique: vi.fn().mockResolvedValue({ id: "month", committedUsd: 0, reconciledAt: new Date(), updatedAt: new Date() }),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    blueprint: { findFirst: vi.fn() },
    aiProposalChange: { update: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    ticketLink: { deleteMany: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
    resourceBooking: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() }
  } as unknown as PrismaClient;
}

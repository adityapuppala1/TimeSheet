/**
 * `requirements-doc.service.ts` orchestrates the interview transcript and materialization
 * mapping — the two AI calls it drives (`conductRequirementsInterviewTurn`,
 * `generateRequirementsDocument`) are mocked at the `ai.service.js` module boundary rather than
 * the SDK level, so these tests never reach `callChat`/a real provider (mirrors this session's own
 * `ai-provider-config.test.ts` pattern of testing the orchestration layer, not the model call).
 */
import { describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/ai.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/ai.service.js")>();
  return {
    ...actual,
    conductRequirementsInterviewTurn: vi.fn(),
    generateRequirementsDocument: vi.fn()
  };
});

const { conductRequirementsInterviewTurn, generateRequirementsDocument } = await import("../../src/services/ai.service.js");
const {
  recordInterviewTurn,
  generateDocument,
  buildTicketMaterializationChanges,
  materializeGoals
} = await import("../../src/services/requirements-doc.service.js");

const BASE_DOC = {
  id: "doc-1",
  title: "Test doc",
  docType: "PRD" as const,
  status: "DRAFTING" as const,
  projectId: null,
  sections: null,
  createdById: "user-1",
  createdAt: new Date(),
  updatedAt: new Date()
};

describe("recordInterviewTurn", () => {
  it("appends the prior answer to the open question, then the new pending question", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.requirementsDocument.findUnique).mockResolvedValue({
      ...BASE_DOC,
      interviewTranscript: [{ question: "What problem are you solving?", answer: null, skipped: false, sectionTag: "problem" }]
    } as never);
    vi.mocked(client.requirementsDocument.update).mockResolvedValue({} as never);
    vi.mocked(conductRequirementsInterviewTurn).mockResolvedValue({
      done: false,
      question: "Who are the target users?",
      sectionTag: "targetUsers",
      progress: { section: "targetUsers", answered: 1, total: 14 },
      model: "test-model",
      interactionId: null
    } as never);

    await runInTenant(client, () => recordInterviewTurn("doc-1", { answer: "Scheduling field techs" }, "user-1"));

    const written = vi.mocked(client.requirementsDocument.update).mock.calls[0][0] as any;
    expect(written.data.interviewTranscript).toEqual([
      { question: "What problem are you solving?", answer: "Scheduling field techs", skipped: false, sectionTag: "problem" },
      { question: "Who are the target users?", answer: null, skipped: false, sectionTag: "targetUsers" }
    ]);
  });

  it("marks a skipped question as skipped rather than dropping it from the transcript", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.requirementsDocument.findUnique).mockResolvedValue({
      ...BASE_DOC,
      interviewTranscript: [{ question: "What is the budget?", answer: null, skipped: false, sectionTag: "nfr" }]
    } as never);
    vi.mocked(client.requirementsDocument.update).mockResolvedValue({} as never);
    vi.mocked(conductRequirementsInterviewTurn).mockResolvedValue({
      done: true,
      progress: { section: "nfr", answered: 14, total: 14 },
      model: "test-model",
      interactionId: null
    } as never);

    await runInTenant(client, () => recordInterviewTurn("doc-1", { skip: true }, "user-1"));

    const written = vi.mocked(client.requirementsDocument.update).mock.calls[0][0] as any;
    expect(written.data.interviewTranscript).toEqual([{ question: "What is the budget?", answer: null, skipped: true, sectionTag: "nfr" }]);
  });

  it("refuses an answer when there is no open question to answer", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.requirementsDocument.findUnique).mockResolvedValue({
      ...BASE_DOC,
      interviewTranscript: [{ question: "Q1", answer: "already answered", skipped: false, sectionTag: "problem" }]
    } as never);

    await expect(runInTenant(client, () => recordInterviewTurn("doc-1", { answer: "extra" }, "user-1"))).rejects.toMatchObject({
      statusCode: 422
    });
  });
});

describe("generateDocument", () => {
  it("refuses to generate from an empty transcript", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.requirementsDocument.findUnique).mockResolvedValue({ ...BASE_DOC, interviewTranscript: [] } as never);

    await expect(runInTenant(client, () => generateDocument("doc-1", "user-1"))).rejects.toMatchObject({ statusCode: 422 });
    expect(generateRequirementsDocument).not.toHaveBeenCalled();
  });
});

const FEATURES = [
  { title: "Scheduling board", description: "", priority: "HIGH" as const, estimatedHours: 40, moduleName: "Scheduling", dependsOnIndex: -1 },
  { title: "Reporting export", description: "", priority: "LOW" as const, estimatedHours: 8, moduleName: "Reporting", dependsOnIndex: -1 },
  { title: "Mobile job view", description: "", priority: "HIGH" as const, estimatedHours: 24, moduleName: "Mobile", dependsOnIndex: 0 }
];
const MODULES = [{ name: "Scheduling", description: "" }, { name: "Reporting", description: "" }, { name: "Mobile", description: "" }];

describe("buildTicketMaterializationChanges", () => {
  it("creates one CREATE row per feature and a LINK only for a real same-document dependency", () => {
    const changes = buildTicketMaterializationChanges(
      { sections: { ...({} as any), features: FEATURES, modules: MODULES } },
      "project-1"
    );

    const creates = changes.filter((c) => c.op === "CREATE");
    const links = changes.filter((c) => c.op === "LINK");
    expect(creates).toHaveLength(3);
    expect(links).toHaveLength(1);
    // Feature 2 (Mobile job view) depends on feature 0 (Scheduling board) — both still selected,
    // so the dense-index remap is the identity here: fromIndex 0, toIndex 2.
    expect(links[0].after).toEqual({ fromIndex: 0, toIndex: 2 });
  });

  it("drops a dependency on a feature excluded by moduleIndexes, and re-maps surviving indexes", () => {
    // Exclude "Scheduling" (module index 0) — only Reporting (1) and Mobile (2) remain. Mobile's
    // dependency on the now-excluded Scheduling board must be dropped, not point at nothing.
    const changes = buildTicketMaterializationChanges(
      { sections: { ...({} as any), features: FEATURES, modules: MODULES } },
      "project-1",
      [1, 2]
    );

    const creates = changes.filter((c) => c.op === "CREATE");
    const links = changes.filter((c) => c.op === "LINK");
    expect(creates.map((c) => c.after.title)).toEqual(["[Reporting] Reporting export", "[Mobile] Mobile job view"]);
    expect(links).toHaveLength(0);
  });

  it("refuses when the document has not been generated yet", () => {
    expect(() => buildTicketMaterializationChanges({ sections: null }, "project-1")).toThrow(/Generate the document/);
  });
});

describe("materializeGoals", () => {
  it("writes one GoalLink per created goal when a projectId is given", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.requirementsDocument.findUnique).mockResolvedValue(BASE_DOC as never);
    vi.mocked(client.goal.create).mockImplementation(({ data }: any) => Promise.resolve({ id: `goal-${data.title}`, ...data }) as never);
    vi.mocked(client.goalLink.create).mockResolvedValue({} as never);
    vi.mocked(client.$transaction).mockImplementation((cb: any) => cb(client));

    await runInTenant(client, () => materializeGoals("doc-1", { projectId: "project-1", items: [{ title: "Goal A" }, { title: "Goal B" }] }, "user-1"));

    expect(client.goal.create).toHaveBeenCalledTimes(2);
    expect(client.goalLink.create).toHaveBeenCalledTimes(2);
  });

  it("creates no GoalLink rows when no projectId is given", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.requirementsDocument.findUnique).mockResolvedValue(BASE_DOC as never);
    vi.mocked(client.goal.create).mockImplementation(({ data }: any) => Promise.resolve({ id: `goal-${data.title}`, ...data }) as never);
    vi.mocked(client.$transaction).mockImplementation((cb: any) => cb(client));

    await runInTenant(client, () => materializeGoals("doc-1", { items: [{ title: "Goal A" }] }, "user-1"));

    expect(client.goal.create).toHaveBeenCalledTimes(1);
    expect(client.goalLink.create).not.toHaveBeenCalled();
  });
});

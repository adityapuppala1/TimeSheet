/**
 * Tests for golden datasets.
 *
 * What's pinned here is the set of refusals, because each one exists to stop a dataset from
 * silently becoming worthless:
 *  - a cross-feature item can never be replayed (wrong capability signature),
 *  - an item without captured inputs can never be replayed at all,
 *  - and an item must copy its inputs, because the interaction it came from gets deleted by the
 *    retention sweep in ~30 days.
 * Each of those failures would show up much later as an eval run that quietly skipped half the set.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { addDatasetItemFromInteraction, defaultExpectedKind, listPromotableInteractions } = await import(
  "../../src/services/ai-dataset.service.js"
);

let client: ReturnType<typeof createFakeTenantClient>;

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(client.globalAISettings.upsert).mockResolvedValue({
    id: "global",
    aiCaptureEnabled: true,
    aiCaptureContentEnabled: true
  } as never);
  vi.mocked(client.aIDatasetItem.create).mockImplementation((async (args: any) => ({ id: "item-1", ...args.data })) as never);
});

const dataset = (over: Record<string, unknown> = {}) => ({ id: "ds-1", name: "Triage regressions", feature: "triage", ...over });
const interaction = (over: Record<string, unknown> = {}) => ({
  id: "int-1",
  feature: "triage",
  paramsJson: { title: "Login fails", description: "500 on submit" },
  outputText: '{"priority":"CRITICAL"}',
  ...over
});

const promote = (over: Record<string, unknown> = {}) =>
  runInTenant(client, () =>
    addDatasetItemFromInteraction({
      datasetId: "ds-1",
      interactionId: "int-1",
      expectedOutput: '{"priority":"LOW"}',
      userId: "user-1",
      ...over
    })
  );

describe("addDatasetItemFromInteraction", () => {
  it("copies the inputs onto the item so it survives interaction retention", async () => {
    vi.mocked(client.aIDataset.findUnique).mockResolvedValue(dataset() as never);
    vi.mocked(client.aIInteraction.findUnique).mockResolvedValue(interaction() as never);

    const item: any = await promote();

    // The whole point: the item holds its own copy. Referencing the interaction would mean the
    // golden set decays as the retention worker deletes rows out from under it.
    expect(item.inputParamsJson).toEqual({ title: "Login fails", description: "500 on submit" });
    expect(item.sourceInteractionId).toBe("int-1");
    expect(item.actualOutput).toBe('{"priority":"CRITICAL"}');
    expect(item.expectedOutput).toBe('{"priority":"LOW"}');
  });

  it("refuses to promote an interaction from a different feature", async () => {
    vi.mocked(client.aIDataset.findUnique).mockResolvedValue(dataset({ feature: "triage" }) as never);
    vi.mocked(client.aIInteraction.findUnique).mockResolvedValue(interaction({ feature: "writing_assistant" }) as never);

    await expect(promote()).rejects.toMatchObject({ statusCode: 422 });
    expect(client.aIDatasetItem.create).not.toHaveBeenCalled();
  });

  it("refuses when the inputs were never captured, and says capture is off", async () => {
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue({
      id: "global",
      aiCaptureEnabled: true,
      aiCaptureContentEnabled: false
    } as never);
    vi.mocked(client.aIDataset.findUnique).mockResolvedValue(dataset() as never);
    vi.mocked(client.aIInteraction.findUnique).mockResolvedValue(interaction({ paramsJson: null }) as never);

    // The two "no params" cases need different fixes, so they must not share one message: this one
    // is "go turn a setting on", the next is "that row is too old, pick a newer one".
    await expect(promote()).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("store prompts and responses") });
  });

  it("refuses with a different reason when capture is on but the row predates it", async () => {
    vi.mocked(client.aIDataset.findUnique).mockResolvedValue(dataset() as never);
    vi.mocked(client.aIInteraction.findUnique).mockResolvedValue(interaction({ paramsJson: null }) as never);

    await expect(promote()).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("before content capture was enabled") });
  });

  it("defaults the scoring strategy from the feature", async () => {
    vi.mocked(client.aIDataset.findUnique).mockResolvedValue(dataset() as never);
    vi.mocked(client.aIInteraction.findUnique).mockResolvedValue(interaction() as never);
    const item: any = await promote();

    // Structured features are scorable field-by-field for free; prose needs a looser check.
    expect(item.expectedKind).toBe("EXACT_FIELDS");
    expect(defaultExpectedKind("triage")).toBe("EXACT_FIELDS");
    expect(defaultExpectedKind("writing_assistant")).toBe("CONTAINS");
  });

  it("404s on an unknown dataset before touching interactions", async () => {
    vi.mocked(client.aIDataset.findUnique).mockResolvedValue(null as never);
    await expect(promote()).rejects.toMatchObject({ statusCode: 404 });
    expect(client.aIInteraction.findUnique).not.toHaveBeenCalled();
  });
});

describe("listPromotableInteractions", () => {
  it("defaults to problems only — unparseable or thumbs-down", async () => {
    vi.mocked(client.aIInteraction.findMany).mockResolvedValue([] as never);
    await runInTenant(client, () => listPromotableInteractions({ feature: "triage" }));

    const where = vi.mocked(client.aIInteraction.findMany).mock.calls[0][0]!.where as any;
    expect(where.OR).toEqual([{ parseOk: false }, { feedback: "down" }]);
  });

  it("flags rows whose inputs weren't captured as un-replayable", async () => {
    vi.mocked(client.aIInteraction.findMany).mockResolvedValue([
      { id: "a", paramsJson: { title: "x" } },
      { id: "b", paramsJson: null }
    ] as never);
    const rows = await runInTenant(client, () => listPromotableInteractions({ feature: "triage" }));

    // Told up front, so nobody writes out a corrected answer and only then hits a 422.
    expect(rows.map((r) => r.replayable)).toEqual([true, false]);
  });

  it("caps the page size regardless of what the caller asks for", async () => {
    vi.mocked(client.aIInteraction.findMany).mockResolvedValue([] as never);
    await runInTenant(client, () => listPromotableInteractions({ feature: "triage", limit: 5000 }));

    expect(vi.mocked(client.aIInteraction.findMany).mock.calls[0][0]!.take).toBe(100);
  });
});

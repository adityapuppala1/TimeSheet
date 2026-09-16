/**
 * Clearing a custom-field value must actually clear it.
 *
 * `setCustomFieldValues` used to write a cleared value as `value: null ?? undefined`, and
 * `undefined` is Prisma for "leave this column alone" — so every path that let a person empty a
 * field (the ticket screen, a request form re-submission) silently kept the old value. The doc
 * comment promised "null/'' always clears"; the database disagreed. This pins the fixed contract
 * at the Prisma boundary: null → the row is deleted; a value → the row is upserted with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const { setCustomFieldValues } = await import("../../src/services/custom-field.service.js");

const FIELD = { id: "f-text", key: "client", label: "Client", type: "TEXT", isRequired: false, options: null, ticketTypeFilter: null, isActive: true, appliesTo: "TICKET" };
let client: PrismaClient;

beforeEach(() => {
  client = {
    customField: { findMany: vi.fn().mockResolvedValue([FIELD]) },
    customFieldValue: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn().mockResolvedValue({ id: "v1" })
    },
    // The service hands $transaction an array of operations; awaiting them is enough here.
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops))
  } as unknown as PrismaClient;
});

const run = (values: Record<string, unknown>) => runInTenant(client, () => setCustomFieldValues({ ticketId: "t-1" }, values), "org-1");

describe("setCustomFieldValues and the empty value", () => {
  it("deletes the value row for null — 'not answered' is the absence of a row", async () => {
    await run({ client: null });
    expect(client.customFieldValue.deleteMany).toHaveBeenCalledWith({ where: { fieldId: "f-text", ticketId: "t-1" } });
    expect(client.customFieldValue.upsert).not.toHaveBeenCalled();
  });

  it("treats an empty string the same way", async () => {
    await run({ client: "" });
    expect(client.customFieldValue.deleteMany).toHaveBeenCalledTimes(1);
    expect(client.customFieldValue.upsert).not.toHaveBeenCalled();
  });

  it("upserts a real value, with the value itself rather than `undefined`", async () => {
    await run({ client: "Acme" });
    expect(client.customFieldValue.deleteMany).not.toHaveBeenCalled();
    const call = vi.mocked(client.customFieldValue.upsert).mock.calls[0][0];
    expect(call.update).toEqual({ value: "Acme" });
    expect(call.create).toMatchObject({ fieldId: "f-text", ticketId: "t-1", value: "Acme" });
  });

  it("refuses to clear a required field", async () => {
    vi.mocked(client.customField.findMany).mockResolvedValue([{ ...FIELD, isRequired: true }] as never);
    await expect(run({ client: null })).rejects.toThrow(/required/);
    expect(client.customFieldValue.deleteMany).not.toHaveBeenCalled();
  });
});

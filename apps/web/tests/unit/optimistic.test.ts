import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { applyOptimistic, replaceById, rollbackOptimistic, settleOptimistic } from "../../src/lib/optimistic";

type Row = { id: string; status: string };

function clientWith(entries: Array<[unknown[], Row[]]>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of entries) qc.setQueryData(key, data);
  return qc;
}

describe("applyOptimistic", () => {
  it("patches every variant of a key and remembers what each held", async () => {
    const qc = clientWith([
      [["tickets", { q: "" }], [{ id: "a", status: "OPEN" }]],
      [["tickets", { q: "bug" }], [{ id: "a", status: "OPEN" }]]
    ]);

    const ctx = await applyOptimistic<Row[]>(qc, [
      { key: ["tickets"], update: (rows) => replaceById(rows, "a", { status: "RESOLVED" }) }
    ]);

    expect(qc.getQueryData(["tickets", { q: "" }])).toEqual([{ id: "a", status: "RESOLVED" }]);
    expect(qc.getQueryData(["tickets", { q: "bug" }])).toEqual([{ id: "a", status: "RESOLVED" }]);
    expect(ctx.previous).toHaveLength(2);
  });

  it("leaves an entry alone when the update returns the same value, so there is nothing to undo", async () => {
    const qc = clientWith([[["tickets"], [{ id: "a", status: "OPEN" }]]]);
    const ctx = await applyOptimistic<Row[]>(qc, [
      // `replaceById` returns the SAME array when no row matched.
      { key: ["tickets"], update: (rows) => (replaceById(rows, "missing", { status: "X" }) === rows ? undefined : rows) }
    ]);
    expect(ctx.previous).toHaveLength(0);
    expect(qc.getQueryData(["tickets"])).toEqual([{ id: "a", status: "OPEN" }]);
  });

  it("cancels in-flight refetches first, so one cannot land on top of the guess", async () => {
    const qc = clientWith([[["tickets"], []]]);
    const cancel = vi.spyOn(qc, "cancelQueries");
    await applyOptimistic<Row[]>(qc, [{ key: ["tickets"], update: (rows) => rows }]);
    expect(cancel).toHaveBeenCalledWith({ queryKey: ["tickets"] });
  });
});

describe("rollbackOptimistic", () => {
  it("restores every touched entry exactly, including ones patched to the same shape", async () => {
    const before = [{ id: "a", status: "OPEN" }];
    const qc = clientWith([[["tickets", 1], before]]);

    const ctx = await applyOptimistic<Row[]>(qc, [
      { key: ["tickets"], update: (rows) => replaceById(rows, "a", { status: "CLOSED" }) }
    ]);
    expect(qc.getQueryData(["tickets", 1])).toEqual([{ id: "a", status: "CLOSED" }]);

    rollbackOptimistic(qc, ctx);
    expect(qc.getQueryData(["tickets", 1])).toEqual(before);
  });

  it("is safe with no context — a mutation that failed before it patched anything", () => {
    const qc = clientWith([[["tickets"], []]]);
    expect(() => rollbackOptimistic(qc, undefined)).not.toThrow();
  });
});

describe("settleOptimistic", () => {
  it("invalidates every key it is given, so the server has the last word", () => {
    const qc = clientWith([[["tickets"], []]]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    settleOptimistic(qc, [["tickets"], ["ticket", "t1"]]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tickets"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ticket", "t1"] });
  });
});

describe("replaceById", () => {
  it("replaces one row and leaves the others untouched by identity", () => {
    const rows = [
      { id: "a", status: "OPEN" },
      { id: "b", status: "OPEN" }
    ];
    const next = replaceById(rows, "b", { status: "CLOSED" });
    expect(next).not.toBe(rows);
    expect(next[0]).toBe(rows[0]);
    expect(next[1]).toEqual({ id: "b", status: "CLOSED" });
  });

  it("returns the very same array when the id is absent", () => {
    const rows = [{ id: "a", status: "OPEN" }];
    expect(replaceById(rows, "zzz", { status: "CLOSED" })).toBe(rows);
  });
});

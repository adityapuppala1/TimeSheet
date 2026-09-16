import { describe, expect, it } from "vitest";
import {
  SPLIT_MIN_SHEET_WIDTH,
  canSplit,
  readActivityHidden,
  ticketSheetLayout,
  writeActivityHidden
} from "../../src/lib/ticket-sheet-layout";

const wide = { resizable: true, width: 576, maximized: true, viewportWidth: 1366 };

describe("ticketSheetLayout", () => {
  it("is stacked on a phone regardless of anything else", () => {
    expect(ticketSheetLayout({ resizable: false, width: 2000, maximized: true, activityHidden: false, viewportWidth: 390 })).toBe("stacked");
  });
  it("is stacked at the default 576px width — nothing changes for today's users", () => {
    expect(ticketSheetLayout({ resizable: true, width: 576, maximized: false, activityHidden: false, viewportWidth: 1366 })).toBe("stacked");
  });
  it("splits once the dragged width reaches the threshold", () => {
    expect(ticketSheetLayout({ resizable: true, width: SPLIT_MIN_SHEET_WIDTH, maximized: false, activityHidden: false, viewportWidth: 1366 })).toBe("split");
    expect(ticketSheetLayout({ resizable: true, width: SPLIT_MIN_SHEET_WIDTH - 1, maximized: false, activityHidden: false, viewportWidth: 1366 })).toBe("stacked");
  });
  it("maximized resolves to the viewport, not the remembered width", () => {
    expect(ticketSheetLayout({ ...wide, activityHidden: false })).toBe("split");
    expect(canSplit({ resizable: true, width: 576, maximized: true, viewportWidth: 900 })).toBe(false);
  });
  it("a closed activity column gives focus only where a split was possible", () => {
    expect(ticketSheetLayout({ ...wide, activityHidden: true })).toBe("focus");
    expect(ticketSheetLayout({ resizable: true, width: 576, maximized: false, activityHidden: true, viewportWidth: 1366 })).toBe("stacked");
  });
});

describe("activity preference storage", () => {
  it("round-trips through storage and tolerates a throwing store", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      }
    };
    expect(readActivityHidden(storage)).toBe(false);
    writeActivityHidden(storage, true);
    expect(readActivityHidden(storage)).toBe(true);
    writeActivityHidden(storage, false);
    expect(readActivityHidden(storage)).toBe(false);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readActivityHidden(broken)).toBe(false);
    expect(() => writeActivityHidden(broken, true)).not.toThrow();
    expect(readActivityHidden(undefined)).toBe(false);
  });
});

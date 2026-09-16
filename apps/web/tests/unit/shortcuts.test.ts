/**
 * The shortcut table is only worth having if the matcher says exactly what the "?" dialog says.
 * These pin the rules a person feels: a letter is a letter while typing; Ctrl+N is not "n"
 * (the browser owns it anyway); "g" then "t" within a second goes to Tickets, and a stray key or
 * the timeout forgets the "g"; nobody is offered a shortcut to a page their role cannot open.
 */
import { describe, expect, it } from "vitest";
import { permissions } from "@timesheet/shared";
import {
  comboForRoute,
  createSequenceMatcher,
  formatCombo,
  globalShortcuts,
  isEditableTarget,
  matchesCombo,
  SHORTCUTS,
  shortcutsForRoute,
  visibleShortcuts
} from "../../src/lib/shortcuts";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
});

describe("matchesCombo", () => {
  it("mod+k accepts Ctrl or ⌘, and refuses a bare k", () => {
    expect(matchesCombo(key("k", { ctrlKey: true }), "mod+k")).toBe(true);
    expect(matchesCombo(key("K", { metaKey: true }), "mod+k")).toBe(true);
    expect(matchesCombo(key("k"), "mod+k")).toBe(false);
  });

  it("a bare letter refuses the browser's Ctrl chord — Ctrl+N is a new window, never 'n'", () => {
    expect(matchesCombo(key("n"), "n")).toBe(true);
    expect(matchesCombo(key("N"), "n")).toBe(true); // Caps Lock does not disable the app
    expect(matchesCombo(key("n", { ctrlKey: true }), "n")).toBe(false);
    expect(matchesCombo(key("n", { altKey: true }), "n")).toBe(false);
  });

  it("'?' matches even though it arrives with Shift held", () => {
    expect(matchesCombo(key("?", { shiftKey: true }), "?")).toBe(true);
    expect(matchesCombo(key("/", { shiftKey: true }), "?")).toBe(false);
  });

  it("never matches a sequence as a chord", () => {
    expect(matchesCombo(key("g"), "g t")).toBe(false);
  });
});

describe("isEditableTarget", () => {
  const el = (html: string) => {
    document.body.innerHTML = html;
    return document.body.firstElementChild!;
  };
  it("is true for fields, editors, comboboxes and anything inside an open dialog or the palette", () => {
    expect(isEditableTarget(el("<input>"))).toBe(true);
    expect(isEditableTarget(el("<textarea></textarea>"))).toBe(true);
    expect(isEditableTarget(el("<select></select>"))).toBe(true);
    expect(isEditableTarget(el('<div role="textbox"></div>'))).toBe(true);
    expect(isEditableTarget(el('<div role="dialog"><button id="b">x</button></div>').querySelector("#b"))).toBe(true);
    expect(isEditableTarget(el('<div cmdk-root=""><span id="s">x</span></div>').querySelector("#s"))).toBe(true);
  });
  it("is false for the page body and plain elements, and for a null target", () => {
    expect(isEditableTarget(el("<div><a href='#' id='a'>x</a></div>").querySelector("#a"))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("sequences", () => {
  it("'g' then 't' within the window goes to Tickets", () => {
    let t = 0;
    const m = createSequenceMatcher(SHORTCUTS, 1000, () => t);
    expect(m.feed(key("g"))).toBeNull();
    expect(m.isPending()).toBe(true);
    t = 500;
    expect(m.feed(key("t"))?.id).toBe("go-tickets");
    expect(m.isPending()).toBe(false);
  });

  it("forgets the 'g' after the window, or after any other key", () => {
    let t = 0;
    const m = createSequenceMatcher(SHORTCUTS, 1000, () => t);
    m.feed(key("g"));
    t = 1500;
    expect(m.feed(key("t"))).toBeNull();
    t = 2000;
    m.feed(key("g"));
    m.feed(key("x"));
    expect(m.feed(key("t"))).toBeNull();
  });

  it("a modifier clears the sequence — Ctrl+G then T is not 'g t'", () => {
    const m = createSequenceMatcher(SHORTCUTS, 1000, () => 0);
    m.feed(key("g", { ctrlKey: true }));
    expect(m.feed(key("t"))).toBeNull();
  });
});

describe("visibility and display", () => {
  it("hides a shortcut whose route the person cannot open", () => {
    const employee = { permissions: [permissions.TIMESHEETS_WRITE] };
    const ids = visibleShortcuts(employee).map((d) => d.id);
    expect(ids).toContain("new-timesheet");
    expect(ids).not.toContain("go-tickets");
    expect(ids).not.toContain("new-ticket");
    expect(ids).toContain("palette");
  });

  it("formats for the platform, and reads sequences aloud", () => {
    expect(formatCombo("mod+k", true)).toBe("⌘ K");
    expect(formatCombo("mod+k", false)).toBe("Ctrl K");
    expect(formatCombo("g t")).toBe("G then T");
    expect(formatCombo("?")).toBe("?");
  });

  it("knows which sequence opens a route, so the palette prints the same key the dialog does", () => {
    expect(comboForRoute("/app/tickets")).toBe("g t");
    expect(comboForRoute("/app/settings")).toBeUndefined();
  });

  it("keeps scoped rows out of the global listener and shows them only on their route", () => {
    expect(globalShortcuts(SHORTCUTS).some((d) => d.scope)).toBe(false);
    expect(shortcutsForRoute("/app/tickets", SHORTCUTS).map((d) => d.id)).not.toContain("inbox-next");
    expect(shortcutsForRoute("/app/inbox", SHORTCUTS).map((d) => d.id)).toContain("inbox-next");
    expect(shortcutsForRoute("/app/inbox/anything", SHORTCUTS).map((d) => d.id)).toContain("inbox-next");
    // "/app/inboxes" is not "/app/inbox" — a prefix match must respect the path boundary.
    expect(shortcutsForRoute("/app/inboxes", SHORTCUTS).map((d) => d.id)).not.toContain("inbox-next");
  });

  it("gives no two rows on one route the same chord", () => {
    const onInbox = shortcutsForRoute("/app/inbox", SHORTCUTS).filter((d) => !d.combo.includes(" ")).map((d) => d.combo);
    expect(new Set(onInbox).size).toBe(onInbox.length);
  });

  it("advertises nothing the browser reserves", () => {
    for (const d of SHORTCUTS) expect(d.combo).not.toMatch(/^mod\+(n|t|w)$/);
  });
});

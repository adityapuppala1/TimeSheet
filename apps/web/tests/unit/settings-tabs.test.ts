/**
 * Two different things are checked here, and the second is the one that will actually catch a bug
 * six months from now.
 *
 * 1. `initialSettingsTab` resolves the right tab. It reads a query string that arrives from an
 *    email or from Stripe, so the interesting cases are the malformed ones, not the happy path.
 * 2. `SETTINGS_TABS` still matches the tabs the page really renders. The set is a hand-written copy
 *    of the `TabsTrigger` values in WorkspaceSettings.tsx, and a hand-written copy of a list is
 *    exactly the drift this repo keeps getting bitten by — so the test reads the page's source and
 *    compares, rather than trusting that whoever adds tab twenty-one also edits this set.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_TABS, initialSettingsTab } from "../../src/utils/settings-tabs";

const at = (search: string) => initialSettingsTab(new URLSearchParams(search));

/* Same lazy `read` helper the sibling pitch-export guard uses, at module scope for the same reason:
   `fileURLToPath(new URL(rel, import.meta.url))` and never a string edit on the href, because
   stripping "file:///" yields "C:/x" on Windows and "home/runner/x" on Linux, where the leading
   slash IS the root. That bug once made this repo's strictest tests silently absent from CI. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The tab values WorkspaceSettings.tsx actually renders, read out of its source. */
const renderedTabs = () =>
  new Set([...read("../../src/pages/WorkspaceSettings.tsx").matchAll(/<TabsTrigger value="([a-z0-9-]+)"/g)].map((m) => m[1]));

describe("initialSettingsTab — ?tab=", () => {
  it("opens the tab an email named", () => {
    // This is the exact link every billing email has carried for months.
    expect(at("?tab=billing")).toBe("billing");
  });

  it("handles a hyphenated tab, which most of them are", () => {
    expect(at("?tab=security-devops")).toBe("security-devops");
    expect(at("?tab=face-verification")).toBe("face-verification");
  });

  it("keeps working when the tab is not the first parameter", () => {
    expect(at("?from=email&tab=sso&utm_source=digest")).toBe("sso");
  });
});

describe("initialSettingsTab — ?billing=, which is Stripe's redirect", () => {
  it("opens Billing after a completed checkout", () => {
    expect(at("?billing=success")).toBe("billing");
  });

  it("opens Billing after a cancelled one too — the customer still came here to see the plan", () => {
    expect(at("?billing=cancelled")).toBe("billing");
  });

  it("loses to an explicit ?tab=, which is the more specific instruction", () => {
    expect(at("?tab=storage&billing=success")).toBe("storage");
  });
});

describe("initialSettingsTab — what it refuses", () => {
  it("falls back to the default with no query string at all", () => {
    expect(at("")).toBe("reminders");
  });

  it("ignores a tab that does not exist rather than rendering an empty page", () => {
    // Radix renders NO panel for a value with no trigger. Honouring this would show a settings page
    // with nothing on it, which is worse than quietly showing the default.
    expect(at("?tab=nonsense")).toBe("reminders");
  });

  it("ignores a tab that is nearly right", () => {
    expect(at("?tab=Billing")).toBe("reminders");
    expect(at("?tab=billing ")).toBe("reminders");
    expect(at("?tab=security_devops")).toBe("reminders");
  });

  it("ignores an empty tab parameter", () => {
    expect(at("?tab=")).toBe("reminders");
  });

  it("does not treat an unrelated parameter as a billing return", () => {
    expect(at("?billed=success")).toBe("reminders");
  });
});

describe("SETTINGS_TABS stays in step with the page", () => {
  it("found the triggers at all — the regex is the weak point of this guard", () => {
    expect(renderedTabs().size).toBeGreaterThan(15);
  });

  it("knows about every tab the page renders", () => {
    const missing = [...renderedTabs()].filter((value) => !SETTINGS_TABS.has(value));
    expect(missing, `WorkspaceSettings.tsx renders these tabs but settings-tabs.ts does not list them: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not list a tab the page no longer renders", () => {
    const rendered = renderedTabs();
    const stale = [...SETTINGS_TABS].filter((value) => !rendered.has(value));
    expect(stale, `settings-tabs.ts lists these tabs but WorkspaceSettings.tsx no longer renders them: ${stale.join(", ")}`).toEqual([]);
  });

  it("still contains the default, or the page opens onto nothing", () => {
    expect(SETTINGS_TABS.has("reminders")).toBe(true);
    expect(renderedTabs().has("reminders")).toBe(true);
  });
});

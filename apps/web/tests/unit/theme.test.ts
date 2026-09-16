import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  adoptSavedAppearance,
  applyAccent,
  applyMode,
  applyTheme,
  currentAccent,
  currentMode,
  currentTheme,
  initializeTheme,
  resolveInitialTheme,
  subscribeTheme,
  toggleTheme
} from "../../src/lib/theme";
import { ACCENT_PALETTES } from "@timesheet/shared";
import { AnimatedThemeToggler } from "../../src/components/ui/animated-theme-toggler";

const key = "timesheet:theme";
let dark = false;
let media: EventTarget;
let cleanup: (() => void) | undefined;
let root: Root | undefined;

function changeSystem(next: boolean) {
  dark = next;
  media.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  dark = false;
  media = new EventTarget();
  Object.defineProperty(media, "matches", { get: () => dark });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("theme preference lifecycle", () => {
  it("follows the OS across changes and reload initialization without saving a choice", () => {
    dark = true;
    cleanup = initializeTheme();
    expect(currentTheme()).toBe("dark");
    expect(localStorage.getItem(key)).toBeNull();
    changeSystem(false);
    expect(currentTheme()).toBe("light");
    cleanup();
    dark = true;
    cleanup = initializeTheme();
    expect(currentTheme()).toBe("dark");
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("preserves legacy explicit choices when the OS changes", () => {
    localStorage.setItem(key, "light");
    cleanup = initializeTheme();
    changeSystem(true);
    expect(currentTheme()).toBe("light");
    expect(toggleTheme()).toBe("dark");
    expect(localStorage.getItem(key)).toBe("dark");
    changeSystem(false);
    expect(currentTheme()).toBe("dark");
  });

  it("falls back to the OS for malformed preferences", () => {
    localStorage.setItem(key, "not-a-theme");
    dark = true;
    expect(resolveInitialTheme()).toBe("dark");
    cleanup = initializeTheme();
    expect(currentTheme()).toBe("dark");
  });

  it("still renders and respects an in-session choice when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    dark = true;
    expect(resolveInitialTheme()).toBe("dark");
    cleanup = initializeTheme();
    applyTheme("light");
    changeSystem(true);
    expect(currentTheme()).toBe("light");
  });

  it("syncs another tab's choice and resumes OS following when that choice is removed", () => {
    cleanup = initializeTheme();
    localStorage.setItem(key, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
    expect(currentTheme()).toBe("dark");
    localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
    expect(currentTheme()).toBe("light");
    changeSystem(true);
    expect(currentTheme()).toBe("dark");
  });

  it("ignores unrelated storage events and removes listeners on cleanup", () => {
    cleanup = initializeTheme();
    localStorage.setItem(key, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", storageArea: localStorage }));
    expect(currentTheme()).toBe("light");
    window.dispatchEvent(new StorageEvent("storage", { key, storageArea: sessionStorage }));
    expect(currentTheme()).toBe("light");
    cleanup();
    changeSystem(true);
    window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
    expect(currentTheme()).toBe("light");
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);
    applyTheme("dark");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    applyTheme("light");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps the real toggle label synchronized with palette and OS changes", () => {
    cleanup = initializeTheme();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(createElement(AnimatedThemeToggler)));
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Switch to dark mode");
    act(() => changeSystem(true));
    expect(button.getAttribute("aria-label")).toBe("Switch to light mode");
    act(() => { toggleTheme(); });
    expect(button.getAttribute("aria-label")).toBe("Switch to dark mode");
    act(() => button.click());
    expect(currentTheme()).toBe("dark");
    expect(button.getAttribute("aria-label")).toBe("Switch to light mode");
  });
});

/** The primary hue actually painted on the root, as index.css would read it. */
const paintedPrimary = () => document.documentElement.style.getPropertyValue("--primary").trim();
const paintedForeground = () => document.documentElement.style.getPropertyValue("--primary-foreground").trim();

describe("the three-way mode", () => {
  it("renders 'system' as following the OS and stores NOTHING for it", () => {
    cleanup = initializeTheme();
    applyTheme("dark");
    expect(localStorage.getItem(key)).toBe("dark");

    applyMode("system");
    // Not stored as the string "system": following the OS must never be a persisted value, or a
    // reload has one more thing to get wrong. The previous unit's whole point.
    expect(localStorage.getItem(key)).toBeNull();
    expect(currentMode()).toBe("system");
    expect(currentTheme()).toBe("light");

    changeSystem(true);
    expect(currentTheme()).toBe("dark");
  });

  it("reports a saved light/dark as itself and a fresh install as system", () => {
    cleanup = initializeTheme();
    expect(currentMode()).toBe("system");
    applyMode("dark");
    expect(currentMode()).toBe("dark");
    expect(localStorage.getItem(key)).toBe("dark");
  });
});

describe("accents", () => {
  it("defaults to the brand teal, painted with the EXACT existing values", () => {
    cleanup = initializeTheme();
    // "Never chose" must be pixel-identical to before this feature existed — index.css's own
    // light primary — or the deploy that adds accents changes everyone's screen.
    expect(currentAccent()).toBe("teal");
    expect(paintedPrimary()).toBe("186 82% 32%");
  });

  it("repaints under the CURRENT theme, and again when the theme flips", () => {
    cleanup = initializeTheme();
    applyAccent("indigo");
    expect(paintedPrimary()).toBe(ACCENT_PALETTES.indigo.light.primary);
    expect(paintedForeground()).toBe("0 0% 100%");

    // The measured fact behind the whole design: no hue passes AA as white-on-fill in dark mode,
    // so the accent has to re-apply per theme with a DARK foreground. A flip that left the light
    // primary in place would be the bug.
    applyTheme("dark");
    expect(paintedPrimary()).toBe(ACCENT_PALETTES.indigo.dark.primary);
    expect(paintedForeground()).toBe("224 38% 8%");
    expect(document.documentElement.dataset.accent).toBe("indigo");
  });

  it("persists the accent and restores it on boot", () => {
    cleanup = initializeTheme();
    applyAccent("rose");
    cleanup();
    document.documentElement.className = "";

    cleanup = initializeTheme();
    expect(currentAccent()).toBe("rose");
    expect(paintedPrimary()).toBe(ACCENT_PALETTES.rose.light.primary);
  });

  it("falls back to teal for a stored id the renderer does not know", () => {
    localStorage.setItem("timesheet:accent", "retired-palette");
    cleanup = initializeTheme();
    expect(currentAccent()).toBe("teal");
  });

  it("still paints when storage is blocked", () => {
    cleanup = initializeTheme();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => applyAccent("sky")).not.toThrow();
    expect(paintedPrimary()).toBe(ACCENT_PALETTES.sky.light.primary);
  });

  it("notifies subscribers, so the Profile swatches and the Topbar agree", () => {
    cleanup = initializeTheme();
    const seen: string[] = [];
    const unsubscribe = subscribeTheme(() => seen.push(currentAccent()));
    applyAccent("amber");
    unsubscribe();
    applyAccent("emerald");
    expect(seen).toEqual(["amber"]);
  });
});

describe("a saved profile preference, adopted on sign-in", () => {
  it("wins over this browser's leftover state", () => {
    // localStorage is where a previous session on this machine — possibly somebody else's —
    // left its footprint. The profile is what THIS person chose, on purpose.
    localStorage.setItem(key, "light");
    localStorage.setItem("timesheet:accent", "sky");
    cleanup = initializeTheme();

    adoptSavedAppearance({ mode: "dark", accent: "violet" });
    expect(currentTheme()).toBe("dark");
    expect(currentAccent()).toBe("violet");
    expect(paintedPrimary()).toBe(ACCENT_PALETTES.violet.dark.primary);
  });

  it("changes nothing for a profile with nothing saved", () => {
    // The deploy that introduces this must not move anyone's screen.
    applyTheme("dark");
    cleanup = initializeTheme();
    applyAccent("rose");
    adoptSavedAppearance(null);
    adoptSavedAppearance({});
    expect(currentTheme()).toBe("dark");
    expect(currentAccent()).toBe("rose");
  });

  it("adopts a saved 'system' by clearing the explicit choice", () => {
    localStorage.setItem(key, "dark");
    cleanup = initializeTheme();
    expect(currentMode()).toBe("dark");
    adoptSavedAppearance({ mode: "system" });
    expect(currentMode()).toBe("system");
    expect(localStorage.getItem(key)).toBeNull();
  });
});

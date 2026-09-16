import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyTheme, currentTheme, initializeTheme, resolveInitialTheme, subscribeTheme, toggleTheme } from "../../src/lib/theme";
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

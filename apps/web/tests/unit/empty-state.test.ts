/**
 * The primitive every empty list now renders. Pins the two things a caller relies on: what it
 * shows for what it is given, and that it never renders an action wrapper for nothing — a hollow
 * CTA slot would be a visible gap under every honest "there is nothing here".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EmptyState } from "../../src/components/ui/empty-state";

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function render(node: ReactElement) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

describe("EmptyState", () => {
  it("renders the title, the description and the action, as a status region", () => {
    const host = render(createElement(EmptyState, { title: "No tickets yet", description: "Raise the first one.", action: createElement("button", null, "New ticket") }));
    const region = host.querySelector('[role="status"]')!;
    expect(region.textContent).toContain("No tickets yet");
    expect(region.textContent).toContain("Raise the first one.");
    expect(region.querySelector("button")?.textContent).toBe("New ticket");
  });

  it("omits the description and the action wrapper when neither is given", () => {
    const host = render(createElement(EmptyState, { title: "Nothing here" }));
    const region = host.querySelector('[role="status"]')!;
    expect(region.querySelectorAll("p")).toHaveLength(1);
    expect(region.querySelector("div")).toBeNull();
  });

  it("is smaller in compact mode, for use inside a card or table", () => {
    const a = render(createElement(EmptyState, { title: "x" })).querySelector('[role="status"]')!.className;
    document.body.innerHTML = "";
    const b = render(createElement(EmptyState, { title: "x", compact: true })).querySelector('[role="status"]')!.className;
    expect(a).toContain("py-10");
    expect(b).toContain("py-6");
  });
});

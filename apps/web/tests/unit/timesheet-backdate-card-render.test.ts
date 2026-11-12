/**
 * The Timesheet back-dating card, as an admin uses it: switch the limit off for "no limit", pick a
 * preset, type something invalid, press Save. The pure helpers are covered in
 * timesheet-backdate-card.test.ts; this proves they are wired to the controls — in particular that
 * "no limit" saves NULL and not 0, and that a half-typed box cannot be saved at all.
 *
 * Rendered with react-dom directly (there is no component-testing library in this workspace).
 */
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimesheetBackdateCard } from "../../src/pages/settings/TimesheetBackdateCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const onSave = vi.fn();

const refetch = vi.fn();

/** Renders the card over a query in the given state: a stored value (or none), loading, or failed. */
function render(opts: { value?: number | null; loading?: boolean; failed?: boolean; readOnly?: boolean } = {}) {
  const { value = 7, loading = false, failed = false, readOnly = false } = opts;
  const settings: ComponentProps<typeof TimesheetBackdateCard>["settings"] = {
    data: failed || loading ? undefined : { timesheetBackdateDays: value },
    isLoading: loading,
    isError: failed,
    refetch
  };
  act(() => {
    root.render(createElement(TimesheetBackdateCard, { settings, readOnly, saving: false, onSave }));
  });
}

const byText = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const saveButton = () => byText("Save back-dating");
const daysInput = () => host.querySelector("#backdate-days") as HTMLInputElement | null;
const limitSwitch = () => host.querySelector("#backdate-limited") as HTMLButtonElement;

/** React tracks the input's value itself, so a plain `.value =` is invisible to it. */
function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  onSave.mockReset();
  refetch.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("TimesheetBackdateCard", () => {
  it("opens on the stored window, with Save disabled until something changes", () => {
    render({ value: 7 });
    expect(daysInput()?.value).toBe("7");
    expect(saveButton()?.disabled).toBe(true);
  });

  it("saves a preset's number of days", () => {
    render({ value: 7 });
    act(() => byText("30 days")!.click());
    expect(daysInput()?.value).toBe("30");
    expect(saveButton()?.disabled).toBe(false);
    act(() => saveButton()!.click());
    expect(onSave).toHaveBeenCalledWith(30);
  });

  it("saves NULL — not 0 — when the limit is switched off", () => {
    render({ value: 7 });
    act(() => limitSwitch().click());
    expect(daysInput()).toBeNull(); // the number is only offered while a limit is on
    act(() => saveButton()!.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toBeNull();
  });

  it("saves 0 for Today only, which is a real window and not 'no limit'", () => {
    render({ value: 7 });
    act(() => byText("Today only")!.click());
    act(() => saveButton()!.click());
    expect(onSave.mock.calls[0][0]).toBe(0);
  });

  it("cannot save an empty or out-of-range number, and says why", () => {
    render({ value: 7 });
    type(daysInput()!, "");
    expect(saveButton()?.disabled).toBe(true);
    expect(host.textContent).toContain("Enter a whole number of days from 0 to 365");
    type(daysInput()!, "400");
    expect(saveButton()?.disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a workspace that has no limit as switched off, and offers no number", () => {
    render({ value: null });
    expect(limitSwitch().getAttribute("aria-checked")).toBe("false");
    expect(daysInput()).toBeNull();
    expect(host.textContent).toContain("Anyone can log for any past date");
  });

  it("is read-only for someone who cannot edit it: no Save, and the controls are disabled", () => {
    render({ value: 7, readOnly: true });
    expect(saveButton()).toBeUndefined();
    expect(daysInput()?.disabled).toBe(true);
    expect(limitSwitch().disabled).toBe(true);
  });

  it("shows a skeleton, not a stale number, while the setting is loading", () => {
    render({ loading: true });
    expect(daysInput()).toBeNull();
    expect(saveButton()).toBeUndefined();
  });

  it("shows a load error with Retry instead of the form when the settings could not be loaded", () => {
    render({ failed: true });
    expect(host.textContent).toContain("couldn't be loaded");
    expect(daysInput()).toBeNull();
    act(() => byText("Retry")!.click());
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

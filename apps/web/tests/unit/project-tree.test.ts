/**
 * The sidebar tree writes these parameters and the Tickets page reads them; both import the same
 * two constants, so the only thing left to pin is the round trip and the one rule that is not
 * obvious — a module is meaningless without its project.
 */
import { describe, expect, it } from "vitest";
import { MODULE_PARAM, PROJECT_PARAM, readProjectSelection, ticketsHref, withoutProjectSelection } from "../../src/lib/project-tree";

describe("ticketsHref ↔ readProjectSelection", () => {
  it("round-trips a project alone", () => {
    const href = ticketsHref("p-1");
    expect(href).toBe(`/app/tickets?${PROJECT_PARAM}=p-1`);
    expect(readProjectSelection(href.slice(href.indexOf("?")))).toEqual({ projectId: "p-1", moduleId: undefined });
  });

  it("round-trips a project and one of its modules", () => {
    const href = ticketsHref("p-1", "m-9");
    expect(readProjectSelection(new URL(href, "https://x.test").searchParams)).toEqual({ projectId: "p-1", moduleId: "m-9" });
  });

  it("ignores a module that arrives without a project — the select could never show it", () => {
    expect(readProjectSelection(`?${MODULE_PARAM}=m-9`)).toEqual({ projectId: undefined, moduleId: undefined });
  });

  it("reads nothing from an unrelated query string", () => {
    expect(readProjectSelection("?open=t-1")).toEqual({ projectId: undefined, moduleId: undefined });
  });
});

describe("withoutProjectSelection", () => {
  it("strips exactly the two keys and keeps the rest — `?open=` must survive a filter change", () => {
    const next = withoutProjectSelection(new URLSearchParams(`?open=t-1&${PROJECT_PARAM}=p-1&${MODULE_PARAM}=m-1`));
    expect(next.toString()).toBe("open=t-1");
  });

  it("does not mutate its input", () => {
    const input = new URLSearchParams(`${PROJECT_PARAM}=p-1`);
    withoutProjectSelection(input);
    expect(input.get(PROJECT_PARAM)).toBe("p-1");
  });
});

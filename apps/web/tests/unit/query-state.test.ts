/**
 * The shared loading / error / empty wrapper for analytics surfaces. What it must never do is the bug
 * it replaces: render a failed request as a zero, an empty card, or "nothing assigned to you".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryState, queryPhase } from "../../src/components/QueryState";

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

const query = <T,>(over: Partial<{ data: T; isLoading: boolean; isError: boolean }>) => ({
  data: undefined as T | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  ...over
});

describe("queryPhase", () => {
  it("calls a failed request with nothing to show an error, never ready", () => {
    expect(queryPhase(query({ isError: true }))).toBe("error");
  });

  it("keeps earlier data on a failed refetch, and says it is stale", () => {
    expect(queryPhase(query({ isError: true, data: { n: 1 } }))).toBe("stale");
  });

  it("is loading until data or an error arrives", () => {
    expect(queryPhase(query({ isLoading: true }))).toBe("loading");
  });

  it("asks the caller what empty means", () => {
    expect(queryPhase(query({ data: [] as number[] }), (d) => d.length === 0)).toBe("empty");
    expect(queryPhase(query({ data: [1] }), (d) => d.length === 0)).toBe("ready");
  });
});

describe("QueryState", () => {
  it("renders a dash and a Retry that refetches — not the children, not a zero", () => {
    const q = query<{ total: number }>({ isError: true });
    const host = render(
      createElement(QueryState<{ total: number }>, { query: q, what: "the summary", children: (d) => createElement("p", null, `Total ${d.total}`) })
    );
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("—");
    expect(alert.textContent).toContain("Couldn't load the summary");
    expect(host.textContent).not.toContain("Total");
    act(() => (alert.querySelector("button") as HTMLButtonElement).click());
    expect(q.refetch).toHaveBeenCalledTimes(1);
  });

  it("renders the caller's empty state only when the data really is empty", () => {
    const host = render(
      createElement(QueryState<number[]>, {
        query: query({ data: [] }),
        what: "your queue",
        isEmpty: (d) => d.length === 0,
        empty: createElement("p", null, "Nothing assigned"),
        children: () => createElement("p", null, "rows")
      })
    );
    expect(host.textContent).toBe("Nothing assigned");
  });

  it("shows the data with a stale note when a refetch failed", () => {
    const host = render(
      createElement(QueryState<{ total: number }>, {
        query: query({ data: { total: 7 }, isError: true }),
        what: "the summary",
        children: (d) => createElement("p", null, `Total ${d.total}`)
      })
    );
    expect(host.textContent).toContain("Total 7");
    expect(host.textContent).toContain("Couldn't refresh the summary");
  });
});

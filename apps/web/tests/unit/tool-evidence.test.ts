import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolEvidence } from "../../src/components/ai/tool-evidence";

function render(calls: Array<{ tool: string; detail: string }>) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(ToolEvidence, { calls }));
  return host;
}

describe("tool evidence", () => {
  it("states when no calls were recorded without an empty disclosure", () => {
    const host = render([]);
    expect(host.textContent).toBe("No tool calls recorded.");
    expect(host.querySelector("details")).toBeNull();
  });

  it("keeps repeated calls ordered and explains missing arguments", () => {
    const host = render([{ tool: "tickets", detail: "first" }, { tool: "tickets", detail: "" }]);
    expect(host.querySelector("summary")?.textContent).toBe("Tool evidence (2)");
    expect([...host.querySelectorAll("pre")].map((node) => node.textContent)).toEqual(["first", "Arguments not recorded."]);
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(host.textContent).toContain("does not confirm success or source freshness");
  });

  it("renders model-authored arguments as text, never as source links or markup", () => {
    const detail = '<a href="https://example.com">source</a><script>alert(1)</script>';
    const host = render([{ tool: "<img src=x>", detail }]);
    expect(host.querySelector("pre")?.textContent).toBe(detail);
    expect(host.querySelectorAll("a, script, img")).toHaveLength(0);
  });
});

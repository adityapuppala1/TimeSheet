/**
 * WHAT: renders Mermaid SOURCE TEXT as an inline SVG diagram, falling back to the raw source in a
 * `<pre>` when the model produced something Mermaid cannot parse.
 *
 * WHY IT LIVES IN ui/ RATHER THAN ON ONE PAGE: two surfaces render model-authored diagrams — the
 * generated PRD/BRD's architecture section, and any ```mermaid fence in an AI answer (ai-markdown).
 * One copy means one place where the initialisation options are correct, which matters more than
 * it sounds: see `htmlLabels` below.
 */
import mermaid from "mermaid";
import { useEffect, useId, useState } from "react";
import { Skeleton } from "./skeleton";

// suppressErrorRendering: without it, a parse failure makes mermaid append its own "bomb" error
// graphic straight to document.body — outside the React tree — IN ADDITION to rejecting the
// render() promise, so the fallback below rendered correctly while a stray graphic stayed stuck on
// the page with nothing to clean it up.
//
// flowchart.htmlLabels: false is load-bearing for PDF export, not a style choice. Mermaid's default
// puts node labels inside <foreignObject>, which <canvas> refuses to rasterise — so the diagram
// exported to PDF came out blank or label-less. Plain <text> nodes rasterise correctly.
mermaid.initialize({
  startOnLoad: false,
  theme: "neutral",
  securityLevel: "strict",
  suppressErrorRendering: true,
  flowchart: { htmlLabels: false }
});

/** Renders `source` to SVG, or null when Mermaid rejects it. Shared with the PDF export path so
 *  both rasterise from an identically-configured Mermaid. */
export async function renderMermaidSvg(source: string, id: string): Promise<string | null> {
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } catch {
    return null;
  }
}

export function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/:/g, "-");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!source.trim()) return;
    setSvg(null);
    setFailed(false);
    renderMermaidSvg(source, `mermaid-${id}`).then((rendered) => {
      if (cancelled) return;
      if (rendered) setSvg(rendered);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [source, id]);

  if (!source.trim()) return <p className="text-sm text-muted-foreground">No diagram generated.</p>;
  // A diagram the model wrote incorrectly still shows its source — hiding it would hide that the
  // model tried, and the source is often readable enough to still be useful.
  if (failed) return <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{source}</pre>;
  if (!svg) return <Skeleton className="h-40 w-full" />;
  // Mermaid's OWN rendered SVG, not user/model HTML — `securityLevel: "strict"` above is what
  // guards this, the same role safeHtml() plays for every other model-authored surface.
  //
  // The size rules are not decoration. Mermaid emits `width: 100%` with a viewBox, so the SVG
  // stretches to the container and its height scales with it — a three-node flowchart rendered a
  // single box the full width of the page and pushed everything else off screen. Capping the
  // height and letting the width follow keeps a diagram diagram-sized whatever its shape.
  return (
    <div
      className="overflow-auto rounded-md border border-border bg-white p-3 [&_svg]:mx-auto [&_svg]:!h-auto [&_svg]:max-h-[420px] [&_svg]:!w-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * The authority ladder, drawn rather than described: every AI capability resolves to one of
 * three rungs, and a run that reads text from outside the workspace drops to Propose for the
 * rest of its life regardless of configuration.
 *
 * WHY an inline SVG and not a screenshot: this is the one marketing claim that is a *rule*, not
 * a screen — there is no page to photograph. Drawing it in the app's own tokens keeps it honest
 * in both themes (every fill/stroke rides the theme variables, nothing is hardcoded to a mode).
 */
export function AuthorityLadder({ className }: { className?: string }) {
  const steps = [
    { x: 12, y: 168, w: 152, h: 72, label: "Observe", sub: "reads and reports" },
    { x: 184, y: 122, w: 152, h: 118, label: "Propose", sub: "reviewable rows, undo" },
    { x: 356, y: 76, w: 152, h: 164, label: "Apply", sub: "same audit ledger" }
  ];
  return (
    <svg
      viewBox="0 0 520 268"
      role="img"
      aria-label="The authority ladder: capabilities resolve to observe, propose or apply — and reading text from outside the workspace drops a run back to propose."
      className={className}
    >
      {steps.map((step) => (
        <g key={step.label}>
          <rect
            x={step.x}
            y={step.y}
            width={step.w}
            height={step.h}
            rx={10}
            className="fill-primary/10 stroke-primary/40"
            strokeWidth="1.5"
          />
          <text x={step.x + step.w / 2} y={step.y + 30} textAnchor="middle" fontSize="15" fontWeight="700" className="fill-foreground">
            {step.label}
          </text>
          <text x={step.x + step.w / 2} y={step.y + 50} textAnchor="middle" fontSize="11" className="fill-muted-foreground">
            {step.sub}
          </text>
        </g>
      ))}
      {/* The drop rule: an arrow from Apply back down to Propose. */}
      <path d="M 432 62 C 432 30, 300 18, 268 100" fill="none" strokeWidth="1.75" strokeDasharray="5 4" className="stroke-warning" />
      <polygon points="268,100 264,86 276,89" className="fill-warning" />
      <text x="250" y="14" textAnchor="middle" fontSize="11" fontWeight="600" className="fill-warning">
        reads text from outside the workspace
      </text>
      <text x="250" y="30" textAnchor="middle" fontSize="11" className="fill-muted-foreground">
        → the rest of the run drops to Propose
      </text>
    </svg>
  );
}

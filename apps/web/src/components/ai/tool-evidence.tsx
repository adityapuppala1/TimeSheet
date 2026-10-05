import type { AiAskExchangeRow } from "../../services/api";
import { Link } from "react-router";

/** Recorded arguments are audit context, not verified record references or successful results. */
export function ToolEvidence({ calls }: { calls: AiAskExchangeRow["toolCalls"] }) {
  if (calls.length === 0) return <p className="text-xs text-muted-foreground">No tool calls recorded.</p>;
  return (
    <details className="min-w-0 text-xs">
      <summary className="focus-ring min-h-[44px] cursor-pointer rounded-md py-3 font-medium text-muted-foreground">
        Tool evidence ({calls.length})
      </summary>
      <p className="mb-2 text-muted-foreground">Recorded arguments may be truncated. A logged call does not confirm success or source freshness.</p>
      <ol className="grid min-w-0 gap-2" aria-label="Recorded tool calls">
        {calls.map((call, index) => (
          <li key={index} className="min-w-0 border-l-2 border-border pl-3">
            <p className="break-all font-mono font-medium">{call.tool}</p>
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-muted-foreground">{call.detail || "Arguments not recorded."}</pre>
            {call.references?.length ? <ul className="mt-2 grid gap-1">
              {call.references.map((reference) => (
                <li key={`${reference.kind}:${reference.id}`}>
                  <Link title={`${reference.key}: ${reference.title}`} className="focus-ring inline-flex min-h-[44px] max-w-full flex-wrap items-center rounded-md text-primary underline underline-offset-2" to={`/app/tickets?open=${encodeURIComponent(reference.id)}`}>
                    Open {reference.key}: <span className="ml-1 wrap-break-word">{reference.title}</span>
                  </Link>
                </li>
              ))}
            </ul> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

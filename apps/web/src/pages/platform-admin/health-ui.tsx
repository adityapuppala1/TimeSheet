/**
 * The two pieces that render account health, shared by every screen that shows it.
 *
 * WHY THEY ARE SHARED RATHER THAN COPIED. The whole design rule of this feature is that a band is
 * never shown without the signal that produced it — an operator who cannot see WHY will not act,
 * and a number nobody acts on is a number nobody maintains. That rule survives exactly as long as
 * there is one component enforcing it. Two copies and the third screen renders a bare pill.
 *
 * So `HealthBandPill` deliberately takes the score as decoration on a band, and `HealthSignals`
 * renders `AccountHealth` whole — there is no prop on either that lets a caller show the conclusion
 * without the evidence.
 */
import { AlertTriangle, CheckCircle2, TrendingUp } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import type { AccountHealth, HealthSignal } from "../../services/platform-admin-api";

const BAND_LABEL: Record<AccountHealth["band"], string> = {
  AT_RISK: "At risk",
  HEALTHY: "Healthy",
  EXPANSION: "Expansion"
};

const BAND_VARIANT: Record<AccountHealth["band"], "destructive" | "success" | "info"> = {
  AT_RISK: "destructive",
  HEALTHY: "success",
  EXPANSION: "info"
};

const BAND_ICON = {
  AT_RISK: AlertTriangle,
  HEALTHY: CheckCircle2,
  EXPANSION: TrendingUp
} as const;

/** The band, with its score as a suffix. The score is never the headline — it is a tiebreaker for
 *  sorting a column, and it is meaningless without the signals beside it. */
export function HealthBandPill({ band, score }: { band: AccountHealth["band"]; score: number }) {
  const Icon = BAND_ICON[band];
  return (
    <Badge variant={BAND_VARIANT[band]} className="gap-1 whitespace-nowrap">
      <Icon className="h-3 w-3" />
      {BAND_LABEL[band]}
      <span className="opacity-70 tabular-nums">{score}</span>
    </Badge>
  );
}

/** One signal as a single line: what it is, and the measured fact behind it. */
export function HealthSignalLine({ signal, className }: { signal: HealthSignal; className?: string }) {
  return (
    <li className={cn("flex min-w-0 items-start gap-2", className)}>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
          signal.direction === "risk" ? "bg-destructive" : signal.direction === "expansion" ? "bg-info" : "bg-muted-foreground/40"
        )}
      />
      <span className="min-w-0">
        <span className="text-sm font-medium text-foreground">{signal.label}</span>
        {/* The detail is the whole reason this component exists. It carries the number. */}
        <span className="block text-xs text-muted-foreground">{signal.detail}</span>
      </span>
    </li>
  );
}

/** Every signal behind a band. Sorted by the server, heaviest first — the order an operator reads
 *  in — and rendered whole, because a truncated reason is a reason nobody trusts. */
export function HealthSignals({ health, className }: { health: AccountHealth; className?: string }) {
  return (
    <ul className={cn("grid min-w-0 gap-2", className)}>
      {health.signals.map((signal) => (
        <HealthSignalLine key={signal.id} signal={signal} />
      ))}
    </ul>
  );
}

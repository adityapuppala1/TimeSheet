/**
 * What trialling and lapsed customers said through the feedback form the retention programme
 * mails — the one place the platform hears WHY somebody did not stay. Ratings and the would-you-
 * come-back split first; every answer, verbatim, underneath. Plain text throughout: these are a
 * stranger's words, and they are shown as words.
 */
import { useQuery } from "@tanstack/react-query";
import { MessageSquareHeart, Star, ThumbsUp, Undo2 } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/utils";
import { platformAdminConsoleApi } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, EmptyState, KpiCard, MARKER_LABEL, OrgStatusPill, shortDateTime } from "./console-ui";

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cn("h-3.5 w-3.5", n <= rating ? "fill-accent text-accent" : "text-muted-foreground/40")} />
      ))}
    </span>
  );
}

export function PlatformAdminFeedback() {
  const feedback = useQuery({ queryKey: ["platform-admin", "feedback"], queryFn: platformAdminConsoleApi.feedback });
  const d = feedback.data;
  const yes = d?.wouldReturn.find((w) => w.answer === "yes")?.count ?? 0;
  const answered = d?.wouldReturn.reduce((s, w) => s + w.count, 0) ?? 0;
  const maxBucket = Math.max(1, ...(d?.distribution.map((x) => x.count) ?? [1]));

  return (
    <ConsolePage eyebrow="Growth" title="Feedback" description="Every answer to the feedback form — sent on day 10 of a trial, and with each reminder after it ends.">
      {feedback.isLoading && <Skeleton className="h-96 w-full" />}
      {d && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <KpiCard label="Responses" value={d.count} icon={MessageSquareHeart} tone="accent" />
            <KpiCard label="Average rating" value={d.avgRating ?? 0} icon={Star} format={(n) => (d.avgRating === null ? "—" : `${n.toFixed(1)} / 5`)} delay={0.05} />
            <KpiCard label="Would come back" value={answered ? Math.round((yes / answered) * 100) : 0} icon={Undo2} tone="success" format={(n) => (answered ? `${Math.round(n)}%` : "—")} hint={answered ? `${yes} of ${answered} who answered` : "nobody has answered yet"} delay={0.1} />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <ConsoleSection title="Ratings">
              <ul className="grid gap-2">
                {[...d.distribution].reverse().map((b) => (
                  <li key={b.rating} className="grid grid-cols-[52px_1fr_32px] items-center gap-2 text-sm">
                    <Stars rating={b.rating} />
                    <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-accent transition-all" style={{ width: `${(b.count / maxBucket) * 100}%` }} />
                    </span>
                    <span className="text-right font-mono tabular-nums text-muted-foreground">{b.count}</span>
                  </li>
                ))}
              </ul>
            </ConsoleSection>
            <ConsoleSection title="Would they come back?" className="lg:col-span-2">
              <div className="grid gap-3 sm:grid-cols-3">
                {d.wouldReturn.map((w) => (
                  <div key={w.answer} className="rounded-lg border border-border p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{w.answer}</p>
                    <p className="text-2xl font-black tabular-nums">{w.count}</p>
                    <p className="text-xs text-muted-foreground">{answered ? `${Math.round((w.count / answered) * 100)}%` : "—"}</p>
                  </div>
                ))}
              </div>
            </ConsoleSection>
          </div>

          <ConsoleSection title="Every response" description="Newest first. Verbatim.">
            {d.rows.length === 0 ? (
              <EmptyState icon={ThumbsUp} title="No feedback yet" description="The first day-10 check-in goes out ten days after a trial starts." />
            ) : (
              <ul className="divide-y divide-border">
                {d.rows.map((r) => (
                  <li key={r.id} className="grid gap-2 py-4 md:grid-cols-[220px_minmax(0,1fr)]">
                    <div className="grid content-start gap-1">
                      <span className="font-medium text-foreground">{r.organization.name}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[11px] text-muted-foreground">{r.organization.slug}</span>
                        <OrgStatusPill status={r.organization.status} />
                      </span>
                      <Stars rating={r.rating} />
                      <span className="text-xs text-muted-foreground">
                        {MARKER_LABEL[r.stage] ?? r.stage} · {shortDateTime(r.createdAt)}
                      </span>
                      {r.wouldReturn && <Badge variant={r.wouldReturn === "yes" ? "success" : r.wouldReturn === "maybe" ? "warning" : "muted"}>would return: {r.wouldReturn}</Badge>}
                    </div>
                    <dl className="grid gap-2 text-sm">
                      {r.liked && (
                        <div>
                          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">What worked</dt>
                          <dd className="whitespace-pre-wrap text-foreground">{r.liked}</dd>
                        </div>
                      )}
                      {r.missing && (
                        <div>
                          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">What got in the way</dt>
                          <dd className="whitespace-pre-wrap text-foreground">{r.missing}</dd>
                        </div>
                      )}
                      {r.comment && (
                        <div>
                          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Anything else</dt>
                          <dd className="whitespace-pre-wrap text-foreground">{r.comment}</dd>
                        </div>
                      )}
                      {!r.liked && !r.missing && !r.comment && <dd className="text-muted-foreground">Rating only.</dd>}
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </ConsoleSection>
        </>
      )}
    </ConsolePage>
  );
}

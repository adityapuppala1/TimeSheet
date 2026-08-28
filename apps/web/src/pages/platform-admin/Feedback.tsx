/**
 * What trialling and lapsed customers said through the feedback form the retention programme
 * mails — the one place the platform hears WHY somebody did not stay. Ratings and the would-you-
 * come-back split first; every answer, verbatim, underneath. Plain text throughout: these are a
 * stranger's words, and they are shown as words.
 *
 * LAYOUT (3.12.x). Geometry comes from the console kit, not from this page:
 *  - the ratings histogram is a real table (`ConsoleTable` + `Num`) because that is what it is —
 *    a rating, a share and a count. The old hand-rolled `52px/1fr/32px` grid clipped the five
 *    stars (they need ~78px) at every width; a table column sizes itself to its content instead,
 *    and the honest 280px minimum scrolls inside the card rather than squashing the bars.
 *  - the three would-return tiles sit on `auto-rows-fr` so they stay the same height once the
 *    2-up phone layout puts them on two rows — grid only equalises within a row on its own.
 *  - a response is a two-column block only from `md`; below that it stacks with the metadata
 *    first, because a verbatim answer beside a 220px column of chrome is unreadable on a phone.
 *    Answers keep `whitespace-pre-wrap` (a stranger's line breaks are part of what they said) and
 *    add `break-words` so one long unbroken URL cannot push the page sideways.
 */
import { useQuery } from "@tanstack/react-query";
import { MessageSquareHeart, MessageSquareQuote, Star, ThumbsUp, Undo2 } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/utils";
import { platformAdminConsoleApi } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, KpiCard, KpiGrid, MARKER_LABEL, Num, OrgStatusPill, TierPill, shortDateTime } from "./console-ui";

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cn("h-3.5 w-3.5 shrink-0", n <= rating ? "fill-accent text-accent" : "text-muted-foreground/40")} />
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
          <KpiGrid>
            <KpiCard label="Responses" value={d.count} icon={MessageSquareHeart} tone="accent" />
            <KpiCard label="Average rating" value={d.avgRating ?? 0} icon={Star} format={(n) => (d.avgRating === null ? "—" : `${n.toFixed(1)} / 5`)} delay={0.05} />
            <KpiCard
              label="Would come back"
              value={answered ? Math.round((yes / answered) * 100) : 0}
              icon={Undo2}
              tone="success"
              format={(n) => (answered ? `${Math.round(n)}%` : "—")}
              hint={answered ? `${yes} of ${answered} who answered` : "nobody has answered yet"}
              delay={0.1}
            />
            {/* The response rate on the part that matters. A wall of rating-only answers means the
                form is asking badly, not that customers have nothing to say — and that is a fact
                about US, so it belongs beside the score rather than buried. */}
            <KpiCard
              label="Left words, not just a score"
              value={d.count ? Math.round((d.withWords / d.count) * 100) : 0}
              icon={MessageSquareQuote}
              format={(n) => (d.count ? `${Math.round(n)}%` : "—")}
              hint={d.count ? `${d.withWords} of ${d.count} wrote something` : undefined}
              delay={0.15}
            />
          </KpiGrid>

          {/* WHY MONTHLY AND NOT DAILY: feedback arrives in single figures a week even on a healthy
              platform, so a daily series of a 1-to-5 score is almost all noise and empty buckets.
              A monthly mean over a year is the shortest window in which a move in it means
              something. Months with no answers plot no point rather than a zero — nobody rated us
              0/5 that month; nobody rated us at all. */}
          <ConsoleSection
            title="Where the score is going"
            description="Average rating per month, over the last twelve. The bars are how many answers that mean is built on — a mean of one answer is an anecdote."
          >
            <div className="h-56 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={d.monthly} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(m: string) => m.slice(2)} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="count" allowDecimals={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="rating" orientation="right" domain={[0, 5]} ticks={[0, 1, 2, 3, 4, 5]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <RTooltip
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, color: "hsl(var(--popover-foreground))" }}
                    cursor={{ fill: "hsl(var(--muted))" }}
                    formatter={(value: number | string, name) => [name === "avgRating" ? `${Number(value).toFixed(1)} / 5` : value, name === "avgRating" ? "Average rating" : "Responses"]}
                  />
                  <Bar yAxisId="count" dataKey="count" name="count" fill="hsl(var(--muted-foreground))" opacity={0.35} radius={[3, 3, 0, 0]} />
                  <Line yAxisId="rating" type="monotone" dataKey="avgRating" name="avgRating" stroke="hsl(var(--accent))" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </ConsoleSection>

          {/* Side by side only where both halves still have room: 50/50 from `lg`, and the
              1/3 + 2/3 split the content actually wants once there is 1280px of it. */}
          <div className="grid min-w-0 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            <ConsoleSection title="Ratings" flush>
              <ConsoleTable minWidth={280} className="rounded-none border-x-0 border-b-0">
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">Rating</TableHead>
                    <TableHead className="w-full">Share</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...d.distribution].reverse().map((b) => (
                    <TableRow key={b.rating}>
                      <TableCell className="whitespace-nowrap">
                        <Stars rating={b.rating} />
                      </TableCell>
                      <TableCell className="w-full">
                        <span className="block h-2.5 overflow-hidden rounded-full bg-muted">
                          <span className="block h-full rounded-full bg-accent transition-all" style={{ width: `${(b.count / maxBucket) * 100}%` }} />
                        </span>
                      </TableCell>
                      <Num className="text-muted-foreground">{b.count}</Num>
                    </TableRow>
                  ))}
                </TableBody>
              </ConsoleTable>
            </ConsoleSection>

            <ConsoleSection title="Would they come back?" className="xl:col-span-2">
              <div className="grid auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-3">
                {d.wouldReturn.map((w) => (
                  <div key={w.answer} className="flex min-w-0 flex-col justify-between gap-1 rounded-lg border border-border p-3">
                    <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{w.answer}</p>
                    <p className="font-mono text-2xl font-black tabular-nums text-foreground">{w.count}</p>
                    <p className="font-mono text-xs tabular-nums text-muted-foreground">{answered ? `${Math.round((w.count / answered) * 100)}%` : "—"}</p>
                  </div>
                ))}
              </div>
            </ConsoleSection>
          </div>

          {/* WHY SPLIT BY STAGE AT ALL: the day-10 check-in and the post-trial reminders are
              different questions asked of different moods. Averaged together they hide which one is
              bad — a good in-trial score and a poor post-trial one is a very different problem from
              the reverse, and only one of them is about the product. */}
          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            <ConsoleSection title="By stage" description="Which moment in the sequence the answer came from." flush>
              <ConsoleTable minWidth={420} className="rounded-none border-x-0 border-b-0">
                <TableHeader>
                  <TableRow>
                    <TableHead>Stage</TableHead>
                    <TableHead className="text-right">Answers</TableHead>
                    <TableHead className="text-right">Average</TableHead>
                    <TableHead className="text-right">Would return</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.stages.map((row) => (
                    <TableRow key={row.stage}>
                      <TableCell className="whitespace-nowrap">{MARKER_LABEL[row.stage] ?? row.stage}</TableCell>
                      <Num>{row.count}</Num>
                      <Num className={cn(row.avgRating !== null && row.avgRating < 3 && "text-destructive")}>{row.avgRating === null ? "—" : row.avgRating.toFixed(1)}</Num>
                      <Num className="text-muted-foreground">{row.wouldReturn}</Num>
                    </TableRow>
                  ))}
                </TableBody>
              </ConsoleTable>
            </ConsoleSection>

            <ConsoleSection title="By plan and lifecycle" description="Who is answering — the tier they were trialling, and where their workspace is now." flush>
              <ConsoleTable minWidth={420} className="rounded-none border-x-0 border-b-0">
                <TableHeader>
                  <TableRow>
                    <TableHead>Segment</TableHead>
                    <TableHead className="text-right">Answers</TableHead>
                    <TableHead className="text-right">Average</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.byTier.map((row) => (
                    <TableRow key={`tier-${row.tier}`}>
                      <TableCell>
                        <TierPill tier={row.tier} />
                      </TableCell>
                      <Num>{row.count}</Num>
                      <Num>{row.avgRating === null ? "—" : row.avgRating.toFixed(1)}</Num>
                    </TableRow>
                  ))}
                  {d.byStatus.map((row) => (
                    <TableRow key={`status-${row.status}`}>
                      <TableCell>
                        <OrgStatusPill status={row.status} />
                      </TableCell>
                      <Num>{row.count}</Num>
                      <Num>{row.avgRating === null ? "—" : row.avgRating.toFixed(1)}</Num>
                    </TableRow>
                  ))}
                </TableBody>
              </ConsoleTable>
            </ConsoleSection>
          </div>

          <ConsoleSection title="Every response" description="Newest first. Verbatim.">
            {d.rows.length === 0 ? (
              <EmptyState icon={ThumbsUp} title="No feedback yet" description="The first day-10 check-in goes out ten days after a trial starts." />
            ) : (
              <ul className="divide-y divide-border">
                {d.rows.map((r) => (
                  <li key={r.id} className="grid min-w-0 gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-x-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
                    {/* `items-start` so the status pill and the would-return badge keep their own
                        width — as flex children they would otherwise stretch across the column. */}
                    <div className="flex min-w-0 flex-col items-start gap-1.5">
                      <span className="break-words font-medium text-foreground">{r.organization.name}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="break-all font-mono text-[11px] text-muted-foreground">{r.organization.slug}</span>
                        <OrgStatusPill status={r.organization.status} />
                      </span>
                      <Stars rating={r.rating} />
                      <span className="text-xs text-muted-foreground">
                        {MARKER_LABEL[r.stage] ?? r.stage} · {shortDateTime(r.createdAt)}
                      </span>
                      {r.wouldReturn && <Badge variant={r.wouldReturn === "yes" ? "success" : r.wouldReturn === "maybe" ? "warning" : "muted"}>would return: {r.wouldReturn}</Badge>}
                    </div>
                    <dl className="grid min-w-0 content-start gap-2 text-sm">
                      {r.liked && (
                        <div className="min-w-0">
                          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">What worked</dt>
                          <dd className="whitespace-pre-wrap break-words text-foreground">{r.liked}</dd>
                        </div>
                      )}
                      {r.missing && (
                        <div className="min-w-0">
                          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">What got in the way</dt>
                          <dd className="whitespace-pre-wrap break-words text-foreground">{r.missing}</dd>
                        </div>
                      )}
                      {r.comment && (
                        <div className="min-w-0">
                          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Anything else</dt>
                          <dd className="whitespace-pre-wrap break-words text-foreground">{r.comment}</dd>
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

/**
 * WHAT: what this change is actually shipping — the repositories and pull requests it delivers,
 * whether their CI is green, what security findings are open against them, who did the work, and how
 * the last few changes to the same application went.
 *
 * WHY IT IS A TAB AND NOT A FORM: every figure here is DERIVED from the tickets the change links.
 * Nothing on this tab can be edited, because nothing on it was typed — the repositories come from
 * `TicketBranch` rows the git webhook keeps live, the CI status from ingested runs, the hours from
 * approved timesheets. Asking somebody to retype any of it produces a second copy that is wrong the
 * moment a PR merges.
 *
 * WHO IT IS FOR: the approver. "What am I actually approving" is the question this module exists to
 * answer, and until now the answer lived across three other pages.
 *
 * THE ONE DISTINCTION THAT MATTERS HERE: a repository with no ingested CI run shows "not reported",
 * never "passing". Nobody having told us and everything being green are different facts, and only
 * one of them is a reason to approve.
 */
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitBranch,
  GitPullRequestArrow,
  History,
  ShieldAlert,
  Users
} from "lucide-react";
import { changeApi, type ChangeContextRepo } from "../../services/api";
import { CHANGE_OUTCOME_TONE, humanizeChange } from "../../lib/change-visuals";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";

const PR_TONE: Record<string, "muted" | "info" | "success" | "destructive"> = {
  NONE: "muted",
  OPEN: "info",
  MERGED: "success",
  CLOSED: "muted"
};

export function ChangeContextTab({ changeId }: { changeId: string }) {
  const context = useQuery({ queryKey: ["change", changeId, "context"], queryFn: () => changeApi.context(changeId) });

  if (context.isLoading) return <Skeleton className="h-64 w-full" />;
  const data = context.data;
  if (!data) return null;

  const nothingLinked = data.totals.repositories === 0 && data.totals.approvedHours === 0 && data.tickets.length <= 1;

  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Figure label="Tickets" value={data.totals.tickets} />
        <Figure label="Repositories" value={data.totals.repositories} />
        <Figure label="Pull requests" value={data.totals.pullRequests} />
        <Figure label="Approved hours" value={data.totals.approvedHours.toFixed(1)} />
        <Figure label="Open findings" value={data.totals.openFindings} tone={data.totals.openFindings > 0 ? "bad" : "good"} />
      </div>

      {nothingLinked && (
        /* Says what would fill it, rather than leaving an empty tab that reads as broken. Everything
           here is derived, so the way to populate it is to link the work — not to type into it. */
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Nothing linked yet</p>
          <p className="mt-1">
            This tab is derived, never typed. It fills in as the change picks up work: tag the closed tickets it
            delivers on <span className="font-medium text-foreground">Tickets &amp; team</span>, and each ticket&apos;s
            repository, branch and pull request appear here — along with the CI runs and security findings ingested
            against them, and the approved hours logged to them.
          </p>
        </div>
      )}

      {data.repositories.length > 0 && (
        <section className="grid gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            What is shipping
          </h3>
          <div className="grid gap-2">
            {data.repositories.map((repo) => (
              <RepoCard key={repo.repository} repo={repo} />
            ))}
          </div>
        </section>
      )}

      {data.tickets.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">Tickets delivered</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Assignee</th>
                  <th className="px-3 py-2 text-right font-medium">Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.tickets.map((t) => (
                  <tr key={t.id}>
                    <td className="px-3 py-1.5 font-mono text-xs">{t.key}</td>
                    <td className="px-3 py-1.5">{t.title}</td>
                    <td className="px-3 py-1.5">
                      <Badge variant="muted">{humanizeChange(t.status)}</Badge>
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{t.assignee ?? "—"}</td>
                    {/* Approved hours only — draft time is typed, not signed off, and a change record
                        quoting it would quote a number that can still change. */}
                    <td className="px-3 py-1.5 text-right tabular-nums">{t.approvedHours > 0 ? t.approvedHours.toFixed(1) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.contributors.length > 0 && (
        <section className="grid gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Users className="h-4 w-4 text-muted-foreground" />
            Who did the work
          </h3>
          <ul className="flex flex-wrap gap-2">
            {data.contributors.map((c) => (
              <li key={c.id} className="rounded-full border border-border px-3 py-1 text-xs">
                <span className="font-medium">{c.name}</span>
                <span className="ml-1.5 tabular-nums text-muted-foreground">{c.approvedHours.toFixed(1)}h</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.applicationHistory.length > 0 && (
        <section className="grid gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <History className="h-4 w-4 text-muted-foreground" />
            Last changes to this application
          </h3>
          {/* The most useful thing an approver can be shown, and it is pure history: three failed
              deploys in a row is a reason to ask harder questions about this one. */}
          <ul className="grid gap-1.5">
            {data.applicationHistory.map((h) => (
              <li key={h.changeKey} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-mono text-xs text-muted-foreground">{h.changeKey}</span>
                  <span className="ml-2">{h.title}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {h.outcome ? (
                    <Badge variant={CHANGE_OUTCOME_TONE[h.outcome as keyof typeof CHANGE_OUTCOME_TONE] ?? "muted"}>
                      {humanizeChange(h.outcome)}
                    </Badge>
                  ) : (
                    <Badge variant="muted">{humanizeChange(h.state)}</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border border-border p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-xl font-black tabular-nums", tone === "bad" && "text-destructive")}>{value}</p>
    </div>
  );
}

function RepoCard({ repo }: { repo: ChangeContextRepo }) {
  const findings = repo.openFindings.critical + repo.openFindings.high + repo.openFindings.medium + repo.openFindings.low;
  return (
    <div className="grid gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-sm font-medium">{repo.repository}</p>
        <CiBadge ci={repo.latestCi} />
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs">
        {repo.branches.map((b) => (
          <span key={b} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            {b}
          </span>
        ))}
      </div>

      {repo.pullRequests.length > 0 && (
        <ul className="grid gap-1">
          {repo.pullRequests.map((pr) => (
            <li key={pr.url} className="flex items-center gap-2 text-xs">
              <GitPullRequestArrow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <a href={pr.url} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">
                {pr.url.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
              </a>
              <Badge variant={PR_TONE[pr.status] ?? "muted"}>{humanizeChange(pr.status)}</Badge>
              <span className="font-mono text-[11px] text-muted-foreground">{pr.ticketKey}</span>
            </li>
          ))}
        </ul>
      )}

      {findings > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <ShieldAlert className="h-3.5 w-3.5" />
          {repo.openFindings.critical > 0 && <span>{repo.openFindings.critical} critical</span>}
          {repo.openFindings.high > 0 && <span>{repo.openFindings.high} high</span>}
          {repo.openFindings.medium > 0 && <span>{repo.openFindings.medium} medium</span>}
          {repo.openFindings.low > 0 && <span>{repo.openFindings.low} low</span>}
          <span className="text-muted-foreground">still open against this repository</span>
        </p>
      )}
    </div>
  );
}

/** "Not reported" is a distinct state from "passing", and deliberately not green. */
function CiBadge({ ci }: { ci: ChangeContextRepo["latestCi"] }) {
  if (!ci) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5" />
        CI not reported
      </span>
    );
  }
  if (ci.status === "RUNNING") {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
        <Clock className="h-3.5 w-3.5" />
        CI running
      </span>
    );
  }
  const passed = ci.status === "PASSED";
  return (
    <span className={cn("flex items-center gap-1 text-xs", passed ? "text-emerald-600 dark:text-emerald-500" : "text-destructive")}>
      {passed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
      {passed ? "CI passing" : "CI failing"}
      <span className="text-muted-foreground">
        {ci.passCount !== null && `${ci.passCount} passed`}
        {ci.failCount ? ` · ${ci.failCount} failed` : ""} · {ci.provider}
      </span>
    </span>
  );
}

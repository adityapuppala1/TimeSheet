/**
 * "Restore my workspace" — the one click every retention email leads with, for an owner whose
 * workspace is lapsed and whose data is still there.
 *
 * What it does and does not do is stated on the page, because a button that silently signs you in
 * or silently charges you is the thing people are afraid of clicking: it reopens the workspace in
 * its grace state and sends the owner to their own sign-in. They still sign in; they still choose
 * a plan.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { useParams } from "react-router";
import { Button } from "../components/ui/button";
import { platformPublicApi } from "../services/platform-admin-api";

export function ReactivatePage() {
  const { token = "" } = useParams();
  const info = useQuery({ queryKey: ["reactivate", token], queryFn: () => platformPublicApi.reactivateInfo(token), retry: false });
  const restore = useMutation({ mutationFn: () => platformPublicApi.reactivate(token) });

  if (info.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (info.isError) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4 text-center">
        <div className="max-w-md">
          <h1 className="text-xl font-bold text-foreground">This link isn't valid any more</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Restore links expire, and a workspace that has passed its retention date cannot be restored — deletion is permanent. You can always{" "}
            <a href="/signup" className="font-medium text-accent underline">
              start a new workspace
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  const d = info.data!;
  const done = restore.data;

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-12">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-8 shadow-sm">
        {done?.restored || done?.alreadyActive ? (
          <div className="grid gap-4 text-center">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-7 w-7" />
            </span>
            <h1 className="text-2xl font-black tracking-tight text-foreground">{done.alreadyActive ? `${d.workspace} is already open` : `${d.workspace} is back`}</h1>
            <p className="text-sm text-muted-foreground">
              {done.alreadyActive ? "Nothing needed changing — sign in and carry on." : "Your workspace is reachable again with all of its data. Sign in and choose a plan to lift the limits."}
            </p>
            <Button asChild size="lg" className="mx-auto gap-2 bg-accent text-accent-foreground hover:bg-accent/90">
              <a href={done.url}>
                Sign in to {d.slug}
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          </div>
        ) : (
          <div className="grid gap-5">
            <div className="grid gap-2">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent/15 text-accent">
                <RotateCcw className="h-5 w-5" />
              </span>
              <h1 className="text-2xl font-black tracking-tight text-foreground">Restore {d.workspace}</h1>
              <p className="text-sm text-muted-foreground">
                Everything is still there — the people, the projects, the timesheets, the history. Restoring reopens the workspace so you can sign in and choose a plan.
              </p>
            </div>

            {d.deleteDate && (
              <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                Without a plan, this workspace is scheduled for permanent deletion on{" "}
                <strong>{new Date(d.deleteDate).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</strong>.
              </p>
            )}

            <ul className="grid gap-1.5 text-sm text-muted-foreground">
              <li>• Restoring does not sign you in, and does not charge anything.</li>
              <li>• It pauses the deletion so nobody is on a clock while you decide.</li>
              <li>• Your sign-in address stays {d.url.replace(/^https?:\/\//, "")}.</li>
            </ul>

            {restore.isError && <p className="text-sm text-destructive">That didn't work. The link may have expired — try the most recent email.</p>}

            <Button size="lg" className="gap-2 bg-accent text-accent-foreground hover:bg-accent/90" disabled={!d.eligible || restore.isPending} onClick={() => restore.mutate()}>
              {restore.isPending ? "Restoring…" : "Restore my workspace"}
              {!restore.isPending && <ArrowRight className="h-4 w-4" />}
            </Button>
            {!d.eligible && <p className="text-center text-xs text-muted-foreground">This workspace is already active — just sign in.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

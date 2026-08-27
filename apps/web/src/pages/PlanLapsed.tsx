/**
 * WHAT a workspace sees when its trial has ended or a renewal failed — the screen behind the
 * server's 402 + `PLAN_LAPSED`.
 *
 * WHY IT EXISTS AT ALL. Without it the API's refusals render as a page full of broken panels with
 * nothing saying why, which reads as "this product is down" rather than "this account needs a
 * card". The distinction matters most to the person who was about to pay.
 *
 * WHAT THE COPY HAS TO DO, in order:
 *  1. Say the data is safe, first and unprompted. The assumption a customer arrives with is that
 *     their work has been deleted, and every sentence after that one is read through it.
 *  2. Name who can fix it. Only a workspace admin can, and an employee staring at a "Choose a plan"
 *     button they cannot use will file a support ticket the admin never hears about.
 *  3. Offer the one action, to the one person who has it.
 *
 * There is deliberately no countdown, no "act now", and no price. This page is shown to people who
 * have already lost access; pressure here is just unpleasant.
 */
import { ArrowRight, LifeBuoy, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { authApi } from "../services/api";
import { useAuthStore } from "../store/auth";

export function PlanLapsedPage() {
  const user = useAuthStore((s) => s.user);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(user ? user.role === "SUPER_ADMIN" : null);

  // The store is empty on a hard navigation, which is exactly how people arrive here — the
  // interceptor does a full `location.assign`. `/auth/me` is one of the routes GRACE leaves open,
  // so this works while everything else on the workspace does not.
  useEffect(() => {
    if (isAdmin !== null) return;
    authApi
      .me()
      .then((profile) => setIsAdmin(profile.role === "SUPER_ADMIN"))
      .catch(() => setIsAdmin(false));
  }, [isAdmin]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-1 grid h-10 w-10 place-items-center rounded-lg bg-warning/10 text-warning">
            <Lock className="h-5 w-5" />
          </div>
          <CardTitle>This workspace is paused</CardTitle>
          <CardDescription>Its plan has lapsed — either a free trial ended, or a renewal payment didn't go through.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <p className="rounded-lg border border-border bg-card p-3.5 text-sm leading-6">
            <strong>Nothing has been deleted.</strong> Every timesheet, ticket, project and document is exactly where you
            left it, and will stay there. Choosing a plan puts the workspace back precisely as it was.
          </p>

          {isAdmin === true && (
            <div className="grid gap-2">
              <Button asChild size="lg">
                <a href="/app/settings?tab=billing">
                  Choose a plan <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
              <p className="text-xs leading-5 text-muted-foreground">
                You can also still export your data from Reports — that stays available whether or not there's a plan.
              </p>
            </div>
          )}

          {isAdmin === false && (
            <div className="grid gap-2">
              <p className="text-sm leading-6 text-muted-foreground">
                A workspace admin needs to choose a plan. If you know who that is, this is worth a message — they may not
                have seen the emails.
              </p>
              <Button variant="outline" asChild>
                <a href="/find-workspace">
                  <LifeBuoy className="h-4 w-4" />
                  Sign in to a different workspace
                </a>
              </Button>
            </div>
          )}

          {/* While we don't yet know which they are, neither branch is shown: an employee who is
              briefly offered "Choose a plan" and then has it taken away has been told something
              untrue about what they can do. */}
        </CardContent>
      </Card>
    </div>
  );
}

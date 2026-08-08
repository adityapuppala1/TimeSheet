/**
 * WHAT: "break this down for me" — the entry point that asks the planning copilot for a proposal.
 *
 * WHY IT DID NOT EXIST UNTIL NOW: the whole review half was built and polished — a page listing
 * proposals, per-row checkboxes, before/after diffs, per-row failure reasons, and now undo — and
 * `copilotApi.planBreakdown` was defined in the client. Nothing called it. The Proposals page's own
 * empty state told people to "ask for a breakdown from a project's timeline", and there was no such
 * affordance anywhere. So the entire proposal envelope had no way to be reached from the product.
 *
 * WHY IT LIVES ON THE TIMELINE: that is the screen where somebody is already looking at a plan and
 * can see the gap this fills. Asking for a breakdown from a settings page would be asking in the
 * abstract.
 *
 * WHY IT DOES NOT SHOW THE RESULT: it deliberately hands off to /app/proposals rather than
 * rendering the change set inline. Reviewing fourteen proposed tasks in a dialog that popped up
 * over a Gantt chart is how a rubber stamp happens, and the whole design exists to avoid that.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Loader2 } from "lucide-react";
import { useNavigate } from "react-router";
import { copilotApi } from "../services/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toaster";

export function PlanBreakdownDialog({
  projectId,
  projectName,
  disabled
}: {
  /** Null when the timeline is showing every project — a breakdown has to land somewhere specific. */
  projectId: string | null;
  projectName: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const ask = useMutation({
    mutationFn: () => copilotApi.planBreakdown({ projectId: projectId!, goal: goal.trim(), context: context.trim() || undefined }),
    onSuccess: (proposal) => {
      setOpen(false);
      setGoal("");
      setContext("");
      queryClient.invalidateQueries({ queryKey: ["ai-proposals"] });
      // The count is in the message on purpose: "14 changes" is the number somebody should see
      // before they open the review, not after.
      toast.success(`${proposal.changes.length} change${proposal.changes.length === 1 ? "" : "s"} suggested`, {
        description: "Nothing has changed yet — review and apply the ones you want.",
        action: { label: "Review", onClick: () => navigate("/app/proposals") }
      });
    },
    onError: (err: any) =>
      toast.error("Could not get a breakdown", { description: err?.response?.data?.message ?? "Try rephrasing the goal." })
  });

  const noProject = !projectId;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          // aria-disabled rather than disabled so the reason stays reachable — "pick a project
          // first" is more useful than a button that does nothing and says nothing.
          aria-disabled={disabled || noProject}
          onClick={(e) => {
            if (disabled || noProject) {
              e.preventDefault();
              toast.info(noProject ? "Pick a project first" : "Planning is not available on this plan", {
                description: noProject ? "A breakdown has to land in one project." : undefined
              });
            }
          }}
        >
          <Sparkles className="mr-2 h-3.5 w-3.5" aria-hidden />
          Break work down
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Break work down with AI</DialogTitle>
          <DialogDescription>
            Describe what needs doing{projectName ? ` in ${projectName}` : ""}. You will get a list of suggested tasks to
            review — nothing is created until you apply it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="breakdown-goal">What needs doing</Label>
            <Textarea
              id="breakdown-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="Ship single sign-on for enterprise customers"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="breakdown-context">Anything else it should know (optional)</Label>
            <Textarea
              id="breakdown-context"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={2}
              placeholder="We already have SAML; this is the Okta side."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={ask.isPending}>
            Cancel
          </Button>
          <Button onClick={() => ask.mutate()} disabled={goal.trim().length < 8 || ask.isPending}>
            {ask.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {ask.isPending ? "Thinking…" : "Suggest tasks"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

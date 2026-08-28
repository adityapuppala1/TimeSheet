/**
 * The feedback form a retention email links to. Public, addressed by a signed token, and reachable
 * when the workspace behind it is suspended or already deleted — so it depends on nothing tenant-
 * scoped and renders on its own.
 *
 * Five questions and a rating, because a form that takes two minutes gets answered and one that
 * takes ten does not. Every field except the rating is optional, and the page says so.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Heart, Loader2, Star } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { platformPublicApi } from "../services/platform-admin-api";

const RETURN_OPTIONS = [
  { value: "yes", label: "Yes" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "No" }
] as const;

export function TrialFeedbackPage() {
  const { token = "" } = useParams();
  const info = useQuery({ queryKey: ["trial-feedback", token], queryFn: () => platformPublicApi.feedbackInfo(token), retry: false });
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [liked, setLiked] = useState("");
  const [missing, setMissing] = useState("");
  const [wouldReturn, setWouldReturn] = useState<"yes" | "maybe" | "no" | "">("");
  const [comment, setComment] = useState("");

  const submit = useMutation({
    mutationFn: () => platformPublicApi.submitFeedback(token, { rating, liked: liked.trim() || undefined, missing: missing.trim() || undefined, wouldReturn: wouldReturn || undefined, comment: comment.trim() || undefined })
  });

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
        <div className="max-w-sm">
          <h1 className="text-xl font-bold text-foreground">This link isn't valid any more</h1>
          <p className="mt-2 text-sm text-muted-foreground">Feedback links expire. If you still want to tell us something, just reply to the email you received.</p>
        </div>
      </div>
    );
  }

  if (submit.isSuccess) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4 text-center">
        <div className="max-w-md">
          <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-success/15 text-success">
            <CheckCircle2 className="h-7 w-7" />
          </span>
          <h1 className="text-2xl font-black tracking-tight text-foreground">Thank you</h1>
          <p className="mt-2 text-sm text-muted-foreground">That goes straight to the people building TimeSphere. If you left an idea, there is a decent chance you hear about it again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto grid w-full max-w-xl gap-6">
        <header className="grid gap-2">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent/15 text-accent">
            <Heart className="h-5 w-5" />
          </span>
          <h1 className="text-2xl font-black tracking-tight text-foreground">How was TimeSphere for {info.data?.workspace}?</h1>
          <p className="text-sm text-muted-foreground">
            Two minutes, and only the rating is required. {info.data?.alreadySubmitted && <span className="text-warning">You have answered this before — a second answer is welcome too.</span>}
          </p>
        </header>

        <form
          className="grid gap-5 rounded-xl border border-border bg-card p-6 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (rating > 0) submit.mutate();
          }}
        >
          <fieldset className="grid gap-2">
            <Label>Overall, how did it go?</Label>
            <div className="flex items-center gap-1.5" onMouseLeave={() => setHover(0)}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setRating(n)} onMouseEnter={() => setHover(n)} aria-label={`${n} out of 5`} className="rounded p-0.5 transition-transform hover:scale-110">
                  <Star className={cn("h-8 w-8 transition-colors", n <= (hover || rating) ? "fill-accent text-accent" : "text-muted-foreground/40")} />
                </button>
              ))}
              {rating > 0 && <span className="ml-2 text-sm text-muted-foreground">{rating} / 5</span>}
            </div>
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor="tf-liked">What worked well?</Label>
            <Textarea id="tf-liked" value={liked} onChange={(e) => setLiked(e.target.value)} rows={3} placeholder="Optional" maxLength={2000} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="tf-missing">What got in the way, or was missing?</Label>
            <Textarea id="tf-missing" value={missing} onChange={(e) => setMissing(e.target.value)} rows={3} placeholder="Optional — this is the one we act on most" maxLength={2000} />
          </div>

          <fieldset className="grid gap-2">
            <Label>Would you consider coming back?</Label>
            <div className="flex flex-wrap gap-2">
              {RETURN_OPTIONS.map((o) => (
                <Button key={o.value} type="button" size="sm" variant={wouldReturn === o.value ? "default" : "outline"} className={cn(wouldReturn === o.value && "bg-accent text-accent-foreground hover:bg-accent/90")} onClick={() => setWouldReturn(o.value)}>
                  {o.label}
                </Button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor="tf-comment">Anything else?</Label>
            <Textarea id="tf-comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="Optional" maxLength={4000} />
          </div>

          {submit.isError && <p className="text-sm text-destructive">That didn't send. Please try again.</p>}

          <Button type="submit" size="lg" disabled={rating === 0 || submit.isPending} className="bg-accent text-accent-foreground hover:bg-accent/90">
            {submit.isPending ? "Sending…" : "Send feedback"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">Your answers reach the TimeSphere team only. Nothing is published.</p>
        </form>
      </div>
    </div>
  );
}

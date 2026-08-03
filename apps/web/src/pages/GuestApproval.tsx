/**
 * The guest approval page — what an external reviewer sees at `/shared/approval/:token`.
 *
 * WHY IT SHOWS SO LITTLE: the reviewer is being asked one question about one deliverable. They
 * are not a member of the workspace, so the page deliberately carries no navigation, no
 * workspace name beyond the item itself, and nothing about who else is in the chain or what
 * anyone else decided. The API returns exactly this much and no more; the page could not show
 * more if it wanted to.
 *
 * WHY THE DECISION IS TWO CLICKS AND A CONFIRMATION: an approval link arrives by email, and email
 * clients pre-fetch and pre-render. A one-click GET that approved something would be decided by a
 * scanner rather than a person. The decision is a POST behind an explicit confirm.
 *
 * WHY THERE IS NO "UNDO": the link is spent the moment it is used, by design — see
 * approval.service.ts. The page says so before the click rather than after it.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileText, Loader2, ShieldCheck, ThumbsDown, ThumbsUp, XCircle } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { fileUrl, guestApprovalApi } from "../services/api";

export function GuestApprovalPage() {
  const { token = "" } = useParams();
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [done, setDone] = useState<"APPROVED" | "REJECTED" | null>(null);

  const approval = useQuery({ queryKey: ["guest-approval", token], queryFn: () => guestApprovalApi.get(token), retry: false });

  const decide = useMutation({
    mutationFn: (decision: "APPROVED" | "REJECTED") => guestApprovalApi.decide(token, decision, comment.trim() || undefined),
    onSuccess: (_r, decision) => setDone(decision)
  });

  if (approval.isLoading) {
    return (
      <div className="mx-auto grid w-full max-w-2xl gap-4 p-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // One generic message for a bad, spent or revoked token — the same indistinguishability the
  // API enforces, carried through to what a person actually reads.
  if (approval.isError || !approval.data) {
    return (
      <div className="mx-auto grid w-full max-w-lg gap-4 p-6">
        <Card>
          <CardContent className="grid gap-3 p-10 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold">This approval link isn&apos;t available</h1>
            <p className="text-sm text-muted-foreground">
              It may already have been used, or withdrawn. Approval links work once — if you need another, ask the
              person who sent it.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto grid w-full max-w-lg gap-4 p-6">
        <Card>
          <CardContent className="grid gap-3 p-10 text-center">
            {done === "APPROVED" ? (
              <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            ) : (
              <XCircle className="mx-auto h-10 w-10 text-destructive" />
            )}
            <h1 className="text-lg font-semibold">{done === "APPROVED" ? "Approved" : "Changes requested"}</h1>
            <p className="text-sm text-muted-foreground">
              Thanks — your decision has been recorded and the team has been told. This link is now closed.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { title, description, dueAt, reviewerEmail, item } = approval.data;

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            {title}
          </CardTitle>
          <CardDescription>
            {reviewerEmail ? `You've been asked to review this as ${reviewerEmail}.` : "You've been asked to review this."}
            {dueAt && ` Needed by ${new Date(dueAt).toLocaleDateString()}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {description && <p className="whitespace-pre-line text-sm">{description}</p>}

          {item && (
            <div className="grid gap-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{item.reference}</Badge>
                <span className="text-sm font-medium">{item.title}</span>
              </div>
              {item.description && (
                <p className="max-h-60 overflow-y-auto whitespace-pre-line text-sm text-muted-foreground">{item.description}</p>
              )}
              {item.attachments.length > 0 && (
                <div className="grid gap-1.5">
                  <Label className="text-xs uppercase text-muted-foreground">Files</Label>
                  {item.attachments.map((file) => (
                    <a
                      key={file.id}
                      href={fileUrl(file.url) ?? "#"}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex items-center gap-2 text-sm text-primary hover:underline"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      {file.fileName}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>Comment {pending === "REJECTED" && <span className="text-muted-foreground">(what needs to change?)</span>}</Label>
            <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional" />
          </div>

          {decide.isError && (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {(decide.error as any)?.response?.data?.message ?? "Something went wrong. Please try again."}
            </p>
          )}

          {pending ? (
            // Explicit confirm: an approval link arrives by email, and email clients pre-fetch.
            // A decision has to be an act, not a side effect of a message being scanned.
            <div className="grid gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
              <p className="text-sm font-medium">
                {pending === "APPROVED" ? "Approve this?" : "Request changes?"}
              </p>
              <p className="text-xs text-muted-foreground">This is final — the link closes once you decide.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={pending === "APPROVED" ? "default" : "destructive"}
                  disabled={decide.isPending}
                  onClick={() => decide.mutate(pending)}
                >
                  {decide.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Yes, {pending === "APPROVED" ? "approve" : "request changes"}
                </Button>
                <Button variant="ghost" disabled={decide.isPending} onClick={() => setPending(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setPending("APPROVED")}>
                <ThumbsUp className="mr-2 h-4 w-4" />
                Approve
              </Button>
              <Button variant="outline" onClick={() => setPending("REJECTED")}>
                <ThumbsDown className="mr-2 h-4 w-4" />
                Request changes
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">Powered by TimeSphere</p>
    </div>
  );
}

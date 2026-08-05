/**
 * WHAT: the dashboard's first-run checklist — profile photo, phone, timezone, and (when the
 * workspace's policy covers this user) face-verification enrollment, each linking straight to
 * where it's done.
 * WHY a dismissible card instead of a blocking first-login wizard: blocking the whole app on
 * profile completion punishes people for an admin's configuration change, and there IS no
 * first-login flow in this app to hang a wizard off. A checklist gets the same completion
 * pressure without ever locking anyone out.
 * The one nuance: the ordinary items are dismissible (localStorage, per user), but a pending
 * REQUIRED face enrollment keeps the card visible even after dismissal — that item, uniquely,
 * blocks a real workflow (submissions return 428 until enrolled), so hiding it would just
 * convert the reminder into a support ticket later.
 * WHO renders this: pages/Dashboard.tsx, right under the page header.
 */
import { useState } from "react";
import { Camera, CheckCircle2, ChevronRight, Circle, ClipboardList, Phone, ScanFace, X } from "lucide-react";
import { Link } from "react-router";
import { useFaceStatus } from "../lib/use-face-status";
import { useAuthStore } from "../store/auth";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";

interface ChecklistItem {
  key: string;
  label: string;
  description: string;
  done: boolean;
  to: string;
  icon: React.ReactNode;
  /** Blocks a real workflow while missing — keeps the card visible through dismissal. */
  blocking?: boolean;
}

export function SetupChecklistCard() {
  const user = useAuthStore((s) => s.user);
  const dismissKey = `setup-checklist-dismissed:${user?.id ?? "anon"}`;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(dismissKey) === "1");

  const faceStatus = useFaceStatus();

  if (!user) return null;

  const faceRequired =
    Boolean(faceStatus.data && (faceStatus.data.requiredForTimesheet || faceStatus.data.requiredForTicket || faceStatus.data.requiredForApproval));
  const faceMissing = faceRequired && (!faceStatus.data?.enrolled || faceStatus.data?.needsReEnrollment);

  const items: ChecklistItem[] = [
    {
      key: "avatar",
      label: "Add a profile photo",
      description: "Helps teammates recognise you across tickets and approvals.",
      done: Boolean(user.avatarUrl),
      to: "/app/profile",
      icon: <Camera className="h-4 w-4" />
    },
    {
      key: "phone",
      label: "Add your phone number",
      description: "So your manager can reach you about urgent approvals.",
      done: Boolean(user.phoneNumber),
      to: "/app/profile",
      icon: <Phone className="h-4 w-4" />
    }
  ];

  if (faceRequired) {
    items.push({
      key: "face",
      label: faceStatus.data?.needsReEnrollment ? "Redo face verification setup" : "Set up face verification",
      description: faceStatus.data?.needsReEnrollment
        ? "Your enrollment was made with an older model and needs to be redone — until then, covered submissions will be held."
        : "Your workspace requires an identity check for some of your actions. Until you enroll, those submissions will be held.",
      done: !faceMissing,
      to: "/app/profile",
      icon: <ScanFace className="h-4 w-4" />,
      blocking: true
    });
  }

  const open = items.filter((i) => !i.done);
  const hasBlockingOpen = open.some((i) => i.blocking);

  // Nothing left to do — or dismissed and nothing workflow-blocking remains.
  if (open.length === 0) return null;
  if (dismissed && !hasBlockingOpen) return null;

  const doneCount = items.length - open.length;

  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-primary" />
            <p className="text-sm font-semibold">
              Finish setting up <span className="text-muted-foreground font-normal">— {doneCount}/{items.length} done</span>
            </p>
          </div>
          {!hasBlockingOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Dismiss setup checklist"
              onClick={() => {
                localStorage.setItem(dismissKey, "1");
                setDismissed(true);
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <ul className="mt-3 grid gap-2">
          {items.map((item) => (
            <li key={item.key}>
              {item.done ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                  <span className="line-through">{item.label}</span>
                </div>
              ) : (
                <Link
                  to={item.to}
                  className="group flex items-start gap-2 rounded-lg border border-border bg-background p-2.5 transition-colors hover:border-primary/50 hover:bg-primary/5"
                >
                  <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {item.icon}
                      {item.label}
                      {item.blocking && (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                          Required
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{item.description}</span>
                  </span>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

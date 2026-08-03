/**
 * WHAT: the "you've been signed out" dialog + the 15-second session heartbeat that makes it
 * prompt. Together they turn a server-side session revocation (an admin's "sign out
 * everywhere", a sign-out from another device, ordinary expiry) into something the person SEES
 * within seconds — instead of a zombie UI that only admits the truth when they next click.
 * HOW the chain works: the heartbeat (or any real request) 401s → api.ts tries the refresh →
 * the refresh is refused (session row revoked) → api.ts fires onSessionEnded exactly once →
 * this dialog opens over whatever they were doing. Confirming clears local auth state and
 * lands on /login. The dialog deliberately CANNOT be dismissed into a broken session — every
 * path out goes through the sign-in page.
 * WHY a modal and not a toast: a toast slides away unnoticed; the entire point of the ask was
 * that the person is told loudly, immediately, with one obvious way forward.
 * WHO renders this: `layouts/AppLayout.tsx`, once for the whole authenticated shell.
 */
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { authApi, onSessionEnded, type SessionEndedReason } from "../services/api";
import { useAuthStore } from "../store/auth";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "./ui/alert-dialog";

const COPY: Record<SessionEndedReason, { title: string; body: string }> = {
  revoked: {
    title: "You've been signed out",
    body: "An administrator ended your session, or it was signed out from another device. Anything you hadn't saved was not submitted — sign in again to continue where you left off."
  },
  expired: {
    title: "Your session expired",
    body: "You were signed in for a while and the session timed out. Sign in again to continue — your saved work is untouched."
  }
};

export function SessionEndedDialog() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [reason, setReason] = useState<SessionEndedReason | null>(null);

  // The heartbeat: a deliberately tiny authenticated request every 15s (also in background
  // tabs — a minimized window must learn about its revocation too). Its FAILURE is its job:
  // the 401 → failed-refresh chain in api.ts is what fires onSessionEnded below. retry: false
  // so a revocation isn't masked by client-side retries.
  useQuery({
    queryKey: ["session-heartbeat"],
    queryFn: authApi.heartbeat,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: false,
    enabled: Boolean(user)
  });

  useEffect(() => onSessionEnded((why) => setReason(why)), []);

  if (!user || !reason) return null;
  const copy = COPY[reason];

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mb-2 grid h-12 w-12 place-items-center rounded-full bg-destructive/10 text-destructive">
            <ShieldAlert className="h-6 w-6" aria-hidden />
          </div>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={() => {
              setReason(null);
              logout();
              navigate("/login", { replace: true });
            }}
          >
            Go to sign in
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

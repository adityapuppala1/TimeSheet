/**
 * WHAT: the screen a person sees instead of the app while their password is one an administrator
 * set — account creation, bulk import, or an admin reset (security audit #11).
 *
 * WHY A SCREEN AND NOT THE BANNER IT REPLACES (for these sessions): the banner was "a prompt, never a
 * gate", so somebody could work indefinitely on a password another person knows, while the Help
 * manual promised the change was required at first sign-in. The server now refuses everything but
 * this screen's own calls until it is done (middleware/auth.ts), so the screen is not a politeness
 * the API could be talked past — it is the only thing the API will serve.
 *
 * Only for PASSWORD sessions: an SSO or LDAP sign-in never used the admin's password and keeps the
 * banner (PasswordChangeBanner.tsx). Rendered by layouts/AppLayout.tsx in place of the shell, with
 * the session heartbeat beside it, so a force-logout still reaches this tab.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { authApi } from "../services/api";
import { useAuthStore } from "../store/auth";
import { newPasswordProblem } from "../lib/password-change-gate";
import { SIGN_OUT_UNCONFIRMED, signOut } from "../lib/sign-out";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { toast } from "./ui/toaster";

function PasswordField(props: { id: string; label: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <div className="relative">
        <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          id={props.id}
          className="pl-9"
          type="password"
          autoComplete={props.autoComplete}
          placeholder="••••••••"
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          required
        />
      </div>
    </div>
  );
}

export function ForcedPasswordChange() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logoutStore = useAuthStore((s) => s.logout);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const problem = newPasswordProblem(current, next, confirm);

  const change = useMutation({
    mutationFn: () => authApi.changePassword(current, next),
    onSuccess: async () => {
      toast.success("Password changed", { description: "Every other device was signed out for safety." });
      // The server cleared the flag; the fresh profile says so, and AppLayout swaps this screen for
      // the app. If the read fails, a reload does the same.
      try {
        setUser(await authApi.me());
      } catch {
        window.location.reload();
      }
    },
    // The server's message is the useful one: a wrong current password, or the policy's reason
    // (a common password, too long, built from the email address).
    onError: (err: any) =>
      toast.error("Could not change your password", { description: err?.response?.data?.message ?? "Check your current password and try again." })
  });

  async function handleSignOut() {
    const outcome = await signOut({
      endSession: authApi.logout,
      clearLocal: () => {
        logoutStore();
        queryClient.clear();
      }
    });
    if (outcome === "unconfirmed") toast.error(SIGN_OUT_UNCONFIRMED.title, { description: SIGN_OUT_UNCONFIRMED.description });
    void navigate("/login");
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <Card className="w-full max-w-md shadow-lg">
        <CardContent className="pt-6">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-warning/15 text-warning">
            <ShieldAlert className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="mt-4 text-2xl font-black tracking-tight">Choose your own password</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {user?.name ? `${user.name.split(" ")[0]}, your` : "Your"} current password was set by an administrator, so someone else knows it.
            Choose a new one to continue — it takes a moment.
          </p>

          <form
            className="mt-6 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!problem) change.mutate();
            }}
          >
            <PasswordField id="forced-current" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />
            <PasswordField id="forced-next" label="New password" value={next} onChange={setNext} autoComplete="new-password" />
            <PasswordField id="forced-confirm" label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
            {next.length > 0 && confirm.length > 0 && problem && (
              <p className="text-xs text-destructive" role="status">
                {problem}
              </p>
            )}
            <Button type="submit" size="lg" disabled={change.isPending || Boolean(problem) || !current}>
              {change.isPending ? "Saving…" : "Change password and continue"}
            </Button>
          </form>

          <Button type="button" variant="ghost" className="mt-3 w-full gap-2 text-muted-foreground" onClick={() => void handleSignOut()}>
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out instead
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

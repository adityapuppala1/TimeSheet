import { useQueryClient } from "@tanstack/react-query";
import { LogOut, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router";

import { SIGN_OUT_UNCONFIRMED, signOut } from "../lib/sign-out";
import { authApi } from "../services/api";
import { useAuthStore } from "../store/auth";
import { TwoFactorPanel } from "./TwoFactorPanel";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { toast } from "./ui/toaster";

/**
 * The screen a workspace that requires two-factor holds a password session at until it is set up —
 * the twin of ForcedPasswordChange, mounted by AppLayout instead of the app shell. The server refuses
 * everything but the setup routes meanwhile (requireAuth, MFA_SETUP_REQUIRED). Once the recovery codes
 * are acknowledged, the fresh profile no longer carries the flag and the app takes over.
 */
export function ForcedMfaSetup() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logoutStore = useAuthStore((s) => s.logout);

  async function continueIntoApp() {
    try {
      setUser(await authApi.me());
    } catch {
      window.location.reload();
    }
  }

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
      <Card className="w-full max-w-lg shadow-lg">
        <CardContent className="pt-6">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="mt-4 text-2xl font-black tracking-tight">Set up two-factor sign-in</h1>
          <p className="mt-2 mb-6 text-sm text-muted-foreground">
            {user?.name ? `${user.name.split(" ")[0]}, this` : "This"} workspace requires a code from an authenticator app when you sign in
            with a password. It takes about a minute.
          </p>
          <TwoFactorPanel required onEnabled={() => void continueIntoApp()} />
          <Button type="button" variant="ghost" className="mt-4 w-full gap-2 text-muted-foreground" onClick={() => void handleSignOut()}>
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out instead
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

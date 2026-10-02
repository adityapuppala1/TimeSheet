/**
 * WHAT: a slim banner shown while the signed-in person is still using a password an admin set —
 * account creation and every admin reset flag the account (`User.mustChangePassword`), and
 * choosing a password of their own (Profile → change password, or the emailed reset link)
 * clears it.
 *
 * A PASSWORD session with the flag never sees this banner: it is held at the forced change screen
 * instead (ForcedPasswordChange.tsx, security audit #11 — the Help manual promised the change was
 * required, and the API now enforces it). What remains for the banner is a session that did NOT use
 * the admin's password — SSO or LDAP — or one established before sessions recorded their method.
 *
 * WHO renders this: layouts/AppLayout.tsx, right under the maintenance banner.
 */
import { KeyRound } from "lucide-react";
import { Link } from "react-router";
import { useAuthStore } from "../store/auth";
import { Button } from "./ui/button";

export function PasswordChangeBanner() {
  const user = useAuthStore((s) => s.user);
  if (!user?.mustChangePassword) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm">
      <p className="flex min-w-0 items-center gap-2">
        <KeyRound className="h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0">
          You're using a password an administrator set — choose your own so nobody else knows it.
        </span>
      </p>
      <Button asChild size="sm" variant="outline">
        <Link to="/app/profile">Change password</Link>
      </Button>
    </div>
  );
}

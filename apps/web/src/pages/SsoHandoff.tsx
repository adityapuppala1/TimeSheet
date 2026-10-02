/**
 * The second half of an SSO sign-in on a multi-workspace deployment.
 *
 * WHY THIS PAGE EXISTS AT ALL. Google and Microsoft require the OAuth `redirect_uri` to be ONE
 * exact registered string, so every workspace's sign-in comes back to a single callback hostname.
 * The API can work out which workspace that was — the organization is carried in the signed `state`
 * — but the session could not follow: a refresh cookie written for the callback host is unreadable
 * by `acme.example.com`, so the person landed back on a login page having just signed in
 * successfully.
 *
 * So the callback parks the finished session behind a one-time code and redirects the browser HERE,
 * on the workspace's own hostname. This page redeems it, which makes the API write the cookie for
 * the origin that will actually use it.
 *
 * WHO RENDERS THIS: App.tsx's `/sso/handoff` route, public and unauthenticated — the visitor has no
 * session yet; acquiring one is the entire job.
 *
 * SINGLE-ORG DEPLOYMENTS NEVER REACH IT. With no ROOT_DOMAIN the callback host and the workspace
 * host are the same origin, so the API redirects straight to `/app` as it always has.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "../components/ui/button";
import { authApi } from "../services/api";
import { useAuthStore } from "../store/auth";

export function SsoHandoff() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const [failed, setFailed] = useState(false);
  /**
   * React 18+ mounts effects twice in development StrictMode, and this code is SINGLE-USE — the
   * second call would redeem an already-burned code and report a failure over a sign-in that
   * worked. A ref rather than state because it must be read synchronously, before the second
   * invocation can start.
   */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const code = params.get("code");
    if (!code) {
      setFailed(true);
      return;
    }

    /**
     * STRIPPED FROM THE ADDRESS BAR IMMEDIATELY, before the request is even made. The code is a
     * short-lived credential and this is the one moment it exists in a URL: leaving it there puts it
     * in browser history, in any screenshot of this page, and in the `Referer` of whatever loads
     * next. `replaceState` also means the back button cannot re-trigger a redemption.
     */
    window.history.replaceState({}, "", window.location.pathname);

    authApi
      .ssoHandoff(code)
      .then((data) => {
        setSession(data.user, data.accessToken);
        void navigate("/app", { replace: true });
      })
      .catch(() => setFailed(true));
  }, [params, navigate, setSession]);

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm text-center">
        {failed ? (
          <>
            <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-full bg-destructive/15 text-destructive-ink">
              <ShieldAlert className="h-5 w-5" aria-hidden="true" />
            </div>
            <h1 className="text-lg font-semibold">That sign-in link has expired</h1>
            {/* Deliberately one message for every failure. An expired code, a reused one and a code
                for another workspace are the same instruction to the person in front of it, and
                telling them apart would describe a credential to whoever is holding it. */}
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Sign-in links are valid for a minute and can only be used once. Start again and you will be signed straight
              in.
            </p>
            <Button className="mt-5 w-full" onClick={() => navigate("/login", { replace: true })}>
              Back to sign in
            </Button>
          </>
        ) : (
          <>
            {/* `aria-live` because there is nothing to read here — a screen-reader user would
                otherwise get silence between the identity provider and the app. */}
            <div aria-live="polite">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
              <p className="mt-4 text-sm text-muted-foreground">Signing you in…</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

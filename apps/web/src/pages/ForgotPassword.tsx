/**
 * WHAT: public "forgot password" form — submits an email to `authApi.forgotPassword`.
 * WHY it always shows the same generic "check your inbox" toast regardless of whether the
 * email actually matched an account: a response that reveals whether an address is registered
 * turns the endpoint into an account-enumeration oracle — see `auth.controller.ts`'s matching
 * comment on the same rationale server-side.
 * WHO links here: `Login.tsx`'s "Forgot password?" link.
 *
 * A WORKSPACE WITH PASSWORD SIGN-IN SWITCHED OFF (SSO only) gets an explanation instead of the form.
 * The API sends nothing there anyway — a password nobody can sign in with is not worth resetting —
 * and the login page already hides the link; this covers a bookmarked or typed URL. Read from the
 * same public `sso-methods` answer the login page uses, so the two can never disagree.
 */
import { Enter } from "../components/ui/enter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Mail, Send } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { toast } from "../components/ui/toaster";
import { authApi } from "../services/api";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const ssoMethods = useQuery({ queryKey: ["auth", "sso-methods"], queryFn: authApi.ssoMethods });
  // Only an explicit "no" hides the form: while loading, or against an older API, it stays.
  const passwordSignInOff = ssoMethods.data?.passwordEnabled === false;
  const mutation = useMutation({
    mutationFn: () => authApi.forgotPassword(email),
    onSuccess: () => toast.success("Check your inbox", { description: "If the account exists, we've sent reset instructions." }),
    onError: (err: any) => toast.error("Unable to send reset link", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="relative grid min-h-screen place-items-center px-4">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-32 top-1/4 h-80 w-80 rounded-full bg-primary/15 blur-3xl" />
        <div className="absolute -right-24 bottom-10 h-80 w-80 rounded-full bg-accent/20 blur-3xl" />
      </div>
      <Enter duration={0.4} className="w-full max-w-md">
        <Card>
          <CardContent className="pt-6">
            <h1 className="text-2xl font-black tracking-tight">Reset password</h1>
            {passwordSignInOff ? (
              <>
                <Alert className="mt-6">
                  <AlertTitle>This workspace uses single sign-on</AlertTitle>
                  <AlertDescription>
                    There is no password to reset here. Sign in with your organization's button on the sign-in page, and ask your
                    administrator if that sign-in is not working.
                  </AlertDescription>
                </Alert>
                <Link className="mt-6 inline-flex w-full items-center justify-center gap-1 text-center text-sm font-semibold text-primary hover:underline" to="/login">
                  <ArrowLeft className="h-3 w-3" />Back to login
                </Link>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-muted-foreground">
                  Enter your account email — we'll send reset instructions if it matches.
                </p>
                <form
                  className="mt-7 grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (email) mutation.mutate();
                  }}
                >
                  <div className="grid gap-1.5">
                    <Label htmlFor="forgot-email">Email</Label>
                    <div className="relative">
                      <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="forgot-email"
                        className="pl-9"
                        type="email"
                        placeholder="name@company.com"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <Button type="submit" disabled={mutation.isPending || !email} size="lg">
                    {mutation.isPending ? "Sending..." : (<><Send className="h-4 w-4" />Send reset link</>)}
                  </Button>
                  {mutation.isSuccess && (
                    <Alert variant="success">
                      <AlertTitle>Reset instructions sent</AlertTitle>
                      <AlertDescription>If the account exists, check your inbox in a minute.</AlertDescription>
                    </Alert>
                  )}
                  <Link className="inline-flex items-center justify-center gap-1 text-center text-sm font-semibold text-primary hover:underline" to="/login">
                    <ArrowLeft className="h-3 w-3" />Back to login
                  </Link>
                </form>
              </>
            )}
          </CardContent>
        </Card>
      </Enter>
    </div>
  );
}

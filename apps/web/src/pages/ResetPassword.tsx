/**
 * WHAT: public password-reset form — reads the reset token from the URL's `?token=` search
 * param and submits the new password via `authApi.resetPassword`.
 * WHY the token lives in the URL, not a form field: it's the link emailed to the user by
 * `auth.controller.ts`'s `/forgot-password` flow — this page just consumes it.
 * WHO links here: the "reset your password" email (`services/mail-templates.ts#reset`).
 */
import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { CheckCircle2, KeyRound } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { toast } from "../components/ui/toaster";
import { authApi } from "../services/api";

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => authApi.resetPassword(token, password),
    onSuccess: () => {
      toast.success("Password updated", { description: "Sign in with your new password." });
      setTimeout(() => navigate("/login"), 1500);
    },
    onError: (err: any) =>
      toast.error("Unable to reset password", {
        description: err?.response?.data?.message ?? "This link may be invalid or expired."
      })
  });

  const passwordsMatch = password.length >= 8 && password === confirmPassword;

  return (
    <div className="relative grid min-h-screen place-items-center px-4">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-32 top-1/4 h-80 w-80 rounded-full bg-primary/15 blur-3xl" />
        <div className="absolute -right-24 bottom-10 h-80 w-80 rounded-full bg-accent/20 blur-3xl" />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <Card>
          <CardContent className="pt-6">
            <h1 className="text-2xl font-black tracking-tight">Choose a new password</h1>
            <p className="mt-2 text-sm text-muted-foreground">Enter and confirm your new password below.</p>

            {!token ? (
              <Alert variant="destructive" className="mt-6">
                <AlertTitle>Missing reset token</AlertTitle>
                <AlertDescription>
                  This link is missing its token. Request a new one from the{" "}
                  <Link className="font-semibold underline" to="/forgot-password">
                    forgot password
                  </Link>{" "}
                  page.
                </AlertDescription>
              </Alert>
            ) : mutation.isSuccess ? (
              <Alert variant="success" className="mt-6">
                <CheckCircle2 className="h-4 w-4" />
                <AlertTitle>Password updated</AlertTitle>
                <AlertDescription>Redirecting you to sign in...</AlertDescription>
              </Alert>
            ) : (
              <form
                className="mt-7 grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (passwordsMatch) mutation.mutate();
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="reset-password">New password</Label>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="reset-password"
                      className="pl-9"
                      type="password"
                      autoComplete="new-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      minLength={8}
                    />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="reset-password-confirm">Confirm password</Label>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="reset-password-confirm"
                      className="pl-9"
                      type="password"
                      autoComplete="new-password"
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      required
                      minLength={8}
                    />
                  </div>
                  {confirmPassword.length > 0 && password !== confirmPassword && (
                    <p className="text-xs text-destructive">Passwords don't match.</p>
                  )}
                </div>
                <Button type="submit" disabled={mutation.isPending || !passwordsMatch} size="lg">
                  {mutation.isPending ? "Updating..." : "Update password"}
                </Button>
              </form>
            )}

            <Link
              className="mt-6 inline-flex items-center justify-center gap-1 text-center text-sm font-semibold text-primary hover:underline"
              to="/login"
            >
              Back to login
            </Link>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

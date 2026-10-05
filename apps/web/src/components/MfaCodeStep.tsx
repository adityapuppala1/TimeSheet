import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { authApi, type LoginResponse } from "../services/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/**
 * The second step of a password sign-in with two-factor on: a code from the authenticator app, or a
 * recovery code. The password step already passed; nothing is signed in until this succeeds. The
 * challenge it carries lasts five minutes — after that the server says so and "Start again" is the
 * way back, never a dead end.
 */
export function MfaCodeStep({
  mfaToken,
  onSuccess,
  onCancel
}: Readonly<{ mfaToken: string; onSuccess: (data: LoginResponse) => void; onCancel: () => void }>) {
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const verify = useMutation({
    mutationFn: () => authApi.loginMfa(mfaToken, code.trim()),
    onSuccess
  });
  const error = (verify.error as { response?: { data?: { message?: string; code?: string } } } | null)?.response?.data;
  const expired = error?.code === "MFA_CHALLENGE_EXPIRED";
  const ready = useRecovery ? code.replace(/[^a-z0-9]/gi, "").length >= 10 : /^\d{6}$/.test(code.replace(/\s/g, ""));

  return (
    <form
      className="mt-7 grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !verify.isPending) verify.mutate();
      }}
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <p className="text-sm text-muted-foreground">
          {useRecovery
            ? "Enter one of the recovery codes you saved when you set up two-factor sign-in. Each works once."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="mfa-code">{useRecovery ? "Recovery code" : "Verification code"}</Label>
        <Input
          id="mfa-code"
          autoFocus
          autoComplete="one-time-code"
          inputMode={useRecovery ? "text" : "numeric"}
          placeholder={useRecovery ? "ABCDE-FGHJK" : "123456"}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "mfa-error" : undefined}
        />
        {error && (
          <p id="mfa-error" role="alert" className="text-xs text-destructive">
            {error.message ?? "That didn't work. Try again."}
          </p>
        )}
      </div>
      {expired ? (
        <Button type="button" onClick={onCancel}>
          Start again
        </Button>
      ) : (
        <Button type="submit" disabled={!ready || verify.isPending}>
          {verify.isPending ? "Checking…" : "Verify and sign in"}
        </Button>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <button type="button" onClick={onCancel} className="focus-ring inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back
        </button>
        <button
          type="button"
          className="focus-ring rounded text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => {
            setUseRecovery((v) => !v);
            setCode("");
            verify.reset();
          }}
        >
          {useRecovery ? "Use your authenticator app" : "Use a recovery code"}
        </button>
      </div>
    </form>
  );
}

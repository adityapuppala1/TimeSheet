import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";

import { authApi } from "../services/api";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Skeleton } from "./ui/skeleton";
import { toast } from "./ui/toaster";

/**
 * Two-factor sign-in for your own account — set it up, see it, replace recovery codes, turn it off.
 *
 * Used on the Profile page and, with `required`, as the screen a workspace that requires two-factor
 * holds a person at (layouts/AppLayout.tsx). THE SECRET AND THE RECOVERY CODES ARE SHOWN ONCE: the
 * codes stay on screen until "I've saved them", because closing that view is the last chance.
 * The QR code is drawn in the browser — the secret never goes to a third-party image service.
 */

type Phase = { kind: "idle" } | { kind: "scan"; secret: string; otpauthUrl: string } | { kind: "codes"; codes: string[] };

const errorMessage = (error: unknown, fallback: string) =>
  (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

function useQrDataUrl(text: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (!text) return;
    import("qrcode")
      .then((qr) => qr.toDataURL(text, { margin: 1, width: 192 }))
      .then((dataUrl) => live && setUrl(dataUrl))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [text]);
  return url;
}

function RecoveryCodes({ codes, onDone }: Readonly<{ codes: string[]; onDone: () => void }>) {
  const text = codes.join("\n");
  return (
    <div className="grid gap-3">
      <Alert variant="warning">
        <KeyRound className="h-4 w-4" />
        <AlertDescription>
          Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone. They won't be shown again.
        </AlertDescription>
      </Alert>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-border bg-muted/40 p-3 font-mono text-sm" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            navigator.clipboard
              .writeText(text)
              .then(() => toast.success("Recovery codes copied"))
              .catch(() => toast.error("Couldn't copy — select and copy them instead."))
          }
        >
          <Copy className="h-4 w-4" /> Copy
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
            link.download = "timesphere-recovery-codes.txt";
            link.click();
            URL.revokeObjectURL(link.href);
          }}
        >
          <Download className="h-4 w-4" /> Download
        </Button>
        <Button type="button" onClick={onDone}>
          <Check className="h-4 w-4" /> I've saved them
        </Button>
      </div>
    </div>
  );
}

function ScanStep({
  secret,
  otpauthUrl,
  required,
  onConfirmed,
  onCancel
}: Readonly<{ secret: string; otpauthUrl: string; required: boolean; onConfirmed: (codes: string[]) => void; onCancel: () => void }>) {
  const [code, setCode] = useState("");
  const qr = useQrDataUrl(otpauthUrl);
  const confirm = useMutation({
    mutationFn: () => authApi.mfaConfirm(code.trim()),
    onSuccess: (data) => onConfirmed(data.recoveryCodes)
  });
  const valid = /^\d{6}$/.test(code.trim());
  const confirmError = confirm.isError ? errorMessage(confirm.error, "That code doesn't match.") : null;
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) confirm.mutate();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…), then enter the 6-digit
        code it shows.
      </p>
      <div className="flex flex-wrap items-start gap-4">
        <div className="grid h-[192px] w-[192px] place-items-center rounded-md border border-border bg-white">
          {qr ? <img src={qr} alt="QR code for your authenticator app" width={192} height={192} /> : <Skeleton className="h-full w-full" />}
        </div>
        <div className="grid min-w-0 flex-1 gap-1.5">
          <Label>Can't scan? Enter this key</Label>
          <code className="select-all break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm tracking-widest">{secret}</code>
        </div>
      </div>
      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor="mfa-confirm">Code from the app</Label>
        <Input
          id="mfa-confirm"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-invalid={Boolean(confirmError)}
        />
        {confirmError && (
          <p className="text-xs text-destructive" role="alert">
            {confirmError}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!valid || confirm.isPending}>
          {confirm.isPending ? "Checking…" : "Turn on two-factor"}
        </Button>
        {!required && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

type MfaStatus = Awaited<ReturnType<typeof authApi.mfaStatus>>;

function EnabledView({ status, onNewCodes, onChanged }: Readonly<{ status: MfaStatus; onNewCodes: (codes: string[]) => void; onChanged: () => void }>) {
  const [code, setCode] = useState("");
  const [action, setAction] = useState<"disable" | "recovery" | null>(null);
  const manage = useMutation({
    mutationFn: () => (action === "disable" ? authApi.mfaDisable(code.trim()).then(() => null) : authApi.mfaRecoveryCodes(code.trim())),
    onSuccess: (data) => {
      setCode("");
      setAction(null);
      if (data) onNewCodes(data.recoveryCodes);
      else toast.success("Two-factor sign-in is off");
      onChanged();
    }
  });
  const manageError = manage.isError ? errorMessage(manage.error, "That didn't work.") : null;
  const codesLabel = `${status.recoveryCodesLeft} recovery ${status.recoveryCodesLeft === 1 ? "code" : "codes"} left`;
  const cancel = () => {
    setAction(null);
    setCode("");
    manage.reset();
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="success">On</Badge>
        <span className="text-muted-foreground">
          {status.enabledAt ? `Since ${new Date(status.enabledAt).toLocaleDateString()} · ` : ""}
          {codesLabel}
        </span>
        {status.requiredByWorkspace && <Badge variant="muted">Required by this workspace</Badge>}
      </div>
      {status.recoveryCodesLeft <= 2 && (
        <Alert variant="warning">
          <AlertDescription>You're running out of recovery codes. Make new ones so you aren't locked out if you lose your phone.</AlertDescription>
        </Alert>
      )}
      {action ? (
        <form
          className="grid max-w-sm gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim().length >= 6) manage.mutate();
          }}
        >
          <Label htmlFor="mfa-manage">{action === "disable" ? "Enter a current code to turn two-factor off" : "Enter a current code to make new recovery codes"}</Label>
          <Input id="mfa-manage" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} aria-invalid={Boolean(manageError)} />
          {manageError && (
            <p className="text-xs text-destructive" role="alert">
              {manageError}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant={action === "disable" ? "destructive" : "default"} disabled={code.trim().length < 6 || manage.isPending}>
              {action === "disable" ? "Turn off two-factor" : "Make new codes"}
            </Button>
            <Button type="button" variant="outline" onClick={cancel}>
              Cancel
            </Button>
          </div>
          {action === "recovery" && <p className="text-xs text-muted-foreground">Your old recovery codes stop working.</p>}
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setAction("recovery")}>
            <KeyRound className="h-4 w-4" /> New recovery codes
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={status.requiredByWorkspace}
            title={status.requiredByWorkspace ? "This workspace requires two-factor sign-in." : undefined}
            onClick={() => setAction("disable")}
          >
            <ShieldOff className="h-4 w-4" /> Turn off
          </Button>
        </div>
      )}
    </div>
  );
}

export function TwoFactorPanel({ required = false, onEnabled }: Readonly<{ required?: boolean; onEnabled?: () => void }>) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["auth", "mfa"], queryFn: authApi.mfaStatus });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["auth", "mfa"] }).catch(() => undefined);
  };

  const setup = useMutation({
    mutationFn: authApi.mfaSetup,
    onSuccess: (data) => setPhase({ kind: "scan", secret: data.secret, otpauthUrl: data.otpauthUrl }),
    onError: (error) => toast.error(errorMessage(error, "Couldn't start setup. Try again."))
  });

  if (status.isLoading) return <Skeleton className="h-24" />;
  if (status.isError || !status.data) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-2">
          Couldn't load your two-factor settings.
          <Button size="sm" variant="outline" onClick={refresh}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (phase.kind === "codes") {
    return (
      <RecoveryCodes
        codes={phase.codes}
        onDone={() => {
          setPhase({ kind: "idle" });
          onEnabled?.();
        }}
      />
    );
  }
  if (phase.kind === "scan") {
    return (
      <ScanStep
        secret={phase.secret}
        otpauthUrl={phase.otpauthUrl}
        required={required}
        onCancel={() => setPhase({ kind: "idle" })}
        onConfirmed={(codes) => {
          setPhase({ kind: "codes", codes });
          refresh();
        }}
      />
    );
  }
  if (status.data.enabled) {
    return <EnabledView status={status.data} onChanged={refresh} onNewCodes={(codes) => setPhase({ kind: "codes", codes })} />;
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* In `required` mode the screen around it (ForcedMfaSetup) already explains why. */}
      {!required && <p className="text-sm text-muted-foreground">Ask for a code from an authenticator app each time you sign in with a password.</p>}
      <Button type="button" onClick={() => setup.mutate()} disabled={setup.isPending}>
        <ShieldCheck className="h-4 w-4" /> {setup.isPending ? "Starting…" : "Set up two-factor"}
      </Button>
    </div>
  );
}

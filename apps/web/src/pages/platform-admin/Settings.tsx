/**
 * Platform settings: the relay the deployment sends from, who can sign in to this console, the
 * sessions this account holds elsewhere, and the control-plane audit trail. Stripe lives with the
 * plan tiers it prices; the retention policy lives on the retention page next to its queue.
 *
 * LAYOUT (3.12.x). Each tab is one `ConsoleSection`, and every card OWNS its section rather than
 * being handed one by the page — that is what lets the action which saves a card sit in that card's
 * header, where the mutation state already lives. What that fixed:
 *   - the mail form was a two-column grid in which one cell held a nested `grid-cols-[1fr_auto]`
 *     (Port beside a bare switch). Port was therefore a different height from every other control
 *     and the TLS switch floated against the input's baseline. It is now seven plain `Field`s in a
 *     `FieldGrid`, with TLS as its own `SwitchField`, so labels and inputs line up across columns.
 *   - "Send a test to" and "Save mail settings" shared one `justify-between` row that wrapped into a
 *     save button stranded beneath the test input. Saving is the section's action (header
 *     `Toolbar`); the test is a Field + button pair that stacks cleanly on a phone.
 *   - both tables go through `ConsoleTable`. The audit metadata column keeps its 360px truncation,
 *     but the table now carries a minimum width, so a long JSON blob makes the TABLE scroll instead
 *     of squeezing `When`/`Action`/`Who` into three-line wraps.
 *
 * The `Tabs` root is `grid-cols-1`, not a bare `grid`: an implicit `auto` track sizes itself to the
 * widest child, so at 390px the tab strip grew the track past the viewport and "Audit trail" became
 * unreachable. A `minmax(0,1fr)` track clamps it and `TabsList`'s own overflow scrolls it instead.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  KeyRound,
  ListChecks,
  Lock,
  LogOut,
  Monitor,
  MonitorSmartphone,
  Send,
  ServerCog,
  ShieldCheck,
  Smartphone,
  Tablet,
  TerminalSquare
} from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { toast } from "../../components/ui/toaster";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { parseUserAgent, type ParsedUserAgent } from "../../lib/user-agent";
import { exportCsv, type CsvColumn } from "../../utils/console-csv";
import { platformAdminAuthApi, platformAdminConsoleApi, type PlatformAuditRow, type PlatformMailSettings } from "../../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../../store/platform-admin-auth";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, Field, FieldGrid, PRIMARY_BTN, SwitchField, Toolbar, shortDateTime } from "./console-ui";
import { AiAdvisorCard } from "./AiAdvisorCard";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

/* ----------------------------------------------------------------------------------------- */
/* Mail server                                                                                */
/* ----------------------------------------------------------------------------------------- */

/* The card owns its section header, so the page needs the same title/description for the loading
   skeleton — one constant rather than two copies that can drift. */
const MAIL_TITLE = "Platform mail server";
const MAIL_DESCRIPTION =
  "Used for signup codes, the retention programme and the public contact form — anything sent to somebody whose workspace is not there to send from, or who does not have one yet. Falls back to the SMTP_* variables in apps/api/.env when empty.";

function MailServerCard({ settings }: { settings: PlatformMailSettings }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ host: settings.host, port: String(settings.port), secure: settings.secure, user: settings.user, password: "", fromAddress: settings.fromAddress, replyTo: settings.replyTo, salesInboxAddress: settings.salesInboxAddress });
  const [testTo, setTestTo] = useState("");
  const save = useMutation({
    mutationFn: () =>
      platformAdminConsoleApi.updateMailSettings({
        host: form.host,
        port: Number(form.port),
        secure: form.secure,
        user: form.user,
        ...(form.password ? { password: form.password } : {}),
        fromAddress: form.fromAddress,
        replyTo: form.replyTo,
        salesInboxAddress: form.salesInboxAddress
      }),
    onSuccess: () => {
      toast.success("Mail settings saved");
      setForm((f) => ({ ...f, password: "" }));
      queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
    },
    onError: (e) => toast.error("Could not save", { description: errorMessageOf(e) })
  });
  const test = useMutation({
    mutationFn: () => platformAdminConsoleApi.testMail(testTo),
    onSuccess: (r) => toast.success(`Test sent to ${r.to}`),
    onError: (e) => toast.error("Test NOT delivered", { description: errorMessageOf(e) })
  });
  const eff = settings.effective;
  return (
    <ConsoleSection
      title={MAIL_TITLE}
      description={MAIL_DESCRIPTION}
      actions={
        <Toolbar>
          <Button size="sm" className={PRIMARY_BTN} onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save mail settings"}
          </Button>
        </Toolbar>
      }
      bodyClassName="grid gap-5"
    >
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <ServerCog className="h-4 w-4 shrink-0 text-muted-foreground" />
        {eff.configured ? (
          <>
            <span className="min-w-0 break-words">
              Sending through <span className="font-mono">{eff.host}:{eff.port}</span> as <span className="font-mono">{eff.from}</span>
            </span>
            <Badge variant={eff.source === "database" ? "info" : "muted"}>{eff.source === "database" ? "from these settings" : "from apps/api/.env"}</Badge>
          </>
        ) : (
          <span className="text-warning">No relay configured — every platform email is recorded as skipped until one is.</span>
        )}
      </div>
      {/* Three columns only on a wide console: at xl the transport trio (host, port, TLS) lands on
          one line, which is how an operator reads it; below that it degrades to 2-up and then 1-up
          without any control changing shape. */}
      <FieldGrid cols={3}>
        <Field label="SMTP host" htmlFor="pm-host">
          <Input id="pm-host" value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} placeholder="smtp.example.com" />
        </Field>
        <Field label="Port" htmlFor="pm-port">
          <Input id="pm-port" type="number" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
        </Field>
        <SwitchField label="TLS (465)" hint="Implicit TLS from connect. Leave off for STARTTLS on 587." icon={Lock} checked={form.secure} onCheckedChange={(v) => setForm((f) => ({ ...f, secure: v }))} />
        <Field label="Username" htmlFor="pm-user">
          <Input id="pm-user" value={form.user} onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))} autoComplete="off" />
        </Field>
        <Field
          label={
            <span className="flex items-center gap-2">
              Password {settings.passwordSet && <Badge variant="success">set</Badge>}
            </span>
          }
          htmlFor="pm-pass"
        >
          <Input id="pm-pass" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder={settings.passwordSet ? "•••••••• (leave blank to keep)" : ""} autoComplete="new-password" />
        </Field>
        <Field label="From address" htmlFor="pm-from">
          <Input id="pm-from" value={form.fromAddress} onChange={(e) => setForm((f) => ({ ...f, fromAddress: e.target.value }))} placeholder="TimeSphere <no-reply@timesphere.app>" />
        </Field>
        <Field label="Reply-to (optional)" htmlFor="pm-reply">
          <Input id="pm-reply" value={form.replyTo} onChange={(e) => setForm((f) => ({ ...f, replyTo: e.target.value }))} placeholder="hello@timesphere.app" />
        </Field>
        {/* The one address on this card that is not about the RELAY but about where a message
            LANDS. It sits here anyway because it is the same row in the same table, and an operator
            looking for "where does mail go" looks in one place. The hint states the effective value
            so "blank" is never a guess. */}
        <Field label="Sales inbox" htmlFor="pm-sales" hint={`Contact-form enquiries go here. Blank uses ${settings.salesInboxEffective}.`}>
          <Input id="pm-sales" value={form.salesInboxAddress} onChange={(e) => setForm((f) => ({ ...f, salesInboxAddress: e.target.value }))} placeholder={settings.salesInboxEffective} />
        </Field>
      </FieldGrid>
      {/* The test pair gets its own row under a rule instead of sharing a `justify-between` line
          with Save. The input column is capped (an email box does not want 900px) and the button
          keeps the default height so it sits ON the input's baseline rather than beside it. */}
      <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-end">
        <Field label="Send a test to" htmlFor="pm-test">
          <Input id="pm-test" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
        </Field>
        <Button variant="outline" className="justify-self-start gap-1.5" disabled={!testTo.includes("@") || test.isPending} onClick={() => test.mutate()}>
          <Send className="h-4 w-4" />
          {test.isPending ? "Sending…" : "Send test"}
        </Button>
      </div>
    </ConsoleSection>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* This operator's own second factor                                                          */
/* ----------------------------------------------------------------------------------------- */

/**
 * TOTP enrolment for the account that is signed in — nobody else's.
 *
 * WHY EVERY ROLE CAN REACH THIS, INCLUDING READ_ONLY. It is the caller's own credential, exactly
 * like the password change beside it. Making "harden your own sign-in" a privilege would be absurd.
 *
 * WHY IT IS OPT-IN AND THE CARD NAGS INSTEAD OF FORCING. Turning a mandatory second factor on at
 * upgrade time locks out every existing operator on the spot: nobody has enrolled yet, and the
 * people who would fix that are the people who are locked out. It is the same failure mode as a
 * restrictive role default, and the migration had to solve it the same way. Once the fleet has
 * enrolled, a later release can require it.
 *
 * THE SECRET AND THE RECOVERY CODES ARE SHOWN ONCE. The secret is encrypted at rest and the codes
 * are bcrypt-hashed, so neither can be re-displayed — losing the list means re-enrolling, which is
 * a five-minute inconvenience rather than a stored bypass of the factor.
 */
function SecondFactorCard() {
  const queryClient = useQueryClient();
  const setAdmin = usePlatformAdminAuthStore((s) => s.setAdmin);
  const me = usePlatformAdminAuthStore((s) => s.admin);
  const status = useQuery({ queryKey: ["platform-admin", "mfa"], queryFn: platformAdminAuthApi.mfaStatus });

  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["platform-admin", "mfa"] });
    platformAdminAuthApi.me().then(setAdmin).catch(() => undefined);
  };

  const begin = useMutation({
    mutationFn: platformAdminAuthApi.mfaBegin,
    onSuccess: setSetup,
    onError: (e: any) => toast.error("Could not start", { description: e?.response?.data?.message ?? "Try again." })
  });
  const confirm = useMutation({
    mutationFn: () => platformAdminAuthApi.mfaConfirm(code),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      refresh();
    },
    onError: (e: any) => toast.error("That code is not right", { description: e?.response?.data?.message ?? "Check your authenticator's clock." })
  });
  const disable = useMutation({
    mutationFn: () => platformAdminAuthApi.mfaDisable(disablePassword),
    onSuccess: () => {
      setDisableOpen(false);
      setDisablePassword("");
      refresh();
      toast.success("Two-factor authentication is off");
    },
    onError: (e: any) => toast.error("Not turned off", { description: e?.response?.data?.message ?? "Try again." })
  });

  const enabled = status.data?.enabled ?? me?.mfaEnabled ?? false;

  return (
    <ConsoleSection
      title="Two-factor authentication"
      description="A code from your authenticator, on top of your password. This console can reach every customer's database — a leaked password should not be enough to open it."
    >
      {status.isLoading && <Skeleton className="h-32 w-full" />}

      {!status.isLoading && !enabled && !setup && !codes && (
        <div className="grid gap-3">
          <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              This account has no second factor. Your password alone opens a console that can drop any workspace's database, restore over one, and read every stored credential.
            </span>
          </div>
          <Toolbar>
            <Button size="sm" className={`gap-1.5 ${PRIMARY_BTN}`} disabled={begin.isPending} onClick={() => begin.mutate()}>
              <Smartphone className="h-3.5 w-3.5" />
              {begin.isPending ? "Starting…" : "Set up an authenticator"}
            </Button>
          </Toolbar>
        </div>
      )}

      {setup && (
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Add this to your authenticator, then type the six digits it shows. Nothing is switched on until that code checks out — enrolling you into a factor you cannot produce is how a console
            locks out its own owner.
          </p>
          <Field label="Setup key" hint="Type this in by hand if you cannot scan. Case-insensitive; the spaces do not matter.">
            <code className="select-all break-all rounded-md border border-accent/40 bg-muted px-3 py-2 font-mono text-sm tracking-widest">{setup.secret}</code>
          </Field>
          <Field label="otpauth:// URI" hint="Paste into an authenticator that accepts a link rather than a QR code.">
            <code className="select-all break-all rounded-md bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">{setup.otpauthUri}</code>
          </Field>
          <FieldGrid cols={2}>
            <Field label="The six digits" htmlFor="pa-totp">
              <Input id="pa-totp" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            </Field>
          </FieldGrid>
          <Toolbar>
            <Button variant="outline" size="sm" onClick={() => setSetup(null)}>
              Cancel
            </Button>
            <Button size="sm" className={PRIMARY_BTN} disabled={code.trim().length < 6 || confirm.isPending} onClick={() => confirm.mutate()}>
              {confirm.isPending ? "Checking…" : "Turn it on"}
            </Button>
          </Toolbar>
        </div>
      )}

      {codes && (
        <div className="grid gap-3">
          <p className="text-sm">
            Two-factor authentication is on. <span className="font-medium">Save these recovery codes now</span> — each works once, and they are the only way back in if you lose the authenticator.
            They are stored hashed, so they cannot be shown again.
          </p>
          <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 sm:grid-cols-5">
            {codes.map((c) => (
              <code key={c} className="select-all text-center font-mono text-sm tracking-wide">
                {c}
              </code>
            ))}
          </div>
          <Toolbar>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>
              <Copy className="h-3.5 w-3.5" />Copy all
            </Button>
            <Button size="sm" className={PRIMARY_BTN} onClick={() => setCodes(null)}>
              I have saved them
            </Button>
          </Toolbar>
        </div>
      )}

      {!codes && enabled && status.data && (
        <div className="grid gap-3">
          <div className="flex items-start gap-3 rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>
              On since {shortDateTime(status.data.enrolledAt)}. <span className="font-medium">{status.data.recoveryCodesRemaining}</span> recovery code
              {status.data.recoveryCodesRemaining === 1 ? "" : "s"} left.
              {status.data.recoveryCodesRemaining <= 2 && " Turn it off and back on to issue a fresh set."}
            </span>
          </div>
          <Toolbar>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDisableOpen(true)}>
              <Lock className="h-3.5 w-3.5" />Turn it off
            </Button>
          </Toolbar>
        </div>
      )}

      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off two-factor authentication</DialogTitle>
            <DialogDescription>
              Your password is asked for again, exactly as it is when you change it: a walked-away console must not be enough to strip an account's second factor. Every recovery code is destroyed
              with it.
            </DialogDescription>
          </DialogHeader>
          <Input type="password" autoComplete="current-password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} placeholder="Current password" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableOpen(false)}>
              Cancel
            </Button>
            <Button className={PRIMARY_BTN} disabled={disablePassword.length < 8 || disable.isPending} onClick={() => disable.mutate()}>
              Turn it off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConsoleSection>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Sessions + audit                                                                           */
/* ----------------------------------------------------------------------------------------- */

/**
 * A pager. Offset-based and deliberately plain: both lists it serves are ordered by an immutable
 * timestamp, and "page 4 of 12" is a thing an operator reading an audit trail actually wants, in a
 * way it is not for an activity feed.
 */
function Pager({ page, pages, total, unit, onPage }: { page: number; pages: number; total: number; unit: string; onPage: (page: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-5">
      <span className="tabular-nums">
        {total.toLocaleString()} {unit}
        {pages > 1 && ` · page ${page} of ${pages}`}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

const DEVICE_ICON: Record<ParsedUserAgent["device"], typeof Monitor> = {
  desktop: Monitor,
  mobile: Smartphone,
  tablet: Tablet,
  bot: TerminalSquare,
  unknown: MonitorSmartphone
};

/**
 * Your own live console sessions.
 *
 * WHY THE USER AGENT IS PARSED. This list printed the raw header, so nine rows of
 * "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 … HeadlessChrome/151" answered
 * neither question the screen exists for — is one of these not mine, and which do I end? The part
 * that differs is ninety characters in. `parseUserAgent` gives the row a device icon, a browser and
 * an OS; the raw string stays as the row's `title`, because a user agent is self-reported and the
 * summary is a reading of it, not a replacement for it.
 *
 * WHY "END ALL OTHERS" KEEPS YOU SIGNED IN. An operator who has to sign in again to find out
 * whether the revocation worked will not press the button.
 */
function SessionsCard() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const sessions = useQuery({
    queryKey: ["platform-admin", "sessions", page],
    queryFn: () => platformAdminConsoleApi.sessions({ page, limit: 8 })
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["platform-admin", "sessions"] });
  const end = useMutation({
    mutationFn: (id: string) => platformAdminConsoleApi.endSession(id),
    onSuccess: invalidate,
    onError: (e) => toast.error("Not ended", { description: errorMessageOf(e) })
  });
  const endOthers = useMutation({
    mutationFn: () => platformAdminConsoleApi.revokeOtherSessions(),
    onSuccess: (r) => {
      toast.success(r.revoked === 0 ? "There were no other sessions" : `${r.revoked} session${r.revoked === 1 ? "" : "s"} ended`);
      setConfirmOpen(false);
      setPage(1);
      invalidate();
    },
    onError: (e) => toast.error("Could not end them", { description: errorMessageOf(e) })
  });

  const others = Math.max(0, (sessions.data?.total ?? 0) - 1);

  return (
    <ConsoleSection
      title="Your sessions"
      description="Everywhere this account is signed in. Ending one signs that browser out on its next request."
      actions={
        <Toolbar>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={others === 0} onClick={() => setConfirmOpen(true)}>
            <LogOut className="h-3.5 w-3.5" />
            End all others{others > 0 && ` (${others})`}
          </Button>
        </Toolbar>
      }
      flush
    >
      {sessions.isLoading && <div className="p-4 sm:p-5"><Skeleton className="h-40 w-full" /></div>}
      {!sessions.isLoading && !sessions.data?.rows.length && (
        <div className="p-4 sm:p-5">
          <EmptyState title="No live sessions" icon={MonitorSmartphone} />
        </div>
      )}
      {!!sessions.data?.rows.length && (
        <>
          <ul className="divide-y divide-border">
            {sessions.data.rows.map((row) => {
              const ua = parseUserAgent(row.userAgent);
              const Icon = DEVICE_ICON[ua.device];
              return (
                <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <Icon className="h-4 w-4" />
                  </span>
                  {/* The raw header on the title, so the parse is a reading and not a claim. */}
                  <div className="min-w-0 flex-1 basis-[15rem]" title={ua.raw || undefined}>
                    <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                      <span className="truncate font-medium text-foreground">{ua.browser}</span>
                      {ua.os && <span className="text-muted-foreground">on {ua.os}</span>}
                      {row.current && <Badge variant="info">this one</Badge>}
                      {ua.automated && <Badge variant="warning">script</Badge>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{row.ipAddress ?? "—"}</span> · started {shortDateTime(row.createdAt)} · expires {shortDateTime(row.expiresAt)}
                    </p>
                  </div>
                  {!row.current && (
                    <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={() => end.mutate(row.id)} disabled={end.isPending}>
                      End session
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <Pager page={sessions.data.page} pages={sessions.data.pages} total={sessions.data.total} unit="live sessions" onPage={setPage} />
        </>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End every other session?</DialogTitle>
            <DialogDescription>
              {others} other session{others === 1 ? "" : "s"} will be signed out on their next request. This one stays signed in, so you can see that it worked.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button className={PRIMARY_BTN} onClick={() => endOthers.mutate()} disabled={endOthers.isPending}>
              {endOthers.isPending ? "Ending…" : `End ${others} session${others === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConsoleSection>
  );
}

const ACTOR_VARIANT: Record<string, "muted" | "info" | "success"> = { SYSTEM: "muted", CUSTOMER: "info", PLATFORM_ADMIN: "success" };

/**
 * The audit export's columns.
 *
 * The REASON column is here and is not in the table, deliberately. On screen it would push the five
 * existing columns past what fits; in a spreadsheet — which is where an audit trail is actually
 * reviewed, months later, by somebody reconstructing a decision — the operator's own sentence is
 * the most valuable field in the row.
 */
const AUDIT_CSV_COLUMNS: Array<CsvColumn<PlatformAuditRow>> = [
  { header: "When", value: (row) => row.createdAt },
  { header: "Action", value: (row) => row.action },
  { header: "Entity", value: (row) => row.entity },
  { header: "Entity id", value: (row) => row.entityId },
  { header: "Actor type", value: (row) => row.actorType },
  { header: "Actor", value: (row) => row.actorLabel },
  { header: "Reason", value: (row) => row.reason ?? "" },
  { header: "Details", value: (row) => (row.metadata ? JSON.stringify(row.metadata) : "") }
];

/**
 * The control-plane audit trail: paginated and filterable, because it only grows and "who deleted
 * that workspace in June" is the question it exists for — one that an un-paginated "last 120" can
 * never answer.
 *
 * The entity filter's options come from the data (the API groups them), so a new entity type
 * appears in the picker the first time something writes one. No hand-kept list to drift.
 */
function AuditCard() {
  const [page, setPage] = useState(1);
  const [entity, setEntity] = useState("all");
  const [actorType, setActorType] = useState("all");
  const audit = useQuery({
    queryKey: ["platform-admin", "audit", page, entity, actorType],
    queryFn: () => platformAdminConsoleApi.audit({ page, limit: 25, entity, actorType })
  });

  // Changing a filter while on page 7 of the unfiltered list would land on an empty page.
  const setFilter = (next: () => void) => {
    next();
    setPage(1);
  };

  return (
    <ConsoleSection
      title="Control-plane audit trail"
      description="Actions taken on tenants from outside them — provisioning, rescues, retention decisions, settings changes — and what customers did through the retention emails."
      actions={
        <Toolbar>
          <Select value={actorType} onValueChange={(v) => setFilter(() => setActorType(v))}>
            <SelectTrigger className="h-8 w-[9.5rem] text-xs" aria-label="Filter by who acted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Anyone</SelectItem>
              <SelectItem value="PLATFORM_ADMIN">Platform admin</SelectItem>
              <SelectItem value="SYSTEM">Scheduler</SelectItem>
              <SelectItem value="CUSTOMER">Customer</SelectItem>
            </SelectContent>
          </Select>
          <Select value={entity} onValueChange={(v) => setFilter(() => setEntity(v))}>
            <SelectTrigger className="h-8 w-[11rem] text-xs" aria-label="Filter by entity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everything</SelectItem>
              {(audit.data?.entities ?? []).map((e) => (
                <SelectItem key={e.entity} value={e.entity}>
                  {e.entity} ({e.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/*
           * THE PAGE, filtered — and the label says so, because this is the one console table where
           * the export is genuinely a subset of what the filter matches. The audit trail is
           * server-paginated: `audit.data.rows` is the 25 rows on screen, not every row the two
           * selects match, and there is no client-side array to widen it to. Calling the button
           * "Export CSV" here would promise the filter and deliver the page.
           */}
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={!audit.data?.rows.length}
            onClick={() => exportCsv("audit-trail", AUDIT_CSV_COLUMNS, audit.data?.rows ?? [])}
            title="Exports the rows on this page, with the filters above applied."
          >
            <Download className="h-4 w-4" />
            Export page
          </Button>
        </Toolbar>
      }
      flush
    >
      {audit.isLoading && <div className="p-4 sm:p-5"><Skeleton className="h-64 w-full" /></div>}
      {!audit.isLoading && !audit.data?.rows.length && (
        <div className="p-4 sm:p-5">
          <EmptyState title="Nothing recorded for this filter" icon={ListChecks} />
        </div>
      )}
      {!!audit.data?.rows.length && (
        <>
          {/* 1080 is what the five columns need once Details is allowed its 360px: below that the
              browser resolved the overflow by wrapping every other column instead of scrolling. */}
          <ConsoleTable minWidth={1080} className="rounded-none border-x-0 border-b-0">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.data.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{shortDateTime(r.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.action}</TableCell>
                  <TableCell className="text-xs">
                    {r.entity}
                    {r.entityId && <span className="ml-1 font-mono text-[10px] text-muted-foreground">{r.entityId.slice(0, 8)}</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    <Badge variant={ACTOR_VARIANT[r.actorType] ?? "muted"}>{r.actorType.toLowerCase().replace("_", " ")}</Badge>
                    {r.actorLabel && <span className="ml-1.5 text-muted-foreground">{r.actorLabel}</span>}
                  </TableCell>
                  <TableCell className="max-w-[360px] truncate font-mono text-[11px] text-muted-foreground" title={r.metadata ? JSON.stringify(r.metadata) : ""}>
                    {r.metadata ? JSON.stringify(r.metadata) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
          <Pager page={audit.data.page} pages={audit.data.pages} total={audit.data.total} unit="entries" onPage={setPage} />
        </>
      )}
    </ConsoleSection>
  );
}

export function PlatformAdminSettings() {
  const mail = useQuery({ queryKey: ["platform-admin", "mail-settings"], queryFn: platformAdminConsoleApi.mailSettings });
  return (
    <ConsolePage eyebrow="Platform" title="Settings" description="The relay the platform sends from, the advisor's own model, your own second factor and sessions, and everything the control plane has recorded. Who can open this console moved to Access, where roles live.">
      {/* `mt-0` on every panel: `TabsContent` ships its own `mt-3`, which on top of this grid's
          `gap-4` made the gap between the tab strip and the card different from the gap the rest of
          the console uses. One gap, owned by the grid. */}
      <Tabs defaultValue="mail" className="grid min-w-0 grid-cols-1 gap-4">
        <TabsList className="flex w-full min-w-0 justify-start overflow-x-auto sm:w-fit">
          <TabsTrigger value="mail" className="gap-1.5">
            <ServerCog className="h-3.5 w-3.5" />Mail server
          </TabsTrigger>
          <TabsTrigger value="advisor" className="gap-1.5">
            <Brain className="h-3.5 w-3.5" />AI advisor
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />My second factor
          </TabsTrigger>
          <TabsTrigger value="sessions" className="gap-1.5">
            <MonitorSmartphone className="h-3.5 w-3.5" />My sessions
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5">
            <ListChecks className="h-3.5 w-3.5" />Audit trail
          </TabsTrigger>
        </TabsList>
        <TabsContent value="mail" className="mt-0">
          {mail.isLoading && (
            <ConsoleSection title={MAIL_TITLE} description={MAIL_DESCRIPTION}>
              <Skeleton className="h-64 w-full" />
            </ConsoleSection>
          )}
          {mail.data && <MailServerCard key={mail.data.updatedAt ?? "initial"} settings={mail.data} />}
        </TabsContent>
        <TabsContent value="advisor" className="mt-0">
          <AiAdvisorCard />
        </TabsContent>
        <TabsContent value="security" className="mt-0">
          <SecondFactorCard />
        </TabsContent>
        <TabsContent value="sessions" className="mt-0">
          <SessionsCard />
        </TabsContent>
        <TabsContent value="audit" className="mt-0">
          <AuditCard />
        </TabsContent>
      </Tabs>
    </ConsolePage>
  );
}

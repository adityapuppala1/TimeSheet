/**
 * WHAT: the "Single sign-on" tab in Workspace Settings — every way somebody can get into this
 * workspace that isn't a local password, plus SCIM, which is how their account got here.
 *
 * WHY SCIM LIVES HERE AND NOT UNDER "INTEGRATIONS": it is the same workflow. An admin connecting
 * Okta does two things in one sitting — point sign-in at the IdP, and let the IdP create and
 * deactivate the accounts that sign in. Those were two tabs, so the second half was routinely
 * missed, and a workspace ended up with SSO working and joiners still being added by hand. They
 * are one job, so they are one tab.
 *
 * WHY THE CARDS COLLAPSE. Five providers laid out flat is roughly two thousand pixels of form,
 * most of it belonging to providers this workspace will never use. Collapsed, the tab answers the
 * question an admin actually arrives with — *what is switched on, and is it working* — in one
 * screen, and opens the one form they came to fill in. Anything with configuration saved starts
 * open, so nothing an admin has already set up is hidden behind a click.
 *
 * WHY THE BODIES STAY MOUNTED WHILE COLLAPSED (a `grid-template-rows` transition rather than
 * unmounting): each card holds unsaved local state — a half-typed client secret, a pasted
 * certificate. Unmounting a collapsed card would silently discard it the moment somebody clicked
 * a different one.
 *
 * Split out of WorkspaceSettings.tsx for the reason every other settings domain is
 * (SecurityDevOpsSettingsCard.tsx, ChatIntegrationsSettingsCard.tsx, ...): that file is large.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Circle,
  Copy,
  KeyRound,
  LogIn,
  Save,
  ShieldAlert,
  ShieldOff
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { GoogleMark, LdapMark, MicrosoftMark, SamlMark, ScimMark } from "../../components/ui/provider-marks";
import { copyText } from "../../lib/clipboard";
import { apiUrl, SERVER_ORIGIN, settingsApi, type SsoProviderConfig, type SsoTestResult } from "../../services/api";

const SSO_PROVIDER_LABEL: Record<"GOOGLE" | "MICROSOFT", string> = { GOOGLE: "Google", MICROSOFT: "Microsoft / Azure AD" };

/* ── Status ───────────────────────────────────────────────────────────────────────────────────
   Four states, and the distinction that matters is between the middle two. "Ready" means every
   credential is saved but the switch is off — a deliberate staging state an admin uses while
   setting up. "Partial" means they started and stopped, which is the state that silently breaks a
   sign-in button. Collapsing those two into one "not enabled" would hide a mistake behind a
   choice. */
type ProviderState = "live" | "ready" | "partial" | "off";

/** Every mark in provider-marks.tsx takes exactly this, so a card, a tile and a button can share one. */
type ProviderMark = ComponentType<{ className?: string }>;

const STATE_META: Record<ProviderState, { label: string; className: string; dot: string }> = {
  live: { label: "Live", className: "bg-success/10 text-success ring-success/20", dot: "bg-success" },
  ready: { label: "Ready — not switched on", className: "bg-warning/10 text-warning ring-warning/20", dot: "bg-warning" },
  partial: { label: "Half configured", className: "bg-warning/10 text-warning ring-warning/20", dot: "bg-warning" },
  off: { label: "Not set up", className: "bg-muted text-muted-foreground ring-border", dot: "bg-muted-foreground/50" }
};

function stateFrom(complete: boolean, started: boolean, enabled: boolean): ProviderState {
  if (complete) return enabled ? "live" : "ready";
  return started ? "partial" : "off";
}

/** The dot pulses only when something is actually live — an animation that is always running says
 *  nothing, and here it is the one piece of state worth catching from across a room. */
function StatusChip({ state, className = "" }: { state: ProviderState; className?: string }) {
  const meta = STATE_META[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${meta.className} ${className}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {state === "live" && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:hidden ${meta.dot}`} />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      </span>
      {meta.label}
    </span>
  );
}

/* ── The board ────────────────────────────────────────────────────────────────────────────────
   The summary an admin came for, above the forms they didn't. Each tile is a real button that
   opens its card and scrolls to it, so the board is navigation rather than decoration — the thing
   that stops this tab from being five long forms in a trench coat. */
type BoardEntry = { id: string; name: string; blurb: string; state: ProviderState; Mark: ProviderMark };

function ConnectionBoard({ entries, onPick }: { entries: BoardEntry[]; onPick: (id: string) => void }) {
  const liveCount = entries.filter((e) => e.state === "live").length;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-5 py-4">
        <div>
          <CardTitle className="text-base">Connections</CardTitle>
          <CardDescription className="mt-0.5">
            {liveCount === 0
              ? "Nothing is switched on yet — everyone signs in with a password."
              : `${liveCount} ${liveCount === 1 ? "connection is" : "connections are"} live.`}
          </CardDescription>
        </div>
        {/* No chip here on purpose — the line above already says how many are live, and a second
            badge saying the same thing in a different shape reads as a control. */}
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {liveCount} / {entries.length}
        </span>
      </div>
      <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry, i) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onPick(entry.id)}
            style={{ animationDelay: `${i * 45}ms` }}
            className="group flex animate-fade-in items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none motion-reduce:animate-none motion-reduce:transition-none"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
              <entry.Mark className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">{entry.name}</span>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_META[entry.state].dot}`} aria-hidden />
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{entry.blurb}</span>
              <span className="mt-2 block text-xs font-medium text-muted-foreground group-hover:text-primary">
                {STATE_META[entry.state].label}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/* ── The card shell ───────────────────────────────────────────────────────────────────────────
   One shell for all five, so a provider cannot end up with a different icon treatment, a
   differently-worded status, or a header that behaves differently from its neighbours. */
function ProviderShell({
  id,
  name,
  blurb,
  state,
  Mark,
  open,
  onToggle,
  children
}: {
  id: string;
  name: string;
  blurb: string;
  state: ProviderState;
  Mark: ProviderMark;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card id={`sso-card-${id}`} className="overflow-hidden scroll-mt-24 transition-shadow duration-200 hover:shadow-soft">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`sso-body-${id}`}
        className="flex w-full items-start gap-3 p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg transition-colors ${
            state === "live" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
          }`}
        >
          <Mark className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">{name}</span>
            <StatusChip state={state} />
          </span>
          <span className="mt-1 block text-sm leading-6 text-muted-foreground">{blurb}</span>
        </span>
        <ChevronDown
          className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      {/* 0fr → 1fr is the one way to transition to a content-derived height without measuring it
          in JS. The inner element owns the overflow; the outer one owns the animation. */}
      <div
        id={`sso-body-${id}`}
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <CardContent className="grid gap-4 border-t border-border pt-5">{children}</CardContent>
        </div>
      </div>
    </Card>
  );
}

/** The switch rows repeated across every provider, made one component so the wording, spacing and
 *  disabled treatment cannot drift apart between cards. */
function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/20 p-4 transition-colors hover:border-primary/30">
      <div className="min-w-0 flex-1">
        <Label>{label}</Label>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * IT SHOWS TWO DIFFERENT THINGS AND KEEPS THEM APART, which is the entire point.
 *
 *  - "Signed in" is the EVIDENCE: a real person completed a real sign-in through this provider.
 *    It is what unlocks Require SSO, and nothing else does.
 *  - "Connection test" is a DIAGNOSTIC: it tells an admin why a sign-in is failing. A green test
 *    is genuinely conclusive for Google, LDAP and a SAML certificate, and genuinely cannot be for
 *    Microsoft — Azure answers a credential probe before it looks at the credentials. Showing them
 *    as one status would put that Microsoft caveat behind a green tick.
 *
 * Presenting them as one row of two facts is deliberate: an admin looking at a card should be able
 * to see at a glance which of "it is configured", "it answers", and "somebody has actually got in"
 * are true, because those are three different problems with three different fixes.
 */
function SsoVerification({
  provider,
  config,
  readOnly
}: {
  provider: "google" | "microsoft" | "saml" | "ldap";
  config: SsoProviderConfig | undefined;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [probeEmail, setProbeEmail] = useState("");
  const [result, setResult] = useState<SsoTestResult | null>(null);

  const test = useMutation({
    mutationFn: () => settingsApi.testSso(provider, provider === "ldap" && probeEmail ? { probeEmail } : {}),
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["settings", "sso"] });
    },
    onError: (err: any) => {
      // A 422 here is "there is nothing saved to test yet", which is guidance rather than a fault.
      setResult({ ok: false, message: err?.response?.data?.message ?? "The test couldn't run.", testedAt: new Date().toISOString() });
    }
  });

  const shown = result ?? (config?.lastTestStatus ? { ok: config.lastTestStatus === "PASS", message: config.lastTestMessage ?? "", testedAt: config.lastTestedAt ?? "" } : null);
  const signedIn = config?.lastSuccessfulLoginAt ?? null;
  const cert = config?.certificate ?? null;

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1.5">
          <Label>Is this actually working?</Label>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className={`inline-flex items-center gap-1.5 font-medium ${signedIn ? "text-success" : "text-muted-foreground"}`}>
              {signedIn ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3 w-3" />}
              {signedIn ? `Someone signed in ${new Date(signedIn).toLocaleDateString()}` : "Nobody has signed in with this yet"}
            </span>
            {shown && (
              <span className={`inline-flex items-center gap-1.5 ${shown.ok ? "text-muted-foreground" : "text-destructive"}`}>
                {shown.ok ? <Check className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                Last test {shown.ok ? "passed" : "failed"}
                {shown.testedAt ? ` · ${new Date(shown.testedAt).toLocaleDateString()}` : ""}
              </span>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" disabled={readOnly || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? "Testing…" : "Test connection"}
        </Button>
      </div>

      {provider === "ldap" && (
        <div className="grid gap-1.5">
          <Label htmlFor={`probe-${provider}`} className="text-xs font-normal text-muted-foreground">
            Optional — an address to run your user filter against, so the test checks the filter and not just the bind
          </Label>
          <Input
            id={`probe-${provider}`}
            value={probeEmail}
            onChange={(e) => setProbeEmail(e.target.value)}
            placeholder="someone@yourcompany.com"
            disabled={readOnly}
          />
        </div>
      )}

      {shown?.message && (
        <p className={`text-xs leading-5 ${shown.ok ? "text-muted-foreground" : "text-destructive"}`}>{shown.message}</p>
      )}

      {cert && (
        <div className="grid gap-0.5 rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Signing certificate</span>
          <span className="break-all">{cert.subject}</span>
          {/* An expiry an admin cannot see is an outage with a date on it — which is why this is
              rendered even when everything is fine, and coloured only when it is not. */}
          <span className={cert.expired ? "font-semibold text-destructive" : cert.expiringSoon ? "font-semibold text-warning" : ""}>
            {cert.expired ? "Expired" : "Valid until"} {new Date(cert.validTo).toLocaleDateString()}
            {cert.expiringSoon && !cert.expired ? " — renew this soon" : ""}
          </span>
        </div>
      )}

      {!signedIn && config?.isEnabled && (
        <p className="text-xs leading-5 text-muted-foreground">
          Requiring SSO stays locked until someone signs in this way. Open this workspace in a private window, use the
          sign-in button, and come back — that is the only check that proves people will still be able to get in after
          password sign-in is switched off.
        </p>
      )}
    </div>
  );
}

/* ── The five cards ───────────────────────────────────────────────────────────────────────────
   Each takes `open`/`onToggle` from the parent rather than owning it, because the board's tiles
   have to be able to open them. */

type CardProps = { config?: SsoProviderConfig; readOnly: boolean; isLoading: boolean; open: boolean; onToggle: () => void };

/**
 * Phase B4 — per-org SSO configuration. Each org registers its OWN OAuth app with Google/
 * Microsoft (there's no shared client id/secret this app provides), so every field here is
 * that org's own credentials. `clientSecret` is write-only (never echoed back), same masking
 * convention as the AI tab's BYOK API key and the email-intake IMAP password.
 */
function OidcProviderCard({ provider, config, readOnly, isLoading, open, onToggle }: CardProps & { provider: "GOOGLE" | "MICROSOFT" }) {
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState(config?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [tenantHint, setTenantHint] = useState(config?.tenantHint ?? "");

  useEffect(() => {
    setClientId(config?.clientId ?? "");
    setTenantHint(config?.tenantHint ?? "");
  }, [config?.clientId, config?.tenantHint]);

  const save = useMutation({
    mutationFn: (payload: Partial<SsoProviderConfig> & { clientSecret?: string }) =>
      settingsApi.updateSso(provider.toLowerCase() as "google" | "microsoft", payload),
    onSuccess: () => {
      toast.success("Saved");
      setClientSecret("");
      queryClient.invalidateQueries({ queryKey: ["settings", "sso"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const complete = Boolean(config?.clientId && config?.clientSecretSet);
  const started = Boolean(config?.clientId || config?.clientSecretSet);

  return (
    <ProviderShell
      id={provider.toLowerCase()}
      name={SSO_PROVIDER_LABEL[provider]}
      blurb={
        provider === "GOOGLE"
          ? "Register an OAuth client in Google Cloud Console; the redirect URI is fixed regardless of which org configures it."
          : 'Register an app registration in Azure AD; set the tenant ID below (or leave blank for multi-tenant "common").'
      }
      state={stateFrom(complete, started, Boolean(config?.isEnabled))}
      Mark={provider === "GOOGLE" ? GoogleMark : MicrosoftMark}
      open={open}
      onToggle={onToggle}
    >
      {isLoading && <Skeleton className="h-32 w-full" />}
      {!isLoading && (
        <>
          <ToggleRow
            label="Enabled"
            hint={`Show a "Continue with ${SSO_PROVIDER_LABEL[provider]}" button on the login page.`}
            checked={config?.isEnabled ?? false}
            disabled={readOnly || !complete}
            onChange={(v) => save.mutate({ isEnabled: v })}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Client ID</Label>
              <Input value={clientId} disabled={readOnly} onChange={(e) => setClientId(e.target.value)} placeholder="Your OAuth client ID" />
            </div>
            <div className="grid gap-1.5">
              <Label>Client secret {config?.clientSecretSet && <span className="font-normal text-muted-foreground">(saved)</span>}</Label>
              <Input
                type="password"
                value={clientSecret}
                disabled={readOnly}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={config?.clientSecretSet ? "•••••••••••••••• (unchanged)" : "Not set"}
              />
            </div>
          </div>

          {provider === "MICROSOFT" && (
            <div className="grid gap-1.5 sm:w-1/2">
              <Label>Azure AD tenant ID (optional)</Label>
              <Input value={tenantHint} disabled={readOnly} onChange={(e) => setTenantHint(e.target.value)} placeholder='Leave blank for multi-tenant "common"' />
            </div>
          )}

          <Button
            size="sm"
            className="w-fit"
            disabled={readOnly}
            onClick={() =>
              save.mutate({
                clientId: clientId || null,
                tenantHint: tenantHint || null,
                ...(clientSecret ? { clientSecret } : {})
              })
            }
          >
            <Save className="h-4 w-4" />Save
          </Button>

          <SsoVerification provider={provider.toLowerCase() as "google" | "microsoft"} config={config} readOnly={readOnly} />
        </>
      )}
    </ProviderShell>
  );
}

function SamlProviderCard({ config, readOnly, isLoading, open, onToggle }: CardProps) {
  const queryClient = useQueryClient();
  const [idpEntityId, setIdpEntityId] = useState(config?.idpEntityId ?? "");
  const [idpSsoUrl, setIdpSsoUrl] = useState(config?.idpSsoUrl ?? "");
  const [idpCertificate, setIdpCertificate] = useState("");
  const [spEntityId, setSpEntityId] = useState(config?.spEntityId ?? "");

  useEffect(() => {
    setIdpEntityId(config?.idpEntityId ?? "");
    setIdpSsoUrl(config?.idpSsoUrl ?? "");
    setSpEntityId(config?.spEntityId ?? "");
  }, [config?.idpEntityId, config?.idpSsoUrl, config?.spEntityId]);

  const save = useMutation({
    mutationFn: (payload: Partial<SsoProviderConfig> & { idpCertificate?: string }) => settingsApi.updateSso("saml", payload),
    onSuccess: () => {
      toast.success("Saved");
      setIdpCertificate("");
      queryClient.invalidateQueries({ queryKey: ["settings", "sso"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const acsUrl = apiUrl("/auth/sso/saml/acs");
  const complete = Boolean(config?.idpEntityId && config?.idpSsoUrl && config?.idpCertificateSet);
  const started = Boolean(config?.idpEntityId || config?.idpSsoUrl || config?.idpCertificateSet);

  return (
    <ProviderShell
      id="saml"
      name="SAML 2.0"
      blurb="Connect any SAML 2.0 identity provider (Okta, OneLogin, ADFS, ...). Give your IdP admin the ACS URL below and paste their IdP's entity ID, SSO URL, and public signing certificate here."
      state={stateFrom(complete, started, Boolean(config?.isEnabled))}
      Mark={SamlMark}
      open={open}
      onToggle={onToggle}
    >
      {isLoading && <Skeleton className="h-32 w-full" />}
      {!isLoading && (
        <>
          <div className="grid gap-1.5">
            <Label>ACS URL (give this to your IdP admin)</Label>
            <Input readOnly value={acsUrl} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
          </div>

          <ToggleRow
            label="Enabled"
            hint='Show a "Continue with single sign-on" button on the login page.'
            checked={config?.isEnabled ?? false}
            disabled={readOnly || !complete}
            onChange={(v) => save.mutate({ isEnabled: v })}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>IdP entity ID</Label>
              <Input value={idpEntityId} disabled={readOnly} onChange={(e) => setIdpEntityId(e.target.value)} placeholder="https://idp.example.com/entity" />
            </div>
            <div className="grid gap-1.5">
              <Label>IdP SSO URL</Label>
              <Input value={idpSsoUrl} disabled={readOnly} onChange={(e) => setIdpSsoUrl(e.target.value)} placeholder="https://idp.example.com/sso" />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>IdP signing certificate {config?.idpCertificateSet && <span className="font-normal text-muted-foreground">(saved)</span>}</Label>
            <Textarea
              value={idpCertificate}
              disabled={readOnly}
              onChange={(e) => setIdpCertificate(e.target.value)}
              rows={4}
              className="font-mono text-xs"
              placeholder={config?.idpCertificateSet ? "•••••••••••••••• (unchanged) — paste a new PEM certificate to replace it" : "-----BEGIN CERTIFICATE-----..."}
            />
          </div>

          <div className="grid gap-1.5 sm:w-1/2">
            <Label>SP entity ID (optional)</Label>
            <Input value={spEntityId} disabled={readOnly} onChange={(e) => setSpEntityId(e.target.value)} placeholder="Defaults to this workspace's metadata URL" />
          </div>

          <Button
            size="sm"
            className="w-fit"
            disabled={readOnly}
            onClick={() =>
              save.mutate({
                idpEntityId: idpEntityId || null,
                idpSsoUrl: idpSsoUrl || null,
                spEntityId: spEntityId || null,
                ...(idpCertificate ? { idpCertificate } : {})
              })
            }
          >
            <Save className="h-4 w-4" />Save
          </Button>

          <SsoVerification provider="saml" config={config} readOnly={readOnly} />
        </>
      )}
    </ProviderShell>
  );
}

/** LDAP/Active Directory — a direct bind rather than a redirect, so the org admin provides a
 *  service-account bind DN/credential this app uses to look up + verify end users, not an
 *  OAuth app registration. Same write-only-credential masking convention as the other cards. */
function LdapProviderCard({ config, readOnly, isLoading, open, onToggle }: CardProps) {
  const queryClient = useQueryClient();
  const [ldapUrl, setLdapUrl] = useState(config?.ldapUrl ?? "");
  const [ldapBindDn, setLdapBindDn] = useState(config?.ldapBindDn ?? "");
  const [ldapBindCredential, setLdapBindCredential] = useState("");
  const [ldapSearchBase, setLdapSearchBase] = useState(config?.ldapSearchBase ?? "");
  const [ldapUserFilter, setLdapUserFilter] = useState(config?.ldapUserFilter ?? "");

  useEffect(() => {
    setLdapUrl(config?.ldapUrl ?? "");
    setLdapBindDn(config?.ldapBindDn ?? "");
    setLdapSearchBase(config?.ldapSearchBase ?? "");
    setLdapUserFilter(config?.ldapUserFilter ?? "");
  }, [config?.ldapUrl, config?.ldapBindDn, config?.ldapSearchBase, config?.ldapUserFilter]);

  const save = useMutation({
    mutationFn: (payload: Partial<SsoProviderConfig> & { ldapBindCredential?: string }) => settingsApi.updateSso("ldap", payload),
    onSuccess: () => {
      toast.success("Saved");
      setLdapBindCredential("");
      queryClient.invalidateQueries({ queryKey: ["settings", "sso"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const complete = Boolean(config?.ldapUrl && config?.ldapBindDn && config?.ldapBindCredentialSet && config?.ldapSearchBase);
  const started = Boolean(config?.ldapUrl || config?.ldapBindDn || config?.ldapBindCredentialSet || config?.ldapSearchBase);

  return (
    <ProviderShell
      id="ldap"
      name="LDAP / Active Directory"
      blurb="Connect any LDAP directory (Active Directory, OpenLDAP, ...). This app binds as a service account to look up the signing-in user, then rebinds as that user to verify their password."
      state={stateFrom(complete, started, Boolean(config?.isEnabled))}
      Mark={LdapMark}
      open={open}
      onToggle={onToggle}
    >
      {isLoading && <Skeleton className="h-32 w-full" />}
      {!isLoading && (
        <>
          <ToggleRow
            label="Enabled"
            hint="Show a username/password LDAP sign-in form on the login page."
            checked={config?.isEnabled ?? false}
            disabled={readOnly || !complete}
            onChange={(v) => save.mutate({ isEnabled: v })}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Server URL</Label>
              <Input value={ldapUrl} disabled={readOnly} onChange={(e) => setLdapUrl(e.target.value)} placeholder="ldaps://dc.example.com:636" />
            </div>
            <div className="grid gap-1.5">
              <Label>Search base</Label>
              <Input value={ldapSearchBase} disabled={readOnly} onChange={(e) => setLdapSearchBase(e.target.value)} placeholder="dc=example,dc=com" />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Bind DN (service account)</Label>
              <Input
                value={ldapBindDn}
                disabled={readOnly}
                onChange={(e) => setLdapBindDn(e.target.value)}
                placeholder="cn=svc-timesphere,dc=example,dc=com"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Bind credential {config?.ldapBindCredentialSet && <span className="font-normal text-muted-foreground">(saved)</span>}</Label>
              <Input
                type="password"
                value={ldapBindCredential}
                disabled={readOnly}
                onChange={(e) => setLdapBindCredential(e.target.value)}
                placeholder={config?.ldapBindCredentialSet ? "•••••••••••••••• (unchanged)" : "Not set"}
              />
            </div>
          </div>

          <div className="grid gap-1.5 sm:w-1/2">
            <Label>User filter</Label>
            <Input
              value={ldapUserFilter}
              disabled={readOnly}
              onChange={(e) => setLdapUserFilter(e.target.value)}
              placeholder="(mail={{email}})"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">{"{{email}}"} is replaced with the email the person types in at login.</p>
          </div>

          <Button
            size="sm"
            className="w-fit"
            disabled={readOnly}
            onClick={() =>
              save.mutate({
                ldapUrl: ldapUrl || null,
                ldapBindDn: ldapBindDn || null,
                ldapSearchBase: ldapSearchBase || null,
                ldapUserFilter: ldapUserFilter || null,
                ...(ldapBindCredential ? { ldapBindCredential } : {})
              })
            }
          >
            <Save className="h-4 w-4" />Save
          </Button>

          <SsoVerification provider="ldap" config={config} readOnly={readOnly} />
        </>
      )}
    </ProviderShell>
  );
}

function CopyableUrl({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs">{url}</code>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            copyText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

/** Moved here from the Integrations tab — see this file's header for why. The behaviour is
 *  unchanged; only the shell around it is. */
function ScimProvisioningCard({
  readOnly,
  open,
  onToggle,
  state
}: {
  readOnly: boolean;
  open: boolean;
  onToggle: () => void;
  state: ProviderState;
}) {
  const queryClient = useQueryClient();
  const scim = useQuery({ queryKey: ["settings", "scim"], queryFn: settingsApi.getScim });
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const toggleEnabled = useMutation({
    mutationFn: (value: boolean) => settingsApi.updateScimEnabled(value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "scim"] }),
    onError: () => toast.error("Could not update SCIM", { description: "Try again." })
  });

  const rotate = useMutation({
    mutationFn: settingsApi.rotateScimToken,
    onSuccess: (res) => {
      setRevealedToken(res.token);
      queryClient.invalidateQueries({ queryKey: ["settings", "scim"] });
      toast.success("SCIM token generated", { description: "Copy it now — it won't be shown again." });
    },
    onError: () => toast.error("Could not generate a token", { description: "Try again." })
  });

  const disable = useMutation({
    mutationFn: settingsApi.disableScim,
    onSuccess: () => {
      setRevealedToken(null);
      queryClient.invalidateQueries({ queryKey: ["settings", "scim"] });
      toast.success("SCIM disabled");
    },
    onError: () => toast.error("Could not disable SCIM", { description: "Try again." })
  });

  const baseUrl = scim.data ? `${SERVER_ORIGIN || window.location.origin}${scim.data.baseUrl}` : "";

  return (
    <ProviderShell
      id="scim"
      name="SCIM provisioning"
      blurb="Let your identity provider (Okta, Azure AD/Entra, OneLogin, ...) automatically create, deactivate, and reactivate users here when they're provisioned/deprovisioned in your IdP. Covers the Users resource — Groups aren't supported yet."
      state={state}
      Mark={ScimMark}
      open={open}
      onToggle={onToggle}
    >
      {scim.isLoading && <Skeleton className="h-32 w-full" />}
      {!scim.isLoading && scim.data && (
        <>
          <CopyableUrl label="SCIM base URL" url={baseUrl} />

          <Alert>
            <AlertTitle className="text-sm">Configure your IdP's SCIM connector</AlertTitle>
            <AlertDescription className="text-xs">
              Paste the base URL above and the bearer token below into your IdP's SCIM app config. New users provisioned from your
              IdP are created here with the EMPLOYEE role (promote them afterward if needed) and an unusable local password —
              they're expected to sign in via SSO. Deactivating a user in your IdP sets their status to Inactive here; it does not
              delete their history.
            </AlertDescription>
          </Alert>

          {revealedToken && (
            <Alert>
              <KeyRound className="h-4 w-4" />
              <AlertTitle className="text-sm">Your new bearer token (copy it now — shown once)</AlertTitle>
              <AlertDescription>
                <div className="mt-1 flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                  <code className="min-w-0 flex-1 select-all truncate text-xs">{revealedToken}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void copyText(revealedToken);
                      toast.success("Copied");
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <ToggleRow
            label="Enable SCIM provisioning"
            hint="Requires a generated token below — toggling this without one has no effect."
            checked={scim.data.isEnabled}
            disabled={readOnly || toggleEnabled.isPending}
            onChange={(v) => toggleEnabled.mutate(v)}
          />

          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
                <KeyRound className="h-3.5 w-3.5" />
                {scim.data.tokenSet ? "Rotate token" : "Generate token"}
              </Button>
              {scim.data.tokenSet && (
                <Button size="sm" variant="outline" onClick={() => disable.mutate()} disabled={disable.isPending}>
                  <ShieldOff className="h-3.5 w-3.5" />
                  Disable SCIM
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </ProviderShell>
  );
}

/* ── The tab ─────────────────────────────────────────────────────────────────────────────────── */

export function SsoSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "sso"], queryFn: settingsApi.getSso });
  const scim = useQuery({ queryKey: ["settings", "scim"], queryFn: settingsApi.getScim });

  const [openId, setOpenId] = useState<string | null>(null);
  /* Auto-open runs ONCE, when the settings first arrive — not on every render of `settings.data`.
     Without the latch, saving a provider refetches the query and would slam every card the admin
     had collapsed back open mid-edit. */
  const autoOpened = useRef(false);

  const authMethod = useMutation({
    mutationFn: (payload: { passwordLoginEnabled?: boolean; requireSsoOnly?: boolean }) => settingsApi.updateAuthMethod(payload),
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["settings", "sso"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const providerOf = (p: SsoProviderConfig["provider"]) => settings.data?.providers.find((x) => x.provider === p);

  const states = useMemo(() => {
    const g = providerOf("GOOGLE");
    const m = providerOf("MICROSOFT");
    const s = providerOf("SAML");
    const l = providerOf("LDAP");
    const oidc = (c?: SsoProviderConfig) =>
      stateFrom(Boolean(c?.clientId && c?.clientSecretSet), Boolean(c?.clientId || c?.clientSecretSet), Boolean(c?.isEnabled));
    return {
      google: oidc(g),
      microsoft: oidc(m),
      saml: stateFrom(
        Boolean(s?.idpEntityId && s?.idpSsoUrl && s?.idpCertificateSet),
        Boolean(s?.idpEntityId || s?.idpSsoUrl || s?.idpCertificateSet),
        Boolean(s?.isEnabled)
      ),
      ldap: stateFrom(
        Boolean(l?.ldapUrl && l?.ldapBindDn && l?.ldapBindCredentialSet && l?.ldapSearchBase),
        Boolean(l?.ldapUrl || l?.ldapBindDn || l?.ldapBindCredentialSet || l?.ldapSearchBase),
        Boolean(l?.isEnabled)
      ),
      scim: stateFrom(Boolean(scim.data?.tokenSet), Boolean(scim.data?.tokenSet), Boolean(scim.data?.isEnabled))
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data, scim.data]);

  useEffect(() => {
    if (autoOpened.current || !settings.data) return;
    autoOpened.current = true;
    const first = (Object.entries(states) as [string, ProviderState][]).find(([, st]) => st !== "off");
    if (first) setOpenId(first[0]);
  }, [settings.data, states]);

  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));

  /** Opening from the board also has to bring the card into view — a tile that expands something
   *  a screen and a half below it reads as a dead click. */
  const pick = (id: string) => {
    setOpenId(id);
    requestAnimationFrame(() => {
      document.getElementById(`sso-card-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const anyProviderConfigured = states.google === "live" || states.microsoft === "live" || states.saml === "live" || states.ldap === "live";

  const board: BoardEntry[] = [
    { id: "google", name: "Google", blurb: "Workspace accounts, one click", state: states.google, Mark: GoogleMark },
    { id: "microsoft", name: "Microsoft / Entra", blurb: "Azure AD app registration", state: states.microsoft, Mark: MicrosoftMark },
    { id: "saml", name: "SAML 2.0", blurb: "Okta, OneLogin, ADFS, anything", state: states.saml, Mark: SamlMark },
    { id: "ldap", name: "LDAP / AD", blurb: "Direct bind against your directory", state: states.ldap, Mark: LdapMark },
    { id: "scim", name: "SCIM provisioning", blurb: "Accounts created and closed by your IdP", state: states.scim, Mark: ScimMark }
  ];

  return (
    <div className="grid gap-5">
      <ConnectionBoard entries={board} onPick={pick} />

      <Card>
        <CardContent className="grid gap-4 pt-6">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <LogIn className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base">Sign-in methods</CardTitle>
              <CardDescription className="mt-1">
                Control whether people can sign in with a password, SSO, or both — for this workspace only.
              </CardDescription>
            </div>
          </div>

          {settings.isLoading && <Skeleton className="h-20 w-full" />}
          {!settings.isLoading && settings.data && (
            <>
              <ToggleRow
                label="Allow password sign-in"
                hint="Turn off to force everyone through SSO — do this only after confirming at least one provider below works."
                checked={settings.data.passwordLoginEnabled}
                disabled={readOnly}
                onChange={(v) => authMethod.mutate({ passwordLoginEnabled: v })}
              />
              <ToggleRow
                label="Require SSO only"
                hint="When on, password sign-in is disabled regardless of the toggle above."
                checked={settings.data.requireSsoOnly}
                disabled={readOnly || !anyProviderConfigured}
                onChange={(v) => authMethod.mutate({ requireSsoOnly: v })}
              />
              {settings.data.requireSsoOnly && !anyProviderConfigured && (
                <Alert variant="warning">
                  <ShieldAlert />
                  <AlertTitle>No SSO provider is fully configured</AlertTitle>
                  <AlertDescription>Configure and enable at least one provider below before requiring SSO-only sign-in.</AlertDescription>
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {(["GOOGLE", "MICROSOFT"] as const).map((provider) => (
        <OidcProviderCard
          key={provider}
          provider={provider}
          config={providerOf(provider)}
          readOnly={readOnly}
          isLoading={settings.isLoading}
          open={openId === provider.toLowerCase()}
          onToggle={() => toggle(provider.toLowerCase())}
        />
      ))}

      <SamlProviderCard
        config={providerOf("SAML")}
        readOnly={readOnly}
        isLoading={settings.isLoading}
        open={openId === "saml"}
        onToggle={() => toggle("saml")}
      />

      <LdapProviderCard
        config={providerOf("LDAP")}
        readOnly={readOnly}
        isLoading={settings.isLoading}
        open={openId === "ldap"}
        onToggle={() => toggle("ldap")}
      />

      <ScimProvisioningCard readOnly={readOnly} open={openId === "scim"} onToggle={() => toggle("scim")} state={states.scim} />
    </div>
  );
}

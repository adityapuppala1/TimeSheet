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
  Circle,
  Copy,
  KeyRound,
  LogIn,
  Save,
  ShieldAlert,
  ShieldOff
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { SectionBoard, SettingsSection, ToggleRow, type BoardEntry, type SectionState } from "../../components/settings/settings-sections";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { GoogleMark, LdapMark, MicrosoftMark, SamlMark, ScimMark } from "../../components/ui/provider-marks";
import { copyText } from "../../lib/clipboard";
import { apiUrl, SERVER_ORIGIN, settingsApi, type SsoProviderConfig, type SsoTestResult } from "../../services/api";
import { runInBackground } from "../../lib/run-in-background";

const SSO_PROVIDER_LABEL: Record<"GOOGLE" | "MICROSOFT", string> = { GOOGLE: "Google", MICROSOFT: "Microsoft / Azure AD" };

/* ── Status ───────────────────────────────────────────────────────────────────────────────────
   The chip, the board and the folding shell are the shared ones in components/settings/
   settings-sections.tsx — this tab was where that shape was first built, and every long settings
   tab now uses it. What stays here is the one SSO-specific rule: "ready" means every credential is
   saved but the switch is off (a staging state), and "attention" means an admin started and
   stopped — the state that silently breaks a sign-in button. Folding those two into one "not
   enabled" would hide a mistake behind a choice. */
type ProviderState = SectionState;

/** Every mark in provider-marks.tsx takes exactly this, so a card, a tile and a button can share one. */
type ProviderMark = ComponentType<{ className?: string }>;

function stateFrom(complete: boolean, started: boolean, enabled: boolean): ProviderState {
  if (complete) return enabled ? "live" : "ready";
  return started ? "attention" : "off";
}

const STATE_LABEL: Partial<Record<ProviderState, string>> = { attention: "Half configured" };

/** The shell every provider card renders through — the shared section with SSO's ids and labels. */
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
    <SettingsSection id={id} prefix="sso" name={name} blurb={blurb} state={state} stateLabel={STATE_LABEL[state]} Icon={Mark} open={open} onToggle={onToggle}>
      {children}
    </SettingsSection>
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
      runInBackground(queryClient.invalidateQueries({ queryKey: ["settings", "sso"] }));
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
 * Tenant IDs that do NOT restrict sign-in to one organization: blank (the server falls back to
 * Microsoft's `common` authority) and the three aliases somebody could type by hand. Mirrors
 * isMultiTenantMicrosoftAuthority in apps/api/src/services/sso.service.ts — the server logs every
 * sign-in that takes this route; this is the half an admin sees BEFORE that happens.
 */
const MULTI_TENANT_MICROSOFT_AUTHORITIES = new Set(["", "common", "organizations", "consumers"]);
const isMultiTenantMicrosoft = (tenantHint: string) => MULTI_TENANT_MICROSOFT_AUTHORITIES.has(tenantHint.trim().toLowerCase());

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
      runInBackground(queryClient.invalidateQueries({ queryKey: ["settings", "sso"] }));
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const complete = Boolean(config?.clientId && config?.clientSecretSet);
  const started = Boolean(config?.clientId || config?.clientSecretSet);

  /*
   * WARN, DON'T BLOCK. A blank tenant ID works — Microsoft's `common` authority accepts accounts
   * from every directory, and this app matches people by email address — so it is an exposure, not
   * a broken setting. Making the field required would lock out every workspace already signing in
   * this way, so it stays optional and this says plainly what leaving it blank means.
   *
   * Reads the TYPED value, not the saved one, so the warning clears the moment a real ID is entered;
   * and appears only once Microsoft is switched on or being filled in, so the card does not open on
   * an alarm for a provider nobody is using.
   */
  const configuring = Boolean(config?.isEnabled) || started || clientId.trim() !== "" || clientSecret !== "";
  const openToAnyMicrosoftAccount = provider === "MICROSOFT" && configuring && isMultiTenantMicrosoft(tenantHint);

  return (
    <ProviderShell
      id={provider.toLowerCase()}
      name={SSO_PROVIDER_LABEL[provider]}
      blurb={
        provider === "GOOGLE"
          ? "Register an OAuth client in Google Cloud Console; the redirect URI is fixed regardless of which org configures it."
          : "Register an app in Azure AD (Microsoft Entra ID) and enter its Directory (tenant) ID below, so only your organization's accounts can sign in."
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
            <div className="grid gap-3">
              <div className="grid gap-1.5 sm:w-1/2">
                <Label htmlFor="sso-microsoft-tenant">
                  Directory (tenant) ID <span className="font-normal text-muted-foreground">(recommended)</span>
                </Label>
                <Input
                  id="sso-microsoft-tenant"
                  value={tenantHint}
                  disabled={readOnly}
                  onChange={(e) => setTenantHint(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  aria-describedby="sso-microsoft-tenant-hint"
                />
                <p id="sso-microsoft-tenant-hint" className="text-xs text-muted-foreground">
                  On your app registration's Overview page in the Azure portal. It limits sign-in to accounts in your organization.
                </p>
              </div>

              {openToAnyMicrosoftAccount && (
                <Alert variant="warning">
                  <ShieldAlert />
                  <AlertTitle>Without a tenant ID, any Microsoft account can sign in</AlertTitle>
                  <AlertDescription>
                    Microsoft will accept a work account from any other organization and, if your app registration allows them,
                    personal Outlook and Hotmail accounts. People are matched to accounts here by email address alone, so someone
                    outside your organization whose Microsoft account shows a colleague's address could sign in as that colleague —
                    and anyone else can be given a new account. Enter your Directory (tenant) ID to allow only your organization's
                    accounts.
                  </AlertDescription>
                </Alert>
              )}
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
      runInBackground(queryClient.invalidateQueries({ queryKey: ["settings", "sso"] }));
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
      runInBackground(queryClient.invalidateQueries({ queryKey: ["settings", "sso"] }));
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
            runInBackground(copyText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }));
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
      runInBackground(queryClient.invalidateQueries({ queryKey: ["settings", "scim"] }));
      toast.success("SCIM token generated", { description: "Copy it now — it won't be shown again." });
    },
    onError: () => toast.error("Could not generate a token", { description: "Try again." })
  });

  const disable = useMutation({
    mutationFn: settingsApi.disableScim,
    onSuccess: () => {
      setRevealedToken(null);
      runInBackground(queryClient.invalidateQueries({ queryKey: ["settings", "scim"] }));
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
      {scim.isError && !scim.data && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>SCIM settings could not be loaded</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>Provisioning status is unknown. Retry before changing this connection.</span>
            <Button size="sm" variant="outline" onClick={() => scim.refetch()}>Retry</Button>
          </AlertDescription>
        </Alert>
      )}
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
      runInBackground(queryClient.invalidateQueries({ queryKey: ["settings", "sso"] }));
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
      scim: scim.isError && !scim.data
        ? "attention" as const
        : stateFrom(Boolean(scim.data?.tokenSet), Boolean(scim.data?.tokenSet), Boolean(scim.data?.isEnabled))
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data, scim.data, scim.isError]);

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
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById(`sso-section-${id}`)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    });
  };

  const anyProviderConfigured = states.google === "live" || states.microsoft === "live" || states.saml === "live" || states.ldap === "live";

  const tile = (id: string, name: string, blurb: string, state: ProviderState, Icon: ProviderMark): BoardEntry => ({ id, name, blurb, state, stateLabel: STATE_LABEL[state], Icon });
  const board: BoardEntry[] = [
    tile("google", "Google", "Workspace accounts, one click", states.google, GoogleMark),
    tile("microsoft", "Microsoft / Entra", "Azure AD app registration", states.microsoft, MicrosoftMark),
    tile("saml", "SAML 2.0", "Okta, OneLogin, ADFS, anything", states.saml, SamlMark),
    tile("ldap", "LDAP / AD", "Direct bind against your directory", states.ldap, LdapMark),
    tile("scim", "SCIM provisioning", "Accounts created and closed by your IdP", states.scim, ScimMark)
  ];
  if (scim.isError && !scim.data) board[board.length - 1].stateLabel = "Could not load";
  const liveCount = board.filter((e) => e.state === "live").length;
  const unknownCount = scim.isError && !scim.data ? 1 : 0;
  let connectionSummary: string;
  if (unknownCount > 0) connectionSummary = "Some connection status is unavailable; retry before changing sign-in configuration.";
  else if (liveCount === 0) connectionSummary = "Nothing is switched on yet — everyone signs in with a password.";
  else connectionSummary = `${liveCount} ${liveCount === 1 ? "connection is" : "connections are"} live.`;

  if (settings.isError && !settings.data) {
    return (
      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Sign-in settings could not be loaded</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>Provider status is unknown. Retry before changing sign-in methods or provider configuration.</span>
          <Button size="sm" variant="outline" onClick={() => settings.refetch()}>Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-5">
      <SectionBoard
        title="Connections"
        summary={connectionSummary}
        entries={board}
        onPick={pick}
        aside={<span className="text-xs font-medium tabular-nums text-muted-foreground">{liveCount} / {board.length}</span>}
      />

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

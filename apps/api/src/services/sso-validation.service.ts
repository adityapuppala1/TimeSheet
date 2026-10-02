/**
 * WHAT: proves an org's SSO configuration is real before a user has to find out it isn't.
 *
 * WHY IT EXISTS. `PATCH /settings/sso/:provider` validated string LENGTH and almost nothing else:
 * `clientId` was `z.string().max(255)`, so `"abc"` saved cleanly; `idpCertificate` was a 10,000-
 * character string that was never parsed as X.509; `ldapUrl` was not even checked for a scheme.
 * There was no completeness check either, so `isEnabled: true` could be set with every credential
 * field `null`. The result was that a broken configuration looked identical to a working one until
 * a real person clicked "Sign in with Microsoft" and got an opaque error — and, in the worst case,
 * until a super admin who had also set `requireSsoOnly` discovered they had locked their entire
 * workspace out including themselves.
 *
 * WHAT "PROVES" MEANS PER PROVIDER, because it is different in each case:
 *
 *  - GOOGLE: discovery proves the issuer is reachable, then a token exchange with a knowingly-
 *    invalid authorization code reads which error comes back. A wrong client_id/secret answers
 *    `invalid_client`; a correct pair answers `invalid_grant` — the code was bad, which we made it.
 *    That one distinction verifies the credentials with no user, no browser and no redirect.
 *
 *  - MICROSOFT: the tenant, and nothing more. The Google technique does not work on Azure AD, and
 *    the first version of this file shipped a confident PASS because of it: Azure validates the
 *    authorization code's SHAPE first and answers `invalid_grant`/AADSTS9002313 whether the
 *    credentials are a real app registration or two words of English. `client_credentials` and
 *    `/authorize?prompt=none` were both measured against the live endpoint too, and neither
 *    discloses anything either — Azure deliberately does not tell an unauthenticated caller
 *    whether an app registration exists. So the Microsoft branch reports the tenant resolving and
 *    says plainly what it could not prove.
 *
 *  - SAML: there is no credential to exchange — trust flows the other way, from the IdP's signing
 *    certificate. So the test is that the certificate PARSES, has not expired, and that the SSO
 *    endpoint is reachable over HTTPS.
 *
 *  - LDAP: a real bind with the service account, then the real user filter against the real search
 *    base. This is the one provider where the test is exactly what a login does, minus the user's
 *    own password.
 *
 * EVERY OUTBOUND REQUEST HERE GOES THROUGH `assertPublicEgressTarget`. These endpoints fetch a URL
 * the customer typed, from this server, which is textbook SSRF — an IdP URL of
 * `http://169.254.169.254/latest/meta-data/` would otherwise turn an admin settings form into a
 * cloud-credential reader. The guard already exists (utils/egress.ts) and blocks private ranges,
 * link-local and RFC 6761 names; nothing here re-implements it.
 *
 * A FAILED TEST IS NOT AN EXCEPTION. Every function returns `{ ok, message }` rather than throwing,
 * because "your IdP is unreachable" is an ANSWER to the admin's question, not an error in handling
 * it — same contract `/settings/mail/test-connection` already uses.
 *
 * NOTHING HERE GATES `requireSsoOnly`. That switch turns off password sign-in for a whole
 * workspace, and the Microsoft case above is exactly why a probe cannot be trusted with it: a green
 * result that proves nothing is worse than no result at all. The gate is
 * `OrgSsoConfig.lastSuccessfulLoginAt` — a real person completed a real sign-in — and these tests
 * are the diagnostics that tell an admin WHY one has not.
 */
import { X509Certificate } from "node:crypto";
import { Client as LdapClient } from "ldapts";
import { assertPublicEgressTarget } from "../utils/egress.js";
import { buildLdapUserFilter } from "../utils/ldap-filter.js";

/** What a Microsoft test can honestly claim. Also the stored status's meaning: see testStatusFor. */
export const MICROSOFT_UNVERIFIED_VERDICT = "Configuration looks valid — credentials are verified on first sign-in";

export interface SsoTestResult {
  ok: boolean;
  /** Shown verbatim to the admin, so it names the next action wherever one exists. */
  message: string;
  /** Extra facts worth surfacing on the card — a certificate's expiry, a directory's entry count. */
  detail?: Record<string, string | number | boolean>;
}

/**
 * The status a test result is RECORDED as. "PASS" only when the test proved the credentials;
 * "UNVERIFIED" when it reached the provider but could not check them (Microsoft, always — see
 * testOidcConnection), so the card can never show a tick for a check that did not happen.
 */
export function testStatusFor(result: SsoTestResult): "PASS" | "FAIL" | "UNVERIFIED" {
  if (!result.ok) return "FAIL";
  return result.detail?.credentialsVerified === false ? "UNVERIFIED" : "PASS";
}

/** How long any single probe may take. An IdP that needs longer than this to answer a metadata
 *  request is not going to serve a login either, and an admin staring at a spinner learns nothing. */
const PROBE_TIMEOUT_MS = 8000;

/** No real IdP endpoint redirects more than a couple of times; a longer chain is a loop or a probe. */
const MAX_REDIRECTS = 5;

/**
 * Every probe request, through the egress guard — EVERY HOP of it.
 *
 * This used `redirect: "follow"`, after the caller had guarded only the first URL. A sign-on URL on
 * the public internet that answered `302 Location: http://169.254.169.254/latest/meta-data/` walked
 * the probe straight into cloud metadata, and the status code came back to the admin (audit M8). So
 * redirects are followed here, by hand, and each Location is resolved and guarded before it is
 * fetched. Same timeout for the whole chain.
 */
async function guardedFetch(url: string, label: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicEgressTarget(current, label);
      const res = await fetch(current, { ...init, signal: controller.signal, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      current = new URL(location, current).href;
    }
    throw new Error(`it redirected more than ${MAX_REDIRECTS} times`);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Certificates
 * ------------------------------------------------------------------ */

export interface CertificateFacts {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  expired: boolean;
  /** True inside the last 30 days of validity — the window where a renewal has to be scheduled. */
  expiringSoon: boolean;
  fingerprint: string;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Re-armours base64 certificate DER as canonical PEM: one header, 64-character lines, one footer —
 *  the exact shape node-saml's PEM check accepts, whatever line endings the admin's paste carried. */
function canonicalPem(body: string): string {
  const base64 = body.replace(/-----(?:BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return `-----BEGIN CERTIFICATE-----\n${base64.replace(/(.{64})/g, "$1\n").trimEnd()}\n-----END CERTIFICATE-----`;
}

/**
 * Every certificate in a stored IdP certificate field, as canonical PEM.
 *
 * A BUNDLE IS HOW CERTIFICATE ROLLOVER WORKS WITHOUT AN OUTAGE. An IdP that rotates its signing
 * certificate publishes the new one ahead of time; an admin who pastes both (old and new, PEM
 * armoured, one after the other) keeps sign-in working on either side of the switch. The field was
 * always text, so this needs no schema change: one certificate is simply a bundle of one.
 *
 * Accepts the bare base64 an Okta metadata blob carries as well — one certificate, since without the
 * armour there is nothing to split on.
 */
export function certificatePems(raw: string | null | undefined): string[] {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return [];
  if (!trimmed.includes("BEGIN CERTIFICATE")) return [canonicalPem(trimmed)];
  return (trimmed.match(PEM_BLOCK) ?? []).map(canonicalPem);
}

/** Facts about EVERY certificate in the field, or null when any of them cannot be read — a bundle
 *  with one garbled member is a paste that went wrong, and saving it would hide that. */
export function describeCertificates(raw: string | null | undefined): CertificateFacts[] | null {
  const pems = certificatePems(raw);
  if (pems.length === 0) return null;
  const facts = pems.map(describeOne);
  return facts.every((fact): fact is CertificateFacts => fact !== null) ? facts : null;
}

/**
 * Parses a SAML IdP signing certificate field — one certificate or a rollover bundle.
 *
 * Accepts it with or without PEM armour, because IdP admin consoles hand out both: Okta gives a
 * bare base64 blob inside its metadata XML, while ADFS exports a `-----BEGIN CERTIFICATE-----`
 * file. Rejecting the bare form would fail the more common of the two.
 *
 * For a bundle it describes the certificate that expires LAST, because that date — not the old
 * certificate's — is when sign-in actually stops working.
 *
 * Returns null rather than throwing on anything unparseable, so the caller decides whether that is
 * a validation error (on save) or a test failure (on test).
 */
export function describeCertificate(raw: string | null | undefined): CertificateFacts | null {
  const all = describeCertificates(raw);
  if (!all) return null;
  return all.reduce((latest, next) => (next.validTo > latest.validTo ? next : latest));
}

function describeOne(pem: string): CertificateFacts | null {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return null;
  }

  const validTo = new Date(cert.validTo);
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

  return {
    // `subject` and `issuer` are UNDEFINED, not empty strings, when a certificate carries an empty
    // DN — which is legal, and which a self-signed cert generated with a malformed `-subj` produces.
    // Reading them straight threw a TypeError out of a function whose entire contract is "returns
    // null on anything unparseable". Found by a test fixture that happened to be exactly that.
    subject: (cert.subject ?? "(no subject)").split("\n").join(", "),
    issuer: (cert.issuer ?? "(no issuer)").split("\n").join(", "),
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    expired: validTo.getTime() < now,
    expiringSoon: validTo.getTime() >= now && validTo.getTime() - now < THIRTY_DAYS,
    fingerprint: cert.fingerprint256
  };
}

/* ------------------------------------------------------------------ *
 * OIDC — Google / Microsoft
 * ------------------------------------------------------------------ */

/** The same issuers `sso.service.ts#issuerFor` uses at login. Kept in step deliberately: a test
 *  that probed a different endpoint than the login flow would be reassuring and worthless. */
function discoveryUrl(provider: "GOOGLE" | "MICROSOFT", tenantHint: string | null): string {
  return provider === "GOOGLE"
    ? "https://accounts.google.com/.well-known/openid-configuration"
    : `https://login.microsoftonline.com/${tenantHint || "common"}/v2.0/.well-known/openid-configuration`;
}

/**
 * Reads the error code out of an OAuth 2.0 token-endpoint failure.
 *
 * RFC 6749 §5.2 puts it in a JSON `error` field, and both providers comply. Microsoft additionally
 * carries a numbered `AADSTS…` string in `error_description` that says far more than the code does
 * ("Invalid client secret provided" vs a bare `invalid_client`), so that is surfaced when present.
 */
function readOAuthError(body: string): { code: string; description: string } {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    return {
      code: typeof parsed.error === "string" ? parsed.error : "",
      description: typeof parsed.error_description === "string" ? parsed.error_description : ""
    };
  } catch {
    return { code: "", description: body.slice(0, 200) };
  }
}

export async function testOidcConnection(input: {
  provider: "GOOGLE" | "MICROSOFT";
  clientId: string;
  clientSecret: string;
  tenantHint: string | null;
  redirectUri: string;
}): Promise<SsoTestResult> {
  const label = input.provider === "GOOGLE" ? "Google" : "Microsoft";
  const wellKnown = discoveryUrl(input.provider, input.tenantHint);

  let tokenEndpoint: string;
  try {
    const res = await guardedFetch(wellKnown, "The identity provider's discovery URL");
    if (!res.ok) {
      // A wrong Azure tenant ID lands here rather than at the token endpoint — the tenant is part
      // of the discovery path, so an unknown one 400s before any credential is involved.
      return {
        ok: false,
        message:
          input.provider === "MICROSOFT" && input.tenantHint
            ? `Microsoft rejected tenant "${input.tenantHint}" (HTTP ${res.status}). Check the Directory (tenant) ID in your Azure app registration.`
            : `${label}'s discovery endpoint answered HTTP ${res.status}.`
      };
    }
    const meta = (await res.json()) as { token_endpoint?: unknown };
    if (typeof meta.token_endpoint !== "string") {
      return { ok: false, message: `${label}'s discovery document did not include a token endpoint.` };
    }
    tokenEndpoint = meta.token_endpoint;
  } catch (error) {
    return { ok: false, message: `Couldn't reach ${label}: ${(error as Error).message}` };
  }

  // MICROSOFT STOPS HERE, AND THAT IS THE HONEST ANSWER.
  //
  // The probe below works on Google and does not work on Azure AD. Measured against the live
  // endpoint, not assumed: Azure validates the authorization code's SHAPE first and answers
  // `invalid_grant` / AADSTS9002313 ("Invalid request. Request is malformed or invalid") whether
  // the client id and secret are a real app registration or two words of English. Every other
  // unauthenticated probe was tried too — `client_credentials` is refused by conditional-access
  // policy on real tenants and rejected outright on `common`, and `/authorize?prompt=none` answers
  // AADSTS50058 ("no user is signed in") without ever looking at the client. Azure deliberately
  // does not disclose whether an app registration exists to an unauthenticated caller.
  //
  // So this reports what it actually proved — the tenant resolves — and says plainly what it
  // could not. An earlier version of this function returned a confident PASS for a Microsoft
  // config holding the literal string "staged-ahead-of-upgrade", which is precisely the false
  // assurance this whole file was written to remove. `requireSsoOnly` is gated on a completed
  // sign-in for exactly this reason (see OrgSsoConfig.lastSuccessfulLoginAt).
  if (input.provider === "MICROSOFT") {
    // The message LEADS with the verdict the card shows (audit L6): this was recorded and displayed as
    // "Last test passed" with a tick, which is the false assurance described above in a smaller font.
    const endpoint = input.tenantHint ? `tenant "${input.tenantHint}"` : "multi-tenant (common)";
    return {
      ok: true,
      message: `${MICROSOFT_UNVERIFIED_VERDICT}. Microsoft's ${endpoint} endpoint resolved; Azure doesn't let anyone verify a client ID or secret without a real sign-in, so sign in once through the Microsoft button to prove them, and check ${input.redirectUri} is registered as a redirect URI.`,
      detail: { issuer: new URL(wellKnown).origin, redirectUri: input.redirectUri, credentialsVerified: false }
    };
  }

  // THE ACTUAL CREDENTIAL TEST — Google only, per the note above. The code below is deliberately
  // invalid, so a correctly-configured client is expected to FAIL, with `invalid_grant`: the code
  // was bad, which we made it. A complaint about the CLIENT (`invalid_client`, or a 401) means the
  // id/secret pair is wrong, which is the thing being tested. One request, no user interaction.
  try {
    const res = await guardedFetch(tokenEndpoint, "The identity provider's token endpoint", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "timesphere-connection-probe",
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri
      }).toString()
    });

    const { code, description } = readOAuthError(await res.text());

    if (code === "invalid_grant") {
      return {
        ok: true,
        message: `${label} accepted these credentials. The client ID and secret are valid for this app registration.`,
        detail: { issuer: new URL(wellKnown).origin, redirectUri: input.redirectUri }
      };
    }
    if (code === "invalid_client" || res.status === 401) {
      return {
        ok: false,
        message: `${label} rejected the client ID or secret.${description ? ` ${description}` : ""} Re-copy both from your Google Cloud OAuth client — a secret is shown only once when it is created.`
      };
    }
    if (code === "unauthorized_client" || code === "invalid_request") {
      // The credentials were understood; something else about the app registration is wrong —
      // most often the redirect URI, which is the next thing to check and is worth naming.
      return {
        ok: false,
        message: `${label} recognised the client but refused the request (${code}).${description ? ` ${description}` : ""} The most common cause is a redirect URI that isn't registered — add ${input.redirectUri} to the app registration.`
      };
    }
    if (res.ok) {
      // Should be unreachable: a deliberately invalid code cannot mint a token. Reported rather
      // than swallowed, because if it ever happens the assumption behind this whole test is wrong.
      return { ok: false, message: `${label} unexpectedly accepted an invalid authorization code — this test cannot verify these credentials.` };
    }
    return { ok: false, message: `${label} answered HTTP ${res.status}${code ? ` (${code})` : ""}.${description ? ` ${description}` : ""}` };
  } catch (error) {
    return { ok: false, message: `Couldn't reach ${label}'s token endpoint: ${(error as Error).message}` };
  }
}

/* ------------------------------------------------------------------ *
 * SAML
 * ------------------------------------------------------------------ */

export async function testSamlConnection(input: {
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
}): Promise<SsoTestResult> {
  const cert = describeCertificate(input.idpCertificate);
  if (!cert) {
    return { ok: false, message: "The signing certificate isn't a readable X.509 certificate. Copy the whole certificate from your IdP's metadata, including the BEGIN/END lines if it has them." };
  }
  if (cert.expired) {
    return {
      ok: false,
      message: `The signing certificate expired on ${cert.validTo.slice(0, 10)}. Every assertion signed with it will be rejected — get the current certificate from your IdP.`,
      detail: { subject: cert.subject, validTo: cert.validTo }
    };
  }

  // Reachability, not correctness: SAML has no request we can make that proves the relationship is
  // configured on the IdP's side without a browser and a real user. What CAN be proven is that the
  // endpoint exists and answers, which is the failure an admin is most likely to have caused by
  // pasting the wrong one of the several URLs an IdP console shows.
  try {
    const res = await guardedFetch(input.idpSsoUrl, "The IdP sign-on URL", { method: "GET" });
    // Any HTTP answer at all means the endpoint is live. IdPs answer a bare GET with anything from
    // 200 to 405 depending on binding, and none of those is a configuration problem.
    const soon = cert.expiringSoon ? ` The certificate expires on ${cert.validTo.slice(0, 10)} — schedule the rollover.` : "";
    return {
      ok: true,
      message: `Certificate is valid and the sign-on URL answered (HTTP ${res.status}).${soon} SAML can only be fully verified by a real sign-in — this confirms the certificate and endpoint, not that your IdP has this SP registered.`,
      detail: {
        subject: cert.subject,
        issuer: cert.issuer,
        validTo: cert.validTo,
        expiringSoon: cert.expiringSoon,
        fingerprint: cert.fingerprint
      }
    };
  } catch (error) {
    return { ok: false, message: `The certificate is valid, but the sign-on URL couldn't be reached: ${(error as Error).message}` };
  }
}

/* ------------------------------------------------------------------ *
 * LDAP / Active Directory
 * ------------------------------------------------------------------ */

export async function testLdapConnection(input: {
  url: string;
  bindDn: string;
  bindCredential: string;
  searchBase: string;
  userFilter: string;
  tlsRejectUnauthorized: boolean;
  /** Optional address to run the real user filter against, so an admin can check the filter finds
   *  a specific person rather than only that the directory answers. */
  probeEmail?: string;
  /**
   * Whether a connection or bind failure may say WHY. True on a single-org install, where the admin
   * reading it is the operator of the network it describes. False on a multi-org deployment (the
   * caller passes `!env.ROOT_DOMAIN`): there a tenant admin can aim this at any host:port the API
   * can reach, and "ECONNREFUSED" versus a timeout versus "invalid credentials" is a port scanner's
   * answer about the platform's own network (audit M8).
   */
  revealErrors?: boolean;
}): Promise<SsoTestResult> {
  const reveal = input.revealErrors ?? true;
  const why = (error: unknown, hint: string) => (reveal ? `: ${(error as Error).message}` : `. ${hint}`);
  // A directory is normally on a private network, so this cannot use `assertPublicEgressTarget` —
  // that guard exists to stop a customer URL reaching THIS deployment's internals, and an LDAP
  // host legitimately is internal. The scheme check below is the guard that applies here.
  if (!/^ldaps?:\/\//i.test(input.url)) {
    return { ok: false, message: "The directory URL must start with ldap:// or ldaps://." };
  }

  const client = new LdapClient({
    url: input.url,
    ...(input.url.toLowerCase().startsWith("ldaps://") ? { tlsOptions: { rejectUnauthorized: input.tlsRejectUnauthorized } } : {}),
    connectTimeout: 5000,
    timeout: PROBE_TIMEOUT_MS
  });

  try {
    try {
      await client.bind(input.bindDn, input.bindCredential);
    } catch (error) {
      return { ok: false, message: `Couldn't bind to the directory as the service account${why(error, "Check the URL, the bind DN and the bind password")}.` };
    }

    // The filter is only exercised when an address is supplied. Built by the SAME function
    // `authenticateLdap` uses, RFC 4515 escape and every placeholder included — a test that built it
    // differently could pass on a filter the real login path sends differently.
    const filter = input.probeEmail ? buildLdapUserFilter(input.userFilter, input.probeEmail) : "(objectClass=*)";

    const { searchEntries } = await client.search(input.searchBase, {
      filter,
      scope: "sub",
      sizeLimit: 5,
      attributes: ["dn", "mail", "cn"]
    });

    if (input.probeEmail && searchEntries.length === 0) {
      return {
        ok: false,
        message: `Bound successfully, but the filter ${input.userFilter} found nobody matching ${input.probeEmail} under ${input.searchBase}. Check the search base and the filter's attribute name.`
      };
    }
    // Sign-in refuses an ambiguous match (sso.service.ts#authenticateLdap), so the test must say so.
    if (input.probeEmail && searchEntries.length > 1) {
      return {
        ok: false,
        message: `The filter ${input.userFilter} matched ${searchEntries.length} entries for ${input.probeEmail}. Sign-in needs it to match exactly one person — narrow the filter or the search base.`
      };
    }

    return {
      ok: true,
      message: input.probeEmail
        ? `Bound as the service account and found ${input.probeEmail} in the directory. Sign-in will work for anyone this filter matches.`
        : `Bound as the service account and read ${searchEntries.length} ${searchEntries.length === 1 ? "entry" : "entries"} from ${input.searchBase}. Add an email address above to check the user filter as well.`,
      detail: { entriesRead: searchEntries.length, searchBase: input.searchBase }
    };
  } catch (error) {
    return { ok: false, message: `Couldn't search the directory${why(error, "Check the search base and the user filter")}.` };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

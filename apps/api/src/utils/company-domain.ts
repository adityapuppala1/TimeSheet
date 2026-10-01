/**
 * WHAT: the company an email address belongs to — `eng.acme.com` is `acme.com` (decision 9 in
 * docs/SIGNUP_AND_DOMAINS_PLAN.md). One company domain may hold one workspace, so this function is
 * the identity of a customer for signup purposes: two answers for one company would let it open two
 * workspaces, and one answer for two companies would route a stranger into somebody else's.
 *
 * HOW: the registrable domain from the Public Suffix List (tldts, private suffixes ON, so
 * `x.github.io` stays `x.github.io` rather than collapsing every GitHub Pages site into one), with one
 * deliberate exception below.
 */
import { domainToASCII } from "node:url";
import { getDomain } from "tldts";

/**
 * Hosts that hand every customer a sub-domain but are NOT on the Public Suffix List. Rolled up, two
 * unrelated companies on their default addresses would be one company — and the second to sign up
 * would be told to request access to the first's workspace. For these the company domain stops one
 * label below the host. Measured 2026-10-01 against tldts 7.4.11: `getDomain("contoso.onmicrosoft.com")`
 * is "onmicrosoft.com" with private suffixes on AND off. Add a host here only with that measurement.
 */
export const SHARED_EMAIL_HOSTS: ReadonlySet<string> = new Set(["onmicrosoft.com"]);

export function companyDomainOf(email: string): string | null {
  const normalised = email.trim().toLowerCase();
  const at = normalised.lastIndexOf("@");
  if (at < 1 || at === normalised.length - 1) return null;
  // IDN to ASCII first, so `bücher.de` and `xn--bcher-kva.de` are one claim rather than two. An empty
  // result means the host was not a valid domain at all.
  const host = domainToASCII(normalised.slice(at + 1));
  if (!host) return null;
  const registrable = getDomain(host, { allowPrivateDomains: true });
  if (!registrable) return null;
  if (!SHARED_EMAIL_HOSTS.has(registrable)) return registrable;
  // One label below the shared host: `eng.contoso.onmicrosoft.com` → `contoso.onmicrosoft.com`. The
  // bare shared host itself is nobody's company.
  const labels = host.split(".");
  const sharedLabels = registrable.split(".").length;
  if (labels.length <= sharedLabels) return null;
  return labels.slice(-(sharedLabels + 1)).join(".");
}

/**
 * WHAT: a continuously scrolling strip of the systems TimeSphere actually connects to.
 *
 * WHY THIS AND NOT A LOGO WALL: the marketing pages' one rule is that every claim maps to shipped
 * code, and its corollary in `docs/MARKETING_PAGES.md` is that we claim no traction — "there are
 * no customer counts, revenue figures or logos on these pages, because there are none to cite."
 * A row of customer logos is the thing this device usually carries and the thing we may not show.
 *
 * So it carries INTEGRATIONS instead: every entry below is a connector with a controller, a
 * settings surface and a row in the docs. It reads the way a trust strip reads, and every item on
 * it is checkable.
 *
 * WHY CSS AND NOT A LIBRARY: an infinite marquee is a translate on a duplicated track. The landing
 * page deliberately ships no animation library (see `Landing.tsx`'s header), and this is exactly
 * the kind of effect that argument was about.
 *
 * REDUCED MOTION: the track stops and wraps instead of scrolling — see `.connector-marquee` in
 * index.css. The content is the point; the movement is not.
 */

interface Connector {
  name: string;
  /** What it actually does here, shown on hover — a strip of names alone is decoration. */
  detail: string;
}

/**
 * Every one of these is a shipped connector, not a roadmap item. Grouped loosely by kind so the
 * strip reads as a sentence rather than a jumble as it passes.
 */
const CONNECTORS: Connector[] = [
  { name: "Google", detail: "SSO — sign in with a Google Workspace account" },
  { name: "Microsoft / Azure AD", detail: "SSO — OIDC against your own tenant" },
  { name: "SAML 2.0", detail: "SSO — Okta, OneLogin, ADFS, any SAML IdP" },
  { name: "LDAP / Active Directory", detail: "SSO — direct bind, no redirect" },
  { name: "Slack", detail: "Chat intake — a message becomes a triaged ticket" },
  { name: "Microsoft Teams", detail: "Chat intake — signature-verified webhook" },
  { name: "Google Chat", detail: "Chat intake — signature-verified webhook" },
  { name: "Telegram", detail: "Chat intake — polled, so it needs no public endpoint" },
  { name: "GitHub", detail: "Live repos, branches and PRs on a ticket, via your own OAuth app" },
  { name: "IMAP", detail: "Email intake — a bug report becomes a routed ticket" },
  { name: "SMTP", detail: "Outbound mail, with per-workspace credentials and delivery analytics" },
  { name: "Stripe", detail: "Billing, on the platform's own account" },
  { name: "Model Context Protocol", detail: "This workspace, exposed as tools to an AI assistant" },
  { name: "Anthropic", detail: "AI — bring your own key" },
  { name: "OpenAI-compatible", detail: "AI — OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, Ollama…" },
  { name: "GitHub Actions", detail: "CI test runs and security findings, ingested" },
  { name: "GitLab CI", detail: "CI test runs and security findings, ingested" },
  { name: "Jenkins", detail: "CI test runs and security findings, ingested" }
];

/**
 * Exported so the stat band counts the same list this strip renders. Two places claiming a number
 * about the same array is how a marketing page ends up saying "18" beside nineteen logos.
 */
export const CONNECTOR_COUNT = CONNECTORS.length;

export function ConnectorMarquee() {
  return (
    <div className="connector-marquee" aria-label={`Connects to ${CONNECTORS.length} systems`}>
      {/*
        The track is rendered TWICE and the animation translates by exactly -50%, so the second copy
        arrives where the first began and the loop has no seam. The duplicate is `aria-hidden` — a
        screen reader should hear this list once, and the label above already counts it.
      */}
      <div className="connector-marquee__track">
        {[0, 1].map((copy) => (
          <ul key={copy} className="connector-marquee__group" aria-hidden={copy === 1 || undefined}>
            {CONNECTORS.map((connector) => (
              <li key={`${copy}-${connector.name}`} className="connector-marquee__item" title={connector.detail}>
                <span className="connector-marquee__dot" aria-hidden />
                {connector.name}
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}

/**
 * The systems TimeSphere actually connects to — the one list, and the count the stat band quotes.
 *
 * WHY THIS IS DATA AND NOT A COMPONENT: it used to live inside ConnectorMarquee.tsx, whose own
 * comment warned that "two places claiming a number about the same array is how a marketing page
 * ends up saying 18 beside nineteen logos". When the marquee was replaced by ConnectorConstellation
 * the new component wrote its own grouped copy — and immediately proved the point by claiming 17
 * beside a stat band saying 18, because GitHub Actions got folded into GitHub along the way. So the
 * list moved here, the grouping moved into the data, and both the diagram and the count are now
 * derived from it. Neither can disagree with the other again.
 *
 * THE MARKETING RULE these entries exist to satisfy: `docs/MARKETING_PAGES.md` forbids customer
 * logos ("there are no customer counts, revenue figures or logos on these pages, because there are
 * none to cite"). Integrations are what that device carries here instead, and every one below is
 * SHIPPED — a controller, a settings surface and a row in the docs. Nothing aspirational goes in
 * this file; the roadmap is a different document.
 */

import type { ComponentType } from "react";
import { GoogleMark, LdapMark, MicrosoftMark, SamlMark } from "../ui/provider-marks";
import {
  AnthropicMark,
  GitHubActionsMark,
  GitHubMark,
  GitLabMark,
  GoogleChatMark,
  ImapMark,
  JenkinsMark,
  McpMark,
  OpenAiMark,
  SlackMark,
  SmtpMark,
  StripeMark,
  TeamsMark,
  TelegramMark
} from "./connector-marks";

/** Which family a connector belongs to in the constellation diagram. */
export type ConnectorGroup = "identity" | "chat" | "code" | "mail" | "ai" | "billing";

export interface Connector {
  name: string;
  /** What it actually does here — a strip of names alone is decoration. */
  detail: string;
  group: ConnectorGroup;
  /** The connector's own mark. See connector-marks.tsx for why these are likenesses built from
   *  primitives rather than copied logo path data. */
  Mark: ComponentType<{ className?: string }>;
}

export const CONNECTORS: Connector[] = [
  { name: "Google", detail: "SSO — sign in with a Google Workspace account", group: "identity", Mark: GoogleMark },
  { name: "Microsoft / Azure AD", detail: "SSO — OIDC against your own tenant", group: "identity", Mark: MicrosoftMark },
  { name: "SAML 2.0", detail: "SSO — Okta, OneLogin, ADFS, any SAML IdP", group: "identity", Mark: SamlMark },
  { name: "LDAP / Active Directory", detail: "SSO — direct bind, no redirect", group: "identity", Mark: LdapMark },
  { name: "Slack", detail: "Chat intake — a message becomes a triaged ticket", group: "chat", Mark: SlackMark },
  { name: "Microsoft Teams", detail: "Chat intake — signature-verified webhook", group: "chat", Mark: TeamsMark },
  { name: "Google Chat", detail: "Chat intake — signature-verified webhook", group: "chat", Mark: GoogleChatMark },
  { name: "Telegram", detail: "Chat intake — polled, so it needs no public endpoint", group: "chat", Mark: TelegramMark },
  { name: "GitHub", detail: "Live repos, branches and PRs on a ticket, via your own OAuth app", group: "code", Mark: GitHubMark },
  { name: "GitHub Actions", detail: "CI test runs and security findings, ingested", group: "code", Mark: GitHubActionsMark },
  { name: "GitLab CI", detail: "CI test runs and security findings, ingested", group: "code", Mark: GitLabMark },
  { name: "Jenkins", detail: "CI test runs and security findings, ingested", group: "code", Mark: JenkinsMark },
  { name: "IMAP", detail: "Email intake — a bug report becomes a routed ticket", group: "mail", Mark: ImapMark },
  { name: "SMTP", detail: "Outbound mail, with per-workspace credentials and delivery analytics", group: "mail", Mark: SmtpMark },
  { name: "Anthropic", detail: "AI — bring your own key", group: "ai", Mark: AnthropicMark },
  { name: "OpenAI-compatible", detail: "AI — OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, Ollama…", group: "ai", Mark: OpenAiMark },
  { name: "Model Context Protocol", detail: "This workspace, exposed as tools to an AI assistant", group: "ai", Mark: McpMark },
  { name: "Stripe", detail: "Billing, on the platform's own account", group: "billing", Mark: StripeMark }
];

/** Counted, never written down. The stat band renders this beside a diagram built from the same
 *  array, so the number and the picture cannot disagree. */
export const CONNECTOR_COUNT = CONNECTORS.length;

export function connectorsIn(group: ConnectorGroup): Connector[] {
  return CONNECTORS.filter((c) => c.group === group);
}

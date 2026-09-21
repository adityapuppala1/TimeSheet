/**
 * Pure rules the settings boards read their states from — kept out of the components so a tile's
 * colour is a tested decision rather than an expression somebody wrote inline four times.
 *
 * The four states are settings-sections.tsx's: live / ready / attention / off. What each tab
 * means by them is decided here, once per tab.
 */
import type { ChatIntegrationRow, ChatPlatform } from "@timesheet/shared";
import type { SectionState } from "../components/settings/settings-sections";

export interface StateVerdict {
  state: SectionState;
  label?: string;
}

/** What "configured" means per platform — exactly the check the card's Enabled switch is gated on,
 *  so the board can never call a platform ready that the switch would refuse. */
export function chatPlatformConfigured(row: Pick<ChatIntegrationRow, "platform" | "botTokenSet" | "signingSecretSet" | "teamsAppId" | "teamsAppPasswordSet" | "googleChatWebhookUrl">): boolean {
  switch (row.platform) {
    case "GOOGLE_CHAT":
      return Boolean(row.googleChatWebhookUrl && row.signingSecretSet);
    case "MICROSOFT_TEAMS":
      return Boolean(row.teamsAppId && row.teamsAppPasswordSet);
    case "SLACK":
    case "TELEGRAM":
      return Boolean(row.botTokenSet);
  }
}

/** Has the admin started on this platform without finishing? The state that silently breaks a bot. */
function chatPlatformStarted(row: Pick<ChatIntegrationRow, "botTokenSet" | "signingSecretSet" | "teamsAppId" | "teamsAppPasswordSet" | "googleChatWebhookUrl">): boolean {
  return Boolean(row.botTokenSet || row.signingSecretSet || row.teamsAppId || row.teamsAppPasswordSet || row.googleChatWebhookUrl);
}

export function chatPlatformState(row: ChatIntegrationRow, allowed: boolean): StateVerdict {
  if (!allowed) return { state: "off", label: "Not on this plan" };
  const configured = chatPlatformConfigured(row);
  if (configured && row.isEnabled) return row.lastError ? { state: "attention", label: "Live — last event failed" } : { state: "live" };
  if (configured) return { state: "ready" };
  if (chatPlatformStarted(row)) return { state: "attention", label: "Half configured" };
  return { state: "off" };
}

export const CHAT_PLATFORM_LABEL: Record<ChatPlatform, string> = {
  SLACK: "Slack",
  MICROSOFT_TEAMS: "Microsoft Teams",
  GOOGLE_CHAT: "Google Chat",
  TELEGRAM: "Telegram"
};

/** "3 minutes ago", "2 days ago" — coarse on purpose; a settings board is not a stopwatch. */
export function agoLabel(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.round(days / 30);
  return `${months} ${months === 1 ? "month" : "months"} ago`;
}

/* ── Tile verdicts per tab ───────────────────────────────────────────────────────────────────
   One small function per tile, if/return rather than a ternary chain, so the board reads as a
   list of names and each rule can be tested on its own. `value` is the tile's one figure. */
export interface TileVerdict extends StateVerdict {
  value?: string;
}

export const onOff = (b: boolean): string => (b ? "on" : "off");

/** "1 rule", "3 rules" — the plural the tiles keep spelling out. */
export const countOf = (n: number, singular: string, plural = `${singular}s`): string => `${n} ${n === 1 ? singular : plural}`;

// ── AI
export function aiFeaturesVerdict(aiOn: boolean, keyed: boolean): TileVerdict {
  if (!aiOn) return { state: "off", label: "Switched off", value: "Off" };
  if (!keyed) return { state: "attention", label: "On — no key or provider", value: "On" };
  return { state: "live", label: "Live", value: "On" };
}

export function aiCapabilitiesVerdict(aiOn: boolean, capsOn: number, total: number, autonomyEnabled: boolean): TileVerdict {
  const value = total ? `${capsOn} of ${total} on` : "—";
  if (!aiOn) return { state: "off", label: "AI is off", value };
  if (capsOn === 0) return { state: "ready", label: "Nothing switched on", value };
  return { state: "live", label: autonomyEnabled ? "Live — may act alone" : "Live — suggest only", value };
}

export function aiPromptsVerdict(customised: number, total: number | undefined): TileVerdict {
  const value = total === undefined ? undefined : `${customised} customised of ${total}`;
  if (customised > 0) return { state: "live", label: "Customised", value };
  return { state: "ready", label: "Built-in prompts", value };
}

export function aiDatasetsVerdict(count: number | undefined): TileVerdict {
  if (count === undefined) return { state: "off", label: "None yet" };
  if (count === 0) return { state: "off", label: "None yet", value: "0 datasets" };
  return { state: "live", label: "Ready to measure", value: `${count} ${count === 1 ? "dataset" : "datasets"}` };
}

export function aiEvalsVerdict(datasetCount: number): TileVerdict {
  return datasetCount > 0 ? { state: "ready", label: "Ready to run" } : { state: "off", label: "Needs a dataset" };
}

export function aiSpendVerdict(spend: number | undefined, budget: number | null | undefined, aiOn: boolean): TileVerdict {
  if (!aiOn) return { state: "off", value: "AI is off" };
  if (spend === undefined) return { state: "live", value: "…" };
  if (!budget) return { state: "live", label: "No cap set", value: `$${spend.toFixed(2)} this period` };
  const share = spend / budget;
  const value = `$${spend.toFixed(2)} of $${budget}`;
  if (share >= 1) return { state: "attention", label: "Budget reached", value };
  if (share >= 0.8) return { state: "attention", label: `${Math.round(share * 100)}% of budget`, value };
  return { state: "live", label: `${Math.round(share * 100)}% of budget`, value };
}

// ── MCP
export function mcpEndpointVerdict(enabled: boolean, allowWrites: boolean): TileVerdict {
  if (!enabled) return { state: "off", label: "Switched off", value: "Off" };
  if (allowWrites) return { state: "attention", label: "Live — writes allowed", value: "On · writes allowed" };
  return { state: "live", label: "Live, read-only", value: "On · read-only" };
}

export function mcpToolsVerdict(enabled: boolean, toolsOn: number, total: number | undefined): TileVerdict {
  const value = total === undefined ? undefined : `${toolsOn} of ${total} on`;
  if (toolsOn === 0) return { state: "off", label: "None offered", value };
  if (!enabled) return { state: "ready", label: "Ready — endpoint is off", value };
  return { state: "live", label: "Offered", value };
}

export function mcpCredentialsVerdict(enabled: boolean, active: number, loaded: boolean): TileVerdict {
  const value = loaded ? `${active} active` : undefined;
  if (active === 0) return { state: "off", label: "None issued", value };
  if (!enabled) return { state: "ready", label: "Issued — endpoint is off", value };
  return { state: "live", label: "Issued", value };
}

// ── Security & DevOps
export function devopsGitVerdict(git: { connected: boolean; clientIdSet: boolean; accountLogin: string | null; webhookSecretSet: boolean } | undefined): TileVerdict {
  if (!git) return { state: "off", label: "Not set up" };
  if (git.connected) return { state: "live", label: "Connected", value: `GitHub as ${git.accountLogin ?? "connected"}` };
  if (git.clientIdSet) return { state: "ready", label: "Credentials saved — not connected" };
  if (git.webhookSecretSet) return { state: "ready", label: "Webhook only", value: "Webhook secret set" };
  return { state: "off", label: "Not set up" };
}

export function liveOrOff(live: boolean, liveLabel: string, offLabel: string, value?: string): TileVerdict {
  return live ? { state: "live", label: liveLabel, value } : { state: "off", label: offLabel, value };
}

// ── Face verification
export function facePolicyVerdict(allowedByPlan: boolean, enabled: boolean, everyone: boolean): TileVerdict {
  let value = "Off";
  if (!allowedByPlan) value = "Enterprise plan";
  else if (enabled) value = everyone ? "On · everyone" : "On · selected people";
  return enabled ? { state: "live", label: "Checking", value } : { state: "off", label: "Switched off", value };
}

export function faceLogVerdict(flagged: number, enabled: boolean, loaded: boolean): TileVerdict {
  const value = loaded ? `${flagged} flagged pending` : undefined;
  if (flagged > 0) return { state: "attention", label: "Needs review", value };
  if (enabled) return { state: "live", label: "Nothing waiting", value };
  return { state: "off", label: "Read-only history", value };
}

// ── Change management
export function changeSettingsVerdict(entitled: boolean, requested: boolean, slaHours: number): TileVerdict {
  const on = entitled && requested;
  let value = "Off";
  if (!entitled) value = "Not in your plan";
  else if (on) value = `On · ${slaHours}h approval SLA`;
  if (on) return { state: "live", label: "Live", value };
  if (requested) return { state: "attention", label: "On, but not in your plan", value };
  return { state: "off", label: "Switched off", value };
}

export function catalogueVerdict(rows: Array<{ isActive?: boolean }> | undefined): TileVerdict {
  if (!rows) return { state: "off", label: "Nothing here yet" };
  const active = rows.filter((r) => r.isActive !== false).length;
  const value = rows.length === active ? `${active} active` : `${active} active of ${rows.length}`;
  return active > 0 ? { state: "live", label: "In the form", value } : { state: "off", label: "Nothing here yet", value };
}

// ── Chat
export function chatSwitchTitle(allowed: boolean, configured: boolean, enabled: boolean): string {
  if (!allowed) return "Not available on this workspace's plan";
  if (!configured) return "Save the credentials first";
  return enabled ? "Pause: stop turning messages into tickets" : "Start turning messages into tickets";
}

export function chatFormLead(allowed: boolean, configured: boolean): string {
  if (!allowed) return "Not available on this workspace's current plan.";
  if (configured) return "Messages sent to your bot are AI-triaged into tickets automatically. Pause or resume with the switch in the header.";
  return "Save the credentials below, then switch it on from the header.";
}

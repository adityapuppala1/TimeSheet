/**
 * lib/settings-state.ts: the rules the settings boards colour their tiles by. A tile's state is
 * a decision an admin acts on ("half configured" is the one that silently breaks a bot), so the
 * rule is pinned here rather than living inline in a component.
 */
import type { ChatIntegrationRow } from "@timesheet/shared";
import { describe, expect, it } from "vitest";
import { agoLabel, chatPlatformConfigured, chatPlatformState } from "../../src/lib/settings-state";

const row = (over: Partial<ChatIntegrationRow>): ChatIntegrationRow => ({
  platform: "SLACK",
  isEnabled: false,
  botTokenSet: false,
  signingSecretSet: false,
  teamsAppId: null,
  teamsAppPasswordSet: false,
  googleChatWebhookUrl: null,
  defaultProjectId: null,
  lastEventAt: null,
  lastError: null,
  ...over
});

describe("chatPlatformConfigured", () => {
  it("is the same check per platform the Enabled switch is gated on", () => {
    expect(chatPlatformConfigured(row({ platform: "SLACK", botTokenSet: true }))).toBe(true);
    expect(chatPlatformConfigured(row({ platform: "TELEGRAM", botTokenSet: true }))).toBe(true);
    expect(chatPlatformConfigured(row({ platform: "MICROSOFT_TEAMS", teamsAppId: "app", teamsAppPasswordSet: true }))).toBe(true);
    expect(chatPlatformConfigured(row({ platform: "MICROSOFT_TEAMS", teamsAppId: "app" }))).toBe(false);
    expect(chatPlatformConfigured(row({ platform: "GOOGLE_CHAT", googleChatWebhookUrl: "https://x", signingSecretSet: true }))).toBe(true);
    expect(chatPlatformConfigured(row({ platform: "GOOGLE_CHAT", googleChatWebhookUrl: "https://x" }))).toBe(false);
  });
});

describe("chatPlatformState", () => {
  it("is off when nothing was entered, and says so when the plan excludes the platform", () => {
    expect(chatPlatformState(row({}), true)).toEqual({ state: "off" });
    expect(chatPlatformState(row({ botTokenSet: true, isEnabled: true }), false)).toEqual({ state: "off", label: "Not on this plan" });
  });

  it("distinguishes half configured from ready from live", () => {
    expect(chatPlatformState(row({ platform: "MICROSOFT_TEAMS", teamsAppId: "app" }), true)).toEqual({ state: "attention", label: "Half configured" });
    expect(chatPlatformState(row({ botTokenSet: true }), true)).toEqual({ state: "ready" });
    expect(chatPlatformState(row({ botTokenSet: true, isEnabled: true }), true)).toEqual({ state: "live" });
  });

  it("keeps a live platform whose last event failed visible as needing attention", () => {
    expect(chatPlatformState(row({ botTokenSet: true, isEnabled: true, lastError: "401 from Slack" }), true)).toEqual({ state: "attention", label: "Live — last event failed" });
  });
});

describe("agoLabel", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  it("is coarse on purpose", () => {
    expect(agoLabel("2026-09-21T11:59:40Z", now)).toBe("just now");
    expect(agoLabel("2026-09-21T11:45:00Z", now)).toBe("15 minutes ago");
    expect(agoLabel("2026-09-21T09:00:00Z", now)).toBe("3 hours ago");
    expect(agoLabel("2026-09-19T12:00:00Z", now)).toBe("2 days ago");
    expect(agoLabel("2026-06-21T12:00:00Z", now)).toBe("3 months ago");
  });
  it("is null for nothing and for garbage", () => {
    expect(agoLabel(null, now)).toBeNull();
    expect(agoLabel("not a date", now)).toBeNull();
  });
});

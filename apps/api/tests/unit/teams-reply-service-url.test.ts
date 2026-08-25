/**
 * `sendTeamsMessage` in services/chat-outbound.service.ts posts a reply to a URL taken from the
 * INBOUND activity body (`activity.serviceUrl`, read in controllers/chat-webhook.controller.ts)
 * and puts an app-only AAD access token for the org's bot in the `Authorization` header.
 *
 * The token is a real credential: whoever holds it can post as that workspace's bot into any
 * conversation the bot belongs to. So if the host in that URL is attacker-chosen, the request
 * hands it to them.
 *
 * WHY THE EXISTING TOKEN CHECK IS NOT ENOUGH. The webhook route does verify the inbound Bot
 * Framework JWT properly — signature against Microsoft's JWKS, `issuer`, and `aud` equal to this
 * org's own app id — so a stranger cannot mint one. But that signature covers the TOKEN, not the
 * BODY it arrived with, and a Bot Framework JWT is a bearer token valid for around an hour. A
 * replayed token with a rewritten `serviceUrl` therefore passed authentication and redirected the
 * outbound credential. Microsoft's own Bot Framework authentication guidance calls for validating
 * the `serviceurl` claim against the activity field for exactly this reason; a host allow-list is
 * the stronger form of the same check — it holds even when the claim is absent, and no host
 * Microsoft does not operate can satisfy it.
 *
 * The assertion that matters most is the second one: the token must not even be REQUESTED for a
 * rejected host. Minting first and refusing to send afterwards would still put a live credential
 * in an Azure log and in this process's memory for a request that was never legitimate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatIntegration } from "@prisma/client";

vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (value: string) => `decrypted:${value}` }));

const { sendChatReply } = await import("../../src/services/chat-outbound.service.js");

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

const integration = {
  platform: "MICROSOFT_TEAMS",
  teamsAppId: "app-id-1234",
  encryptedTeamsAppPassword: "cipher"
} as unknown as ChatIntegration;

function teamsMessage(serviceUrl: string) {
  return {
    platform: "MICROSOFT_TEAMS" as const,
    externalUserId: "29:abc",
    externalUserName: "Teams user",
    channelId: "19:conversation@thread.tacv2",
    text: "hello",
    replyContext: { serviceUrl }
  };
}

/** Records every outbound call so a test can assert on what was NOT requested, not just what was. */
let calls: string[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "a-real-bot-credential" })
      } as unknown as Response;
    })
  );
});

describe("Bot Framework reply target", () => {
  it.each([
    ["https://evil.example.com", "an attacker-controlled host"],
    ["https://smba.trafficmanager.io.attacker.com", "a host that merely LOOKS like Microsoft's"],
    ["https://botframework.com.attacker.net", "the allowed name as a PREFIX of someone else's domain"],
    ["https://notbotframework.com", "the allowed name without the separating dot"],
    ["https://attacker.trafficmanager.net", "any Azure customer can claim a trafficmanager.net label"],
    ["http://smba.trafficmanager.net/emea/", "plaintext http — the same disclosure by another route"],
    ["https://169.254.169.254", "an internal address"]
  ])("refuses to send the bot token to %s (%s)", async (serviceUrl) => {
    await expect(sendChatReply(integration, teamsMessage(serviceUrl), "TS-1 created")).rejects.toThrow();

    // The load-bearing assertion: no token was even minted for a host we were never going to use.
    expect(calls).not.toContain(TOKEN_ENDPOINT);
    expect(calls).toHaveLength(0);
  });

  it("refuses a serviceUrl that is not a URL at all", async () => {
    await expect(sendChatReply(integration, teamsMessage("not-a-url"), "TS-1 created")).rejects.toThrow(/valid URL/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["https://smba.trafficmanager.net/emea/", "Teams, commercial cloud — the host the real product uses"],
    ["https://directline.botframework.com/", "Direct Line"],
    ["https://smba.infra.gov.teams.microsoft.us/gov/", "Teams, sovereign cloud"]
  ])("still replies through %s (%s)", async (serviceUrl) => {
    // The guard has to leave the legitimate flow working — this case is why the allow-list is a
    // mix of exact hosts and suffixes rather than the tidier suffix-only list it started as: the
    // first entry here is not expressible as a safe suffix, and a suffix-only version rejected
    // every real Teams reply.
    await sendChatReply(integration, teamsMessage(serviceUrl), "TS-1 created");

    expect(calls[0]).toBe(TOKEN_ENDPOINT);
    expect(calls[1]).toContain(new URL(serviceUrl).hostname);
    expect(calls[1]).toContain("/v3/conversations/");
    // The conversation id is percent-encoded — ":" and "@" in a Teams thread id would otherwise
    // change the path's shape.
    expect(calls[1]).toContain(encodeURIComponent("19:conversation@thread.tacv2"));
  });
});

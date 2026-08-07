/**
 * The session decoder behind the admin "Who's online" panel.
 *
 * These are exactly the assertions a hand-rolled UA parser needs, because its failure mode is
 * silent: it never throws, it just reports the wrong browser forever. The Chromium family is the
 * whole hazard — Edge, Opera and Samsung Internet all impersonate Chrome in their UA string, so
 * the ordering of the checks is the actual logic under test. The unknown cases matter just as
 * much: the panel's job is to make a session that shouldn't be there LOOK wrong, and a confident
 * wrong guess would hide it.
 */
import { describe, expect, it } from "vitest";
import { isPrivateIpAddress, parseUserAgent } from "../../src/utils/user-agent.js";

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.68",
  operaWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0",
  firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  windows7: "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:60.0) Gecko/20100101 Firefox/60.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  chromeAndroidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  chromeAndroidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  samsungInternet:
    "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  edgeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  firefoxIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  edgeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.0.0.0 Mobile/15E148 Safari/605.1.15"
} as const;

describe("parseUserAgent — browser", () => {
  it("does not let the Chromium family pass itself off as Chrome", () => {
    // Every one of these carries a "Chrome/" token. If the ordering in detectBrowser is ever
    // shuffled, this is the test that fails.
    expect(parseUserAgent(UA.edgeWindows).browser).toBe("Edge");
    expect(parseUserAgent(UA.operaWindows).browser).toBe("Opera");
    expect(parseUserAgent(UA.samsungInternet).browser).toBe("Samsung Internet");
    expect(parseUserAgent(UA.edgeAndroid).browser).toBe("Edge");
    expect(parseUserAgent(UA.chromeWindows).browser).toBe("Chrome");
  });

  it("recognises the iOS re-skins, which are WebKit underneath but not Safari", () => {
    expect(parseUserAgent(UA.chromeIphone).browser).toBe("Chrome");
    expect(parseUserAgent(UA.firefoxIphone).browser).toBe("Firefox");
    expect(parseUserAgent(UA.edgeIphone).browser).toBe("Edge");
  });

  it("calls Safari Safari, on both desktop and iOS", () => {
    expect(parseUserAgent(UA.safariMac).browser).toBe("Safari");
    expect(parseUserAgent(UA.safariIphone).browser).toBe("Safari");
    expect(parseUserAgent(UA.safariIpad).browser).toBe("Safari");
  });

  it("recognises Firefox everywhere it ships", () => {
    expect(parseUserAgent(UA.firefoxWindows).browser).toBe("Firefox");
    expect(parseUserAgent(UA.firefoxLinux).browser).toBe("Firefox");
  });
});

describe("parseUserAgent — OS", () => {
  it("names Windows 10 and 11 together, because a UA cannot tell them apart", () => {
    expect(parseUserAgent(UA.chromeWindows).os).toBe("Windows 10/11");
    expect(parseUserAgent(UA.windows7).os).toBe("Windows 7");
  });

  it("reports macOS WITHOUT a version — Safari and Chrome both freeze it at 10_15_7", () => {
    expect(parseUserAgent(UA.safariMac).os).toBe("macOS");
    expect(parseUserAgent(UA.chromeMac).os).toBe("macOS");
  });

  it("prefers Android/ChromeOS over the Linux token both UAs also contain", () => {
    expect(parseUserAgent(UA.chromeAndroidPhone).os).toBe("Android 14");
    expect(parseUserAgent(UA.chromeAndroidTablet).os).toBe("Android 13");
    expect(parseUserAgent(UA.chromeOs).os).toBe("ChromeOS");
    expect(parseUserAgent(UA.firefoxLinux).os).toBe("Linux");
  });

  it("prefers iOS/iPadOS over the 'like Mac OS X' those UAs also contain", () => {
    expect(parseUserAgent(UA.safariIphone).os).toBe("iOS 17");
    expect(parseUserAgent(UA.safariIpad).os).toBe("iPadOS 17");
  });
});

describe("parseUserAgent — form factor", () => {
  it("splits Android phone from Android tablet on the absence of the Mobile token", () => {
    expect(parseUserAgent(UA.chromeAndroidPhone).formFactor).toBe("mobile");
    expect(parseUserAgent(UA.chromeAndroidTablet).formFactor).toBe("tablet");
  });

  it("classifies iPhone as mobile and iPad as tablet", () => {
    expect(parseUserAgent(UA.safariIphone).formFactor).toBe("mobile");
    expect(parseUserAgent(UA.safariIpad).formFactor).toBe("tablet");
  });

  it("classifies the desktop OSes as desktop", () => {
    for (const ua of [UA.chromeWindows, UA.safariMac, UA.firefoxLinux, UA.chromeOs]) {
      expect(parseUserAgent(ua).formFactor, ua).toBe("desktop");
    }
  });
});

describe("parseUserAgent — refusing to guess", () => {
  it("returns 'Unknown device' for a missing/blank user agent rather than inventing one", () => {
    for (const value of [null, undefined, "", "   "]) {
      const parsed = parseUserAgent(value);
      expect(parsed.label, String(value)).toBe("Unknown device");
      expect(parsed.formFactor, String(value)).toBe("unknown");
    }
  });

  it("returns 'Unknown device' for non-browser clients instead of a plausible-looking lie", () => {
    for (const ua of ["curl/8.4.0", "PostmanRuntime/7.39.0", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"]) {
      const parsed = parseUserAgent(ua);
      expect(parsed.label, ua).toBe("Unknown device");
      expect(parsed.browser, ua).toBe("Unknown browser");
      expect(parsed.os, ua).toBe("Unknown OS");
    }
  });

  it("still names the half it CAN read when only one of browser/OS is recognisable", () => {
    // A UA with an OS but no browser we know, and vice versa — the label must degrade to the
    // known half rather than all the way to "Unknown device".
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) SomeBot/1.0").label).toBe("Windows 10/11");
    expect(parseUserAgent("Chrome/126.0.0.0").label).toBe("Chrome");
  });

  it("KNOWN LIMITATION: an iPad in desktop mode is indistinguishable from a Mac, and reports as one", () => {
    // Documented, not fixed: iPadOS 13+ sends a verbatim Macintosh UA when "Request Desktop
    // Website" is on. Guessing "iPad" from a Mac UA would mislabel every real Mac.
    expect(parseUserAgent(UA.chromeMac).os).toBe("macOS");
  });
});

describe("parseUserAgent — label", () => {
  it("reads as one line an admin can scan", () => {
    expect(parseUserAgent(UA.chromeWindows).label).toBe("Chrome on Windows 10/11");
    expect(parseUserAgent(UA.safariIphone).label).toBe("Safari on iOS 17");
    expect(parseUserAgent(UA.edgeAndroid).label).toBe("Edge on Android 14");
  });
});

describe("isPrivateIpAddress", () => {
  it("flags loopback, RFC1918, link-local, CGNAT and IPv6 ULA", () => {
    const local = [
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "0:0:0:0:0:0:0:1",
      "[::1]",
      "10.0.0.5",
      "10.255.255.255",
      "192.168.1.42",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.10.1",
      "100.64.0.1",
      "fd00::1",
      "fe80::1c2f:8ff:fe12:3456"
    ];
    for (const ip of local) expect(isPrivateIpAddress(ip), ip).toBe(true);
  });

  it("does NOT flag public addresses, including the near-misses either side of 172.16/12", () => {
    const publicIps = [
      "8.8.8.8",
      "1.1.1.1",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "11.0.0.1",
      "100.128.0.1",
      "2001:4860:4860::8888"
    ];
    for (const ip of publicIps) expect(isPrivateIpAddress(ip), ip).toBe(false);
  });

  it("sees through the IPv4-mapped IPv6 form Express hands back on a dual-stack socket", () => {
    expect(isPrivateIpAddress("::ffff:192.168.1.5")).toBe(true);
    expect(isPrivateIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIpAddress("::FFFF:10.1.2.3")).toBe(true);
    expect(isPrivateIpAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("treats an absent address as not-private — 'local network' must never be a default", () => {
    for (const value of [null, undefined, "", "   ", "not-an-ip"]) {
      expect(isPrivateIpAddress(value), String(value)).toBe(false);
    }
  });
});

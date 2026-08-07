/**
 * WHAT: a deliberately small decoder for the two forensic fields a `Session` row carries —
 * the raw `userAgent` string and the `ipAddress` Express captured at login.
 *
 * WHY SERVER-SIDE, and why a regex parser instead of `ua-parser-js`: the admin "Who's online"
 * panel shows OTHER people's devices, so the API returns a decoded label rather than shipping
 * every user's raw UA string to the browser. And the question this answers is "which browser,
 * roughly which machine, for a human glancing at a list" — not full UA taxonomy. A dependency
 * with a thousand device regexes would be a supply-chain surface bought for nothing.
 *
 * WHY IT REFUSES TO GUESS: an admin uses this panel to spot the session that shouldn't be there.
 * A confident-but-wrong "Chrome on Windows" is strictly worse than "Unknown device" — it hides
 * exactly the anomaly the panel exists to surface. Every branch below therefore falls through to
 * an explicit unknown rather than to a plausible default.
 */

export type DeviceFormFactor = "desktop" | "mobile" | "tablet" | "unknown";

export interface ParsedUserAgent {
  /** e.g. "Chrome", "Safari", or "Unknown browser". */
  browser: string;
  /** e.g. "Windows 10/11", "Android 14", or "Unknown OS". */
  os: string;
  formFactor: DeviceFormFactor;
  /** One-line summary for the UI: "Chrome on macOS", or "Unknown device" when nothing matched. */
  label: string;
}

const UNKNOWN_BROWSER = "Unknown browser";
const UNKNOWN_OS = "Unknown OS";

function detectBrowser(ua: string): string {
  // ORDER IS THE WHOLE TRICK: Edge, Opera and Samsung Internet all carry a "Chrome/" token for
  // compatibility, so Chrome must be tested LAST of the Chromium family. Safari appears in
  // nearly every WebKit-derived UA, so it is tested last of all.
  if (/\bedg(?:e|a|ios)?\//i.test(ua)) return "Edge";
  if (/\bopr\/|\bopios\/|\bopera\b/i.test(ua)) return "Opera";
  if (/\bsamsungbrowser\//i.test(ua)) return "Samsung Internet";
  if (/\bfirefox\/|\bfxios\//i.test(ua)) return "Firefox";
  if (/\bchrome\/|\bcrios\/|\bchromium\//i.test(ua)) return "Chrome";
  // iOS Safari has no "Safari/"-only marker worth trusting without "Version/"; desktop Safari
  // always pairs the two. Anything else claiming Safari is a WebView or a bot.
  if (/\bsafari\//i.test(ua) && /\bversion\//i.test(ua)) return "Safari";
  return UNKNOWN_BROWSER;
}

function detectOs(ua: string): string {
  // iOS/iPadOS before macOS: an iPhone UA also contains "like Mac OS X".
  const ios = /\b(?:iphone|ipad|ipod)\b/i.test(ua) ? /\bos (\d+)[._](\d+)/i.exec(ua) : null;
  if (/\bipad\b/i.test(ua)) return ios ? `iPadOS ${ios[1]}` : "iPadOS";
  if (/\b(?:iphone|ipod)\b/i.test(ua)) return ios ? `iOS ${ios[1]}` : "iOS";

  // Android before Linux: every Android UA contains "Linux".
  const android = /\bandroid (\d+)/i.exec(ua);
  if (android) return `Android ${android[1]}`;
  if (/\bandroid\b/i.test(ua)) return "Android";

  const windows = /\bwindows nt (\d+\.\d+)/i.exec(ua);
  if (windows) {
    // 11 is INDISTINGUISHABLE from 10 in a UA string — Microsoft froze the token at 10.0. Saying
    // "Windows 10" would be a guess presented as a fact, so both are named.
    if (windows[1] === "10.0") return "Windows 10/11";
    if (windows[1] === "6.3") return "Windows 8.1";
    if (windows[1] === "6.2") return "Windows 8";
    if (windows[1] === "6.1") return "Windows 7";
    return "Windows";
  }
  if (/\bwindows\b/i.test(ua)) return "Windows";
  if (/\bcros\b/i.test(ua)) return "ChromeOS";
  // No macOS version: Safari and Chrome both freeze it at 10_15_7 regardless of the real OS.
  if (/\bmac os x\b|\bmacintosh\b/i.test(ua)) return "macOS";
  if (/\blinux\b|\bx11\b/i.test(ua)) return "Linux";
  return UNKNOWN_OS;
}

function detectFormFactor(ua: string, os: string): DeviceFormFactor {
  if (/\bipad\b|\btablet\b|\bkindle\b|\bplaybook\b/i.test(ua)) return "tablet";
  // An Android TABLET is exactly an Android UA WITHOUT the "Mobile" token — the absence is the
  // signal, so this must be checked before the generic mobile test below.
  if (/\bandroid\b/i.test(ua)) return /\bmobi/i.test(ua) ? "mobile" : "tablet";
  if (/\bmobi|\biphone\b|\bipod\b|\bwindows phone\b/i.test(ua)) return "mobile";
  if (os !== UNKNOWN_OS) return "desktop";
  return "unknown";
}

export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  const ua = userAgent?.trim();
  if (!ua) return { browser: UNKNOWN_BROWSER, os: UNKNOWN_OS, formFactor: "unknown", label: "Unknown device" };

  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  const formFactor = detectFormFactor(ua, os);
  const knownBrowser = browser !== UNKNOWN_BROWSER;
  const knownOs = os !== UNKNOWN_OS;
  const label = knownBrowser && knownOs ? `${browser} on ${os}` : knownBrowser ? browser : knownOs ? os : "Unknown device";
  return { browser, os, formFactor, label };
}

/**
 * True for addresses that can only have come from the same network as the server — loopback,
 * RFC1918, CGNAT, link-local, IPv6 ULA.
 *
 * WHY THE UI NEEDS THIS: on a LAN deployment every session's IP is a 192.168.x, and an admin
 * reading a column of them cannot tell "our office" from "somewhere on the internet". Labelling
 * the private ones removes that ambiguity in the only place it matters. It is a display hint,
 * never an authorisation input.
 */
export function isPrivateIpAddress(ipAddress: string | null | undefined): boolean {
  const raw = ipAddress?.trim().toLowerCase();
  if (!raw) return false;
  // Express hands back IPv4-mapped IPv6 ("::ffff:192.168.1.5") whenever the socket is dual-stack,
  // and a bracketed form when a port was attached. Both must reduce to the bare address first.
  const ip = raw.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");

  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // IPv6 unique-local (fc00::/7)
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true; // IPv6 link-local (fe80::/10)

  const octets = ip.split(".");
  if (octets.length !== 4) return false;
  const [a, b] = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return false;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // IPv4 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598) — not the public internet
  return false;
}

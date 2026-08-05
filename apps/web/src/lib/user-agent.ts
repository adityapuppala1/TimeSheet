/**
 * Lightweight browser/OS decoder for the raw `navigator.userAgent` string a session's login
 * request carried (`Session.userAgent`, stamped once at login — see auth.service.ts). Deliberately
 * a small regex parser rather than a dependency (ua-parser-js etc.) — this only needs to answer
 * "which browser/OS, for a human glancing at their Active Sessions list," not full UA parsing.
 */
export interface ParsedUserAgent {
  browser: string;
  os: string;
  deviceType: "desktop" | "mobile" | "tablet";
}

function detectBrowser(ua: string): string {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\//i.test(ua) || /opera/i.test(ua)) return "Opera";
  if (/chrome|crios/i.test(ua) && !/edg\//i.test(ua)) return "Chrome";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/safari/i.test(ua) && !/chrome|crios|android/i.test(ua)) return "Safari";
  if (/msie|trident/i.test(ua)) return "Internet Explorer";
  return "Unknown browser";
}

function detectOs(ua: string): string {
  if (/windows nt 10/i.test(ua)) return "Windows 10/11";
  if (/windows nt/i.test(ua)) return "Windows";
  if (/mac os x/i.test(ua)) return "macOS";
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/linux/i.test(ua)) return "Linux";
  return "Unknown OS";
}

function detectDeviceType(ua: string): "desktop" | "mobile" | "tablet" {
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (/mobi|iphone|android/i.test(ua)) return "mobile";
  return "desktop";
}

export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  if (!userAgent) return { browser: "Unknown browser", os: "Unknown device", deviceType: "desktop" };
  return { browser: detectBrowser(userAgent), os: detectOs(userAgent), deviceType: detectDeviceType(userAgent) };
}

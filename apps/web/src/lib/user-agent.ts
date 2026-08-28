/**
 * WHAT: turns a raw `User-Agent` string into the three things a person reading a session list
 * actually wants — what kind of device, which browser, which operating system.
 *
 * WHY IT EXISTS AT ALL. The platform console's session list printed the raw header, so nine rows of
 * "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
 * HeadlessChrome/151.0.7922.34 Safari/537.36" answered none of the questions the screen exists for:
 * is one of these not mine, and which one do I end? Every row looked identical because the part
 * that differs is buried 90 characters in.
 *
 * WHY NOT A LIBRARY. `ua-parser-js` is ~20KB for a regex table, and this is presentation for a list
 * that is at most a few dozen rows — a bad trade for a page an operator opens twice a year. The
 * rules below cover what actually signs into this console: desktop browsers, phones, and the
 * non-browser clients (curl, node, Playwright) that show up during setup and testing.
 *
 * IT IS DELIBERATELY LOSSY, AND THE RAW STRING IS NEVER THROWN AWAY. A user agent is
 * self-reported and every parser is a pile of heuristics, so `raw` comes back untouched for the
 * tooltip: the summary is for scanning, the raw string is the evidence.
 */

export interface ParsedUserAgent {
  /** "Chrome 151", "Safari", "curl" — what is making the request. */
  browser: string;
  /** "Windows", "macOS", "iOS", "Linux", or "" when the string does not say. */
  os: string;
  /** Broad shape, for the icon. */
  device: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
  /** True for curl / node / Playwright and friends — worth flagging, since a script holding a live
   *  console session is a different kind of fact from a browser doing so. */
  automated: boolean;
  /** One line: "Chrome 151 on Windows". */
  label: string;
  raw: string;
}

const BROWSERS: Array<{ re: RegExp; name: string }> = [
  // Order matters throughout: every Chromium browser also says "Chrome", and Chrome says "Safari".
  { re: /\bEdg(?:e|A|iOS)?\/(\d+)/, name: "Edge" },
  { re: /\bOPR\/(\d+)/, name: "Opera" },
  { re: /\bSamsungBrowser\/(\d+)/, name: "Samsung Internet" },
  { re: /\bHeadlessChrome\/(\d+)/, name: "Headless Chrome" },
  { re: /\bChrome\/(\d+)/, name: "Chrome" },
  { re: /\bFirefox\/(\d+)/, name: "Firefox" },
  { re: /\bVersion\/(\d+).*\bSafari\//, name: "Safari" },
  { re: /\bcurl\/([\d.]+)/, name: "curl" },
  { re: /\bWget\/([\d.]+)/, name: "Wget" },
  { re: /\bPostmanRuntime\/([\d.]+)/, name: "Postman" },
  { re: /\bnode(?:js)?[/ ]?([\d.]*)/i, name: "Node" },
  { re: /\bpython-requests\/([\d.]+)/, name: "python-requests" },
  { re: /\bPlaywright\/([\d.]+)/, name: "Playwright" }
];

const OSES: Array<{ re: RegExp; name: string }> = [
  { re: /\bWindows NT 10\.0/, name: "Windows" },
  { re: /\bWindows NT/, name: "Windows" },
  { re: /\bAndroid\s*([\d.]+)?/, name: "Android" },
  // iPadOS reports as "Macintosh" on desktop-mode Safari; the touch hint below is what separates them.
  { re: /\biPhone|\biPod/, name: "iOS" },
  { re: /\biPad/, name: "iPadOS" },
  { re: /\bMac OS X ([\d_]+)/, name: "macOS" },
  { re: /\bMacintosh/, name: "macOS" },
  { re: /\bCrOS/, name: "ChromeOS" },
  { re: /\bLinux/, name: "Linux" }
];

const AUTOMATED = /\b(curl|wget|node|python-requests|postman|playwright|puppeteer|headlesschrome|axios|got|okhttp|java|go-http-client)\b/i;

export function parseUserAgent(raw: string | null | undefined): ParsedUserAgent {
  const ua = (raw ?? "").trim();
  if (!ua) {
    return { browser: "Unknown client", os: "", device: "unknown", automated: false, label: "Unknown client", raw: "" };
  }

  let browser = "";
  for (const b of BROWSERS) {
    const m = b.re.exec(ua);
    if (m) {
      browser = m[1] ? `${b.name} ${m[1].split(".")[0]}` : b.name;
      break;
    }
  }

  let os = "";
  for (const o of OSES) {
    if (o.re.test(ua)) {
      os = o.name;
      break;
    }
  }

  const automated = AUTOMATED.test(ua);
  const mobile = /\bMobile\b|\biPhone|\bAndroid\b.*\bMobile/.test(ua);
  const tablet = /\biPad|\bTablet\b|(\bAndroid\b(?!.*\bMobile\b))/.test(ua);
  const device: ParsedUserAgent["device"] = automated ? "bot" : mobile ? "mobile" : tablet ? "tablet" : os ? "desktop" : "unknown";

  // A client that names itself and nothing else (curl, node) has no OS in its string, and inventing
  // one would be a guess presented as a fact.
  const name = browser || (ua.length > 40 ? `${ua.slice(0, 40)}…` : ua);
  const label = os && browser ? `${browser} on ${os}` : name;

  return { browser: name, os, device, automated, label, raw: ua };
}

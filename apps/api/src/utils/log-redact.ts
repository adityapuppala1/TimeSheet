/**
 * WHAT: a request URL made safe for a log line.
 *
 * Two things in a URL are credentials and must never reach a log:
 *   - the calendar feed token, which IS the path (`/calendar/feed/<64 hex>.ics`): anyone holding the
 *     log line can subscribe to that person's calendar;
 *   - query-string values: an OIDC callback's `code` and `state`, one-time links, filters with
 *     personal data. Keys are kept (they are what makes a log line useful), values are not.
 * The kiosk device token travels in the `X-Kiosk-Token` header, never in a URL.
 *
 * Used by the access log (app.ts, morgan) and by the error handler's 500 line.
 */

/** Any calendar feed token in the path replaced. */
export function redactFeedTokens(url: string): string {
  return url.replaceAll(/(\/calendar\/feed\/)[a-f0-9]{8,}/gi, "$1[redacted]");
}

/** The path with feed tokens redacted, and every query value replaced by `[redacted]`. */
export function redactUrlForLog(url: string): string {
  const q = url.indexOf("?");
  const path = redactFeedTokens(q === -1 ? url : url.slice(0, q));
  if (q === -1) return path;
  const keys = url
    .slice(q + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => `${pair.split("=")[0]}=[redacted]`);
  return keys.length ? `${path}?${keys.join("&")}` : path;
}

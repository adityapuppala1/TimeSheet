/**
 * WHAT: deterministic, client-side classification of a grouped SMTP failure reason into a
 * human-readable card — a title, what it means, whether it clears on its own, and the first
 * actions an admin should take.
 *
 * WHY THIS IS CODE AND NOT THE AI: the dozen failure shapes below cover the overwhelming
 * majority of real SMTP rejections, and pattern-matching them is free, instant, offline, and
 * identical on every render. The AI diagnosis (POST /analytics/failures/analyze) sits on top
 * for the long tail and for case-specific advice — it refines a card, it is never required to
 * read one. An analytics page whose legibility depends on a model call would be unreadable
 * exactly when the budget runs out or the key is unset.
 *
 * WHY CLASSIFICATION KEYS OFF THE NORMALISED REASON: the server has already collapsed volatile
 * ids (email-analytics.service.ts#normalizeErrorMessage), so one rule here matches one group
 * there — patterns never need to anticipate queue ids or timestamps.
 */

export type EmailFailureCategoryKey =
  | "not-configured"
  | "provider-throttle"
  | "auth"
  | "quota"
  | "recipient-rejected"
  | "connection"
  | "tls"
  | "content-rejected"
  | "no-message"
  | "unknown";

export interface EmailFailureTriage {
  key: EmailFailureCategoryKey;
  /** Short human title — what an admin scans in the table. */
  title: string;
  /** One-paragraph plain-language explanation of what this rejection means. */
  meaning: string;
  /** True when waiting / retrying is a legitimate response; false when config must change. */
  transient: boolean;
  /** Badge tone: destructive = fix your config, warning = provider/recipient side, muted = noise. */
  tone: "destructive" | "warning" | "muted";
  /** Concrete first steps, in order. */
  actions: string[];
}

interface Rule {
  pattern: RegExp;
  triage: EmailFailureTriage;
}

/** Order matters: first match wins, so the most specific shapes sit above the catch-alls. */
const RULES: Rule[] = [
  {
    pattern: /SMTP_HOST is not configured/i,
    triage: {
      key: "not-configured",
      title: "Email is not configured",
      meaning:
        "The app has no SMTP server to hand mail to, so nothing was ever sent. Every message in this group was dropped at the door — recipients saw nothing.",
      transient: false,
      tone: "destructive",
      actions: [
        "Add SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS to apps/api/.env (or the workspace email settings).",
        "Restart the API so the transport picks up the new credentials.",
        "Send yourself a test from any template card to confirm delivery."
      ]
    }
  },
  {
    pattern: /\b421\b|4\.3\.0|Temporary System Problem|try again later|4\.7\.28|unusual rate/i,
    triage: {
      key: "provider-throttle",
      title: "Provider temporarily refused (throttling)",
      meaning:
        "The receiving server accepted the connection but told us to slow down — a temporary refusal, usually rate-limiting a sender that submitted too many messages too quickly. Mail is not being rejected permanently; it is being pushed back.",
      transient: true,
      tone: "warning",
      actions: [
        "Check whether a burst (bulk test, escalation storm, digest run) lines up with the timestamps.",
        "Reduce notification volume — the email role matrix and per-category toggles control fan-out.",
        "If you relay through a personal Gmail account, move to a transactional provider or Google Workspace SMTP relay: consumer Gmail's daily limits are low.",
        "No config is necessarily wrong — if volume stays high, these will recur at the provider's limit."
      ]
    }
  },
  {
    pattern: /\b535\b|\b534\b|5\.7\.8|authentication|auth.*(failed|required)|username and password|BadCredentials|application-specific password/i,
    triage: {
      key: "auth",
      title: "SMTP sign-in rejected",
      meaning:
        "The mail server refused our username or password, so nothing in this group was accepted. Common causes: a rotated password, or a provider (like Gmail) that requires an app-specific password instead of the account password.",
      transient: false,
      tone: "destructive",
      actions: [
        "Re-enter SMTP_USER / SMTP_PASS — for Gmail, generate an App Password (requires 2-Step Verification) and use that.",
        "Restart the API after changing credentials.",
        "Confirm with a single test send before assuming the queue will drain."
      ]
    }
  },
  {
    pattern: /\b452\b|\b450\b|4\.2\.1|quota|mailbox full|over.{0,10}limit|toomanyconnections|too many connections/i,
    triage: {
      key: "quota",
      title: "Quota or mailbox limit hit",
      meaning:
        "The receiving side ran out of room or patience — a full mailbox, a daily sending quota, or too many simultaneous connections. Usually clears on its own; recurring hits mean the limit is real and being reached routinely.",
      transient: true,
      tone: "warning",
      actions: [
        "If one recipient dominates the list, their mailbox is likely full — tell them out-of-band.",
        "If many recipients are affected, the SENDING account hit its daily quota — check the provider dashboard.",
        "Consider a transactional email provider if quotas are hit monthly."
      ]
    }
  },
  {
    pattern: /5\.1\.1|user unknown|mailbox (unavailable|not found)|no such user|recipient.*(rejected|not exist)|address rejected|\bdoes not exist\b/i,
    triage: {
      key: "recipient-rejected",
      title: "Recipient address does not exist",
      meaning:
        "The receiving server says there is no such mailbox. These addresses are wrong, retired, or mistyped — retrying cannot fix them, and repeatedly mailing dead addresses hurts the sender's reputation.",
      transient: false,
      tone: "warning",
      actions: [
        "Check the affected recipients below against the Users page — deactivate or correct retired addresses.",
        "For external recipients (ticket reporters, guests), confirm the address on the source record.",
        "Do not keep resending — bounce rate is a spam signal against your whole domain."
      ]
    }
  },
  {
    pattern: /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|Connection (refused|timed out|closed)|greeting never received/i,
    triage: {
      key: "connection",
      title: "Could not reach the SMTP server",
      meaning:
        "The app never got a working connection to the mail server — wrong host/port, a firewall in the way, DNS not resolving, or the server being down. Nothing was handed over.",
      transient: false,
      tone: "destructive",
      actions: [
        "Verify SMTP_HOST and SMTP_PORT (587 with STARTTLS is the usual pair; 465 for implicit TLS).",
        "Check outbound firewall rules — many hosts block port 25 outright.",
        "Test reachability from the API host itself, not from your laptop.",
        "If it resolves and connects intermittently, treat it as a provider outage and retry later."
      ]
    }
  },
  {
    pattern: /certificate|self.?signed|unable to verify|TLS|SSL|wrong version number|starttls/i,
    triage: {
      key: "tls",
      title: "TLS/certificate problem",
      meaning:
        "The encrypted handshake with the mail server failed — a certificate the app does not trust, a port/encryption mismatch (implicit TLS on a STARTTLS port or vice-versa), or an internal relay with a self-signed certificate.",
      transient: false,
      tone: "destructive",
      actions: [
        "Match the port to the mode: 465 expects TLS from the first byte, 587 expects STARTTLS.",
        "If this is an internal relay with a self-signed certificate, install a real one — do not disable verification.",
        "Check whether the provider recently rotated certificates."
      ]
    }
  },
  {
    pattern: /5\.7\.\d|spam|blocked|blacklist|denylist|policy|prohibited|banned sending IP|refused to talk/i,
    triage: {
      key: "content-rejected",
      title: "Blocked by recipient policy",
      meaning:
        "The receiving server judged the message or the sending server unwanted — spam filtering, an IP on a blocklist, or missing sender authentication (SPF/DKIM/DMARC). The message was refused on reputation, not correctness.",
      transient: false,
      tone: "warning",
      actions: [
        "Set up SPF and DKIM DNS records for the From: domain — the single biggest lever.",
        "Check the sending IP against public blocklists (the rejection often names the list).",
        "Make the From: address match the authenticated SMTP account's domain.",
        "If relaying through a shared host, a neighbour may have burned the IP — a transactional provider isolates you."
      ]
    }
  },
  {
    pattern: /^No error message recorded$/i,
    triage: {
      key: "no-message",
      title: "Failed with no recorded reason",
      meaning:
        "The send failed but no SMTP text was stored — typically a crash or restart mid-send. The failure is real; the diagnosis has to come from server logs of that moment.",
      transient: true,
      tone: "muted",
      actions: [
        "Check the API logs around the listed timestamps.",
        "If these cluster at deploy/restart times, they are the restart, not the mail config."
      ]
    }
  }
];

const UNKNOWN: EmailFailureTriage = {
  key: "unknown",
  title: "Unrecognized failure",
  meaning:
    "This rejection does not match a known pattern. The raw SMTP text below is the source of truth — the numeric code at its start (4xx = temporary, 5xx = permanent) says whether retrying can ever help.",
  transient: false,
  tone: "muted",
  actions: [
    "Read the raw SMTP text — 4xx codes are temporary, 5xx are permanent.",
    "Search the exact code (e.g. \"550 5.7.1\") together with your provider's name.",
    "Use the AI diagnosis for a case-specific reading of this exact text."
  ]
};

export function triageEmailFailure(normalizedReason: string): EmailFailureTriage {
  for (const rule of RULES) {
    if (rule.pattern.test(normalizedReason)) return rule.triage;
  }
  return UNKNOWN;
}

/** Distinct categories present in a list of reasons, in RULES order — drives the filter Select. */
export function categoriesIn(reasons: Array<{ reason: string }>): EmailFailureTriage[] {
  const seen = new Map<EmailFailureCategoryKey, EmailFailureTriage>();
  for (const r of reasons) {
    const t = triageEmailFailure(r.reason);
    if (!seen.has(t.key)) seen.set(t.key, t);
  }
  return [...seen.values()];
}

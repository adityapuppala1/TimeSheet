/**
 * A mark per connector, for the "Connects to what you already run" diagram.
 *
 * WHY THESE ARE BUILT FROM PRIMITIVES rather than copied logo path data. Reproducing eighteen
 * vendors' official paths from memory is how you ship a shape that is confidently wrong — a
 * mangled octocat is worse than no octocat, and nobody reviewing a diff of `d="M12.3 4.1c-.4..."`
 * can tell the difference. Everything here is composed from circles, rectangles and short paths I
 * can reason about, checked by rendering them and looking.
 *
 * So they are RECOGNISABLE, not official. Google and Microsoft (in provider-marks.tsx) are the two
 * exceptions — those are the published marks, unmodified, because their geometry is simple enough
 * to be exact. Everything else is an honest likeness in the brand's colour, and where a vendor's
 * logo is genuinely a piece of illustration (Jenkins' butler, the GitHub octocat) the mark says
 * what the thing DOES instead of pretending to be the logo.
 *
 * COLOUR: brand hues are hardcoded and identical in both themes, for the same reason as
 * provider-marks.tsx — they are not this product's colours to theme. The protocol marks (SAML,
 * LDAP, IMAP, SMTP, MCP) use `currentColor`, because a protocol has no brand and should follow the
 * surface it sits on.
 */

type MarkProps = { className?: string };

const box = (className: string) => ({ className, viewBox: "0 0 24 24", "aria-hidden": true as const, focusable: "false" as const });

/* ── Chat ─────────────────────────────────────────────────────────────────────────────────── */

/** Slack's four-bar hash, in its four brand colours. Geometric, so this one is close to exact. */
export function SlackMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)}>
      <rect x="8.6" y="1.5" width="3" height="9.5" rx="1.5" fill="#36C5F0" />
      <rect x="13" y="13" width="3" height="9.5" rx="1.5" fill="#2EB67D" />
      <rect x="13" y="8.6" width="9.5" height="3" rx="1.5" fill="#ECB22E" />
      <rect x="1.5" y="13" width="9.5" height="3" rx="1.5" fill="#E01E5A" />
    </svg>
  );
}

/** Microsoft Teams — the rounded "T" tile in Teams purple. */
export function TeamsMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)}>
      <rect x="2" y="4" width="13" height="16" rx="3" fill="#5059C9" />
      <path d="M5 8h7M8.5 8v8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="18.5" cy="7" r="2.6" fill="#7B83EB" />
      <path d="M16.4 11.2h4.3a1.3 1.3 0 0 1 1.3 1.3v3.6a3.4 3.4 0 0 1-5.6 2.6z" fill="#7B83EB" />
    </svg>
  );
}

/** Google Chat — a speech bubble in Google's four colours. */
export function GoogleChatMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)}>
      <path d="M3 4.5h18v11.5a1.5 1.5 0 0 1-1.5 1.5H9l-5 4.2V17.5A1.5 1.5 0 0 1 3 16z" fill="#fff" />
      <path d="M3 4.5h18v11.5a1.5 1.5 0 0 1-1.5 1.5H9l-5 4.2V17.5A1.5 1.5 0 0 1 3 16z" fill="none" stroke="#34A853" strokeWidth="1.7" strokeLinejoin="round" />
      <circle cx="8.5" cy="10.5" r="1.5" fill="#4285F4" />
      <circle cx="12.5" cy="10.5" r="1.5" fill="#FBBC05" />
      <circle cx="16.5" cy="10.5" r="1.5" fill="#EA4335" />
    </svg>
  );
}

/** Telegram — the paper plane on its circle. */
export function TelegramMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)}>
      <circle cx="12" cy="12" r="11" fill="#2AABEE" />
      <path d="M5.6 12.1 17.4 7.2c.6-.2 1.1.2 .9.9l-2 9.4c-.1.6-.5.8-1 .5l-3-2.2-1.5 1.4c-.2.2-.4.3-.7.2l.3-3 5.5-5c.2-.2 0-.4-.3-.2l-6.8 4.3-2.9-.9c-.6-.2-.6-.6.1-.9z" fill="#fff" />
    </svg>
  );
}

/* ── Code & CI ────────────────────────────────────────────────────────────────────────────── */

/** GitHub — a branch with a commit, not an attempted octocat. See the header on why. */
export function GitHubMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2.4" />
      <circle cx="6" cy="19" r="2.4" />
      <circle cx="18" cy="9" r="2.4" />
      <path d="M6 7.4v9.2" />
      <path d="M18 11.4c0 3.6-3 5.2-6 5.2" />
    </svg>
  );
}

/** GitHub Actions — the run marker: a play inside a ring, in Actions blue. */
export function GitHubActionsMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)}>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="#2088FF" strokeWidth="2" />
      <path d="M10 8.2 16 12l-6 3.8z" fill="#2088FF" />
    </svg>
  );
}

/** GitLab — the tanuki's fold, simplified to its two chevrons in GitLab orange. */
export function GitLabMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)}>
      <path d="M12 22 2.6 14.4l1.3-4.1L6 3.6l2.2 6.7h7.6L18 3.6l2.1 6.7 1.3 4.1z" fill="#FC6D26" />
      <path d="m12 22-3.8-11.7h7.6z" fill="#E24329" />
    </svg>
  );
}

/** Jenkins — a CI run's status, since the butler is illustration rather than a mark. */
export function JenkinsMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)} fill="none" stroke="#D33833" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M21 4v4.2h-4.2" />
      <path d="m8.8 12 2.3 2.3 4.4-4.6" />
    </svg>
  );
}

/* ── Mail ─────────────────────────────────────────────────────────────────────────────────── */

/** IMAP — mail arriving into a tray. */
export function ImapMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13.5V19a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 19v-5.5h-5l-1.5 2.5h-5L8 13.5z" />
      <path d="M12 3v7" />
      <path d="m9 7.2 3 3 3-3" />
    </svg>
  );
}

/** SMTP — mail leaving. The mirror of IMAP above, deliberately, because the pair is the point. */
export function SmtpMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="6" width="19" height="13" rx="2" />
      <path d="m3.5 7.5 8.5 6.5 8.5-6.5" />
    </svg>
  );
}

/* ── AI ───────────────────────────────────────────────────────────────────────────────────── */

/** Anthropic — the burst, in the brand's clay orange. */
export function AnthropicMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)}>
      <path d="M7.1 4h3.4l5.2 16h-3.5l-1-3.3H6.3L5.2 20H1.7zm.2 9.6h3.6L9.1 8.2z" fill="#D97757" />
      <path d="M16.4 4h3.5L22 20h-3.4z" fill="#D97757" />
    </svg>
  );
}

/** OpenAI-compatible — a hexagonal knot, standing for the whole family of endpoints that speak
 *  this API (Groq, Mistral, DeepSeek, OpenRouter, Ollama …) rather than for OpenAI alone. */
export function OpenAiMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M12 2.6 20.1 7v10L12 21.4 3.9 17V7z" />
      <path d="M12 7.4 16.1 9.8v4.4L12 16.6 7.9 14.2V9.8z" />
    </svg>
  );
}

/** Model Context Protocol — a plug going into a socket, which is what it is. */
export function McpMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2.5v5M15 2.5v5" />
      <path d="M6.5 7.5h11v3.2a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16.2v5.3" />
    </svg>
  );
}

/* ── Billing ──────────────────────────────────────────────────────────────────────────────── */

/** Stripe — the wordmark's "S" on its rounded tile, in Stripe indigo. */
export function StripeMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg {...box(className)}>
      <rect x="2" y="2" width="20" height="20" rx="4.5" fill="#635BFF" />
      <path
        d="M11.7 9.6c0-.6.5-.8 1.2-.8 1 0 2.3.3 3.3.9V6.6a8.4 8.4 0 0 0-3.3-.6c-2.7 0-4.5 1.4-4.5 3.8 0 3.7 5 3.1 5 4.7 0 .7-.6.9-1.4.9-1.1 0-2.6-.5-3.7-1.1v3.2c1.2.5 2.5.8 3.7.8 2.8 0 4.7-1.4 4.7-3.8 0-4-5-3.3-5-4.9z"
        fill="#fff"
      />
    </svg>
  );
}

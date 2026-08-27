/**
 * The identity-provider marks, as inline SVG.
 *
 * WHY INLINE AND NOT FILES: these appear on the sign-in page, which is the one screen whose entire
 * job is to load fast, and four network requests for four small logos is four chances to render a
 * button with a missing image next to the word "Continue". Inline they cannot 404, cannot flash,
 * and cost nothing after the first byte of the bundle.
 *
 * WHY THE BRAND COLOURS ARE HARDCODED HEXES here, when nothing else in this codebase is: they are
 * not this product's colours to theme. Google's four-colour G is Google's, and recolouring it to
 * `--primary` in dark mode would be both wrong and, for the trademark holders whose brand
 * guidelines govern these marks, not permitted. They are the same in both themes on purpose.
 *
 * WHY SAML/LDAP/SCIM GET DRAWN SHAPES rather than a logo: they are protocols, not companies. There
 * is no mark to reproduce, so each gets a glyph that says what it does — a key changing hands, a
 * directory tree, a person crossing a boundary — sized and weighted to sit beside the real logos
 * without pretending to be one.
 */

type MarkProps = { className?: string };

/** Google's four-colour "G". Paths are the published mark, unmodified. */
export function GoogleMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.63h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.55Z"
      />
      <path
        fill="#34A853"
        d="M12 23.5c3.11 0 5.72-1.03 7.62-2.79l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.03-6.45-4.75H1.71v2.98A11.5 11.5 0 0 0 12 23.5Z"
      />
      <path
        fill="#FBBC05"
        d="M5.55 14.17a6.9 6.9 0 0 1 0-4.34V6.85H1.71a11.5 11.5 0 0 0 0 10.3l3.84-2.98Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.08c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.72 1.62 15.11.5 12 .5A11.5 11.5 0 0 0 1.71 6.85l3.84 2.98C6.46 7.11 9 5.08 12 5.08Z"
      />
    </svg>
  );
}

/** Microsoft's four-square logo. Deliberately the squares alone — the wordmark beside them is a
 *  separate trademark with its own clear-space rules, and a button already carries the word. */
export function MicrosoftMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path fill="#F25022" d="M1 1h10.2v10.2H1z" />
      <path fill="#7FBA00" d="M12.8 1H23v10.2H12.8z" />
      <path fill="#00A4EF" d="M1 12.8h10.2V23H1z" />
      <path fill="#FFB900" d="M12.8 12.8H23V23H12.8z" />
    </svg>
  );
}

/**
 * SAML — an assertion passing between two parties.
 *
 * `currentColor` rather than a fixed hue: unlike the logos above this is ours to theme, so it
 * inherits whatever the surface it sits on has set.
 */
export function SamlMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="2" y="5" width="7" height="14" rx="1.5" />
      <rect x="15" y="5" width="7" height="14" rx="1.5" />
      <path d="M9 12h6" />
      <path d="m12.5 9.5 2.5 2.5-2.5 2.5" />
    </svg>
  );
}

/** LDAP / Active Directory — a directory tree, which is what it literally is. */
export function LdapMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="9" y="2" width="6" height="5" rx="1" />
      <rect x="2" y="17" width="6" height="5" rx="1" />
      <rect x="16" y="17" width="6" height="5" rx="1" />
      <path d="M12 7v4M5 17v-2a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

/** SCIM — accounts arriving from outside the boundary, which is the whole idea. */
export function ScimMark({ className = "h-4 w-4" }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <circle cx="8" cy="8" r="3.2" />
      <path d="M2.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 9h6" />
      <path d="m19 6 3 3-3 3" />
    </svg>
  );
}

/** One place that maps a provider key to its mark, so a card, a button and a status row cannot end
 *  up showing three different icons for the same thing. */
export const PROVIDER_MARKS = {
  GOOGLE: GoogleMark,
  MICROSOFT: MicrosoftMark,
  SAML: SamlMark,
  LDAP: LdapMark,
  SCIM: ScimMark
} as const;

export type ProviderMarkKey = keyof typeof PROVIDER_MARKS;

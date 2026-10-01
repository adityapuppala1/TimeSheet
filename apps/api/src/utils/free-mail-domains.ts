/**
 * WHAT: the set of email domains that belong to a PERSON rather than to an ORGANISATION, and the
 * one predicate that answers it.
 *
 * WHY IT IS ITS OWN FILE. Two surfaces ask this question and they answer it in opposite
 * directions, which is exactly the situation a copy-pasted list gets wrong:
 *
 *  - `controllers/signup.controller.ts` REFUSES a free-mail address. A trial is per organisation;
 *    gmail.com is not one, and allowing it turns "one trial per company" into "one trial per
 *    address anybody can make in ten seconds".
 *  - `services/sales-lead.service.ts` FLAGS one and accepts the lead anyway. A founder evaluating
 *    the product from a personal address is a real enquiry, and refusing it would lose a customer
 *    to protect nothing — there is no infrastructure behind a contact form. (The deployment's own
 *    sales inbox is itself a Gmail address, which is the shortest proof that the two rules are not
 *    the same rule.)
 *
 * Two lists that must stay identical while their consequences differ is the shape of bug where one
 * side gets a new domain and the other quietly does not. One list, two callers, and the difference
 * written down where both can see it.
 *
 * Not exhaustive, on purpose — a complete list of free-mail providers does not exist and chasing one
 * is how this becomes a maintenance burden that still misses the newest domain. It covers the large
 * global providers plus the regional ones this product's market actually uses (the first version
 * missed rediffmail.com and yahoo.co.in, which is how it came to be extended on 2026-10-01). An
 * operator adds anything else WITHOUT a release, in Platform admin → Settings → Self-serve signup
 * (`PlatformSignupSettings.blockedDomains`), and on the signup path the verify-first step catches
 * the rest by costing an inbox per attempt.
 */
export const FREE_MAIL_DOMAINS = new Set([
  // Global providers
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "hotmail.co.uk",
  "outlook.com", "live.com", "msn.com", "aol.com", "aim.com", "icloud.com", "me.com", "mac.com", "mail.com",
  "gmx.com", "gmx.net", "yandex.com", "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
  "zoho.com", "zohomail.com", "tutanota.com", "tutanota.de", "tuta.io", "tutamail.com",
  "fastmail.com", "fastmail.fm", "hey.com", "hushmail.com", "inbox.com", "ymail.com", "rocketmail.com",
  // India
  "rediffmail.com", "rediff.com", "yahoo.co.in", "yahoo.in", "live.in", "zohomail.in",
  // Europe
  "gmx.de", "gmx.at", "gmx.ch", "web.de", "t-online.de", "freenet.de", "yahoo.de", "yahoo.fr",
  "yahoo.es", "yahoo.it", "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es", "live.co.uk",
  "live.fr", "outlook.fr", "outlook.de", "laposte.net", "orange.fr", "free.fr", "libero.it",
  "virgilio.it", "btinternet.com", "sky.com", "virginmedia.com", "mail.ru", "inbox.ru", "bk.ru",
  "list.ru", "yandex.ru", "ya.ru",
  // Americas, Asia-Pacific
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "yahoo.ca",
  "rogers.com", "shaw.ca", "uol.com.br", "bol.com.br", "terra.com.br", "yahoo.com.br", "yahoo.co.jp",
  "yahoo.com.au", "bigpond.com", "optusnet.com.au", "qq.com", "163.com", "126.com", "sina.com",
  "naver.com", "daum.net", "hanmail.net"
]);

/**
 * Throwaway inboxes — addresses that exist for minutes. Kept apart from FREE_MAIL_DOMAINS because
 * the two callers disagree about them too: signup refuses both, but a sales enquiry from a personal
 * address is a real lead while one from a ten-minute inbox is not somebody we can ever answer.
 * The sales path only flags free mail, so this list is signup's alone today.
 */
export const DISPOSABLE_MAIL_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "grr.la",
  "10minutemail.com", "temp-mail.org", "yopmail.com", "yopmail.fr", "trashmail.com", "getnada.com",
  "dispostable.com", "maildrop.cc", "mailnesia.com", "throwawaymail.com", "emailondeck.com",
  "fakeinbox.com", "discard.email", "spamgourmet.com", "mailcatch.com", "mohmal.com", "tempr.email"
]);

/**
 * The domain part of an address, normalised the way every caller here compares it.
 * Case- and whitespace-tolerant, because every caller is handed whatever a person typed. Splits at
 * the LAST `@`, which is where an address's domain actually starts.
 */
export function emailDomainOf(email: string): string {
  const normalised = email.trim().toLowerCase();
  return normalised.slice(normalised.lastIndexOf("@") + 1);
}

export function isFreeMailAddress(email: string): boolean {
  return FREE_MAIL_DOMAINS.has(emailDomainOf(email));
}

export function isDisposableAddress(email: string): boolean {
  return DISPOSABLE_MAIL_DOMAINS.has(emailDomainOf(email));
}

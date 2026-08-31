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
 * Deliberately short and not exhaustive — a complete list of free-mail providers does not exist and
 * chasing one is how this becomes a maintenance burden that still misses the newest domain. It
 * catches the overwhelming majority of casual abuse, and on the signup path the verify-first step
 * catches the rest by costing an inbox per attempt.
 */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "hotmail.co.uk",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mail.com",
  "gmx.com", "gmx.net", "yandex.com", "proton.me", "protonmail.com", "zoho.com", "tutanota.com"
]);

/** Case- and whitespace-tolerant, because both callers are handed whatever a person typed. */
export function isFreeMailAddress(email: string): boolean {
  return FREE_MAIL_DOMAINS.has(email.trim().toLowerCase().split("@")[1] ?? "");
}

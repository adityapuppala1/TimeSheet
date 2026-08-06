/**
 * WHAT: server-side phone-number validation and normalization — the authority the profile PATCH
 * trusts, whatever any client sent.
 *
 * WHY libphonenumber-js AND NOT A REGEX: "valid phone number" is a per-country question — an
 * Indian mobile has 10 national digits, a Singapore number 8, and countries change their own
 * numbering plans. libphonenumber (Google's dataset) is the industry answer; a hand regex is a
 * bug factory with a delay timer.
 *
 * WHY E.164 IN THE DATABASE: one canonical format ("+919876543210") means equality checks,
 * display formatting and future SMS integrations all start from the same value — never from
 * whatever spacing/dashes a person happened to type.
 */
import { parsePhoneNumberFromString } from "libphonenumber-js";

export type PhoneCheck = { ok: true; e164: string } | { ok: false; message: string };

export function normalizePhoneNumber(raw: string): PhoneCheck {
  const value = raw.trim();
  // Without a leading +, the country is a guess — and a guess that validates "5550123" as
  // somebody's local format defeats the point. International form is the contract.
  if (!value.startsWith("+")) {
    return { ok: false, message: "Phone number must start with a country code, e.g. +65 8123 4567 or +91 98765 43210." };
  }
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed?.isValid()) {
    return { ok: false, message: "That isn't a valid phone number for its country code — check the digits." };
  }
  return { ok: true, e164: parsed.number };
}

/**
 * "Can this runtime actually format dates in that zone" — asked of the runtime itself, NOT via
 * membership in `Intl.supportedValuesOf("timeZone")`. That list holds only each ICU build's
 * CANONICAL names, and canonicalization differs by build: this Node canonicalizes to
 * "Asia/Calcutta", so a membership check rejects "Asia/Kolkata" — the primary modern IANA name,
 * and exactly what a user's browser may report. DateTimeFormat accepts every alias the tz
 * database knows and throws RangeError for anything it doesn't.
 */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

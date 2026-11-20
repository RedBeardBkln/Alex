import { domainToUnicode } from "node:url";
import { env } from "@/lib/env";
import { addressKey } from "./addresses";

/**
 * Recipient rules for the approval step (Phase 2d, plan §6.3): the per-recipient confirmation of
 * new messages, the daily first-time-recipient cap and the IDN display. Page-safe: no database
 * and no Gmail.
 */

/** Default for EMAIL_NEW_RECIPIENTS_PER_DAY (owner Q3). */
export const DEFAULT_NEW_RECIPIENTS_PER_DAY = 10;

/** A non-negative integer, or the default for anything else (unset, empty, negative, fractional, garbage). */
export function parseNewRecipientLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_NEW_RECIPIENTS_PER_DAY;
  const v = value.trim();
  if (!/^[0-9]{1,6}$/.test(v)) return DEFAULT_NEW_RECIPIENTS_PER_DAY;
  return Number(v);
}

/** The configured daily cap on first-time recipients (UTC day). 0 means none at all. */
export function newRecipientLimit(e: Pick<ReturnType<typeof env>, "EMAIL_NEW_RECIPIENTS_PER_DAY"> = env()): number {
  return parseNewRecipientLimit(e.EMAIL_NEW_RECIPIENTS_PER_DAY);
}

/** The distinct to ∪ cc addresses, lowercased, in order. */
export function recipientKeys(p: { to: string[]; cc: string[] }): string[] {
  return [...new Set([...p.to, ...p.cc].map(addressKey))];
}

/**
 * Owner Q2: the confirmed addresses must be exactly the payload's to ∪ cc, compared
 * case-insensitively. Missing or extra entries fail, and so does any repeated entry (a browser
 * sends each ticked box once, so a repeat means the form was tampered with). Empty never matches,
 * because a payload always has at least one To address.
 */
export function confirmationMatches(confirmed: string[], p: { to: string[]; cc: string[] }): boolean {
  const expected = new Set(recipientKeys(p));
  if (expected.size === 0 || confirmed.length !== expected.size) return false;
  const seen = new Set<string>();
  for (const a of confirmed) {
    const k = addressKey(a);
    if (!expected.has(k) || seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

/** Owner Q3: an approval with `n` first-time recipients fits if n is 0 or used + n stays within the limit. */
export function capAllows(n: number, usedToday: number, limit: number): boolean {
  return n === 0 || usedToday + n <= limit;
}

/** How many first-time recipients are still allowed today (never negative). */
export function capRemaining(usedToday: number, limit: number): number {
  return Math.max(0, limit - usedToday);
}

/**
 * Owner Q7: the Unicode form of an address's domain when any label is punycode (`xn--`), so the
 * approval page can show what the recipient's domain really looks like. Null for plain ASCII
 * domains, and when the conversion fails (node:url returns "" for an invalid name).
 */
export function idnDisplay(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1);
  if (!domain.split(".").some((label) => label.toLowerCase().startsWith("xn--"))) return null;
  const unicode = domainToUnicode(domain);
  return unicode === "" ? null : unicode;
}

import { replySubject } from "@/lib/gmail/compose";
import { findInvisible, hasBidiControl } from "./text";

/**
 * Subject warnings on the approval screen (plan §7, review round 1):
 * - `changed`: the subject differs from the default reply subject, so Gmail may not thread the
 *   reply. Never raised when the original has no subject.
 * - `bidi`: the subject contains bidirectional formatting characters, which can make it display
 *   differently from what is sent. (Recipients are ASCII-only, so they can't contain any.)
 */
export function subjectWarnings(shownSubject: string, originalSubject: string | null): { changed: boolean; bidi: boolean } {
  const original = (originalSubject ?? "").trim();
  return {
    changed: original !== "" && shownSubject.trim() !== replySubject(original),
    bidi: hasBidiControl(shownSubject),
  };
}

// ---- Phase 2c content warnings (plan §6.7, 2b security review F1) ----------------------------

/** To/Cc addresses that appear nowhere in the thread's stored From/To/Cc/Reply-To headers and aren't one of the owner's accounts. */
export function newRecipients(recipients: string[], threadAddresses: string[], ownAccounts: string[]): string[] {
  const known = new Set([...threadAddresses, ...ownAccounts].map((a) => a.toLowerCase()));
  return recipients.filter((a) => !known.has(a.toLowerCase()));
}

export type InvisibleFinding = { count: number; items: { codePoint: string; index: number }[] };

/** Bidi and invisible characters, listed with their position (at most 20 listed). */
export function invisibleCharacters(text: string): InvisibleFinding {
  const found = findInvisible(text);
  return {
    count: found.length,
    items: found.slice(0, 20).map((f) => ({ codePoint: `U+${f.codePoint.toString(16).toUpperCase().padStart(4, "0")}`, index: f.index })),
  };
}

const TOKEN_BREAK = new Set([" ", "\n", "\t", "\r", "<", ">", "\"", "'", "(", ")", "[", "]", "{", "}", ",", ";", "|", "*", "`"]);

/** Splits text into candidate link tokens without regexes (linear). */
function tokens(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const ch of text) {
    if (TOKEN_BREAK.has(ch)) {
      if (cur.length > 0) out.push(cur.join(""));
      cur = [];
    } else cur.push(ch);
  }
  if (cur.length > 0) out.push(cur.join(""));
  return out;
}

function isDomain(s: string): boolean {
  if (s.length < 4 || s.length > 253) return false;
  const labels = s.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1]!;
  if (tld.length < 2 || tld.length > 24 || !/^[a-z]+$/i.test(tld)) return false;
  return labels.every((l) => l.length > 0 && l.length <= 63 && /^[a-z0-9-]+$/i.test(l) && !l.startsWith("-") && !l.endsWith("-"));
}

/** True if the string has a character outside ASCII. */
const hasNonAscii = (v: string) => {
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) > 127) return true;
  return false;
};

/**
 * The ASCII (punycode) form of a host name, or null if it isn't a plausible domain. A Unicode
 * (IDN) name is converted with the WHATWG URL parser, so a homograph such as a Cyrillic "а" in
 * "paypal.com" becomes a different xn-- name and never equals the real domain.
 */
export function normalizeHost(host: string): string | null {
  let h = host.toLowerCase().replace(/\.$/, "");
  if (hasNonAscii(h)) {
    try {
      h = new URL(`http://${h}/`).hostname;
    } catch {
      return null;
    }
  }
  return isDomain(h) ? h : null;
}

/** A strict dotted-quad IPv4 address: four decimal octets 0–255, no leading zeros (owner Q8). */
export function isIPv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

/** A link found in text: what is shown, and its host (null when it has none or it can't be parsed). */
type Link = { display: string; host: string | null; ip: boolean };

const BACKSLASH = String.fromCharCode(92);
const isSchemeChar = (c: string) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "+" || c === "." || c === "-";
const isLetter = (c: string) => c >= "a" && c <= "z";

/** `s` from `from` up to the first `/`, `?`, `#` or backslash (an authority). Linear. */
function authorityAt(s: string, from: number): string {
  let end = from;
  while (end < s.length) {
    const c = s[end]!;
    if (c === "/" || c === "?" || c === "#" || c === BACKSLASH) break;
    end++;
  }
  return s.slice(from, end);
}

/**
 * The host of an authority (userinfo up to the last `@` and the port dropped), parsed with the
 * WHATWG URL parser as an http host: IDNA/punycode, lowercasing, fullwidth dots, percent-decoding
 * and IPv4 normalisation (decimal, hex and octal forms), as for http links. Null if it is empty,
 * can't be parsed, or is neither an IPv4 address nor a plausible domain.
 */
function hostOfAuthority(authority: string): { host: string; ip: boolean } | null {
  const at = authority.lastIndexOf("@");
  let h = at >= 0 ? authority.slice(at + 1) : authority;
  const colon = h.indexOf(":");
  if (colon >= 0) h = h.slice(0, colon);
  if (h === "") return null;
  let parsed: string;
  try {
    parsed = new URL(`http://${h}/`).hostname;
  } catch {
    return null;
  }
  if (isIPv4(parsed)) return { host: parsed, ip: true };
  const domain = normalizeHost(parsed);
  return domain ? { host: domain, ip: false } : null;
}

/** Drops trailing `.`, `:`, `!` and `?` (sentence punctuation) without a regex, so it stays linear. */
function stripTrailing(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s[end - 1]!;
    if (c !== "." && c !== ":" && c !== "!" && c !== "?") break;
    end--;
  }
  return s.slice(0, end);
}

/**
 * The link in one token, if any (S1/N2 follow-up):
 * - a `scheme://` link anywhere in the token (the scheme is the run of letters, digits, `+`, `.`
 *   and `-` before a `://`, starting at its first letter; the first `://` that has one counts). Shown from the scheme on. Its
 *   host may be null (`file:///x`, `x://`), and then it is always flagged (owner Q10).
 * - a protocol-relative `//host` link, only if the host is a domain or an IPv4 address (so `//`
 *   comments such as `// note` or `//TODO` aren't links). Shown as the token.
 * - otherwise a bare domain (as before: after the last `@`, before the first `/`), or a bare strict
 *   dotted-quad IPv4 address (after the last `@`, before `/`, `?`, `#` or `:port`), shown as the host.
 */
function linkInToken(raw: string): Link | null {
  const lower = stripTrailing(raw).toLowerCase();
  // Round 2 (D2): a `://` with no valid scheme before it (`://`, `0://`, `-://`) doesn't end the
  // search; the next one is tried. Linear: each backward scan stops at the `:` or `/` of the previous
  // `://`, so the scanned runs don't overlap.
  for (let sep = lower.indexOf("://"); sep >= 0; sep = lower.indexOf("://", sep + 1)) {
    let start = sep;
    while (start > 0 && isSchemeChar(lower[start - 1]!)) start--;
    while (start < sep && !isLetter(lower[start]!)) start++;
    if (start < sep) {
      const host = hostOfAuthority(authorityAt(lower, sep + 3));
      return { display: lower.slice(start), host: host?.host ?? null, ip: host?.ip ?? false };
    }
  }
  if (lower.startsWith("//")) {
    const host = hostOfAuthority(authorityAt(lower, 2));
    return host ? { display: lower, host: host.host, ip: host.ip } : null;
  }
  const at = lower.lastIndexOf("@");
  const candidate = at >= 0 ? lower.slice(at + 1) : lower;
  const domain = normalizeHost(candidate.split("/")[0]!);
  if (domain) return { display: domain, host: domain, ip: false };
  let end = 0;
  while (end < candidate.length) {
    const c = candidate[end]!;
    if (c === "/" || c === "?" || c === "#" || c === ":") break;
    end++;
  }
  const ip = candidate.slice(0, end);
  return isIPv4(ip) ? { display: ip, host: ip, ip: true } : null;
}

/** Every link in `text`, de-duplicated by what is shown. */
function linkEntries(text: string): Link[] {
  const found = new Map<string, Link>();
  for (const raw of tokens(text)) {
    const link = linkInToken(raw);
    if (link && !found.has(link.display)) found.set(link.display, link);
  }
  return [...found.values()];
}

/**
 * URLs (any `scheme://` and `//host` link), domains (including the domains of email addresses) and
 * bare IPv4 addresses mentioned in `text`, lowercased and de-duplicated.
 */
export function linksIn(text: string): string[] {
  return linkEntries(text).map((l) => l.display);
}

/** The hosts of every URL, domain and IPv4 address in `text` (normalized; see normalizeHost). */
export function hostsIn(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const link of linkEntries(text)) if (link.host) hosts.add(link.host);
  return hosts;
}

/** `host` equals `known` or is a subdomain of it ("a.b.example.org" under "example.org"), on label boundaries. */
function underHost(host: string, known: string): boolean {
  return host === known || host.endsWith(`.${known}`);
}

/**
 * Links in an AI-written body whose host doesn't appear in the thread (review round 1, D2): a
 * body link counts as known only if its host equals, or is a subdomain of, a host that appears in
 * the thread's stored text, HTML or headers. Matching is on whole host names, never substrings
 * ("evil.co" is not "evil.com"; "bank.com" is not "mybank.com").
 *
 * S1/N2 follow-up: any `scheme://` link, `//host` links and bare IPv4 addresses count as links. An
 * IPv4 host is known only if exactly that address appears in the thread (owner Q9); a link with no
 * host or an unparseable one is always flagged (owner Q10).
 *
 * Note: this can't catch a link the sender put in their own email; it only flags links that came
 * from nowhere in the thread.
 */
export function linksNotInThread(body: string, threadHaystack: string): string[] {
  const known = hostsIn(threadHaystack);
  const knownDomains = [...known];
  return linkEntries(body)
    .filter((link) => {
      if (!link.host) return true;
      if (link.ip) return !known.has(link.host);
      return !knownDomains.some((k) => underHost(link.host!, k));
    })
    .map((l) => l.display);
}

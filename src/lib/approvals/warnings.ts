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

/** A host a link may lead to (normalized; see normalizeHost), and whether it is an IPv4 address. */
type Host = { host: string; ip: boolean };

/**
 * A link found in one token (phase-2-followups-2, SF1): what is shown, every host it may lead to,
 * and whether some part of it is a scheme link with no parseable host (then it is always flagged,
 * owner Q10).
 */
type Link = { display: string; hosts: Host[]; hostless: boolean };

const BACKSLASH = String.fromCharCode(92);
/** Schemes whose host is read without `//` (owner Q4): WHATWG's special schemes minus `file`. */
const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp"]);
/** A host substring longer than this is treated as unparseable (no slice longer than this is made). */
const MAX_HOST_CHARS = 1024;

const CC_SLASH = 47;
const CC_BACKSLASH = 92;
const CC_QUESTION = 63;
const CC_HASH = 35;
const CC_COLON = 58;
const CC_AT = 64;
/** Lowercase scheme characters: letters, digits, `+`, `.` and `-`. */
const isSchemeCode = (c: number) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45;
const isLetterCode = (c: number) => c >= 97 && c <= 122;

/**
 * A host string parsed with the WHATWG URL parser as an http host: IDNA/punycode, lowercasing,
 * fullwidth dots, percent-decoding and IPv4 normalisation (decimal, hex and octal forms). Null if it
 * is empty, can't be parsed, or is neither an IPv4 address nor a plausible domain.
 */
function parseHost(h: string): Host | null {
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
 * Per-position lookups for one token, each built in one pass (SF1 linear-time requirement), so every
 * candidate costs O(1) plus at most one memoised host parse of at most MAX_HOST_CHARS characters.
 */
function indexToken(s: string) {
  const n = s.length;
  /** Next `/`, `?`, `#` or backslash at or after i (an authority end, stopping at backslash). */
  const endWithBackslash = new Int32Array(n + 1);
  /** Next `/`, `?` or `#` at or after i (an authority end, not stopping at backslash). */
  const endNoBackslash = new Int32Array(n + 1);
  const nextColon = new Int32Array(n + 1);
  /** Next position at or after i that is neither `/` nor a backslash. */
  const nextNonSlash = new Int32Array(n + 1);
  const nextLetter = new Int32Array(n + 1);
  /** The last `@` before position i, or -1. */
  const prevAt = new Int32Array(n + 1);
  endWithBackslash[n] = endNoBackslash[n] = nextColon[n] = nextNonSlash[n] = nextLetter[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    const delim = c === CC_SLASH || c === CC_QUESTION || c === CC_HASH;
    endNoBackslash[i] = delim ? i : endNoBackslash[i + 1]!;
    endWithBackslash[i] = delim || c === CC_BACKSLASH ? i : endWithBackslash[i + 1]!;
    nextColon[i] = c === CC_COLON ? i : nextColon[i + 1]!;
    nextNonSlash[i] = c === CC_SLASH || c === CC_BACKSLASH ? nextNonSlash[i + 1]! : i;
    nextLetter[i] = isLetterCode(c) ? i : nextLetter[i + 1]!;
  }
  prevAt[0] = -1;
  for (let i = 0; i < n; i++) prevAt[i + 1] = s.charCodeAt(i) === CC_AT ? i : prevAt[i]!;

  const memo = new Map<number, Host | null>();
  /** The host range of the authority [a, end): after its last `@`, up to its first `:`; null if empty or too long. */
  const hostRange = (a: number, end: number): [number, number] | null => {
    const at = prevAt[end]!;
    const hs = at >= a ? at + 1 : a;
    const he = Math.min(nextColon[hs]!, end);
    return he > hs && he - hs <= MAX_HOST_CHARS ? [hs, he] : null;
  };
  const hostIn = (r: [number, number]): Host | null => {
    const key = r[0] * (n + 1) + r[1];
    let h = memo.get(key);
    if (h === undefined) {
      h = parseHost(s.slice(r[0], r[1]));
      memo.set(key, h);
    }
    return h;
  };
  /**
   * The hosts of the authority starting at `a`, read both stopping and not stopping at a backslash
   * (owner Q3). `strictIp` keeps an IPv4 host only if it is written as a strict dotted quad.
   */
  const hostsAt = (a: number, strictIp = false): Host[] => {
    const out: Host[] = [];
    for (const end of [endWithBackslash[a]!, endNoBackslash[a]!]) {
      const r = hostRange(a, end);
      if (!r) continue;
      const h = hostIn(r);
      if (!h || out.some((o) => o.host === h.host)) continue;
      if (strictIp && h.ip && !isIPv4(s.slice(r[0], r[1]))) continue;
      out.push(h);
    }
    return out;
  };
  return { nextColon, nextNonSlash, nextLetter, hostsAt };
}

/** The first `/`, `?`, `#` or backslash in `s` at or after `from`, or `s.length`. */
function authorityEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === CC_SLASH || c === CC_QUESTION || c === CC_HASH || c === CC_BACKSLASH) break;
    i++;
  }
  return i;
}

/** R5: every `:`-separated segment of s[from, to) that is a plausible domain or a strict IPv4 address (owner Q5). */
function bareHosts(s: string, from: number, to: number, out: Host[]): void {
  let i = from;
  while (i <= to) {
    let j = s.indexOf(":", i);
    if (j < 0 || j > to) j = to;
    if (j > i && j - i <= MAX_HOST_CHARS) {
      const seg = s.slice(i, j);
      if (isIPv4(seg)) out.push({ host: seg, ip: true });
      else {
        const domain = normalizeHost(seg);
        if (domain) out.push({ host: domain, ip: false });
      }
    }
    i = j + 1;
  }
}

/**
 * The links in one token (SF1, phase-2-followups-2). The token is stripped of trailing sentence
 * punctuation and lowercased. Every host candidate in it counts (owner Q2):
 * - R1: a `:` after a special scheme (`http`, `https`, `ws`, `wss`, `ftp`; owner Q4), with or
 *   without slashes: any run of `/` and backslashes is skipped, then the authority is read.
 * - R2: `://` after any other scheme (the run of scheme characters before it, from its first letter).
 * - R3: `://` with no valid scheme before it (`://`, `_://`, `0://`, a look-alike such as a Cyrillic
 *   letter): read as a `//host`, and a link only if that gives a domain or a strict IPv4 address.
 * - R4: a token that starts with `//`: a link only if it gives a domain or an IPv4 address.
 * - R5: bare hosts: the text after the token's last `@`, and the token's authority after its own last
 *   `@`, each cut at `/`, `?`, `#` or backslash; every `:` segment that is a plausible domain or a
 *   strict IPv4 address counts. Shown as the host.
 * An authority's host is after its last `@` and before its first `:`, read both stopping and not
 * stopping at a backslash (owner Q3). R1–R4 candidates in a token form one link, shown from the
 * earliest candidate's start (the scheme, or the token for R3/R4), with all their hosts; it is
 * host-less (always flagged) if an R1 or R2 candidate has no parseable host. R5 hosts already in the
 * token are skipped.
 */
function linksInToken(raw: string): Link[] {
  const s = stripTrailing(raw).toLowerCase();
  if (s === "") return [];
  let url: { start: number; hosts: Host[]; hostless: boolean } | null = null;
  // Round 2 (D1): a Set, so a token with many distinct hosts stays linear (no scan of the list per host).
  const urlHosts = new Set<string>();
  const addUrl = (start: number, hosts: Host[], hostless: boolean) => {
    if (!url) url = { start, hosts: [], hostless: false };
    url.start = Math.min(url.start, start);
    url.hostless ||= hostless;
    for (const h of hosts) {
      if (urlHosts.has(h.host)) continue;
      urlHosts.add(h.host);
      url.hosts.push(h);
    }
  };

  const startsSlashSlash = s.startsWith("//");
  if (startsSlashSlash || s.includes(":")) {
    const ix = indexToken(s);
    if (startsSlashSlash) {
      const hosts = ix.hostsAt(2);
      if (hosts.length > 0) addUrl(0, hosts, false);
    }
    // Left to right over every `:`. The backward scheme scans don't overlap (a scheme can't contain
    // `:`), so all of this is linear in the token.
    for (let p = ix.nextColon[0]!; p < s.length; p = ix.nextColon[p + 1]!) {
      let run = p;
      while (run > 0 && isSchemeCode(s.charCodeAt(run - 1))) run--;
      const schemeStart = ix.nextLetter[run]!;
      const hasScheme = schemeStart < p;
      const slashes = s.charCodeAt(p + 1) === CC_SLASH && s.charCodeAt(p + 2) === CC_SLASH;
      if (hasScheme && p - schemeStart <= 5 && SPECIAL_SCHEMES.has(s.slice(schemeStart, p))) {
        const hosts = ix.hostsAt(ix.nextNonSlash[p + 1]!);
        addUrl(schemeStart, hosts, hosts.length === 0);
      } else if (slashes && hasScheme) {
        const hosts = ix.hostsAt(p + 3);
        addUrl(schemeStart, hosts, hosts.length === 0);
      } else if (slashes) {
        const hosts = ix.hostsAt(p + 3, true);
        if (hosts.length > 0) addUrl(0, hosts, false);
      }
    }
  }

  const out: Link[] = [];
  const seen = new Set<string>();
  const found = url as { start: number; hosts: Host[]; hostless: boolean } | null;
  if (found) {
    out.push({ display: s.slice(found.start), hosts: found.hosts, hostless: found.hostless });
    for (const h of found.hosts) seen.add(h.host);
  }
  const bare: Host[] = [];
  const lastAt = s.lastIndexOf("@");
  bareHosts(s, lastAt + 1, authorityEnd(s, lastAt + 1), bare);
  const end0 = authorityEnd(s, 0);
  const at0 = end0 > 0 ? s.lastIndexOf("@", end0 - 1) : -1;
  if (at0 !== lastAt) bareHosts(s, at0 + 1, end0, bare);
  for (const h of bare) {
    if (seen.has(h.host)) continue;
    seen.add(h.host);
    out.push({ display: h.host, hosts: [h], hostless: false });
  }
  return out;
}

/** Every link in `text`, de-duplicated by what is shown. */
function linkEntries(text: string): Link[] {
  const found = new Map<string, Link>();
  for (const raw of tokens(text)) {
    for (const link of linksInToken(raw)) if (!found.has(link.display)) found.set(link.display, link);
  }
  return [...found.values()];
}

/**
 * URLs (scheme links with or without `//`, `//host` links), domains (including the domains of email
 * addresses and `host:port` forms) and bare IPv4 addresses mentioned in `text`, lowercased and
 * de-duplicated. See linksInToken for the rules.
 */
export function linksIn(text: string): string[] {
  return linkEntries(text).map((l) => l.display);
}

/** The hosts of every URL, domain and IPv4 address in `text` (normalized; see normalizeHost). */
export function hostsIn(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const link of linkEntries(text)) for (const h of link.hosts) hosts.add(h.host);
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
 * SF1 (phase-2-followups-2): a link may have several hosts (every candidate in its token, both
 * backslash readings); it is flagged if any of them is unknown.
 *
 * Note: this can't catch a link the sender put in their own email; it only flags links that came
 * from nowhere in the thread.
 */
export function linksNotInThread(body: string, threadHaystack: string): string[] {
  const known = hostsIn(threadHaystack);
  const knownDomains = [...known];
  const isKnown = (h: Host) => (h.ip ? known.has(h.host) : knownDomains.some((k) => underHost(h.host, k)));
  return linkEntries(body)
    .filter((link) => link.hostless || link.hosts.length === 0 || !link.hosts.every(isKnown))
    .map((l) => l.display);
}

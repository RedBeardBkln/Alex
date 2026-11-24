// FROZEN BASELINE: a copy of src/lib/approvals/warnings.ts at main 82c6255 (phase-h1-link-hardening, A1).
// Only the ./text import line differs (it uses the @/ alias). It is the reference for tests/h1-links-differential.test.ts:
// the link rules may only ever add warnings relative to this copy. Never import it from src/. Update it only when the
// owner approves a change that removes warnings, and then update the sha256 constant in h1-links-differential too.

import { replySubject } from "@/lib/gmail/compose";
import { findInvisible, hasBidiControl } from "@/lib/approvals/text";

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

/**
 * S3 (phase-2-followups-3): `text` without its trailing partial token, for a field cut by a size
 * cap. Keeps everything up to and including the last TOKEN_BREAK character, or nothing if there is
 * none. A cut inside "bank.com" must not leave "bank.co" behind as a known host (fail toward
 * warning). Every TOKEN_BREAK character is a single UTF-16 unit, so this never splits a pair.
 */
export function cutAtTokenBoundary(text: string): string {
  for (let i = text.length - 1; i >= 0; i--) if (TOKEN_BREAK.has(text[i]!)) return text.slice(0, i + 1);
  return "";
}

/** A punycode (IDN) top-level label written in ASCII, such as "xn--p1ai" (N2, owner Q5). */
const PUNYCODE_TLD = /^xn--[a-z0-9-]{1,59}$/i;

function isDomain(s: string): boolean {
  if (s.length < 4 || s.length > 253) return false;
  const labels = s.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1]!;
  if (!PUNYCODE_TLD.test(tld) && (tld.length < 2 || tld.length > 24 || !/^[a-z]+$/i.test(tld))) return false;
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
export type Host = { host: string; ip: boolean };

/**
 * A link found in one token (phase-2-followups-2, SF1): what is shown, every host it may lead to,
 * and whether it is always flagged: some part of it is a scheme link with no parseable host (owner
 * Q10), or a network-share or Windows handler form (phase-2-followups-3, S2/N2).
 */
type Link = { display: string; hosts: Host[]; always: boolean };

const BACKSLASH = String.fromCharCode(92);
/** Schemes whose host is read without `//` (owner Q4): WHATWG's special schemes minus `file`. */
const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp"]);
const CC_EQUALS = 61;
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
/** D1: a character that can be part of a (lowercased) domain: a-z, 0-9, "-", "." or non-ASCII. */
const isDomainRunCode = (c: number) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c > 127;

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

  return {
    s,
    n,
    nextColon,
    nextNonSlash,
    nextLetter,
    endWithBackslash,
    endNoBackslash,
    prevAt,
    hostRange,
    hostIn,
    hostsAt,
    /** D1b: built on the first lenient read only (see lenientIndex). */
    nextGlue: null as Int32Array | null,
    domainRunEnd: null as Int32Array | null,
  };
}

type TokenIndex = ReturnType<typeof indexToken>;
type Lenient = { hosts: Host[]; encodedAt: boolean };
const NO_LENIENT: Lenient = { hosts: [], encodedAt: false };

/**
 * D1b: the lenient lookups, built in one pass on a token's first lenient read, so tokens that never
 * need one pay nothing: nextGlue[i] is the next `&` or `=` at or after i (query text glued into an
 * authority), and domainRunEnd[i] the first position at or after i that is not a domain character.
 */
function lenientIndex(ix: TokenIndex): void {
  const { s, n } = ix;
  const g = new Int32Array(n + 1);
  const d = new Int32Array(n + 1);
  g[n] = d[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    g[i] = c === 38 || c === 61 ? i : g[i + 1]!;
    d[i] = isDomainRunCode(c) ? d[i + 1]! : i;
  }
  ix.nextGlue = g;
  ix.domainRunEnd = d;
}

/** The accumulator of one lenientAt call (module-level, so a token's reads allocate no closures). */
const lenAcc: { hosts: Host[] | null; encodedAt: boolean } = { hosts: null, encodedAt: false };

function takeRun(ix: TokenIndex, st: number, failed: [number, number] | null, strictIp: boolean): void {
  const { s } = ix;
  const e = Math.min(ix.domainRunEnd![st]!, st + MAX_HOST_CHARS);
  if (s.charCodeAt(e) === 37 && s.startsWith("%40", e)) lenAcc.encodedAt = true;
  if (e === st || (failed !== null && failed[0] === st && failed[1] === e)) return;
  const h = ix.hostIn([st, e]);
  if (!h || (strictIp && h.ip && !isIPv4(s.slice(st, e)))) return;
  if (lenAcc.hosts === null) lenAcc.hosts = [h];
  else if (!lenAcc.hosts.some((o) => o.host === h.host)) lenAcc.hosts.push(h);
}

function lenientReading(ix: TokenIndex, a: number, end: number, strictIp: boolean): void {
  const at = ix.prevAt[end]!;
  const range = ix.hostRange(a, end);
  if (range === null) takeRun(ix, at >= a ? at + 1 : a, null, strictIp);
  else if (!ix.hostIn(range)) takeRun(ix, at >= a ? at + 1 : a, range, strictIp);
  if (at >= a && ix.nextGlue![a]! < at) takeRun(ix, a, null, strictIp);
}

/**
 * D1/D1b (rounds 2 and 4): extra hosts for the authority at `a`, used only to add hosts (never to
 * clear the host-less flag or to mark a link as covered for N-1). For each backslash reading (as
 * hostsAt; once if both readings end at the same place):
 * - if the strict read gave no host (WHATWG reads "evil.test&v=1" as the host), the run of domain
 *   characters after the authority's last `@` (prevAt), or from `a` if it has none:
 *   `user@evil.test&v=1` gives evil.test;
 * - if the part before that `@` contains `&` or `=` (query text glued on), also the run from `a`:
 *   `evil.test&e=a@bank.test` gives evil.test (a redirector splitting the query on `&` goes there).
 *   Plain userinfo (`john.doe@host`, `user:pw@host`) is not read as a host.
 * A run is the longest stretch of a-z, 0-9, "-", "." or non-ASCII (domainRunEnd, at most
 * MAX_HOST_CHARS), parsed through hostIn; a run equal to the strict range that just failed isn't
 * parsed again. `encodedAt` is true if a run stopped at "%40" (an encoded `@`, as in
 * `bank.test%40evil.test`): the caller then always flags the link.
 * Linear: every run starts at a candidate's authority start (right after ":", "/" or a backslash)
 * or right after an "@", which are non-domain characters, and covers only domain characters, so runs
 * from different starts don't overlap; each costs at most one memoised parse.
 */
function lenientAt(ix: TokenIndex, a: number, strictIp = false): Lenient {
  if (ix.nextGlue === null) lenientIndex(ix);
  lenAcc.hosts = null;
  lenAcc.encodedAt = false;
  const e1 = ix.endWithBackslash[a]!;
  const e2 = ix.endNoBackslash[a]!;
  lenientReading(ix, a, e1, strictIp);
  if (e2 !== e1) lenientReading(ix, a, e2, strictIp);
  if (lenAcc.hosts === null && !lenAcc.encodedAt) return NO_LENIENT;
  return { hosts: lenAcc.hosts ?? [], encodedAt: lenAcc.encodedAt };
}

/** The strict hosts plus the lenient ones (a new array only when there are lenient ones). */
const withLenient = (strict: Host[], l: Lenient): Host[] => (l.hosts.length > 0 ? [...strict, ...l.hosts] : strict);

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

/** Characters the WHATWG host parser treats as a label dot: `.`, U+3002, U+FF0E and U+FF61. */
const isDotCode = (c: number) => c === 46 || c === 0x3002 || c === 0xff0e || c === 0xff61;

/**
 * N2 (owner Q5): a bare host's punycode TLD counts only if its last label was written in ASCII, so
 * CJK or Cyrillic prose that the URL parser maps to xn-- labels doesn't become a "domain".
 */
function asciiLastLabel(seg: string): boolean {
  let end = seg.length;
  while (end > 0 && isDotCode(seg.charCodeAt(end - 1))) end--;
  let i = end;
  while (i > 0 && !isDotCode(seg.charCodeAt(i - 1))) i--;
  for (let k = i; k < end; k++) if (seg.charCodeAt(k) > 127) return false;
  return true;
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
        if (domain && (!domain.slice(domain.lastIndexOf(".") + 1).startsWith("xn--") || asciiLastLabel(seg))) out.push({ host: domain, ip: false });
      }
    }
    i = j + 1;
  }
}

/** True for `/` or a backslash. */
const isSlashCode = (c: number) => c === CC_SLASH || c === CC_BACKSLASH;

/**
 * S2 (owner Q1): a UNC prefix at position q: `\\`, `\/` or `/\` (not `//`, which is R4), then at
 * least one character that is neither `/` nor a backslash.
 */
function uncAt(s: string, q: number): boolean {
  if (q + 2 >= s.length) return false;
  const a = s.charCodeAt(q);
  const b = s.charCodeAt(q + 1);
  return isSlashCode(a) && isSlashCode(b) && !(a === CC_SLASH && b === CC_SLASH) && !isSlashCode(s.charCodeAt(q + 2));
}

/**
 * D2 (round 3): Unicode White_Space characters that aren't in TOKEN_BREAK (NBSP, U+2000–U+200A, the
 * ideographic space and others). They start a new leading run for the UNC check only.
 */
const isExtraSpace = (c: number) =>
  c === 0x0b || c === 0x0c || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
/** D2: a letter or digit (any script) at i. ASCII is checked directly; other characters by code point. */
function isWordCode(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  if (c < 128) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
  return WORD_CHAR.test(String.fromCodePoint(s.codePointAt(i)!));
}

/**
 * S2/N2 (owner Q1, Q1b, Q5): schemes that are always flagged, whatever the thread contains. `file` and
 * `smb` only when a `/` or backslash follows the colon (`file:evil.test` keeps the R5 reading);
 * `search-ms`, `search` and `ms-*` (Windows handler schemes) with or without slashes. Each check is
 * O(1): a length comparison, then a bounded startsWith.
 */
function alwaysScheme(s: string, schemeStart: number, colon: number): boolean {
  const len = colon - schemeStart;
  if (len === 9 && s.startsWith("search-ms", schemeStart)) return true;
  if (len === 6 && s.startsWith("search", schemeStart)) return true;
  if (len > 3 && s.startsWith("ms-", schemeStart)) return true;
  if (!isSlashCode(s.charCodeAt(colon + 1))) return false;
  return (len === 4 && s.startsWith("file", schemeStart)) || (len === 3 && s.startsWith("smb", schemeStart));
}

/**
 * The links in one token (SF1, phase-2-followups-2). The token is stripped of trailing sentence
 * punctuation and lowercased. Every host candidate in it counts (owner Q2):
 * - R1: a `:` after a special scheme (`http`, `https`, `ws`, `wss`, `ftp`; owner Q4), with or
 *   without slashes: any run of `/` and backslashes is skipped, then the authority is read.
 * - R2: `://` after any other scheme (the run of scheme characters before it, from its first letter).
 * - R3: `://` with no valid scheme before it (`://`, `_://`, `0://`, a look-alike such as a Cyrillic
 *   letter): read as a `//host`, and a link only if that gives a domain or a strict IPv4 address.
 * - R4: a token that starts with `//`, or (phase-2-followups-3, N2) a `//` right after an `=`: a
 *   link only if it gives a domain or an IPv4 address.
 * - R5: bare hosts: the text after the token's last `@`, and the token's authority after its own last
 *   `@`, each cut at `/`, `?`, `#` or backslash; every `:` segment that is a plausible domain or a
 *   strict IPv4 address counts (a punycode TLD only if written in ASCII). Shown as the host.
 * - Always flagged (phase-2-followups-3, S2/N2; owner Q1, Q1b, Q5): a UNC prefix (`\\`, `\/`, `/\`)
 *   at the token's start, after a leading run of non-alphanumeric characters (D2, round 3; a
 *   Unicode space that isn't a token break starts a new run), or right after an `=`, shown from there; `file:` or `smb:` followed by `/`
 *   or a backslash; and the `search-ms:`, `search:` and `ms-*:` schemes, shown from the scheme.
 *   These need no host parse (R2 still reads the hosts of `file://` and `smb://`).
 * An authority's host is after its last `@` and before its first `:`, read both stopping and not
 * stopping at a backslash (owner Q3). R1–R4 and always-flag candidates in a token form one link,
 * shown from the earliest candidate's start (the scheme, or the token for R3/R4), with all their
 * hosts. It is always flagged if it has an always-flag candidate, or an R1 or R2 candidate with no
 * parseable host that starts before the authority end of the first candidate that gave a host
 * (N-1, owner Q4: a host-less `myapp://` inside a known link's path, query or fragment no longer
 * flags it). Every R1–R4 and `=//` candidate also contributes lenient hosts (indexToken's lenientAt;
 * D1/D1b, rounds 2 and 4): when a backslash reading has no strict host, the run of domain characters
 * after the authority's last `@`, so `?next=https://bank.test@evil.test&v=1` still checks evil.test;
 * and the run from the authority start when query text (`&`, `=`) is glued before an `@`. These only
 * add hosts. A lenient run that stops at `%40` always flags the link. R5 hosts already in the token
 * are skipped.
 *
 * Linear time: the backward scheme scans don't overlap (a scheme can't contain `:`); every `:` and
 * `=` position costs O(1) plus at most one memoised host parse of at most MAX_HOST_CHARS characters;
 * the authority ranges of R1–R4 and `=//` candidates start after a `:` + slashes, or after `//`, and
 * end at the next `/`, `?` or `#`, so they don't overlap each other.
 */
function linksInToken(raw: string): Link[] {
  const s = stripTrailing(raw).toLowerCase();
  if (s === "") return [];
  let url: { start: number; hosts: Host[]; always: boolean } | null = null;
  // Round 2 (D1): a Set, so a token with many distinct hosts stays linear (no scan of the list per host).
  const urlHosts = new Set<string>();
  const addUrl = (start: number, hosts: Host[], always: boolean) => {
    if (!url) url = { start, hosts: [], always: false };
    url.start = Math.min(url.start, start);
    url.always ||= always;
    for (const h of hosts) {
      if (urlHosts.has(h.host)) continue;
      urlHosts.add(h.host);
      url.hosts.push(h);
    }
  };
  /** N-1: the authority end of the first candidate that gave a host, and the first host-less R1/R2 scheme start. */
  let coveredFrom = Number.POSITIVE_INFINITY;
  let hostlessFrom = Number.POSITIVE_INFINITY;

  const startsSlashSlash = s.startsWith("//");
  const hasColon = s.includes(":");
  const hasEquals = s.includes("=");
  // D2 (owner "Narrow", round 3): a UNC prefix is also flagged after a leading run of non-alphanumeric
  // characters (curly quotes, guillemets, ASCII punctuation). A Unicode space that isn't a token break
  // (NBSP, U+2003 and so on) starts a new leading run, for this check only. One forward pass.
  let lead = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isExtraSpace(c)) lead = true;
    else if (!lead) continue;
    else if (isSlashCode(c)) {
      if (uncAt(s, i)) addUrl(i, [], true);
      lead = false;
    } else if (isWordCode(s, i)) lead = false;
  }
  if (startsSlashSlash || hasColon || hasEquals) {
    const ix = indexToken(s);
    /** Hosts of a candidate whose authority starts at a; records coveredFrom when it gives any. */
    const hostsFrom = (a: number, strictIp = false) => {
      const hosts = ix.hostsAt(a, strictIp);
      if (hosts.length > 0) coveredFrom = Math.min(coveredFrom, ix.endNoBackslash[a]!);
      return hosts;
    };
    // D1/D1b: each candidate also gets lenientAt hosts (only added; an encoded "@" always flags).
    if (startsSlashSlash) {
      const l = lenientAt(ix, 2);
      if (l.encodedAt) addUrl(0, [], true);
      const hosts = withLenient(hostsFrom(2), l);
      if (hosts.length > 0) addUrl(0, hosts, false);
    }
    // Every `=`: a UNC prefix right after it is always flagged; a `//host` right after it is read like R4.
    if (hasEquals) {
      for (let e = s.indexOf("="); e >= 0; e = s.indexOf("=", e + 1)) {
        const q = e + 1;
        if (uncAt(s, q)) addUrl(q, [], true);
        else if (s.charCodeAt(q) === CC_SLASH && s.charCodeAt(q + 1) === CC_SLASH && q + 2 < s.length && !isSlashCode(s.charCodeAt(q + 2))) {
          const l = lenientAt(ix, q + 2);
          if (l.encodedAt) addUrl(0, [], true);
          const hosts = withLenient(hostsFrom(q + 2), l);
          if (hosts.length > 0) addUrl(0, hosts, false);
        }
      }
    }
    // Left to right over every `:`.
    for (let p = ix.nextColon[0]!; p < s.length; p = ix.nextColon[p + 1]!) {
      let run = p;
      while (run > 0 && isSchemeCode(s.charCodeAt(run - 1))) run--;
      const schemeStart = ix.nextLetter[run]!;
      const hasScheme = schemeStart < p;
      const slashes = s.charCodeAt(p + 1) === CC_SLASH && s.charCodeAt(p + 2) === CC_SLASH;
      if (hasScheme && p - schemeStart <= 5 && SPECIAL_SCHEMES.has(s.slice(schemeStart, p))) {
        const a = ix.nextNonSlash[p + 1]!;
        const strict = hostsFrom(a);
        if (strict.length === 0) hostlessFrom = Math.min(hostlessFrom, schemeStart);
        const l = lenientAt(ix, a);
        if (l.encodedAt) addUrl(schemeStart, [], true);
        addUrl(schemeStart, withLenient(strict, l), false);
      } else if (slashes && hasScheme) {
        const strict = hostsFrom(p + 3);
        if (strict.length === 0) hostlessFrom = Math.min(hostlessFrom, schemeStart);
        const l = lenientAt(ix, p + 3);
        if (l.encodedAt) addUrl(schemeStart, [], true);
        addUrl(schemeStart, withLenient(strict, l), false);
      } else if (slashes) {
        const l = lenientAt(ix, p + 3, true);
        if (l.encodedAt) addUrl(0, [], true);
        const hosts = withLenient(hostsFrom(p + 3, true), l);
        if (hosts.length > 0) addUrl(0, hosts, false);
      }
      if (hasScheme && alwaysScheme(s, schemeStart, p)) addUrl(schemeStart, [], true);
    }
    if (hostlessFrom < coveredFrom) addUrl(hostlessFrom, [], true);
  }

  const out: Link[] = [];
  const seen = new Set<string>();
  const found = url as { start: number; hosts: Host[]; always: boolean } | null;
  if (found) {
    out.push({ display: s.slice(found.start), hosts: found.hosts, always: found.always });
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
    out.push({ display: h.host, hosts: [h], always: false });
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

/**
 * True if `h` is known (S3a, phase-2-followups-3): an IPv4 host only if exactly that address is in
 * `known` (owner Q9); a domain if it, or one of its label suffixes ("example.org" for
 * "a.b.example.org"), is in `known`. Exactly "equals or is a subdomain of some known host, on label
 * boundaries", with O(labels) Set lookups instead of a scan of every known host. A normalized domain
 * has no leading or trailing dot, and no IPv4 address is a label suffix of a domain (its last label
 * is all digits, a domain's TLD never is).
 */
export function isKnownHost(h: Host, known: ReadonlySet<string>): boolean {
  if (known.has(h.host)) return true;
  if (h.ip) return false;
  for (let i = h.host.indexOf("."); i >= 0; i = h.host.indexOf(".", i + 1)) if (known.has(h.host.slice(i + 1))) return true;
  return false;
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
 * Phase-2-followups-3: network-share and Windows handler forms are always flagged (S2/N2), and the
 * thread haystack may be only the newest part of a very long thread (S3, see threadContext), which
 * can only add warnings.
 *
 * Note: this can't catch a link the sender put in their own email; it only flags links that came
 * from nowhere in the thread.
 */
export function linksNotInThread(body: string, threadHaystack: string): string[] {
  const known = hostsIn(threadHaystack);
  return linkEntries(body)
    .filter((link) => link.always || link.hosts.length === 0 || !link.hosts.every((h) => isKnownHost(h, known)))
    .map((l) => l.display);
}

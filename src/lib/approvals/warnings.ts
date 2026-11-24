import { replySubject } from "@/lib/gmail/compose";
import { findInvisible, hasBidiControl, isInvisibleOrBidi } from "./text";

/**
 * Subject warnings on the approval screen:
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

// ---- Content warnings for AI-written drafts --------------------------------------------------

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
 * `text` without its trailing partial token, for a field cut by a size cap. Keeps everything up to
 * and including the last TOKEN_BREAK character, or nothing if there is none. A cut inside "bank.com"
 * must not leave "bank.co" behind as a known host (fail toward warning). Every TOKEN_BREAK character
 * is a single UTF-16 unit, so this never splits a pair.
 */
export function cutAtTokenBoundary(text: string): string {
  for (let i = text.length - 1; i >= 0; i--) if (TOKEN_BREAK.has(text[i]!)) return text.slice(0, i + 1);
  return "";
}

/** A punycode (IDN) top-level label written in ASCII, such as "xn--p1ai" (owner Q5). */
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
 * A link found in one token: what is shown, every host it may lead to, and whether it is always
 * flagged: some part of it is a scheme link with no parseable host (owner Q10), or a network-share or
 * Windows handler form (owner Q1, Q5).
 *
 * Two tiers (owner Q1 a): `hosts` are the hosts the baseline (batch-3) rules read, and they alone make up the
 * thread's known set (hostsIn). `extraHosts` are hosts found only by the newer reads (the glue run
 * after a userinfo, and percent-decoded segments); they never make a host known for a base host,
 * and are checked against the thread read the same way (see linksNotInThread).
 */
type Link = { display: string; hosts: Host[]; extraHosts: Host[]; always: boolean };

/**
 * How a token is scanned: BASE reads only the base hosts (for the known set); FULL adds the extra
 * reads, including one percent-decoding pass; DECODED is the scan of a decoded segment's tokens
 * (extra reads on, no further decoding, and no host-less flag, owner Q3).
 */
const BASE = 0;
const FULL = 1;
const DECODED = 2;
type ScanMode = typeof BASE | typeof FULL | typeof DECODED;

/** Schemes whose host is read without `//` (owner Q4): WHATWG's special schemes minus `file`. */
const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp"]);
/** A host substring longer than this is treated as unparseable (no slice longer than this is made). */
const MAX_HOST_CHARS = 1024;

const CC_PERCENT = 37;
const CC_AMP = 38;
const CC_SLASH = 47;
const CC_COLON = 58;
const CC_EQUALS = 61;
const CC_QUESTION = 63;
const CC_AT = 64;
const CC_HASH = 35;
const CC_BACKSLASH = 92;
const CC_TAB = 9;
const CC_LF = 10;
const CC_CR = 13;
const CC_SPACE = 32;
const CC_PLUS = 43;
/** The last C0 control (U+001F); U+0000–U+001F plus the space are WHATWG's leading-strip set. */
const CC_LAST_C0 = 31;
/** Lowercase scheme characters: letters, digits, `+`, `.` and `-`. */
const isSchemeCode = (c: number) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45;
const isLetterCode = (c: number) => c >= 97 && c <= 122;
/** A character that can be part of a (lowercased) domain: a-z, 0-9, "-", "." or non-ASCII. */
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

/** UTF-8 for decoded bytes: invalid sequences become U+FFFD (never throws), and a BOM is kept as a character. */
const UTF8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
/**
 * Reused byte buffer for one run of escapes (grown on demand, dropped again after a very long run).
 * Module state shared across requests, like lenAcc: safe because every function that touches it is
 * synchronous (no `await`), so two calls can't interleave in one isolate. Keep it that way.
 */
let escapeBytes = new Uint8Array(256);
const hexValue = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);
/** True if a valid `%XX` escape starts at i and ends before `to`. */
const escapeAt = (s: string, i: number, to: number) =>
  i + 2 < to && s.charCodeAt(i) === CC_PERCENT && hexValue(s.charCodeAt(i + 1)) >= 0 && hexValue(s.charCodeAt(i + 2)) >= 0;

/**
 * s[from, to) percent-decoded once, then lowercased (owner Q2): each valid `%XX` (either case)
 * is a byte, and each run of consecutive bytes is decoded as UTF-8 (invalid bytes become U+FFFD);
 * every other character, `+` and an invalid `%` included, is copied. The result is never decoded
 * again, and is never longer than the range before lowercasing: three units become at most one.
 * Linear: one pass, one TextDecoder call per run of escapes, output joined once.
 */
export function percentDecodeOnce(s: string, from: number, to: number): string {
  const out: string[] = [];
  let lit = from;
  let i = from;
  while (i < to) {
    if (!escapeAt(s, i, to)) {
      i++;
      continue;
    }
    if (i > lit) out.push(s.slice(lit, i));
    let k = 0;
    let ascii = true;
    while (escapeAt(s, i, to)) {
      if (k === escapeBytes.length) {
        const grown = new Uint8Array(k * 2);
        grown.set(escapeBytes);
        escapeBytes = grown;
      }
      const v = hexValue(s.charCodeAt(i + 1)) * 16 + hexValue(s.charCodeAt(i + 2));
      escapeBytes[k++] = v;
      if (v > 127) ascii = false;
      i += 3;
    }
    if (ascii) for (let j = 0; j < k; j++) out.push(String.fromCharCode(escapeBytes[j]!));
    else out.push(UTF8.decode(escapeBytes.subarray(0, k)));
    if (escapeBytes.length > 65_536) escapeBytes = new Uint8Array(256);
    lit = i;
  }
  if (to > lit) out.push(s.slice(lit, to));
  return out.join("").toLowerCase();
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
 * Per-position lookups for one token, each built in one pass, so every candidate costs O(1) plus at
 * most one memoised host parse of at most MAX_HOST_CHARS characters.
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
    /** The lenient lookups, built on the token's first lenient read only (see lenientIndex). */
    nextGlue: null as Int32Array | null,
    nextAmp: null as Int32Array | null,
    domainRunEnd: null as Int32Array | null,
  };
}

type TokenIndex = ReturnType<typeof indexToken>;
/**
 * Lenient hosts: base ones (`hosts`), extra ones (`extra`, the glue run after a userinfo), and the
 * "%40" stop of a base run (`encodedAt`) or of the extra run (`encodedExtra`).
 */
type Lenient = { hosts: Host[]; extra: Host[]; encodedAt: boolean; encodedExtra: boolean };
const NO_HOSTS = Object.freeze([]) as unknown as Host[];
const NO_LENIENT: Lenient = Object.freeze({ hosts: NO_HOSTS, extra: NO_HOSTS, encodedAt: false, encodedExtra: false });

/**
 * The lenient lookups, built in one pass on a token's first lenient read, so tokens that never need
 * one pay nothing: nextGlue[i] is the next `&` or `=` at or after i (query text glued into an
 * authority), nextAmp[i] the next `&` at or after i, and domainRunEnd[i] the first position at or
 * after i that is not a domain character.
 */
function lenientIndex(ix: TokenIndex): void {
  const { s, n } = ix;
  const g = new Int32Array(n + 1);
  const m = new Int32Array(n + 1);
  const d = new Int32Array(n + 1);
  g[n] = m[n] = d[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    g[i] = c === CC_AMP || c === CC_EQUALS ? i : g[i + 1]!;
    m[i] = c === CC_AMP ? i : m[i + 1]!;
    d[i] = isDomainRunCode(c) ? d[i + 1]! : i;
  }
  ix.nextGlue = g;
  ix.nextAmp = m;
  ix.domainRunEnd = d;
}

/**
 * The accumulator of one lenientAt call (module-level, so a token's reads allocate no closures).
 * Shared across requests: safe because lenientAt and everything it calls are synchronous (no
 * `await`), so two calls can't interleave in one isolate. Keep it that way.
 */
const lenAcc: { hosts: Host[] | null; extra: Host[] | null; encodedAt: boolean; encodedExtra: boolean } = {
  hosts: null,
  extra: null,
  encodedAt: false,
  encodedExtra: false,
};

/** One lenient run from `st`, added to the base (`extra` false) or the extra lenient hosts. */
function takeRun(ix: TokenIndex, st: number, failed: [number, number] | null, strictIp: boolean, extra = false): void {
  const { s } = ix;
  const e = Math.min(ix.domainRunEnd![st]!, st + MAX_HOST_CHARS);
  if (s.charCodeAt(e) === CC_PERCENT && s.startsWith("%40", e)) {
    if (extra) lenAcc.encodedExtra = true;
    else lenAcc.encodedAt = true;
  }
  if (e === st || (failed !== null && failed[0] === st && failed[1] === e)) return;
  const h = ix.hostIn([st, e]);
  if (!h || (strictIp && h.ip && !isIPv4(s.slice(st, e)))) return;
  // At most four runs per lenientAt call, so this .some is O(1).
  const list = extra ? lenAcc.extra : lenAcc.hosts;
  if (list === null) {
    if (extra) lenAcc.extra = [h];
    else lenAcc.hosts = [h];
  } else if (!list.some((o) => o.host === h.host)) list.push(h);
}

function lenientReading(ix: TokenIndex, a: number, end: number, strictIp: boolean, extras: boolean): void {
  const at = ix.prevAt[end]!;
  const range = ix.hostRange(a, end);
  if (range === null) takeRun(ix, at >= a ? at + 1 : a, null, strictIp);
  else if (!ix.hostIn(range)) takeRun(ix, at >= a ? at + 1 : a, range, strictIp);
  const glue = ix.nextGlue![a]!;
  if (at >= a && glue < at) {
    takeRun(ix, a, null, strictIp);
    // A userinfo before the first `&` (`https://bank.test@evil.test&e=x@bank.test`, also with an `=`
    // inside it: `https://bank.test=1@evil.test&e=…`) hides the host a redirector splitting the query on
    // `&` goes to, so also read the run after the last `@` before the first `&`. Extra only.
    const amp = ix.nextAmp![a]!;
    if (extras && amp < at) {
      const u = ix.prevAt[amp]!;
      if (u >= a) takeRun(ix, u + 1, null, strictIp, true);
    }
  }
}

/**
 * Lenient hosts for the authority at `a`, used only to add hosts (never to clear the host-less flag
 * or to mark a link as covered for N-1). For each backslash reading (as hostsAt; once if both
 * readings end at the same place):
 * - if the strict read gave no host (WHATWG reads "evil.test&v=1" as the host), the run of domain
 *   characters after the authority's last `@` (prevAt), or from `a` if it has none:
 *   `user@evil.test&v=1` gives evil.test;
 * - if the part before that `@` contains `&` or `=` (query text glued on), also the run from `a`:
 *   `evil.test&e=a@bank.test` gives evil.test (a redirector splitting the query on `&` goes there).
 *   Plain userinfo (`john.doe@host`, `user:pw@host`) is not read as a host. With `extras`, if the
 *   authority has an `&` before its last `@`, also the run after the last `@` before that first `&`,
 *   as an extra host: `bank.test@evil.test&e=x@bank.test` and `bank.test=1@evil.test&e=x@bank.test`
 *   give evil.test.
 * A run is the longest stretch of a-z, 0-9, "-", "." or non-ASCII (domainRunEnd, at most
 * MAX_HOST_CHARS), parsed through hostIn; a run equal to the strict range that just failed isn't
 * parsed again. `encodedAt` (a base run) or `encodedExtra` (the extra run) is true if a run stopped
 * at "%40" (an encoded `@`, as in `bank.test%40evil.test`): the caller then always flags the link.
 * Linear: every run starts at a candidate's authority start (right after ":", "/" or a backslash)
 * or right after an "@", which are non-domain characters, and covers only domain characters, so runs
 * from different starts don't overlap; each costs at most one memoised parse.
 */
function lenientAt(ix: TokenIndex, a: number, strictIp: boolean, extras: boolean): Lenient {
  if (ix.nextGlue === null) lenientIndex(ix);
  lenAcc.hosts = null;
  lenAcc.extra = null;
  lenAcc.encodedAt = false;
  lenAcc.encodedExtra = false;
  const e1 = ix.endWithBackslash[a]!;
  const e2 = ix.endNoBackslash[a]!;
  lenientReading(ix, a, e1, strictIp, extras);
  if (e2 !== e1) lenientReading(ix, a, e2, strictIp, extras);
  if (lenAcc.hosts === null && lenAcc.extra === null && !lenAcc.encodedAt && !lenAcc.encodedExtra) return NO_LENIENT;
  return { hosts: lenAcc.hosts ?? NO_HOSTS, extra: lenAcc.extra ?? NO_HOSTS, encodedAt: lenAcc.encodedAt, encodedExtra: lenAcc.encodedExtra };
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
 * Owner Q5: a bare host's punycode TLD counts only if its last label was written in ASCII, so CJK or
 * Cyrillic prose that the URL parser maps to xn-- labels doesn't become a "domain".
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
 * Owner Q1: a UNC prefix at position q: `\\`, `\/` or `/\` (not `//`, which is R4), then at least one
 * character that is neither `/` nor a backslash.
 */
function uncAt(s: string, q: number): boolean {
  if (q + 2 >= s.length) return false;
  const a = s.charCodeAt(q);
  const b = s.charCodeAt(q + 1);
  return isSlashCode(a) && isSlashCode(b) && !(a === CC_SLASH && b === CC_SLASH) && !isSlashCode(s.charCodeAt(q + 2));
}

/**
 * Unicode White_Space characters that aren't in TOKEN_BREAK (NBSP, U+2000–U+200A, the ideographic
 * space and others). They start a new leading run for the UNC check only.
 */
const isExtraSpace = (c: number) =>
  c === 0x0b || c === 0x0c || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
/**
 * Owner Q6: a character that starts a new leading run for the UNC check: a Unicode space as above,
 * the soft hyphen U+00AD, every (BMP) character on the invisible-character list (isInvisibleOrBidi),
 * and the blank fillers U+115F, U+1160, U+2800, U+3164 and U+FFA0. One code unit, O(1).
 */
const isLeadReset = (c: number) =>
  isExtraSpace(c) || c === 0xad || isInvisibleOrBidi(c) || c === 0x115f || c === 0x1160 || c === 0x2800 || c === 0x3164 || c === 0xffa0;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
/** A letter or digit (any script) at i. ASCII is checked directly; other characters by code point. */
function isWordCode(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  if (c < 128) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
  return WORD_CHAR.test(String.fromCodePoint(s.codePointAt(i)!));
}

/**
 * Schemes that are always flagged, whatever the thread contains (owner Q1, Q1b, Q5). `file` and `smb`
 * only when a `/` or backslash follows the colon (`file:evil.test` keeps the R5 reading);
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
 * The link being built for one token: its display start, its hosts, and the N-1 positions. Only the
 * baseline (batch-3) reads move `url.start` (POSITIVE_INFINITY while none has added to the link); the
 * newer reads (an extra-only glue candidate, a "%40" stop in the extra run, `scheme:\\`, a UNC prefix
 * after a newer lead-run reset, a decoded segment) record their start in `newStart`, which is shown
 * only when no baseline read made the link. So every display the baseline rules show is still shown,
 * with at least their hosts and flags (the SUPERSET rule). In FULL mode the newer reads are also
 * listed in `newer`: one that starts before the baseline display adds the whole word as a second
 * display (owner display ii; see linksInToken).
 */
type Scan = {
  mode: ScanMode;
  url: { start: number; hosts: Host[]; extraHosts: Host[]; always: boolean } | null;
  newStart: number;
  /** FULL mode only: each newer read's start, always flag and hosts (null until the first one). */
  newer: { start: number; always: boolean; hosts: Host[] }[] | null;
  /** The host names already in url.hosts or url.extraHosts (Sets, so many distinct hosts in one token stay linear). */
  urlHosts: Set<string>;
  urlExtra: Set<string>;
  /** N-1: the authority end of the first candidate that gave a host. */
  coveredFrom: number;
  /** N-1: the first scheme start of an R1 or R2 candidate with no strict host. */
  hostlessFrom: number;
};

/** Adds to the token's link; `isNew` marks a newer read (not a baseline one), which doesn't move url.start. */
function addUrl(sc: Scan, start: number, hosts: Host[], always: boolean, isNew = false): void {
  if (!sc.url) sc.url = { start: Number.POSITIVE_INFINITY, hosts: [], extraHosts: [], always: false };
  const url = sc.url;
  if (isNew) sc.newStart = Math.min(sc.newStart, start);
  else url.start = Math.min(url.start, start);
  url.always ||= always;
  for (const h of hosts) {
    if (sc.urlHosts.has(h.host)) continue;
    sc.urlHosts.add(h.host);
    url.hosts.push(h);
  }
}

/**
 * A newer read (see Scan): adds to the token's link without moving url.start, and in FULL mode lists
 * it for the second display. `hosts` are the read's hosts (the caller adds them as extra hosts).
 */
function addNewer(sc: Scan, start: number, always: boolean, hosts: Host[]): void {
  addUrl(sc, start, NO_HOSTS, always, true);
  listNewer(sc, start, always, hosts);
}

/** Lists a newer read for the second display (FULL mode, and only if it flags or has a host). */
function listNewer(sc: Scan, start: number, always: boolean, hosts: Host[]): void {
  if (sc.mode !== FULL || (!always && hosts.length === 0)) return;
  (sc.newer ??= []).push({ start, always, hosts });
}

/** Adds extra hosts to the token's link, which must exist; a host already among its base hosts is skipped. */
function addExtra(sc: Scan, hosts: Host[]): void {
  const url = sc.url!;
  for (const h of hosts) {
    if (sc.urlHosts.has(h.host) || sc.urlExtra.has(h.host)) continue;
    sc.urlExtra.add(h.host);
    url.extraHosts.push(h);
  }
}

/**
 * One R1–R4 or `=//` candidate whose authority starts at `a`. `schemeStart` is the scheme's first
 * letter for R1 and R2, or -1 for R3, R4 and `=//` (shown from the token's start, and a link only if
 * a host is found). Its hosts are the strict ones (hostsAt) plus the lenient ones (lenientAt).
 * A strict host records coveredFrom; an R1/R2 candidate with no strict host records hostlessFrom;
 * a lenient run that stopped at "%40" always flags the link. Outside BASE mode, the extra lenient
 * hosts go to the link's extra hosts. As in the baseline (batch-3) rules, an R1/R2 candidate, an R3/R4/`=//` candidate with
 * a base host, and a base run's "%40" stop place the link; an R3/R4/`=//` candidate with only extra
 * hosts, and the extra run's "%40" stop, are newer reads (see Scan).
 */
function candidate(sc: Scan, ix: TokenIndex, a: number, schemeStart: number, strictIp: boolean): void {
  const strict = ix.hostsAt(a, strictIp);
  if (strict.length > 0) sc.coveredFrom = Math.min(sc.coveredFrom, ix.endNoBackslash[a]!);
  else if (schemeStart >= 0) sc.hostlessFrom = Math.min(sc.hostlessFrom, schemeStart);
  const l = lenientAt(ix, a, strictIp, sc.mode !== BASE);
  const start = schemeStart >= 0 ? schemeStart : 0;
  if (l.encodedAt) addUrl(sc, start, NO_HOSTS, true);
  if (l.encodedExtra) addNewer(sc, start, true, NO_HOSTS);
  const hosts = withLenient(strict, l);
  if (schemeStart >= 0 || hosts.length > 0) addUrl(sc, start, hosts, false);
  else if (l.extra.length > 0) addNewer(sc, start, false, l.extra);
  if (l.extra.length > 0) addExtra(sc, l.extra);
}

/**
 * The links in one token. The token is stripped of trailing sentence punctuation and lowercased.
 * Every host candidate in it counts (owner Q2):
 * - R1: a `:` after a special scheme (`http`, `https`, `ws`, `wss`, `ftp`; owner Q4), with or
 *   without slashes: any run of `/` and backslashes is skipped, then the authority is read.
 * - R2: `://` after any other scheme (the run of scheme characters before it, from its first letter).
 * - R3: `://` with no valid scheme before it (`://`, `_://`, `0://`, a look-alike such as a Cyrillic
 *   letter): read as a `//host`, and a link only if that gives a domain or a strict IPv4 address.
 * - R4: a token that starts with `//`, or a `//` right after an `=`: a link only if it gives a
 *   domain or an IPv4 address.
 * - R5: bare hosts: the text after the token's last `@`, and the token's authority after its own last
 *   `@`, each cut at `/`, `?`, `#` or backslash; every `:` segment that is a plausible domain or a
 *   strict IPv4 address counts (a punycode TLD only if written in ASCII). Shown as the host.
 * - Always flagged (owner Q1, Q1b, Q5), shown from where the form starts; no host parse is needed:
 *   - a UNC prefix (`\\`, `\/`, `/\`) at the token's start, after a leading run of non-alphanumeric
 *     characters (a Unicode space that isn't a token break, a soft hyphen, an invisible character or
 *     a blank filler starts a new run; owner Q6), or right after an `=`;
 *   - `file:` or `smb:` followed by `/` or a backslash (R2 still reads the hosts of `file://` and
 *     `smb://`);
 *   - the `search-ms:`, `search:` and `ms-*:` schemes;
 *   - a non-special scheme of two or more characters followed by a UNC prefix (`onenote:\\host`;
 *     owner Q5). A one-letter scheme (`C:\\x`, drive-like) doesn't count.
 *
 * An authority's host is after its last `@` and before its first `:`, read both stopping and not
 * stopping at a backslash (owner Q3). Each R1–R4 and `=//` candidate also adds lenient hosts
 * (lenientAt), which never clear a flag. R1–R4 and always-flag candidates in a token form one link,
 * shown from the earliest start (the scheme, or the token for R3/R4) of the baseline (batch-3)
 * candidates, or of the newer ones only when there is no baseline one (see Scan), with all their hosts. If a newer read
 * that flags or has a host starts before that display, the whole token is a second link with that
 * read's hosts (as extra hosts) and flag (owner display ii; secondDisplay). The first link is always
 * flagged if it has an always-flag candidate, a lenient run that stopped at
 * `%40`, or an R1 or R2 candidate with no strict host that starts before the authority end of the
 * first candidate that gave a host (N-1, owner Q4: a host-less `myapp://` inside a known link's path,
 * query or fragment doesn't flag it). R5 hosts already in the token's link are skipped.
 *
 * Extra reads (outside BASE mode), whose hosts are the link's extra hosts (see Link): the glue run
 * after a userinfo (lenientAt), and in FULL mode one percent-decoding pass (decodeSegments). Each
 * decoded segment, as readDecoded reads it (decoded tab/LF/CR dropped, leading spaces skipped, cut at
 * the next decoded space), has its tokens scanned with these
 * rules (DECODED mode: no further decoding), and every host they give is an extra host of the token's
 * link; an always-flag form or a "%40" stop among them flags it. They never set the host-less flag or
 * N-1 coverage (owner Q3) and never move the link's start; a token with no link gets one, shown from
 * the first such segment's start.
 *
 * Linear time: the backward scheme scans don't overlap (a scheme can't contain `:`); every `:` and
 * `=` position costs O(1) plus at most one memoised host parse of at most MAX_HOST_CHARS characters;
 * the authority ranges of R1–R4 and `=//` candidates start after a `:` + slashes, or after `//`, and
 * end at the next `/`, `?` or `#`, so they don't overlap each other; lenient runs don't overlap either
 * (see lenientAt); decoding is one pass over disjoint segments, each scanned once (decodeSegments).
 */
function linksInToken(raw: string, mode: ScanMode): Link[] {
  const s = stripTrailing(raw).toLowerCase();
  if (s === "") return [];
  const sc: Scan = {
    mode,
    url: null,
    newStart: Number.POSITIVE_INFINITY,
    newer: null,
    urlHosts: new Set<string>(),
    urlExtra: new Set<string>(),
    coveredFrom: Number.POSITIVE_INFINITY,
    hostlessFrom: Number.POSITIVE_INFINITY,
  };

  const startsSlashSlash = s.startsWith("//");
  const hasColon = s.includes(":");
  const hasEquals = s.includes("=");
  // A UNC prefix after a leading run of non-alphanumeric characters (curly quotes, guillemets, ASCII
  // punctuation; owner "Narrow"). A Unicode space that isn't a token break (NBSP, U+2003 and so on),
  // a soft hyphen, an invisible character or a blank filler starts a new leading run, for this check
  // only (isLeadReset). One forward pass. `baseLead` is the baseline (batch-3) leading run (only isExtraSpace resets
  // it, and a reset character that is a letter, such as U+3164, ends it); a UNC prefix found only
  // through the wider resets is a newer read. baseLead implies lead.
  let lead = true;
  let baseLead = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isExtraSpace(c)) {
      lead = baseLead = true;
    } else if (isLeadReset(c)) {
      lead = true;
      if (baseLead && isWordCode(s, i)) baseLead = false;
    } else if (!lead) continue;
    else if (isSlashCode(c)) {
      if (uncAt(s, i)) {
        if (baseLead) addUrl(sc, i, NO_HOSTS, true);
        else addNewer(sc, i, true, NO_HOSTS);
      }
      lead = baseLead = false;
    } else if (isWordCode(s, i)) lead = baseLead = false;
  }
  if (startsSlashSlash || hasColon || hasEquals) {
    const ix = indexToken(s);
    if (startsSlashSlash) candidate(sc, ix, 2, -1, false);
    // Every `=`: a UNC prefix right after it is always flagged; a `//host` right after it is read like R4.
    if (hasEquals) {
      for (let e = s.indexOf("="); e >= 0; e = s.indexOf("=", e + 1)) {
        const q = e + 1;
        if (uncAt(s, q)) addUrl(sc, q, [], true);
        else if (s.charCodeAt(q) === CC_SLASH && s.charCodeAt(q + 1) === CC_SLASH && q + 2 < s.length && !isSlashCode(s.charCodeAt(q + 2))) {
          candidate(sc, ix, q + 2, -1, false);
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
      const special = hasScheme && p - schemeStart <= 5 && SPECIAL_SCHEMES.has(s.slice(schemeStart, p));
      if (special) candidate(sc, ix, ix.nextNonSlash[p + 1]!, schemeStart, false);
      else if (slashes && hasScheme) candidate(sc, ix, p + 3, schemeStart, false);
      else if (slashes) candidate(sc, ix, p + 3, -1, true);
      // Owner Q5: also a non-special scheme of 2+ characters followed by a UNC prefix (`onenote:\\host`);
      // a one-letter scheme is drive-like (`C:\\x`) and stays quiet.
      if (hasScheme && alwaysScheme(s, schemeStart, p)) addUrl(sc, schemeStart, NO_HOSTS, true);
      else if (hasScheme && !special && p - schemeStart >= 2 && uncAt(s, p + 1)) addNewer(sc, schemeStart, true, NO_HOSTS);
    }
    // Owner Q3: host-less candidates in a decoded segment never flag the link.
    if (mode !== DECODED && sc.hostlessFrom < sc.coveredFrom) addUrl(sc, sc.hostlessFrom, [], true);
  }
  if (mode === FULL && s.includes("%")) decodeSegments(sc, s);

  const out: Link[] = [];
  const seen = new Set<string>();
  const found = sc.url;
  if (found) {
    const start = found.start !== Number.POSITIVE_INFINITY ? found.start : sc.newStart;
    out.push({ display: s.slice(start), hosts: found.hosts, extraHosts: found.extraHosts, always: found.always });
    for (const h of found.hosts) seen.add(h.host);
    if (sc.newer !== null && start > 0) {
      const second = secondDisplay(s, start, sc.newer);
      if (second) out.push(second);
    }
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
    out.push({ display: h.host, hosts: [h], extraHosts: [], always: false });
  }
  return out;
}

/**
 * Owner display (ii): the newer reads that start before the display `start` (so the display doesn't
 * show them) give the whole word as a second link, with their hosts as extra hosts and their always
 * flag; null if there are none. The first link is unchanged. O(listed reads + their hosts).
 */
function secondDisplay(s: string, start: number, newer: { start: number; always: boolean; hosts: Host[] }[]): Link | null {
  let always = false;
  let any = false;
  const extra: Host[] = [];
  const names = new Set<string>();
  for (const r of newer) {
    if (r.start >= start) continue;
    any = true;
    always ||= r.always;
    mergeHosts(extra, names, r.hosts);
  }
  return any ? { display: s, hosts: [], extraHosts: extra, always } : null;
}

/**
 * Adds what one link of a decoded segment found to the raw token's link: its hosts and extra hosts
 * as extra hosts, and its `always` (which in DECODED mode only an always-flag form sets, never the
 * host-less rule; owner Q3). The token's link keeps its start; if it has none yet, this is a newer
 * read starting at the segment.
 */
function addDecoded(sc: Scan, segStart: number, link: Link): void {
  if (!link.always && link.hosts.length === 0 && link.extraHosts.length === 0) return;
  if (!sc.url) addUrl(sc, segStart, NO_HOSTS, false, true);
  sc.url!.always ||= link.always;
  listNewer(sc, segStart, link.always, link.hosts);
  listNewer(sc, segStart, false, link.extraHosts);
  addExtra(sc, link.hosts);
  addExtra(sc, link.extraHosts);
}

/**
 * The decoded value as it is read (owner, encoded spaces option b as refined, and R2-N1): tab, LF and
 * CR are dropped, as a URL parser drops them; at the start and right after each `=`, spaces, the other
 * C0 controls (U+0000–U+001F, the rest of WHATWG's leading-strip set) and `+` (a space in form
 * decoding) are skipped; the rest is cut at the first remaining space. `+` elsewhere is kept. So
 * `Annual%20Report.pdf` reads as `annual`, while `u=%0Ahttps%3A…`, `u=%20https%3A…`,
 * `u=%0B%20https%3A…`, `u=+%20https%3A…` and `ev%09il.test` read as `u=https:…` and `evil.test`.
 * A raw token never holds a space, tab, LF or CR (they are TOKEN_BREAKs), so every one here was
 * decoded. One pass; the result is never longer than `d`.
 */
export function readDecoded(d: string): string {
  let i = 0;
  while (i < d.length) {
    const c = d.charCodeAt(i);
    if (c <= CC_SPACE || c === CC_PLUS) break;
    i++;
  }
  if (i === d.length) return d;
  const out: string[] = [];
  let lit = 0;
  /** True at the start and after an `=` (with only dropped or skipped characters since). */
  let lead = true;
  for (i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    if (c === CC_TAB || c === CC_LF || c === CC_CR || (lead && (c <= CC_LAST_C0 || c === CC_SPACE || c === CC_PLUS))) {
      if (i > lit) out.push(d.slice(lit, i));
      lit = i + 1;
    } else if (c === CC_SPACE) break;
    else lead = c === CC_EQUALS;
  }
  if (i > lit) out.push(d.slice(lit, i));
  return out.join("");
}

/** Decodes s[st, en) once and scans the tokens of what is read of it (readDecoded; DECODED mode) into the raw token's link. */
function decodeSegment(sc: Scan, s: string, st: number, en: number): void {
  for (const tok of tokens(readDecoded(percentDecodeOnce(s, st, en)))) for (const link of linksInToken(tok, DECODED)) addDecoded(sc, st, link);
}

/**
 * Owner Q1 a, Q2 B, Q3: every segment of the token between raw `?`, `&` and `#` (the first one,
 * with the scheme, authority and path, included) that has a valid `%XX` is decoded once and scanned.
 * One pass: segments are disjoint, and each is decoded into a string no longer than itself and scanned
 * by the non-decoding scanner, so the total is linear.
 */
function decodeSegments(sc: Scan, s: string): void {
  let st = 0;
  let escaped = false;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s.charCodeAt(i) : -1;
    if (c === -1 || c === CC_QUESTION || c === CC_AMP || c === CC_HASH) {
      if (escaped) decodeSegment(sc, s, st, i);
      st = i + 1;
      escaped = false;
    } else if (!escaped && c === CC_PERCENT && escapeAt(s, i, s.length)) escaped = true;
  }
}

/** Host names of a link entry, built on its first merge only. */
type MergeSets = { hosts: Set<string>; extra: Set<string> };

/** Appends the hosts in `from` whose names aren't in `names` to `to`. */
function mergeHosts(to: Host[], names: Set<string>, from: Host[]): void {
  for (const h of from) {
    if (names.has(h.host)) continue;
    names.add(h.host);
    to.push(h);
  }
}

/**
 * Every link in `text`, de-duplicated by what is shown. A display seen again is merged into the
 * first entry: the union of its hosts, of its extra hosts, and of `always`, so no read is lost to
 * an earlier token with the same display. Each entry's name Sets are built on its first merge,
 * so the merges cost O(hosts) in total.
 */
function linkEntries(text: string, mode: ScanMode): Link[] {
  const found = new Map<string, Link>();
  let sets: Map<string, MergeSets> | null = null;
  for (const raw of tokens(text)) {
    for (const link of linksInToken(raw, mode)) {
      const first = found.get(link.display);
      if (first === undefined) {
        found.set(link.display, link);
        continue;
      }
      sets ??= new Map<string, MergeSets>();
      let m = sets.get(link.display);
      if (m === undefined) {
        m = { hosts: new Set(first.hosts.map((h) => h.host)), extra: new Set(first.extraHosts.map((h) => h.host)) };
        sets.set(link.display, m);
      }
      mergeHosts(first.hosts, m.hosts, link.hosts);
      mergeHosts(first.extraHosts, m.extra, link.extraHosts);
      first.always ||= link.always;
    }
  }
  return [...found.values()];
}

/**
 * URLs (scheme links with or without `//`, `//host` links), domains (including the domains of email
 * addresses and `host:port` forms) and bare IPv4 addresses mentioned in `text`, lowercased and
 * de-duplicated. See linksInToken for the rules.
 */
export function linksIn(text: string): string[] {
  return linkEntries(text, FULL).map((l) => l.display);
}

/**
 * The hosts of every URL, domain and IPv4 address in `text` (normalized; see normalizeHost): the
 * base hosts only, which are the thread's known set.
 */
export function hostsIn(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const link of linkEntries(text, BASE)) for (const h of link.hosts) hosts.add(h.host);
  return hosts;
}

/** The base known set plus every host the extra reads find in `text`. */
function allHostsIn(text: string, base: ReadonlySet<string>): Set<string> {
  const hosts = new Set(base);
  for (const link of linkEntries(text, FULL)) {
    for (const h of link.hosts) hosts.add(h.host);
    for (const h of link.extraHosts) hosts.add(h.host);
  }
  return hosts;
}

/**
 * True if `h` is known: an IPv4 host only if exactly that address is in `known` (owner Q9); a domain
 * if it, or one of its label suffixes ("example.org" for "a.b.example.org"), is in `known`. Exactly
 * "equals or is a subdomain of some known host, on label boundaries", with O(labels) Set lookups
 * instead of a scan of every known host. A normalized domain has no leading or trailing dot, and no
 * IPv4 address is a label suffix of a domain (its last label is all digits, a domain's TLD never is).
 */
export function isKnownHost(h: Host, known: ReadonlySet<string>): boolean {
  if (known.has(h.host)) return true;
  if (h.ip) return false;
  for (let i = h.host.indexOf("."); i >= 0; i = h.host.indexOf(".", i + 1)) if (known.has(h.host.slice(i + 1))) return true;
  return false;
}

/**
 * Links in an AI-written body whose host doesn't appear in the thread: a body link counts as known
 * only if its host equals, or is a subdomain of, a host that appears in the thread's stored text,
 * HTML or headers. Matching is on whole host names, never substrings ("evil.co" is not "evil.com";
 * "bank.com" is not "mybank.com").
 *
 * Any `scheme://` link, `//host` links and bare IPv4 addresses count as links. An IPv4 host is known
 * only if exactly that address appears in the thread (owner Q9); a link with no host or an
 * unparseable one is always flagged (owner Q10). A link may have several hosts (every candidate in
 * its token, both backslash readings); it is flagged if any of them is unknown. Network-share and
 * Windows handler forms are always flagged. The thread haystack may be only the newest part of a
 * very long thread (see threadContext), which can only add warnings.
 *
 * Two tiers (owner Q1 a): a base host must be known in hostsIn(thread), exactly as before; an extra
 * host must be known in the thread read the same way (its base hosts plus its extra hosts). The
 * second set is built only when some extra host isn't already known in the first.
 *
 * Note: this can't catch a link the sender put in their own email; it only flags links that came
 * from nowhere in the thread.
 */
export function linksNotInThread(body: string, threadHaystack: string): string[] {
  const known = hostsIn(threadHaystack);
  let knownAll: Set<string> | null = null;
  const extraKnown = (h: Host) => {
    if (isKnownHost(h, known)) return true;
    knownAll ??= allHostsIn(threadHaystack, known);
    return isKnownHost(h, knownAll);
  };
  return linkEntries(body, FULL)
    .filter(
      (link) =>
        link.always ||
        (link.hosts.length === 0 && link.extraHosts.length === 0) ||
        !link.hosts.every((h) => isKnownHost(h, known)) ||
        !link.extraHosts.every(extraKnown),
    )
    .map((l) => l.display);
}

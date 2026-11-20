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

function hostOf(link: string): string | null {
  try {
    return normalizeHost(new URL(link).hostname);
  } catch {
    return null;
  }
}

/** URLs and domains (including the domains of email addresses) mentioned in `text`, lowercased and de-duplicated. */
export function linksIn(text: string): string[] {
  const found = new Set<string>();
  for (const raw of tokens(text)) {
    const t = raw.replace(/[.:!?]+$/, "");
    const lower = t.toLowerCase();
    if (lower.startsWith("http://") || lower.startsWith("https://")) {
      found.add(lower);
      continue;
    }
    const at = lower.lastIndexOf("@");
    const candidate = at >= 0 ? lower.slice(at + 1) : lower;
    const host = normalizeHost(candidate.split("/")[0]!);
    if (host) found.add(host);
  }
  return [...found];
}

/** The hosts of every URL and domain in `text` (normalized; see normalizeHost). */
export function hostsIn(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const link of linksIn(text)) {
    const host = link.includes("://") ? hostOf(link) : link;
    if (host) hosts.add(host);
  }
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
 * Note: this can't catch a link the sender put in their own email; it only flags links that came
 * from nowhere in the thread.
 */
export function linksNotInThread(body: string, threadHaystack: string): string[] {
  const known = [...hostsIn(threadHaystack)];
  return linksIn(body).filter((link) => {
    const host = link.includes("://") ? hostOf(link) : link;
    if (!host) return true;
    return !known.some((k) => underHost(host, k));
  });
}

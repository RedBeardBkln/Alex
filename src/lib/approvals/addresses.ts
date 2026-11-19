/**
 * Email addresses for outgoing replies (Phase 2b). Import-free.
 *
 * Only bare ASCII addr-specs are ever sent (no display names), and every one must pass
 * `isValidAddress`. Header values from received mail are attacker-controlled, so the extractor is
 * conservative: it reads `addr-spec` and `name <addr-spec>` tokens and counts everything else
 * (groups, comments, malformed tokens) as unreadable, for the "add them manually" notice.
 */

/** Most recipients (To plus Cc) on one message. */
export const MAX_RECIPIENTS = 50;

// RFC 5322 dot-atom local part (atext only: no quotes, spaces, commas, <>, ;, : or controls).
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// LDH labels, at least two of them. IDN domains must be typed in punycode (xn--...).
const DOMAIN_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** A bare ASCII addr-spec: local part ≤ 64, domain ≤ 253, nothing that could break a header. */
export function isValidAddress(value: string): boolean {
  if (value.length > 254) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at !== value.indexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return local.length <= 64 && domain.length <= 253 && LOCAL_RE.test(local) && DOMAIN_RE.test(domain);
}

/** Case-insensitive identity for de-duplication and own-address removal. */
export const addressKey = (a: string) => a.toLowerCase();

/** Removes duplicates (case-insensitive), keeping the first spelling and the order. */
export function dedupe(addresses: string[], exclude: string[] = []): string[] {
  const seen = new Set(exclude.map(addressKey));
  const out: string[] = [];
  for (const a of addresses) {
    const k = addressKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export type Extracted = { addresses: string[]; unreadable: number };

/**
 * Splits a header value at commas outside quotes, angle brackets and parentheses. Linear.
 * Returns null if the quoting is unbalanced (the whole header is then unreadable).
 */
function splitTopLevel(value: string): string[] | null {
  const tokens: string[] = [];
  let start = 0;
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (c === "," && angle === 0 && paren === 0) {
      tokens.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted || angle !== 0 || paren !== 0) return null;
  tokens.push(value.slice(start));
  return tokens;
}

/** Removes quoted strings, so structural characters inside display names don't count. */
function withoutQuoted(token: string): string {
  return token.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Reads the addresses in an address-list header (From, To, Cc, Reply-To). */
export function extractAddresses(value: string | null): Extracted {
  if (!value || value.trim() === "") return { addresses: [], unreadable: 0 };
  const tokens = splitTopLevel(value);
  if (!tokens) return { addresses: [], unreadable: 1 };
  const addresses: string[] = [];
  let unreadable = 0;
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === "") continue;
    const bare = withoutQuoted(token);
    // Groups (`name: a, b;`) and comments are not read.
    if (bare.includes(":") || bare.includes(";") || bare.includes("(")) {
      unreadable++;
      continue;
    }
    let candidate: string | null = null;
    if (bare.endsWith(">")) {
      const open = bare.lastIndexOf("<");
      if (open >= 0 && bare.indexOf("<") === open) candidate = bare.slice(open + 1, -1).trim();
    } else if (!bare.includes("<") && !bare.includes(">") && !/\s/.test(bare)) {
      candidate = bare;
    }
    if (candidate !== null && isValidAddress(candidate)) addresses.push(candidate);
    else unreadable++;
  }
  return { addresses, unreadable };
}

export type ParentHeaders = {
  isSent: boolean;
  fromHeader: string | null;
  toHeader: string | null;
  ccHeader: string | null;
  replyToHeader: string | null;
};

export type ReplyDefaults = {
  to: string[];
  cc: string[];
  /** Addresses in the parent's headers that couldn't be read ("add them manually"). */
  unreadable: number;
};

/**
 * Default recipients (owner Q1). Reply: the parent's Reply-To if present, otherwise From. Reply
 * all: that, plus the parent's To and Cc. The sending account's own address is removed and
 * duplicates are dropped (case-insensitive). For a parent the owner sent, Reply goes to its To
 * (and Reply all adds its Cc), as Gmail does.
 */
export function replyDefaults(parent: ParentHeaders, ownAddress: string, mode: "reply" | "all"): ReplyDefaults {
  const from = extractAddresses(parent.fromHeader);
  const to = extractAddresses(parent.toHeader);
  const cc = extractAddresses(parent.ccHeader);
  const replyTo = extractAddresses(parent.replyToHeader);
  let primary: Extracted;
  let others: Extracted[];
  if (parent.isSent) {
    primary = to;
    others = mode === "all" ? [cc] : [];
  } else {
    primary = replyTo.addresses.length > 0 || replyTo.unreadable > 0 ? replyTo : from;
    others = mode === "all" ? [to, cc] : [];
  }
  const own = [ownAddress];
  const toList = dedupe(primary.addresses, own);
  const ccList = dedupe(others.flatMap((e) => e.addresses), [...own, ...toList]);
  const unreadable = primary.unreadable + others.reduce((n, e) => n + e.unreadable, 0);
  return { to: toList, cc: ccList, unreadable };
}

/**
 * True when some To address came from a Reply-To that isn't the From address (R2: Reply-To is
 * attacker-controlled, so the approval screen warns about it).
 */
export function replyToDiffers(parent: ParentHeaders, to: string[]): boolean {
  if (parent.isSent) return false;
  const replyTo = new Set(extractAddresses(parent.replyToHeader).addresses.map(addressKey));
  if (replyTo.size === 0) return false;
  const from = new Set(extractAddresses(parent.fromHeader).addresses.map(addressKey));
  return to.some((a) => replyTo.has(addressKey(a)) && !from.has(addressKey(a)));
}

/**
 * Parses an owner-typed recipient list (one per line, or separated by commas, semicolons or
 * spaces). Returns the valid bare addresses and the tokens that aren't valid.
 */
export function parseRecipientInput(value: string): { addresses: string[]; invalid: string[] } {
  const addresses: string[] = [];
  const invalid: string[] = [];
  for (const token of value.split(/[\s,;]+/)) {
    if (token === "") continue;
    if (isValidAddress(token)) addresses.push(token);
    else invalid.push(token);
  }
  return { addresses: dedupe(addresses), invalid };
}

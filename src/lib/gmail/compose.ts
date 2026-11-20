import { isValidAddress, MAX_RECIPIENTS } from "@/lib/approvals/addresses";
import { sliceOnCodePoint, stripBidiControls, wellFormed } from "@/lib/approvals/text";

/**
 * RFC 2822/5322 text/plain message builder for replies (Phase 2b). Pure, so the exact bytes sent
 * can be tested.
 *
 * Header injection is prevented by construction:
 * - From/To/Cc are bare addr-specs that pass isValidAddress (no display names are sent)
 * - the subject is checked for CR, LF and controls, then sent as printable ASCII or as RFC 2047
 *   encoded words
 * - Message-IDs (ours, In-Reply-To, References) must match MSG_ID_RE
 * - a final check rejects any line in the header block that isn't one of our headers or a fold
 * The body is base64 (76-character lines), so its content can't affect the header block.
 */

/** A msg-id with no spaces, `<`, `>`, CR or LF inside (parent ids come from attacker headers). */
export const MSG_ID_RE = /^<[\x21-\x3B\x3D\x3F-\x7E]{1,250}@[\x21-\x3B\x3D\x3F-\x7E]{1,250}>$/;

export const MAX_SUBJECT_CHARS = 500;
export const MAX_BODY_CHARS = 100_000;
/** References: the first id plus the last 9, and at most this many characters. */
export const MAX_REFERENCES_CHARS = 900;

export class ComposeError extends Error {
  constructor(public readonly code: string) {
    super(`message rejected: ${code}`);
    this.name = "ComposeError";
  }
}

/** Characters never allowed in a subject: C0 controls (including CR/LF), DEL, C1, and the Unicode line/paragraph separators. */
const SUBJECT_FORBIDDEN_RE = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/;

export function isValidSubject(subject: string): boolean {
  return subject.length <= MAX_SUBJECT_CHARS && !SUBJECT_FORBIDDEN_RE.test(subject);
}

/** `Re: ` + the parent subject, unless it already starts with "re:" (case-insensitive, after trimming). */
export function replySubject(parentSubject: string | null): string {
  // Bidi controls are removed (review round 1): they can make the subject display misleadingly.
  const s = stripBidiControls(wellFormed(parentSubject ?? "")).replace(SUBJECT_FORBIDDEN_RE_GLOBAL, " ").trim();
  const subject = /^re:/i.test(s) ? s : `Re: ${s}`;
  return sliceOnCodePoint(subject, MAX_SUBJECT_CHARS).trim();
}
const SUBJECT_FORBIDDEN_RE_GLOBAL = /[\x00-\x1F\x7F-\x9F\u2028\u2029]+/g;

/** Splits a References/In-Reply-To header into msg-ids; anything that isn't a valid id is dropped. */
function msgIds(value: string | null): string[] {
  if (!value) return [];
  return (value.match(/<[^<>]*>/g) ?? []).filter((id) => MSG_ID_RE.test(id));
}

export type Threading = { gmailThreadId: string; inReplyTo: string | null; references: string[] };

/**
 * In-Reply-To is the parent's Message-ID. References is the parent's References (or its
 * In-Reply-To if it has none) followed by the parent's Message-ID, trimmed to the first id plus
 * the last 9 and to MAX_REFERENCES_CHARS. If the parent's Message-ID is invalid both are omitted
 * and threading relies on threadId alone.
 */
export function replyThreading(
  gmailThreadId: string,
  parent: { rfc822MessageId: string | null; references: string | null; inReplyTo: string | null },
): Threading {
  const own = parent.rfc822MessageId?.trim() ?? "";
  if (!MSG_ID_RE.test(own)) return { gmailThreadId, inReplyTo: null, references: [] };
  let refs = msgIds(parent.references);
  if (refs.length === 0) refs = msgIds(parent.inReplyTo);
  refs = [...refs.filter((r) => r !== own), own];
  if (refs.length > 10) refs = [refs[0]!, ...refs.slice(-9)];
  while (refs.length > 1 && refs.join(" ").length > MAX_REFERENCES_CHARS) refs.splice(refs.length > 2 ? 1 : 0, 1);
  return { gmailThreadId, inReplyTo: own, references: refs };
}

/** RFC 5322 date-time in UTC, e.g. "Wed, 19 Nov 2026 10:00:00 +0000". */
export function rfc5322Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Printable ASCII only (no controls). */
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]*$/;

/**
 * The Subject header line(s). Printable ASCII is sent as is; anything else becomes RFC 2047
 * `=?UTF-8?B?…?=` words of at most 39 bytes each (whole code points), folded so every line
 * stays under 78 characters.
 */
export function subjectHeader(subject: string): string {
  if (!isValidSubject(subject)) throw new ComposeError("subject");
  if (PRINTABLE_ASCII_RE.test(subject) && subject.length + "Subject: ".length <= 998) return `Subject: ${subject}`;
  const words: string[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const ch of subject) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > 39 && chunk.length > 0) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk.join(""), "utf8").toString("base64")}?=`);
      chunk = [];
      bytes = 0;
    }
    chunk.push(ch);
    bytes += n;
  }
  if (chunk.length > 0 || words.length === 0) words.push(`=?UTF-8?B?${Buffer.from(chunk.join(""), "utf8").toString("base64")}?=`);
  return `Subject: ${words.join("\r\n ")}`;
}

/**
 * One header from a list of tokens joined by `separator` ("," for address lists, "" for
 * References), folded before 78 characters where possible (each token stays on one line).
 */
function foldTokens(name: string, tokens: string[], separator: "," | ""): string {
  const lines: string[] = [];
  let line = `${name}:`;
  tokens.forEach((t, i) => {
    const add = i === 0 ? ` ${t}` : `${separator} ${t}`;
    if (i > 0 && line.length + add.length > 78) {
      lines.push(line + separator);
      line = ` ${t}`;
    } else {
      line += add;
    }
  });
  lines.push(line);
  return lines.join("\r\n");
}

export type OutgoingMessage = {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** The text as sent: the owner's text plus, if included, the quoted text. LF or CRLF line endings. */
  bodyText: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  date: Date;
};

const KNOWN_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
  "MIME-Version",
  "Content-Type",
  "Content-Transfer-Encoding",
];
const HEADER_LINE_RE = new RegExp(`^(?:${KNOWN_HEADERS.join("|")}): \\S`);

/** Every header line is one of ours or a fold (starts with a space); no CR or LF except CRLF between lines. */
export function assertHeaderBlock(block: string): void {
  const lines = block.split("\r\n");
  for (const line of lines) {
    if (line.includes("\r") || line.includes("\n")) throw new ComposeError("header_newline");
    if (line.length > 998) throw new ComposeError("header_length");
    if (HEADER_LINE_RE.test(line)) continue;
    if (line.startsWith(" ") && line.trim() !== "") continue;
    throw new ComposeError("header_line");
  }
}

/** Base64 of the UTF-8 bytes, in lines of at most 76 characters (CRLF). */
function base64Lines(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

/**
 * The full RFC 5322 message (CRLF line endings). Headers in this order: From, To, Cc, Subject,
 * Date, Message-ID, In-Reply-To, References, MIME-Version, Content-Type,
 * Content-Transfer-Encoding. Throws ComposeError if any part is invalid.
 */
export function buildMessage(m: OutgoingMessage): string {
  if (!isValidAddress(m.from)) throw new ComposeError("from");
  if (m.to.length === 0) throw new ComposeError("no_recipients");
  if (m.to.length + m.cc.length > MAX_RECIPIENTS) throw new ComposeError("too_many_recipients");
  for (const a of [...m.to, ...m.cc]) if (!isValidAddress(a)) throw new ComposeError("recipient");
  if (!MSG_ID_RE.test(m.messageId)) throw new ComposeError("message_id");
  if (m.inReplyTo !== null && !MSG_ID_RE.test(m.inReplyTo)) throw new ComposeError("in_reply_to");
  for (const r of m.references) if (!MSG_ID_RE.test(r)) throw new ComposeError("references");
  if (m.bodyText.length > MAX_BODY_CHARS * 2) throw new ComposeError("body_length");

  const headers: string[] = [`From: ${m.from}`, foldTokens("To", m.to, ",")];
  if (m.cc.length > 0) headers.push(foldTokens("Cc", m.cc, ","));
  headers.push(subjectHeader(m.subject), `Date: ${rfc5322Date(m.date)}`, `Message-ID: ${m.messageId}`);
  if (m.inReplyTo !== null) headers.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references.length > 0) headers.push(foldTokens("References", m.references, ""));
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
  const block = headers.join("\r\n");
  assertHeaderBlock(block);

  const body = m.bodyText.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
  return `${block}\r\n\r\n${base64Lines(body)}\r\n`;
}

/** base64url of the message bytes, as messages.send's `raw` field expects. */
export function toRaw(message: string): string {
  return Buffer.from(message, "utf8").toString("base64url");
}

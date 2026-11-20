import type { FullMessage, MessagePart, MessagePartHeader } from "./client";

/**
 * Turns a Gmail `format=full` message into headers, text and HTML bodies and attachment metadata.
 *
 * Body data is base64url (Gmail reference). Charset handling and RFC 2047 pre-decoding by Gmail
 * are not documented, so decoding here is defensive: unknown charsets fall back to UTF-8 and
 * encoded-words in headers are decoded if present.
 */

export type AttachmentMeta = {
  partId: string;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  gmailAttachmentId: string | null;
  contentId: string | null;
  isInline: boolean;
};

/** A text body part whose content Gmail returned by attachmentId instead of inline data. */
export type PendingBodyPart = { kind: "text" | "html"; part: MessagePart; attachmentId: string; charset: string | null };

export type ParsedMessage = {
  headers: MessagePartHeader[];
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  replyTo: string | null;
  date: string | null;
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  pendingBodies: PendingBodyPart[];
  attachments: AttachmentMeta[];
};

function header(headers: MessagePartHeader[] | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  const h = headers?.find((x) => x.name.toLowerCase() === lower);
  return h ? h.value : null;
}

/** Value of a parameter (e.g. charset, filename) in a structured header such as Content-Type. */
function headerParam(value: string | null, param: string): string | null {
  if (!value) return null;
  const re = new RegExp(`(?:^|;)\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i");
  const m = value.match(re);
  const v = m ? (m[1] ?? m[2] ?? null) : null;
  return v ? v.trim() : null;
}

function mimeTypeOf(part: MessagePart): string {
  return (part.mimeType ?? "").toLowerCase();
}

function dispositionOf(part: MessagePart): string | null {
  const v = header(part.headers, "Content-Disposition");
  return v ? v.split(";")[0]!.trim().toLowerCase() : null;
}

/**
 * True for a text/plain or text/html part with no filename and no `Content-Disposition: attachment`.
 * Only such parts may ever be fetched through messages.attachments.get.
 */
export function isBodyPart(part: MessagePart): boolean {
  const type = mimeTypeOf(part);
  if (type !== "text/plain" && type !== "text/html") return false;
  if (part.filename && part.filename.length > 0) return false;
  return dispositionOf(part) !== "attachment";
}

/** A part that is a real attachment: it has a filename or an attachment disposition. Its content is never fetched. */
export function isAttachmentPart(part: MessagePart): boolean {
  if (mimeTypeOf(part).startsWith("multipart/")) return false;
  return (part.filename !== undefined && part.filename.length > 0) || dispositionOf(part) === "attachment";
}

function decoderFor(charset: string | null): TextDecoder {
  if (charset) {
    try {
      return new TextDecoder(charset.toLowerCase(), { fatal: false });
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8", { fatal: false });
}

/** Decodes base64url body data (Gmail's encoding) using the part's charset, falling back to UTF-8. */
export function decodeBodyData(data: string, charset: string | null): string {
  const bytes = Buffer.from(data, "base64url");
  return decoderFor(charset).decode(bytes);
}

function charsetOf(part: MessagePart): string | null {
  return headerParam(header(part.headers, "Content-Type"), "charset");
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/** Decodes RFC 2047 encoded-words (=?charset?B|Q?...?=). Whitespace between adjacent encoded-words is dropped. */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  const joined = value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, "$1");
  return joined.replace(ENCODED_WORD, (whole, charset: string, enc: string, text: string) => {
    try {
      const label = charset.split("*")[0]!; // RFC 2231 language suffix
      let bytes: Buffer;
      if (enc.toUpperCase() === "B") {
        bytes = Buffer.from(text, "base64");
      } else {
        const qp = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        bytes = Buffer.from(qp, "latin1");
      }
      return decoderFor(label).decode(bytes);
    } catch {
      return whole;
    }
  });
}

function decodedHeader(headers: MessagePartHeader[] | undefined, name: string): string | null {
  const v = header(headers, name);
  return v === null ? null : decodeEncodedWords(v);
}

export function parseMessage(message: FullMessage): ParsedMessage {
  const payload = message.payload ?? {};
  const headers = payload.headers ?? [];
  const result: ParsedMessage = {
    headers,
    subject: decodedHeader(headers, "Subject"),
    from: decodedHeader(headers, "From"),
    to: decodedHeader(headers, "To"),
    cc: decodedHeader(headers, "Cc"),
    replyTo: decodedHeader(headers, "Reply-To"),
    date: header(headers, "Date"),
    rfc822MessageId: header(headers, "Message-ID"),
    inReplyTo: header(headers, "In-Reply-To"),
    references: header(headers, "References"),
    bodyText: null,
    bodyHtml: null,
    pendingBodies: [],
    attachments: [],
  };

  let haveText = false;
  let haveHtml = false;

  const visit = (part: MessagePart, path: string) => {
    const type = mimeTypeOf(part);
    if (isBodyPart(part)) {
      const kind = type === "text/html" ? "html" : "text";
      if ((kind === "html" && haveHtml) || (kind === "text" && haveText)) return; // first of each only
      if (kind === "html") haveHtml = true;
      else haveText = true;
      const charset = charsetOf(part);
      const data = part.body?.data;
      if (data !== undefined && data.length > 0) {
        const text = decodeBodyData(data, charset);
        if (kind === "html") result.bodyHtml = text;
        else result.bodyText = text;
      } else if (part.body?.attachmentId) {
        result.pendingBodies.push({ kind, part, attachmentId: part.body.attachmentId, charset });
      } else {
        // Present but empty.
        if (kind === "html") result.bodyHtml = "";
        else result.bodyText = "";
      }
      return;
    }
    if (isAttachmentPart(part)) {
      const disposition = dispositionOf(part);
      const contentId = header(part.headers, "Content-ID");
      result.attachments.push({
        partId: part.partId ?? path,
        filename: part.filename && part.filename.length > 0 ? decodeEncodedWords(part.filename) : null,
        mimeType: part.mimeType ?? null,
        sizeBytes: part.body?.size ?? null,
        gmailAttachmentId: part.body?.attachmentId ?? null,
        contentId: contentId ? contentId.trim().replace(/^<|>$/g, "") : null,
        isInline: disposition === "inline" || (disposition === null && contentId !== null),
      });
      return; // never descend into an attachment (e.g. a forwarded message/rfc822)
    }
    (part.parts ?? []).forEach((child, i) => visit(child, path === "" ? String(i) : `${path}.${i}`));
  };

  visit(payload, "");
  return result;
}

/**
 * Display name from a From header: `"Name" <addr>` gives "Name"; otherwise the header itself.
 * Uses indexOf/slice only: the From header is attacker-controlled, and the earlier regex
 * backtracked quadratically on long whitespace runs.
 */
export function senderDisplayName(from: string | null): string {
  if (!from) return "(unknown sender)";
  const s = from.trim();
  const lt = s.lastIndexOf("<");
  if (lt > 0 && s.endsWith(">")) {
    let name = s.slice(0, lt).trim();
    if (name.startsWith('"')) name = name.slice(1);
    if (name.endsWith('"')) name = name.slice(0, -1);
    name = name.trim();
    if (name) return name;
  }
  return s || "(unknown sender)";
}

/** Gmail snippets are HTML-escaped text; this turns them back into plain text for display (React escapes it again). */
export function snippetText(snippet: string | null): string {
  if (!snippet) return "";
  return snippet.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, ent: string) => {
    const e = ent.toLowerCase();
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e === "nbsp") return " ";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Applies the content of a body part fetched via messages.attachments.get. */
export function applyFetchedBody(parsed: ParsedMessage, pending: PendingBodyPart, data: string | undefined): void {
  const text = data ? decodeBodyData(data, pending.charset) : "";
  if (pending.kind === "html") parsed.bodyHtml = text;
  else parsed.bodyText = text;
}

import { describe, expect, it } from "vitest";
import type { FullMessage, MessagePart } from "@/lib/gmail/client";
import { applyFetchedBody, decodeBodyData, decodeEncodedWords, isAttachmentPart, isBodyPart, parseMessage, snippetText } from "@/lib/gmail/mime";
import { alternative, b64url, header, textPart } from "./mail-fixtures";

function message(payload: MessagePart, headers = [header("Subject", "Hello"), header("From", "A <a@example.com>")]): FullMessage {
  return { id: "m1", threadId: "t1", labelIds: ["INBOX"], payload: { ...payload, partId: "", headers: [...headers, ...(payload.headers ?? [])] } };
}

describe("parseMessage", () => {
  it("single-part text/plain", () => {
    const p = parseMessage(message(textPart("text/plain", "Just text")));
    expect(p.bodyText).toBe("Just text");
    expect(p.bodyHtml).toBeNull();
    expect(p.subject).toBe("Hello");
    expect(p.from).toBe("A <a@example.com>");
    expect(p.attachments).toEqual([]);
    expect(p.pendingBodies).toEqual([]);
  });

  it("HTML-only", () => {
    const p = parseMessage(message(textPart("text/html", "<b>Hi</b>")));
    expect(p.bodyHtml).toBe("<b>Hi</b>");
    expect(p.bodyText).toBeNull();
  });

  it("multipart/alternative gives both bodies", () => {
    const p = parseMessage(message(alternative("plain version", "<p>html version</p>")));
    expect(p.bodyText).toBe("plain version");
    expect(p.bodyHtml).toBe("<p>html version</p>");
  });

  it("threading headers are kept for 2b replies", () => {
    const p = parseMessage(
      message(textPart("text/plain", "x"), [
        header("Message-ID", "<abc@example.com>"),
        header("In-Reply-To", "<prev@example.com>"),
        header("References", "<root@example.com> <prev@example.com>"),
        header("Reply-To", "list@example.com"),
        header("Cc", "c@example.com"),
      ]),
    );
    expect(p.rfc822MessageId).toBe("<abc@example.com>");
    expect(p.inReplyTo).toBe("<prev@example.com>");
    expect(p.references).toBe("<root@example.com> <prev@example.com>");
    expect(p.replyTo).toBe("list@example.com");
    expect(p.cc).toBe("c@example.com");
    expect(p.headers.length).toBeGreaterThanOrEqual(5);
  });

  it("nested mixed with an attachment and an inline cid image: metadata only", () => {
    const payload: MessagePart = {
      mimeType: "multipart/mixed",
      filename: "",
      body: { size: 0 },
      parts: [
        {
          partId: "0",
          mimeType: "multipart/related",
          filename: "",
          body: { size: 0 },
          parts: [
            { ...alternative("text body", '<p>html <img src="cid:logo1"></p>'), partId: "0.0" },
            {
              partId: "0.1",
              mimeType: "image/png",
              filename: "logo.png",
              headers: [header("Content-ID", "<logo1>"), header("Content-Disposition", 'inline; filename="logo.png"')],
              body: { attachmentId: "ATT-LOGO", size: 2048 },
            },
          ],
        },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "report.pdf",
          headers: [header("Content-Disposition", 'attachment; filename="report.pdf"')],
          body: { attachmentId: "ATT-PDF", size: 50000 },
        },
      ],
    };
    const p = parseMessage(message(payload));
    expect(p.bodyText).toBe("text body");
    expect(p.bodyHtml).toContain("cid:logo1");
    expect(p.pendingBodies).toEqual([]);
    expect(p.attachments).toEqual([
      { partId: "0.1", filename: "logo.png", mimeType: "image/png", sizeBytes: 2048, gmailAttachmentId: "ATT-LOGO", contentId: "logo1", isInline: true },
      { partId: "1", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 50000, gmailAttachmentId: "ATT-PDF", contentId: null, isInline: false },
    ]);
  });

  it("decodes iso-8859-1 bodies", () => {
    const latin1 = Buffer.from("Café crème", "latin1");
    const part: MessagePart = {
      mimeType: "text/plain",
      filename: "",
      headers: [header("Content-Type", "text/plain; charset=ISO-8859-1")],
      body: { size: latin1.length, data: b64url(latin1) },
    };
    expect(parseMessage(message(part)).bodyText).toBe("Café crème");
  });

  it("falls back to UTF-8 for an unknown charset", () => {
    expect(decodeBodyData(b64url("héllo"), "x-not-a-charset")).toBe("héllo");
  });

  it("decodes RFC 2047 encoded-word subjects (B and Q, adjacent words joined)", () => {
    const p = parseMessage(message(textPart("text/plain", "x"), [header("Subject", "=?UTF-8?B?w4lsw6lwaGFudA==?= =?ISO-8859-1?Q?_caf=E9?=")]));
    expect(p.subject).toBe("Éléphant café");
    expect(decodeEncodedWords("plain subject")).toBe("plain subject");
    expect(decodeEncodedWords("Re: =?utf-8?q?Hello_World?= again")).toBe("Re: Hello World again");
  });

  it("reports a body part delivered by attachmentId as pending, and applies fetched data", () => {
    const bodyByAttachment: MessagePart = {
      partId: "1",
      mimeType: "text/html",
      filename: "",
      headers: [header("Content-Type", "text/html; charset=utf-8")],
      body: { attachmentId: "ATT-BODY", size: 900000 },
    };
    const payload: MessagePart = {
      mimeType: "multipart/alternative",
      filename: "",
      body: { size: 0 },
      parts: [{ ...textPart("text/plain", "short"), partId: "0" }, bodyByAttachment],
    };
    const p = parseMessage(message(payload));
    expect(p.bodyHtml).toBeNull();
    expect(p.pendingBodies).toHaveLength(1);
    expect(p.pendingBodies[0]!.attachmentId).toBe("ATT-BODY");
    expect(p.attachments).toEqual([]);
    applyFetchedBody(p, p.pendingBodies[0]!, b64url("<p>big body</p>"));
    expect(p.bodyHtml).toBe("<p>big body</p>");
  });

  it("the same structure with a filename is a real attachment, never a pending body", () => {
    const realAttachment: MessagePart = {
      partId: "1",
      mimeType: "text/html",
      filename: "page.html",
      headers: [header("Content-Type", 'text/html; name="page.html"')],
      body: { attachmentId: "ATT-REAL", size: 900000 },
    };
    const payload: MessagePart = {
      mimeType: "multipart/mixed",
      filename: "",
      body: { size: 0 },
      parts: [{ ...textPart("text/plain", "see attached"), partId: "0" }, realAttachment],
    };
    const p = parseMessage(message(payload));
    expect(p.pendingBodies).toEqual([]);
    expect(p.attachments.map((a) => a.gmailAttachmentId)).toEqual(["ATT-REAL"]);
  });

  it("a text part with Content-Disposition: attachment and no filename is an attachment", () => {
    const part: MessagePart = {
      partId: "1",
      mimeType: "text/plain",
      filename: "",
      headers: [header("Content-Disposition", "attachment")],
      body: { attachmentId: "ATT-TXT", size: 10 },
    };
    expect(isBodyPart(part)).toBe(false);
    expect(isAttachmentPart(part)).toBe(true);
  });

  it("does not descend into an attached message/rfc822", () => {
    const payload: MessagePart = {
      mimeType: "multipart/mixed",
      filename: "",
      body: { size: 0 },
      parts: [
        { ...textPart("text/plain", "outer"), partId: "0" },
        {
          partId: "1",
          mimeType: "message/rfc822",
          filename: "forwarded.eml",
          body: { attachmentId: "ATT-EML", size: 4000 },
          parts: [{ ...textPart("text/html", "<p>inner</p>"), partId: "1.0" }],
        },
      ],
    };
    const p = parseMessage(message(payload));
    expect(p.bodyText).toBe("outer");
    expect(p.bodyHtml).toBeNull();
    expect(p.attachments.map((a) => a.filename)).toEqual(["forwarded.eml"]);
  });
});

describe("isBodyPart", () => {
  it("only text/plain or text/html without filename or attachment disposition", () => {
    expect(isBodyPart({ mimeType: "text/plain", filename: "" })).toBe(true);
    expect(isBodyPart({ mimeType: "TEXT/HTML" })).toBe(true);
    expect(isBodyPart({ mimeType: "text/html", headers: [header("Content-Disposition", "inline")] })).toBe(true);
    expect(isBodyPart({ mimeType: "text/plain", filename: "a.txt" })).toBe(false);
    expect(isBodyPart({ mimeType: "text/plain", headers: [header("content-disposition", 'ATTACHMENT; filename="x"')] })).toBe(false);
    expect(isBodyPart({ mimeType: "text/calendar" })).toBe(false);
    expect(isBodyPart({ mimeType: "image/png" })).toBe(false);
    expect(isBodyPart({ mimeType: "multipart/alternative" })).toBe(false);
  });
});

describe("snippetText", () => {
  it("decodes the HTML entities Gmail puts in snippets", () => {
    expect(snippetText("It&#39;s &quot;fine&quot; &amp; &lt;ok&gt;")).toBe('It\'s "fine" & <ok>');
    expect(snippetText(null)).toBe("");
  });
});

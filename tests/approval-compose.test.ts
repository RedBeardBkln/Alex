import { describe, expect, it } from "vitest";
import {
  assertHeaderBlock,
  buildMessage,
  ComposeError,
  MSG_ID_RE,
  replySubject,
  replyThreading,
  subjectHeader,
  toRaw,
  type OutgoingMessage,
} from "@/lib/gmail/compose";
import { decodeEncodedWords, parseMessage } from "@/lib/gmail/mime";

// Phase 2b AC7: the text/plain MIME builder, threading rules and header-injection safety.

const ch = (code: number) => String.fromCodePoint(code);
const LS = ch(0x2028);
const PS = ch(0x2029);
const NEL = ch(0x85);

const base: OutgoingMessage = {
  from: "work@example.com",
  to: ["alice@example.org"],
  cc: ["bob@example.net", "carol@example.net"],
  subject: "Re: Lunch",
  bodyText: "Sounds good.\n\nSee you there.",
  messageId: "<alex.11111111-2222-3333-4444-555555555555.1.abcdef012345@alex.example.com>",
  inReplyTo: "<parent@mail.example.org>",
  references: ["<root@mail.example.org>", "<parent@mail.example.org>"],
  date: new Date(Date.UTC(2026, 10, 19, 10, 5, 9)),
};

function split(message: string) {
  const at = message.indexOf("\r\n\r\n");
  return { head: message.slice(0, at), body: message.slice(at + 4) };
}

/** Unfolds the header block into {name, value} pairs, as a receiving parser does. */
function headersOf(head: string) {
  const unfolded = head.replace(/\r\n /g, " ");
  return unfolded.split("\r\n").map((line) => {
    const i = line.indexOf(":");
    return { name: line.slice(0, i), value: line.slice(i + 2) };
  });
}

describe("buildMessage: format (golden)", () => {
  it("produces exactly the expected bytes", () => {
    const msg = buildMessage(base);
    const body = Buffer.from("Sounds good.\r\n\r\nSee you there.", "utf8").toString("base64");
    expect(msg).toBe(
      [
        "From: work@example.com",
        "To: alice@example.org",
        "Cc: bob@example.net, carol@example.net",
        "Subject: Re: Lunch",
        "Date: Thu, 19 Nov 2026 10:05:09 +0000",
        `Message-ID: ${base.messageId}`,
        "In-Reply-To: <parent@mail.example.org>",
        "References: <root@mail.example.org> <parent@mail.example.org>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        body,
        "",
      ].join("\r\n"),
    );
  });

  it("uses CRLF only, the header order is fixed, and base64 lines are at most 76 characters", () => {
    const msg = buildMessage({ ...base, bodyText: "x".repeat(5000) + "\n" + "é".repeat(300) });
    expect(msg.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const { head, body } = split(msg);
    expect(headersOf(head).map((h) => h.name)).toEqual([
      "From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References", "MIME-Version", "Content-Type", "Content-Transfer-Encoding",
    ]);
    for (const line of body.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    for (const line of head.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
  });

  it("omits Cc, In-Reply-To and References when empty", () => {
    const { head } = split(buildMessage({ ...base, cc: [], inReplyTo: null, references: [] }));
    expect(headersOf(head).map((h) => h.name)).toEqual(["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
  });

  it("folds long recipient and References lists under 78 characters per line, splitting only between tokens", () => {
    const to = Array.from({ length: 12 }, (_, i) => `person${i}@example.org`);
    const refs = Array.from({ length: 10 }, (_, i) => `<ref${i}.abcdefghijklmnop@mail.example.org>`);
    const { head } = split(buildMessage({ ...base, to, cc: [], references: refs }));
    const lines = head.split("\r\n");
    const linesOf = (name: string) => {
      const i = lines.findIndex((l) => l.startsWith(`${name}: `));
      const out = [lines[i]!];
      for (let j = i + 1; j < lines.length && lines[j]!.startsWith(" "); j++) out.push(lines[j]!);
      return out;
    };
    for (const line of [...linesOf("To"), ...linesOf("References")]) expect(line.length, line).toBeLessThan(78);
    expect(linesOf("To").length).toBeGreaterThan(1);
    const h = headersOf(head);
    expect(h.find((x) => x.name === "To")!.value.split(", ")).toEqual(to);
    expect(h.find((x) => x.name === "References")!.value.split(" ")).toEqual(refs);
  });

  it("toRaw is base64url of the UTF-8 bytes", () => {
    const msg = buildMessage(base);
    const raw = toRaw(msg);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toBe(msg);
  });

  it("round-trips through 2a's MIME parser (headers, encoded subject, body)", () => {
    const subject = `Re: Café ${ch(0x65e5)}${ch(0x672c)} ${"long ".repeat(20)}`.trim();
    const bodyText = "Héllo\nsecond line";
    const msg = buildMessage({ ...base, subject, bodyText });
    const { head, body } = split(msg);
    const headers = headersOf(head);
    const parsed = parseMessage({
      id: "x",
      threadId: "t",
      payload: {
        mimeType: "text/plain",
        headers: [...headers, { name: "Content-Type", value: "text/plain; charset=UTF-8" }],
        body: { data: Buffer.from(Buffer.from(body.replace(/\r\n/g, ""), "base64")).toString("base64url") },
      },
    });
    expect(parsed.subject).toBe(subject);
    expect(parsed.from).toBe("work@example.com");
    expect(parsed.to).toBe("alice@example.org");
    expect(parsed.inReplyTo).toBe(base.inReplyTo);
    expect(parsed.rfc822MessageId).toBe(base.messageId);
    expect(parsed.bodyText).toBe("Héllo\r\nsecond line");
  });
});

describe("subject encoding", () => {
  it("printable ASCII is sent as is", () => {
    expect(subjectHeader("Re: Hello, world!")).toBe("Subject: Re: Hello, world!");
  });

  it("non-ASCII becomes RFC 2047 B words of whole code points, folded under 78 characters, and decodes back", () => {
    const s = `${ch(0x1f600)}é${ch(0x4e2d)}`.repeat(30);
    const h = subjectHeader(s);
    for (const line of h.split("\r\n")) {
      expect(line.length).toBeLessThan(78);
      expect(line).toMatch(/^(Subject: | )=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    expect(decodeEncodedWords(h.slice("Subject: ".length).replace(/\r\n /g, " "))).toBe(s);
  });

  it("the Re: rule", () => {
    expect(replySubject("Lunch")).toBe("Re: Lunch");
    expect(replySubject("  re: Lunch")).toBe("re: Lunch");
    expect(replySubject("RE:Lunch")).toBe("RE:Lunch");
    expect(replySubject(null)).toBe("Re:");
    expect(replySubject("   ")).toBe("Re:");
    expect(replySubject("Fwd: Lunch")).toBe("Re: Fwd: Lunch");
    expect(replySubject(`a\r\nBcc: x@example.com`)).toBe("Re: a Bcc: x@example.com");
  });
});

describe("threading headers", () => {
  const parent = { rfc822MessageId: "<p@x.example>", references: "<r1@x.example> <r2@x.example>", inReplyTo: "<r2@x.example>" };

  it("In-Reply-To is the parent's Message-ID; References is the parent's References then its Message-ID", () => {
    expect(replyThreading("t1", parent)).toEqual({ gmailThreadId: "t1", inReplyTo: "<p@x.example>", references: ["<r1@x.example>", "<r2@x.example>", "<p@x.example>"] });
  });

  it("falls back to In-Reply-To when the parent has no References", () => {
    expect(replyThreading("t1", { ...parent, references: null }).references).toEqual(["<r2@x.example>", "<p@x.example>"]);
  });

  it("trims to the first id plus the last 9, and to 900 characters", () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<r${i}@x.example>`).join(" ");
    const t = replyThreading("t1", { ...parent, references: refs });
    expect(t.references).toHaveLength(10);
    expect(t.references[0]).toBe("<r0@x.example>");
    expect(t.references.at(-1)).toBe("<p@x.example>");
    const long = Array.from({ length: 12 }, (_, i) => `<${"a".repeat(200)}${i}@x.example>`).join(" ");
    const t2 = replyThreading("t1", { ...parent, references: long });
    expect(t2.references.join(" ").length).toBeLessThanOrEqual(900);
    expect(t2.references.at(-1)).toBe("<p@x.example>");
  });

  it("drops invalid parent ids; an invalid parent Message-ID omits both headers", () => {
    const t = replyThreading("t1", { ...parent, references: "<ok@x.example> <bad id@x> <no-at> <a@b>\r\nBcc: z@example.com" });
    expect(t.references).toEqual(["<ok@x.example>", "<a@b>", "<p@x.example>"]);
    for (const bad of [null, "", "p@x.example", "<p@x.example> extra", "<p\r\n@x.example>", "<p@x.example>\r\nBcc: a@b.c"]) {
      expect(replyThreading("t1", { ...parent, rfc822MessageId: bad })).toEqual({ gmailThreadId: "t1", inReplyTo: null, references: [] });
    }
  });
});

describe("header-injection corpus: every hostile value is rejected or encoded", () => {
  const CRLF_VARIANTS = ["\r\n", "\n", "\r", "%0d%0a", LS, PS, NEL, ch(0), ch(0x0b), ch(0x0c)];

  it("addresses with CR/LF, commas, <>, quotes, spaces, NUL or over-long parts are rejected", () => {
    const bad = [
      ...CRLF_VARIANTS.map((v) => `a${v}Bcc: x@example.com`),
      ...CRLF_VARIANTS.map((v) => `alice@example.org${v}`),
      "a,b@example.org",
      "<a@example.org>",
      '"a"@example.org',
      "a b@example.org",
      "a;b@example.org",
      "a:b@example.org",
      "Name <a@example.org>",
      `${"a".repeat(65)}@example.org`,
      `a@${"b".repeat(250)}.org`,
      "a@localhost",
      "a@-x.org",
      "é@example.org",
      "a@exämple.org",
      "@example.org",
      "a@",
      "a@@example.org",
    ];
    for (const addr of bad) {
      expect(() => buildMessage({ ...base, to: [addr] }), JSON.stringify(addr)).toThrow(ComposeError);
      expect(() => buildMessage({ ...base, cc: [addr] }), JSON.stringify(addr)).toThrow(ComposeError);
      expect(() => buildMessage({ ...base, from: addr }), JSON.stringify(addr)).toThrow(ComposeError);
    }
  });

  it("subjects with CR, LF, controls or Unicode line separators are rejected; %0d%0a is just text", () => {
    for (const v of CRLF_VARIANTS.filter((x) => x !== "%0d%0a")) {
      expect(() => buildMessage({ ...base, subject: `Hi${v}Bcc: x@example.com` }), JSON.stringify(v)).toThrow(ComposeError);
    }
    expect(() => buildMessage({ ...base, subject: "x".repeat(501) })).toThrow(ComposeError);
    const { head } = split(buildMessage({ ...base, subject: "Hi%0d%0aBcc: x@example.com" }));
    expect(head.split("\r\n").filter((l) => l.startsWith("Bcc"))).toEqual([]);
  });

  it("message ids with spaces, brackets, CR/LF or no @ are rejected", () => {
    for (const id of ["<a b@x>", "<a@x> <b@y>", "a@x", "<a@x", "<a<b@x>", "<a@x>\r\nBcc: z@example.com", `<a${LS}@x>`, `<${"a".repeat(251)}@x>`]) {
      expect(MSG_ID_RE.test(id), id).toBe(false);
      expect(() => buildMessage({ ...base, messageId: id }), id).toThrow(ComposeError);
      expect(() => buildMessage({ ...base, inReplyTo: id }), id).toThrow(ComposeError);
      expect(() => buildMessage({ ...base, references: [id] }), id).toThrow(ComposeError);
    }
  });

  it("a hostile body never reaches the header block (base64)", () => {
    const hostile = "\r\n\r\nBcc: x@example.com\r\n.\r\nSubject: evil\n" + ch(0) + LS;
    const msg = buildMessage({ ...base, bodyText: hostile });
    const { head } = split(msg);
    expect(head).not.toContain("Bcc");
    expect(head).not.toContain("evil");
    expect(msg.indexOf("\r\n\r\n")).toBe(head.length);
  });

  it("no recipients, or more than 50, is rejected", () => {
    expect(() => buildMessage({ ...base, to: [] })).toThrow(ComposeError);
    const many = Array.from({ length: 49 }, (_, i) => `p${i}@example.org`);
    expect(() => buildMessage({ ...base, to: many, cc: ["a@example.org"] })).not.toThrow();
    expect(() => buildMessage({ ...base, to: many, cc: ["a@example.org", "b@example.org"] })).toThrow(ComposeError);
  });

  it("assertHeaderBlock rejects any line that isn't one of our headers or a fold", () => {
    expect(() => assertHeaderBlock("From: a@b.c\r\nBcc: x@y.z")).toThrow(ComposeError);
    expect(() => assertHeaderBlock("From: a@b.c\nTo: x@y.z")).toThrow(ComposeError);
    expect(() => assertHeaderBlock("From: a@b.c\r\n\r\nTo: x@y.z")).toThrow(ComposeError);
    expect(() => assertHeaderBlock("From: a@b.c\r\n ")).toThrow(ComposeError);
    expect(() => assertHeaderBlock("From: a@b.c\r\n folded")).not.toThrow();
  });
});

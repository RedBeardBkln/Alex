import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBody, type BodyMessage } from "@/app/(app)/inbox/[threadId]/message-body";
import { EMAIL_IFRAME_SANDBOX, emailCsp } from "@/lib/email/shell";
import { MIN_DISPLAYABLE_SANITIZER_VERSION, SANITIZER_VERSION } from "@/lib/email/version";

// Plan Revision 4, R4.5 and AC 18j (view-time), 18l (toggle), 18o (display gate): the page only
// shows stored output.

const base: BodyMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  isSent: false,
  fromHeader: "Ann <ann@example.com>",
  bodyText: null,
  bodyIncomplete: false,
  renderKind: null,
  renderReason: null,
  renderedHtml: null,
  renderedHtmlRemote: null,
  renderedText: null,
  renderTruncated: false,
  sanitizerVersion: null,
};
const html = (m: Partial<BodyMessage>, remoteOn = false) =>
  renderToStaticMarkup(createElement(MessageBody, { message: { ...base, ...m }, threadId: "t-1", remoteOn }));

/** The decoded srcdoc of the rendered iframe. */
function srcdoc(markup: string): string | null {
  const m = markup.match(/srcDoc="([^"]*)"/i) ?? markup.match(/srcdoc="([^"]*)"/i);
  return m ? m[1]!.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
}

const htmlMessage = { renderKind: "html" as const, renderedHtml: "<p>Hello</p>", sanitizerVersion: SANITIZER_VERSION };

describe("MessageBody", () => {
  it("html: wraps the stored default variant in the shell with the sandbox and default CSP", () => {
    const out = html(htmlMessage);
    expect(out).toContain(`sandbox="${EMAIL_IFRAME_SANDBOX}"`);
    const doc = srcdoc(out)!;
    expect(doc).toContain(emailCsp({ allowRemoteImages: false }));
    expect(doc).toContain("<body><p>Hello</p></body>");
    expect(out).not.toContain("Show remote images"); // no remote variant stored
  });

  it("html with a remote variant: toggle shown; with remote on, the remote variant and widened img-src", () => {
    const m = { ...htmlMessage, renderedHtmlRemote: '<p>Hello <img src="https://i.example/a.png" /></p>' };
    const off = html(m, false);
    expect(off).toContain("Show remote images");
    expect(srcdoc(off)).toContain("<body><p>Hello</p></body>");
    const on = html(m, true);
    expect(on).toContain("Hide remote images");
    const doc = srcdoc(on)!;
    expect(doc).toContain(emailCsp({ allowRemoteImages: true }));
    expect(doc).toContain('https://i.example/a.png');
  });

  it("remote requested but no remote variant: default variant and default CSP", () => {
    const doc = srcdoc(html(htmlMessage, true))!;
    expect(doc).toContain(emailCsp({ allowRemoteImages: false }));
    expect(doc).not.toContain("https:");
  });

  it("text kinds: escaped text in a <pre>, with a note by reason and for truncation", () => {
    for (const reason of ["too_large", "too_deep", "timeout", "crash", "postcheck"]) {
      const out = html({ renderKind: "text", renderReason: reason, renderedText: "<b>not markup</b>", sanitizerVersion: SANITIZER_VERSION });
      expect(out).toContain("<pre");
      expect(out).toContain("&lt;b&gt;not markup&lt;/b&gt;");
      expect(out).toContain("couldn&#x27;t be displayed safely");
      expect(out).not.toContain("<iframe");
    }
    const unavailable = html({ renderKind: "text", renderReason: "worker_unavailable", renderedText: "t", sanitizerVersion: null, renderTruncated: true });
    expect(unavailable).toContain("still being prepared");
    expect(unavailable).toContain("Text truncated.");
  });

  it("none: body_text, or (no content)", () => {
    expect(html({ renderKind: "none", bodyText: "Just text", sanitizerVersion: SANITIZER_VERSION })).toContain("Just text");
    expect(html({ renderKind: "none", sanitizerVersion: SANITIZER_VERSION })).toContain("(no content)");
  });

  it("not rendered yet: body_text or 'being prepared'; never an iframe", () => {
    expect(html({ bodyText: "Fallback" })).toContain("Fallback");
    const out = html({});
    expect(out).toContain("This message is being prepared for display.");
    expect(out).not.toContain("<iframe");
  });

  it("html below MIN_DISPLAYABLE_SANITIZER_VERSION is not displayed", () => {
    const old = { ...htmlMessage, sanitizerVersion: MIN_DISPLAYABLE_SANITIZER_VERSION - 1, bodyText: "Safe text" };
    const out = html(old);
    expect(out).not.toContain("<iframe");
    expect(out).toContain("Safe text");
    expect(html({ ...htmlMessage, sanitizerVersion: MIN_DISPLAYABLE_SANITIZER_VERSION - 1 })).toContain("being prepared");
    expect(html({ ...htmlMessage, sanitizerVersion: null })).not.toContain("<iframe");
  });

  it("18j view-time: 8 stored maximum-size messages (both variants) render in under 100 ms", () => {
    const fragment = "<p>".padEnd(256 * 1024, "x");
    const messages = Array.from({ length: 8 }, (_, i) => ({
      ...base,
      id: `m${i}`,
      renderKind: "html" as const,
      renderedHtml: fragment,
      renderedHtmlRemote: fragment.replace("<p>", '<p><img src="https://i.example/a.png" />'),
      sanitizerVersion: SANITIZER_VERSION,
    }));
    renderToStaticMarkup(createElement(MessageBody, { message: messages[0]!, threadId: "t", remoteOn: false })); // warm-up
    const t0 = performance.now();
    for (const [i, m] of messages.entries()) renderToStaticMarkup(createElement(MessageBody, { message: m, threadId: "t", remoteOn: i % 2 === 0 }));
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

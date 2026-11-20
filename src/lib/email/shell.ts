/**
 * The srcdoc document wrapper for stored, already-sanitized email HTML (plan Revision 4, R4.5).
 * Page-safe: constant string concatenation only, no sanitizer imports. The body passed in must be
 * output produced at ingest by sanitizeEmailHtml (src/lib/email-html.ts).
 */

export type ShellOptions = { allowRemoteImages: boolean };

/**
 * CSP for the email iframe: nothing may load except inline styles and `<img>` images (data:,
 * plus https: when allowed). No font-src: CSS can't load fonts.
 */
export function emailCsp(opts: ShellOptions): string {
  const img = opts.allowRemoteImages ? "img-src https: data:" : "img-src data:";
  return `default-src 'none'; ${img}; style-src 'unsafe-inline'`;
}

/** Iframe sandbox tokens: links may open in a new tab; no scripts, no same-origin, no forms. */
export const EMAIL_IFRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

const BASE_STYLE =
  "<style>body{margin:0;padding:8px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;color:#1c1c1a;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}.alex-inline-image{color:#6b6b66;font-style:italic}</style>";

/** Wraps a sanitized body fragment in the srcdoc document (doctype, meta CSP, referrer policy, base target). */
export function emailShell(sanitizedBody: string, opts: ShellOptions): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${emailCsp(opts)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<base target="_blank">',
    BASE_STYLE,
    `</head><body>${sanitizedBody}</body></html>`,
  ].join("");
}

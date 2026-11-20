/**
 * Shapes shared by the ingest-time renderer, the store and the page. Type-only and import-free,
 * so the page can depend on it without pulling in the sanitizer (plan Revision 4, R4.5).
 */

export type RenderKind = "html" | "text" | "none";

/** Why a message that has HTML is shown as text. Content-free. */
export type RenderReason = "too_large" | "too_deep" | "timeout" | "crash" | "postcheck" | "worker_unavailable";

/** The render_* columns of mail_messages (R4.6). */
export type RenderFields = {
  renderKind: RenderKind;
  renderReason: RenderReason | null;
  renderedHtml: string | null;
  renderedHtmlRemote: string | null;
  renderedText: string | null;
  renderTruncated: boolean;
  /** SANITIZER_VERSION that produced this output; null when the worker was unavailable (re-rendered later). */
  sanitizerVersion: number | null;
  renderedAt: Date;
};

import { EMAIL_IFRAME_SANDBOX, emailShell } from "@/lib/email/shell";
import type { RenderKind } from "@/lib/email/types";
import { MIN_DISPLAYABLE_SANITIZER_VERSION } from "@/lib/email/version";

/**
 * Displays a message body from its stored ingest-time rendering (plan Revision 4, R4.5). Nothing
 * is sanitized here: the page only wraps stored output (`emailShell`) or shows text.
 */

export type BodyMessage = {
  id: string;
  isSent: boolean;
  fromHeader: string | null;
  bodyText: string | null;
  bodyIncomplete: boolean;
  renderKind: RenderKind | null;
  renderReason: string | null;
  renderedHtml: string | null;
  renderedHtmlRemote: string | null;
  renderedText: string | null;
  renderTruncated: boolean;
  sanitizerVersion: number | null;
};

const TEXT_NOTES: Record<string, string> = {
  worker_unavailable: "Shown as plain text while this message's formatting is still being prepared.",
};
const DEFAULT_TEXT_NOTE = "Shown as plain text because this message's formatting couldn't be displayed safely.";

function Pre({ text }: { text: string }) {
  return <pre className="whitespace-pre-wrap break-words font-sans text-sm">{text}</pre>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-[var(--muted)]">{children}</p>;
}

export function MessageBody({ message: m, threadId, remoteOn }: { message: BodyMessage; threadId: string; remoteOn: boolean }) {
  const base = `/inbox/${threadId}`;
  const displayableHtml =
    m.renderKind === "html" && m.renderedHtml !== null && m.sanitizerVersion !== null && m.sanitizerVersion >= MIN_DISPLAYABLE_SANITIZER_VERSION;

  let body: React.ReactNode;
  if (displayableHtml) {
    const hasRemote = m.renderedHtmlRemote !== null;
    const useRemote = remoteOn && hasRemote;
    body = (
      <>
        <iframe
          title={`Message from ${m.isSent ? "you" : m.fromHeader || "unknown sender"}`}
          sandbox={EMAIL_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={emailShell(useRemote ? m.renderedHtmlRemote! : m.renderedHtml!, { allowRemoteImages: useRemote })}
          className="h-[480px] w-full resize-y overflow-auto rounded border border-[var(--border)] bg-white"
        />
        {hasRemote && (
          <Muted>
            {useRemote ? (
              <a className="underline" href={`${base}#m-${m.id}`}>
                Hide remote images
              </a>
            ) : (
              <>
                Remote images are blocked.{" "}
                <a className="underline" href={`${base}?remote=${m.id}#m-${m.id}`}>
                  Show remote images
                </a>
              </>
            )}
          </Muted>
        )}
      </>
    );
  } else if (m.renderKind === "text" && m.renderedText !== null) {
    // Plain text is React text, never HTML, so it is shown whatever its sanitizer version.
    body = (
      <>
        <Pre text={m.renderedText} />
        <Muted>
          {TEXT_NOTES[m.renderReason ?? ""] ?? DEFAULT_TEXT_NOTE}
          {m.renderTruncated ? " Text truncated." : ""}
        </Muted>
      </>
    );
  } else if (m.renderKind === "none") {
    body = m.bodyText ? <Pre text={m.bodyText} /> : <p className="text-sm text-[var(--muted)]">(no content)</p>;
  } else {
    // Not rendered yet, or rendered by a sanitizer version that may no longer be displayed: never sanitize on view.
    body = m.bodyText ? <Pre text={m.bodyText} /> : <p className="text-sm text-[var(--muted)]">This message is being prepared for display.</p>;
  }

  return (
    <div className="mt-3">
      {body}
      {m.bodyIncomplete && <p className="mt-1 text-xs text-[var(--danger)]">Part of this message's body couldn't be downloaded from Gmail.</p>}
    </div>
  );
}

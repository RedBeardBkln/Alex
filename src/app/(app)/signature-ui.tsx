/**
 * Signature display pieces (phase email-signatures). Import-free, so both server pages and the
 * reply form's client component can use them. The signature is always rendered as React text in a
 * <pre>, never as HTML.
 */

export type SignatureState = "set" | "none" | "not_found" | "too_large" | null;

/** What the forms need: the stored state (null: never read successfully, or no row) and the text when `set`. */
export type SignaturePreviewData = { state: SignatureState; text: string | null };

/** Why the reply form shows no signature (plan step 7). Fixed text. */
export function replySignatureReason(state: SignatureState): string {
  switch (state) {
    case "none":
      return "No signature: none is set in Gmail for this address";
    case "too_large":
      return "Your Gmail signature is too long to add";
    case "not_found":
      return "Not found in Gmail's settings for this address";
    default:
      return "Alex hasn't read this account's signature yet";
  }
}

export function SignatureText({ text }: { text: string }) {
  return <pre className="mt-1 max-w-full whitespace-pre-wrap break-words rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-sm">{text}</pre>;
}

/** The reply form's preview: the signature that will be added, or a fixed reason there is none. */
export function ReplySignaturePreview({ signature }: { signature: SignaturePreviewData }) {
  if (signature.state === "set" && signature.text) {
    return (
      <div>
        <p className="text-[var(--muted)]">Your Gmail signature is added below your message, before the quoted text.</p>
        <SignatureText text={signature.text} />
      </div>
    );
  }
  return <p className="text-[var(--muted)]">{replySignatureReason(signature.state)}</p>;
}

/** Compose (owner Q4b). Fixed text. */
export const COMPOSE_SIGNATURE_NOTE =
  "Your Gmail signature for the account you choose is added below your message. You'll see it on the approval page before anything is sent.";

/** The approval page's Edit form. Fixed text. */
export const EDIT_SIGNATURE_NOTE = "Saving adds this account's current Gmail signature.";

import { replySubject } from "@/lib/gmail/compose";
import { hasBidiControl } from "./text";

/**
 * Subject warnings on the approval screen (plan §7, review round 1):
 * - `changed`: the subject differs from the default reply subject, so Gmail may not thread the
 *   reply. Never raised when the original has no subject.
 * - `bidi`: the subject contains bidirectional formatting characters, which can make it display
 *   differently from what is sent. (Recipients are ASCII-only, so they can't contain any.)
 */
export function subjectWarnings(shownSubject: string, originalSubject: string | null): { changed: boolean; bidi: boolean } {
  const original = (originalSubject ?? "").trim();
  return {
    changed: original !== "" && shownSubject.trim() !== replySubject(original),
    bidi: hasBidiControl(shownSubject),
  };
}

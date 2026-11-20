import type { AiUsage } from "@/lib/ai-ledger/ledger";

/**
 * Provider-neutral AI interfaces (Phase 2c, plan §4). Inputs and outputs are plain data with no
 * SDK types, so another provider (for example a local one) can implement them unchanged.
 */

export const TRIAGE_CATEGORIES = ["needs_reply", "fyi", "newsletter", "notification", "promo", "spam_suspect"] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/** One message as the model sees it: untrusted data, sent only inside a JSON-encoded tool result. */
export type ThreadTextMessage = {
  source: "inbound_email" | "owner_sent";
  from_address: string | null;
  date: string | null;
  subject: string | null;
  text: string;
  /** True when `text` was cut to the per-message or total cap. */
  truncated?: boolean;
};

export type TriageInput = { message: ThreadTextMessage };
export type TriageResult = { category: TriageCategory; needsReply: boolean; summary: string };

export type DraftInput = {
  /** This thread only, oldest first, already capped (src/lib/ai/prompts.ts). */
  messages: ThreadTextMessage[];
  /** Optional owner text, trusted, sent as the owner's words in the user turn. */
  ownerInstruction: string | null;
};

export type ProviderStatus = "ok" | "refused" | "invalid" | "error";

export type TriageOutcome = { status: ProviderStatus; result: TriageResult | null; errorCode: string | null; usage: AiUsage };
export type DraftOutcome = { status: ProviderStatus; body: string | null; notes: string | null; errorCode: string | null; usage: AiUsage };

export interface TriageProvider {
  id: string;
  triage(input: TriageInput, signal: AbortSignal): Promise<TriageOutcome>;
}

export interface DraftProvider {
  id: string;
  draft(input: DraftInput, signal: AbortSignal): Promise<DraftOutcome>;
}

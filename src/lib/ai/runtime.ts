import { db } from "@/db";
import { aiConfigured, triageProviderId } from "@/lib/ai-ledger/config";
import { env } from "@/lib/env";
import { draftReply, type DraftResult } from "./draft";
import { anthropicClient, anthropicDraftProvider, anthropicTriageProvider } from "./providers/anthropic";
import { triageThreadNow } from "./triage";
import type { DraftProvider, TriageProvider } from "./types";

/**
 * Production wiring for the AI features (Phase 2c). Imported by the sync routes (statically) and
 * by the thread page's AI actions (dynamically), never by a page's static import graph, so the
 * SDK stays out of page bundles' static graph (AC10).
 */

/** The configured triage provider, or null when triage is off (no key, or an unknown provider id). */
export function triageProvider(): TriageProvider | null {
  const id = triageProviderId();
  if (id === "anthropic-haiku") return anthropicTriageProvider(anthropicClient(env().ANTHROPIC_API_KEY!));
  return null;
}

export function draftProvider(): DraftProvider | null {
  return aiConfigured() ? anthropicDraftProvider(anthropicClient(env().ANTHROPIC_API_KEY!)) : null;
}

/** For the sync routes: triage settings for SyncDeps, or undefined when triage is off. */
export function productionTriage(): { provider: TriageProvider } | undefined {
  const provider = triageProvider();
  return provider ? { provider } : undefined;
}

export function draftReplyNow(input: { userId: string; threadId: string; mode: "reply" | "all"; instruction: string | null }): Promise<DraftResult> {
  return draftReply({ db: db(), provider: draftProvider() }, input);
}

export async function triageThreadOnDemand(userId: string, threadId: string) {
  const provider = triageProvider();
  if (!provider) return "not_configured" as const;
  return triageThreadNow({ db: db(), provider }, userId, threadId);
}

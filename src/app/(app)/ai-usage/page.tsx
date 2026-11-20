import { db } from "@/db";
import { aiCaps, aiConfigured, triageProviderId } from "@/lib/ai-ledger/config";
import { todaysUsage, usageReport } from "@/lib/ai-ledger/ledger";
import { PRICING_VERSION } from "@/lib/ai-ledger/pricing";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * AI usage report (Phase 2c, plan §7): calls, tokens and estimated cost per UTC day and purpose
 * for the last 14 days, read from the content-free `ai_calls` log. No SDK on this page.
 */

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;
const n = (v: number) => v.toLocaleString("en-US");

export default async function AiUsagePage() {
  const user = await requireUser();
  const now = new Date();
  const [rows, today] = await Promise.all([usageReport(db(), user.id, now), todaysUsage(db(), user.id, now)]);
  const caps = aiCaps();
  const configured = aiConfigured();
  const total = rows.reduce((s, r) => s + r.costUsdMicros, 0);

  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-xl font-semibold">AI usage</h1>
      <p className="text-[var(--muted)]">
        {configured ? `AI is on. Triage: ${triageProviderId() ? "on" : "off"}. Drafts: on, only when you click.` : "AI not configured (no ANTHROPIC_API_KEY)."} Costs are
        estimates from the price table ({PRICING_VERSION}); check the Anthropic Console for the actual bill.
      </p>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="font-medium">Today (UTC) and the daily caps</h2>
        <ul className="mt-2 space-y-1">
          <li>
            Triage: {n(today.triage.calls)} of {n(caps.triageCalls)} calls, {usd(today.triage.micros)} of {usd(caps.triageMicros)}
          </li>
          <li>
            Drafts: {n(today.draft.calls)} of {n(caps.draftCalls)} calls, {usd(today.draft.micros)} of {usd(caps.draftMicros)}
          </li>
          <li>
            Overall: {usd(today.totalMicros)} of {usd(caps.totalMicros)}
          </li>
          {today.spendLimitHit && <li className="rounded-md bg-[var(--warn-bg)] px-3 py-2">Anthropic reported a spend limit today: AI is paused until midnight UTC.</li>}
        </ul>
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="font-medium">Last 14 days (estimated total {usd(total)})</h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-[var(--muted)]">No AI calls yet.</p>
        ) : (
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-[var(--muted)]">
              <tr>
                <th className="py-1">Day</th>
                <th>Purpose</th>
                <th>Calls</th>
                <th>Not ok</th>
                <th>Input</th>
                <th>Output</th>
                <th>Thinking</th>
                <th>Cache write</th>
                <th>Cache read</th>
                <th>Cost (est.)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.day}-${r.purpose}`} className="border-t border-[var(--border)]">
                  <td className="py-1">{r.day}</td>
                  <td>{r.purpose}</td>
                  <td>{n(r.calls)}</td>
                  <td>{n(r.failed)}</td>
                  <td>{n(r.inputTokens)}</td>
                  <td>{n(r.outputTokens)}</td>
                  <td>{n(r.thinkingTokens)}</td>
                  <td>{n(r.cacheWriteTokens)}</td>
                  <td>{n(r.cacheReadTokens)}</td>
                  <td>
                    {usd(r.costUsdMicros)}
                    {r.estimated > 0 && (
                      <span className="block text-xs text-[var(--muted)]">
                        incl. {usd(r.estimatedUsdMicros)} for {n(r.estimated)} {r.estimated === 1 ? "call" : "calls"} estimated (no usage returned)
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

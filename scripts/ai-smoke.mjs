// Owner-run AI smoke check (Phase 2c, approval amendment C). Not used by the app or the tests.
//
//   ANTHROPIC_API_KEY=... node --experimental-strip-types scripts/ai-smoke.mjs
//   node --experimental-strip-types scripts/ai-smoke.mjs --dry-run      (no key, no call)
//
// - Set the key only in the shell you run this from: never in a file, the repo or chat.
// - It sends one fixed synthetic email through the real triage and draft request builders
//   (src/lib/ai/prompts.ts): one Haiku 5.5 call and one Opus 5.5 call.
// - It has no database access and reads no real mail.
// - It prints only the stop reason, the usage numbers and the estimated cost, never model output.
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const prompts = await import(pathToFileURL(path.join(root, "src/lib/ai/prompts.ts")).href);
const pricing = await import(pathToFileURL(path.join(root, "src/lib/ai-ledger/pricing.ts")).href);

const SAMPLE = {
  source: "inbound_email",
  from_address: "sample.sender@example.com",
  date: "Wed, 19 Nov 2026 09:00:00 +0000",
  subject: "Lunch next week?",
  text: "Hi,\n\nAre you free for lunch next Tuesday or Wednesday? Let me know which day works.\n\nThanks,\nSam",
};

const triage = prompts.buildTriageRequest({ message: SAMPLE });
const draft = prompts.buildDraftRequest({ messages: [SAMPLE], ownerInstruction: "Say Wednesday works." });

const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
  for (const [name, req] of [["triage", triage], ["draft", draft]]) {
    console.log(`${name}: model ${req.model}, max_tokens ${req.max_tokens}, effort ${req.output_config.effort}, ${req.messages.length} turns, request ${JSON.stringify(req).length} characters`);
  }
  process.exit(0);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY in this shell only (not in a file), or use --dry-run.");
  process.exit(1);
}
const client = new Anthropic({ apiKey, maxRetries: 2 });

async function run(name, req) {
  const started = Date.now();
  try {
    const { data, request_id } = await client.messages.create(req, { timeout: 120_000 }).withResponse();
    const u = data.usage;
    const tokens = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
    };
    const cost = pricing.costUsdMicros(req.model, tokens);
    const blocks = data.content.map((b) => b.type).join(",");
    console.log(
      `${name}: stop_reason=${data.stop_reason} blocks=[${blocks}] input=${tokens.inputTokens} output=${tokens.outputTokens} thinking=${u.output_tokens_details?.thinking_tokens ?? "n/a"} cache_write=${tokens.cacheWriteTokens} cache_read=${tokens.cacheReadTokens} cost_estimate=$${cost === null ? "n/a" : (cost / 1e6).toFixed(6)} latency_ms=${Date.now() - started} request_id=${request_id ?? "n/a"}`,
    );
  } catch (err) {
    // Status and type only: no request or response content.
    console.log(`${name}: error status=${err?.status ?? "n/a"} type=${err?.type ?? err?.name ?? "n/a"} code=${err?.errorCode ?? "n/a"} request_id=${err?.requestID ?? "n/a"}`);
    process.exitCode = 1;
  }
}

await run("triage", triage);
await run("draft", draft);

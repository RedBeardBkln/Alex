import { z } from "zod";

/** Optional setting: unset and empty both mean "not configured". Use sites fail closed. */
const optional = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  ALEX_ALLOWED_EMAILS: z
    .string()
    .min(1, "ALEX_ALLOWED_EMAILS must list at least one email")
    .transform((s) =>
      s
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ALEX_ENCRYPTION_KEY: z
    .string()
    .refine((k) => Buffer.from(k, "base64").length === 32, "ALEX_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  GOOGLE_OAUTH_TESTING_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Mail ingestion (Phase 2a). All optional so the app runs without push; each use site fails closed.
  /** Pub/Sub topic Gmail publishes to, e.g. projects/<project-id>/topics/gmail-push. Unset: polling only. */
  GMAIL_PUBSUB_TOPIC: optional,
  /** Audience configured on the push subscription (the push endpoint URL). Unset: push endpoint returns 503. */
  PUBSUB_PUSH_AUDIENCE: optional,
  /** Service account the push subscription authenticates as. Unset: push endpoint returns 503. */
  PUBSUB_PUSH_SERVICE_ACCOUNT: optional,
  /** Bearer secret Vercel Cron sends. Unset or too short: cron endpoints return 401. */
  CRON_SECRET: optional,
  // AI (Phase 2c). All optional: without ANTHROPIC_API_KEY the AI features are off ("AI not configured").
  /** Claude API key (Anthropic Console). Server-only; never sent to the browser. */
  ANTHROPIC_API_KEY: optional,
  /** Triage provider id; unset means "anthropic-haiku". An unknown id turns triage off. */
  AI_TRIAGE_PROVIDER: optional,
  /** Daily cap overrides (UTC day). Invalid values fall back to the defaults in src/lib/ai-ledger/config.ts. */
  AI_TRIAGE_MAX_CALLS_PER_DAY: optional,
  AI_TRIAGE_MAX_USD_PER_DAY: optional,
  AI_DRAFT_MAX_CALLS_PER_DAY: optional,
  AI_DRAFT_MAX_USD_PER_DAY: optional,
  AI_MAX_USD_PER_DAY: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated environment. Read lazily so `next build` works without secrets present. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment configuration: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

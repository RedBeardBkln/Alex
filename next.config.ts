import type { NextConfig } from "next";

// Routes that render mail at ingest start the bundled render worker (.alex-build/render-worker.mjs,
// built by scripts/build-render-worker.mjs) from process.cwd(); include it in their function bundles.
const RENDER_WORKER_FILES = ["./.alex-build/**"];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/api/cron/gmail-sync": RENDER_WORKER_FILES,
    "/api/gmail/push": RENDER_WORKER_FILES,
    "/api/accounts/google/callback": RENDER_WORKER_FILES,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;

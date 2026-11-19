/**
 * Sanitizer versioning (plan Revision 4, R4.7). Page-safe: no imports.
 *
 * Bump SANITIZER_VERSION on any change to the files listed in SANITIZER_SOURCE_FILES (the HTML and
 * CSS sanitizers, the plain-text scanner, the worker and the render routing, including every cap).
 * Stored output with a lower version is re-rendered in the background by the cron `rerender` stage.
 *
 * Also bump MIN_DISPLAYABLE_SANITIZER_VERSION when the change fixes a security defect: older stored
 * output then stops being displayed (body_text or "being prepared" is shown) until it is re-rendered.
 *
 * tests/email-version.test.ts recomputes SANITIZER_SOURCE_HASH and fails (printing the new hash) when
 * any listed file changes, forcing a conscious decision about the version. It also checks the
 * installed versions of SANITIZER_DEPENDENCIES against SANITIZER_DEPENDENCY_HISTORY: upgrading
 * any of them (sanitize-html, htmlparser2, postcss, @csstools/*) fails until SANITIZER_VERSION is
 * bumped.
 */

export const SANITIZER_VERSION = 1;
export const MIN_DISPLAYABLE_SANITIZER_VERSION = 1;

/** Files whose content determines rendered output, relative to the repo root. */
export const SANITIZER_SOURCE_FILES = [
  "src/lib/email-css.ts",
  "src/lib/email-html.ts",
  "src/lib/email/plain-text.ts",
  "src/lib/email/postcheck.ts",
  "src/lib/email/render.ts",
  "src/lib/email/render.worker.ts",
];

/**
 * Third-party packages whose code determines rendered output (Round 10, security V1). Each is
 * resolved the way Node resolves it: from the repo root, or from inside another package's
 * directory (sanitize-html's own htmlparser2 and its nested postcss).
 */
export const SANITIZER_DEPENDENCIES: { name: string; resolveFrom: "." | "sanitize-html" }[] = [
  { name: "sanitize-html", resolveFrom: "." },
  { name: "htmlparser2", resolveFrom: "sanitize-html" },
  { name: "postcss", resolveFrom: "sanitize-html" },
  { name: "@csstools/css-tokenizer", resolveFrom: "." },
  { name: "@csstools/css-parser-algorithms", resolveFrom: "." },
];

/**
 * The resolved versions of SANITIZER_DEPENDENCIES that each SANITIZER_VERSION was built with,
 * oldest first. tests/email-version.test.ts requires the installed versions (and the lockfile) to
 * equal the last entry, and the last entry's version to equal SANITIZER_VERSION, with versions
 * strictly increasing. So upgrading any of these packages fails the test until a new entry is
 * appended with a bumped SANITIZER_VERSION, which makes the cron re-render stored mail.
 * Never edit an existing entry.
 */
export const SANITIZER_DEPENDENCY_HISTORY: { version: number; packages: Record<string, string> }[] = [
  {
    version: 1,
    packages: {
      "sanitize-html": "2.18.2",
      htmlparser2: "12.0.0",
      postcss: "8.5.33",
      "@csstools/css-tokenizer": "4.0.3",
      "@csstools/css-parser-algorithms": "4.0.3",
    },
  },
];

/** sha256 of SANITIZER_SOURCE_FILES (LF-normalized) as of SANITIZER_VERSION. */
export const SANITIZER_SOURCE_HASH = "41249bcea72f5e6fb978149c715a8d690cdd32fd91d559cc54787fdbfb1f7511";

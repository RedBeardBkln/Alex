/**
 * Sanitizer versioning (plan Revision 4, R4.7). Page-safe: no imports.
 *
 * Bump SANITIZER_VERSION whenever stored output can change for some input, including any change to
 * SANITIZER_DEPENDENCY_HISTORY. A refactor that provably leaves output identical (exact-output suites
 * unchanged) may only re-pin SANITIZER_SOURCE_HASH, and the implementation report must say why. When
 * in doubt, bump. (SANITIZER_SOURCE_FILES are the HTML and CSS sanitizers, the plain-text scanner, the
 * post-checks, the worker and the render routing, including every cap.) Stored output with a lower
 * version is re-rendered in the background by the cron `rerender` stage.
 *
 * Also bump MIN_DISPLAYABLE_SANITIZER_VERSION when the change fixes a security defect: older stored
 * output then stops being displayed (body_text or "being prepared" is shown) until it is re-rendered.
 *
 * tests/email-version.test.ts recomputes SANITIZER_SOURCE_HASH and fails (printing the new hash) when
 * any listed file changes, forcing a conscious decision about the version. It also checks the
 * installed versions of SANITIZER_DEPENDENCIES against SANITIZER_DEPENDENCY_HISTORY: upgrading
 * any of them (sanitize-html, htmlparser2, entities, postcss, parse-srcset, launder, @csstools/*)
 * fails until SANITIZER_VERSION is bumped.
 *
 * Version 2 (phase-2a-followups): the depth pre-scan models htmlparser2's open-element stack
 * (F1/H1), the main thread runs the render check (G1), and the dependency guard covers entities,
 * parse-srcset, launder and the tokenizer as css-parser-algorithms resolves it (G2).
 */

export const SANITIZER_VERSION = 2;
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
 * Third-party packages whose code determines rendered output (Round 10, security V1; follow-up G2).
 * Each is resolved the way Node resolves it, along `resolveFrom`: starting at the repo root, each
 * package in the chain is resolved from the previous one's directory, then `name` from the last
 * (for example sanitize-html -> htmlparser2 -> entities). A name may appear more than once (the
 * tokenizer is checked both from the root and as css-parser-algorithms resolves it); every
 * resolution must equal the history entry for that name.
 *
 * Not listed, after reading the source: domhandler and dom-serializer. sanitize-html uses
 * `htmlparser.Parser` directly with its own callbacks and builds the output string itself
 * (sanitize-html index.js:316); htmlparser2's Parser.js and Tokenizer.js import only each other and
 * entities/decode. htmlparser2's index.js imports domhandler and domutils at module level, but
 * nothing on this path calls them. (launder's only dependency, dayjs, is used by its date helpers,
 * not by naughtyHref.)
 */
export const SANITIZER_DEPENDENCIES: { name: string; resolveFrom: string[] }[] = [
  { name: "sanitize-html", resolveFrom: [] },
  { name: "htmlparser2", resolveFrom: ["sanitize-html"] },
  { name: "entities", resolveFrom: ["sanitize-html", "htmlparser2"] },
  { name: "postcss", resolveFrom: ["sanitize-html"] },
  { name: "parse-srcset", resolveFrom: ["sanitize-html"] },
  { name: "launder", resolveFrom: ["sanitize-html"] },
  { name: "@csstools/css-tokenizer", resolveFrom: [] },
  { name: "@csstools/css-parser-algorithms", resolveFrom: [] },
  { name: "@csstools/css-tokenizer", resolveFrom: ["@csstools/css-parser-algorithms"] },
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
  {
    version: 2,
    packages: {
      "sanitize-html": "2.18.2",
      htmlparser2: "12.0.0",
      postcss: "8.5.33",
      "@csstools/css-tokenizer": "4.0.3",
      "@csstools/css-parser-algorithms": "4.0.3",
      entities: "8.1.0",
      "parse-srcset": "1.0.2",
      launder: "1.7.2",
    },
  },
];

/** sha256 of SANITIZER_SOURCE_FILES (LF-normalized) as of SANITIZER_VERSION. */
export const SANITIZER_SOURCE_HASH = "2fa2f9b66452ab65934f3a51191e693f60b220aa955e76107f20218d8597c77c";

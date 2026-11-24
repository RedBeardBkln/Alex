// Node module-resolution hook for the fresh-process timing helpers: lets `node --experimental-strip-types`
// load src/lib/*.ts files whose relative imports omit the ".ts" extension (as the bundler-style tsconfig allows).
// It also maps the tsconfig `@/` alias to src/ (phase-h1-link-hardening: warnings.ts imports `@/lib/...`).
import { pathToFileURL } from "node:url";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../../src");

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const target = path.join(SRC, specifier.slice(2));
    const url = pathToFileURL(/\.[cm]?[jt]s$/.test(target) ? target : `${target}.ts`).href;
    return next(url, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith(".ts")) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // fall through to the default resolution
    }
  }
  return next(specifier, context);
}

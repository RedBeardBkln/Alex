// Node module-resolution hook for the fresh-process timing helpers: lets `node --experimental-strip-types`
// load src/lib/*.ts files whose relative imports omit the ".ts" extension (as the bundler-style tsconfig allows).
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith(".ts")) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // fall through to the default resolution
    }
  }
  return next(specifier, context);
}

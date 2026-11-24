// phase-h1-link-hardening A5: named input generators for the per-process link timing harness
// (tests/helpers/time-links.mjs, tests/h1-links-timing.test.ts). Each builds about n UTF-16 units.
// "f1:", "f2:" and "f3:" are the cases of the existing in-process guards (followups-units "linear time",
// followups2-units "SF1: linear time", followups3-units "linear time (AC-L-7)"), scaled to n; "h1:" are
// the H1 cases (plan §11.4). Loaded by node --experimental-transform-types, so plain TypeScript only.

const BS = String.fromCharCode(92);
const SHY = String.fromCharCode(0xad);
/** Backslash notation as in followups3-units: "~" stands for a backslash. */
const b = (s: string) => s.split("~").join(BS);

/** `unit` repeated to about n units. */
const fill = (unit: string, n: number) => unit.repeat(Math.max(1, Math.floor(n / unit.length)));
/** Distinct pieces f(0), f(1), … joined with `sep` until the total reaches about n units. */
function many(f: (i: number) => string, n: number, sep = ""): string {
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; len < n; i++) {
    const p = f(i);
    parts.push(p);
    len += p.length + sep.length;
  }
  return parts.join(sep);
}
/** prefix + fill(unit) + suffix, about n units in total. */
const wrap = (prefix: string, unit: string, suffix: string, n: number) => prefix + fill(unit, Math.max(unit.length, n - prefix.length - suffix.length)) + suffix;

export const LINK_TIMING_CASES: Record<string, (n: number) => string> = {
  // followups-units: "linear time: 1 MB of scheme:// and // repeats, and a long punctuation run"
  "f1:a-scheme-slashes": (n) => fill("a://", n),
  "f1:slash-slash": (n) => fill("//", n),
  "f1:a-scheme-space": (n) => fill("a:// ", n),
  "f1:dots": (n) => fill(".", n - 1) + "x",
  "f1:slash-slash-a": (n) => fill("//a", n),
  "f1:zero-scheme": (n) => fill("0://", n),
  "f1:dash-scheme": (n) => fill("-://", n),
  "f1:bare-colon-slashes": (n) => wrap("", "://", "https://evil.test/", n),
  "f1:digits-scheme": (n) => "1".repeat(Math.floor(n / 2)) + "://" + "1".repeat(Math.floor(n / 2)) + "://x",
  "f1:a1-scheme": (n) => fill("a1://", n),
  "f1:colon-three-slashes": (n) => fill(":///", n),
  // followups2-units: "SF1: linear time"
  "f2:http-colon": (n) => fill("http:", n),
  "f2:https-colon-slash": (n) => fill("https:/", n),
  "f2:a-scheme-evil": (n) => wrap("", "a://", "evil.test", n),
  "f2:http-then-at": (n) => fill("http:", n / 3) + "@" + "a".repeat(Math.floor((2 * n) / 3)),
  "f2:backslash-at": (n) => fill(`${BS}@`, n),
  "f2:colons": (n) => fill(":", n - 1) + "x",
  "f2:a-b-colon": (n) => fill("a.b:", n),
  "f2:underscore-scheme": (n) => fill("_://", n),
  "f2:a-colon-then-x": (n) => fill("a:", (3 * n) / 7) + "x".repeat(Math.floor((4 * n) / 7)),
  "f2:https-long-backslash-at": (n) => `https://${"a".repeat(Math.floor(n / 2))}${BS}@${"b".repeat(Math.floor((2 * n) / 5))}`,
  "f2:slashes-a-at": (n) => wrap("//", "a@", "x", n),
  "f2:http-slashes-ats": (n) => "http:" + "/".repeat(Math.floor(n / 2)) + "@".repeat(Math.floor((2 * n) / 5)),
  // followups3-units: "linear time (AC-L-7)"
  "f3:unc-hosts": (n) => many((i) => b(`~~h${i}.test~s`), n, " "),
  "f3:equals-unc": (n) => many((i) => b(`=~~h${i}~`), n),
  "f3:equals-slashes": (n) => many((i) => `=//h${i}.test`, n),
  "f3:file-unc-spaced": (n) => many((i) => b(`file:~~h${i}.test`), n, " "),
  "f3:file-unc-glued": (n) => many((i) => b(`file:~~h${i}.test`), n),
  "f3:ms-x": (n) => fill("ms-x:", n),
  "f3:search-ms-unc": (n) => wrap("search-ms:", b("~~"), "", n),
  "f3:xn-labels": (n) => Array.from({ length: Math.max(1, Math.floor(n / 1007)) }, () => "a.xn--" + "a".repeat(1_000)).join(" "),
  "f3:https-xn-labels": (n) => Array.from({ length: Math.max(1, Math.floor(n / 1015)) }, () => "https://a.xn--" + "a".repeat(1_000)).join(" "),
  "f3:hostless-in-query": (n) => many((i) => `https://h${i}.test/?u=x://`, n),
  "f3:equals": (n) => fill("=", n - 1) + "x",
  "f3:equals-backslash": (n) => fill(b("=~"), n),
  "f3:userinfo-run": (n) => wrap("https://", "a@", "evil.test&v=1", n),
  "f3:distinct-userinfo": (n) => "https://bank.test/?" + many((i) => `u=https://u${i}@h${i}.test&`, n),
  "f3:distinct-glue": (n) => "https://bank.test/?" + many((i) => `u=https://h${i}.test&e=a@b${i}.test&`, n),
  "f3:amp-then-at": (n) => wrap("https://", "a&", "@evil.test", n),
  "f3:encoded-at": (n) => wrap("x://", "a%40", "", n),
  // H1 (plan §11.4): decoding
  "h1:one-segment-%41": (n) => wrap("https://bank.test/?u=", "%41", "", n),
  "h1:tiny-segments": (n) => wrap("https://bank.test/?", "&%41", "", n),
  "h1:distinct-encoded-urls": (n) => "https://bank.test/?" + many((i) => `&u=https%3A%2F%2Fh${i}.test`, n),
  "h1:encoded-slash-at": (n) => wrap("https://bank.test/?u=", "%2F@", "", n),
  "h1:%25": (n) => wrap("https://bank.test/?u=", "%25", "", n),
  "h1:%2540": (n) => wrap("https://bank.test/?u=", "%2540", "", n),
  "h1:percent": (n) => wrap("https://bank.test/?u=", "%", "", n),
  "h1:%4": (n) => wrap("https://bank.test/?u=", "%4", "", n),
  "h1:%C3%A9": (n) => wrap("https://bank.test/?u=", "%C3%A9", "", n),
  "h1:%C3%A9a": (n) => wrap("https://bank.test/?u=", "%C3%A9a", "", n),
  "h1:%FF": (n) => wrap("https://bank.test/?u=", "%FF", "", n),
  "h1:%20-flood": (n) => wrap("https://bank.test/?u=", "%20", "", n),
  "h1:%20-hosts": (n) => "https://bank.test/?u=" + many((i) => `h${i}.test%20`, n),
  "h1:encoded-at-run": (n) => wrap("https://bank.test/?u=https%3A%2F%2F", "a%40", "evil.test&v=1", n),
  "h1:path-encoded": (n) => "https://bank.test/r/" + many((i) => `https%3A%2F%2Fh${i}.test%2F`, n),
  // H1: C2 (the glue run)
  "h1:glue-userinfo": (n) => wrap("https://bank.test/?next=https://", "x@", "evil.test&e=y@bank.test", n),
  "h1:glue-distinct": (n) => "https://bank.test/?next=https://" + many((i) => `u${i}@h${i}.test&e=a@b.test&`, n),
  "h1:glue-shared": (n) => wrap("", "_://a", "@evil.test&v=1", n),
  "h1:glue-shared-https": (n) => wrap("", "https://a", "@evil.test&v=1", n),
  // H1: C4 and C5
  "h1:scheme-unc": (n) => fill(b("ab:~~x"), n),
  "h1:onenote-unc": (n) => fill(b("onenote:~~"), n),
  "h1:shy-lead-reset": (n) => wrap("", `a${SHY}`, b("~~x"), n),
  // H1 round 2: the glue run after the last `@` before the first `&`, the cut at a decoded space,
  // and newer reads before main's reads in one token (display start kept apart).
  "h1:glue-equals-userinfo": (n) => "https://bank.test/?next=https://" + many((i) => `u${i}=1@h${i}.test&e=a@b.test&`, n),
  "h1:equals-at-flood": (n) => wrap("https://", "=@", "evil.test&e=y@bank.test", n),
  "h1:amp-after-ats": (n) => wrap("https://", "a=1@", "&e=x@bank.test", n),
  "h1:%20-cut": (n) => "https://bank.test/?" + many((i) => `&u=https%3A%2F%2Fh${i}.test%20h${i}.test`, n),
  "h1:new-then-main": (n) => many((i) => b(`ab:~~h${i}/https://h${i}.test/`), n),
  "h1:shy-unc-then-main": (n) => fill(b(`a${SHY}~~x/https://evil.test/`), n),
  // H1 round 3: dropped tab/LF/CR, skipped spaces after `=`, and many newer reads before main's display (second display).
  "h1:%09-drop": (n) => wrap("https://bank.test/?u=", "%09", "https%3A%2F%2Fevil.test", n),
  "h1:eq-space-flood": (n) => wrap("https://bank.test/?u=", "=%20", "", n),
  // H1 round 4 (R2-N1): leading C0 controls and `+` skipped after each `=`.
  "h1:c0-plus-lead": (n) => wrap("https://bank.test/?u=", "=%0B+%00", "https%3A%2F%2Fevil.test", n),
  "h1:decoded-before-main": (n) => many((i) => `a${i}=https%3A%2F%2Fh${i}.test&`, n) + "v=https://bank.test/",
  // H1: a haystack whose extra hosts are not all in the base known set (knownAll must be computed in "self" mode)
  "h1:haystack-knownall": (n) => many((i) => `see https://bank.test/?u=https%3A%2F%2Fh${i}.test and https://k${i}.test/?next=https://k${i}.test@e${i}.test&e=x@k${i}.test`, n, " "),
};
